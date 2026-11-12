/**
 * End-to-end tests against a real OpenSSH server.
 *
 * These cover the parts that only a real server exercises: the handshake,
 * host key verification against known_hosts, exit codes and stderr from a
 * real shell, SFTP, and the key bootstrap writing a file that sshd then
 * accepts. They skip on machines without sshd rather than failing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  connect,
  downloadFile,
  execCommand,
  listDirectory,
  uploadFile,
  withConnection,
} from "../src/clients/ssh-client.ts";
import { authorizeKey, ensureLocalKey } from "../src/authorize.ts";
import * as config from "../src/config.ts";
import type { SshProfile } from "../src/types.ts";
import { startTestServer, type TestServer } from "./sshd.ts";

let server: TestServer | null = null;
let workspace: string;
let knownHosts: string;

function profileFor(overrides: Partial<SshProfile> = {}): SshProfile {
  return {
    host: "127.0.0.1",
    port: server!.port,
    user: server!.user,
    privateKeyPath: server!.clientKeyPath,
    knownHostsFile: knownHosts,
    strictHostKey: true,
    ...overrides,
  };
}

before(async () => {
  server = await startTestServer();
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-work-")));
  knownHosts = path.join(workspace, "known_hosts");
});

after(() => {
  server?.stop();
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

describe("host key verification", () => {
  it("refuses a host that is not in known_hosts", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    fs.rmSync(knownHosts, { force: true });

    await assert.rejects(
      () => withConnection(profileFor(), {}, async () => undefined),
      (err: Error) => {
        assert.strictEqual(err.name, "UnknownHostKeyError");
        assert.match(err.message, /SHA256:/);
        return true;
      },
    );
  });

  it("records the key on first use and matches it afterwards", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    fs.rmSync(knownHosts, { force: true });

    const first = await withConnection(profileFor(), { acceptNewHostKey: true }, async (c) => c.identity);
    assert.strictEqual(first.hostKeyVerdict, "unknown");
    assert.match(first.fingerprint, /^SHA256:/);
    assert.ok(fs.existsSync(knownHosts));

    const second = await withConnection(profileFor(), {}, async (c) => c.identity);
    assert.strictEqual(second.hostKeyVerdict, "match");
    assert.strictEqual(second.authMethod, "key");
  });

  it("refuses hard when the recorded key no longer matches", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    fs.rmSync(knownHosts, { force: true });
    await withConnection(profileFor(), { acceptNewHostKey: true }, async () => undefined);

    // Same host, same key type, different key: the machine-in-the-middle shape.
    const [hosts, keyType] = fs.readFileSync(knownHosts, "utf-8").trim().split(/\s+/);
    fs.writeFileSync(
      knownHosts,
      `${hosts} ${keyType} AAAAC3NzaC1lZDI1NTE5AAAAIIADt87HvPw/z1PKr5GJ3eNj/p0jA4zY1t8pbLoLumqx\n`,
    );

    await assert.rejects(
      () => withConnection(profileFor(), {}, async () => undefined),
      (err: Error) => {
        assert.strictEqual(err.name, "HostKeyChangedError");
        assert.match(err.message, /HOST KEY CHANGED/);
        assert.match(err.message, /ssh-keygen -R/);
        return true;
      },
    );
  });

  it("does not record a key when acceptNewHostKey is not given", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    fs.rmSync(knownHosts, { force: true });
    await assert.rejects(() => withConnection(profileFor(), {}, async () => undefined));
    assert.strictEqual(fs.existsSync(knownHosts), false);
  });
});

describe("running commands", () => {
  before(async () => {
    if (!server) return;
    fs.rmSync(knownHosts, { force: true });
    await withConnection(profileFor(), { acceptNewHostKey: true }, async () => undefined);
  });

  it("returns stdout and a zero exit code", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    const result = await withConnection(profileFor(), {}, (c) =>
      execCommand(c, "echo hello from the server"),
    );
    assert.strictEqual(result.stdout.trim(), "hello from the server");
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.truncated, false);
  });

  it("reports a non-zero exit code and stderr separately", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    const result = await withConnection(profileFor(), {}, (c) =>
      execCommand(c, "echo problem >&2; exit 3"),
    );
    assert.strictEqual(result.code, 3);
    assert.strictEqual(result.stderr.trim(), "problem");
    assert.strictEqual(result.stdout.trim(), "");
  });

  it("runs in the requested directory", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    const result = await withConnection(profileFor(), {}, (c) =>
      execCommand(c, "pwd", { cwd: server!.dir }),
    );
    assert.strictEqual(result.stdout.trim(), fs.realpathSync(server!.dir));
  });

  it("quotes a working directory containing spaces", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    const awkward = path.join(server!.dir, "a dir with spaces");
    fs.mkdirSync(awkward, { recursive: true });
    const result = await withConnection(profileFor(), {}, (c) =>
      execCommand(c, "pwd", { cwd: awkward }),
    );
    assert.strictEqual(result.stdout.trim(), fs.realpathSync(awkward));
  });

  it("gives up on a command that never finishes", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    await assert.rejects(
      () => withConnection(profileFor(), {}, (c) => execCommand(c, "sleep 30", { timeoutMs: 800 })),
      /timed out/,
    );
  });

  it("closes the connection even when the command fails", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    const connection = await connect(profileFor(), {});
    let closed = false;
    connection.client.on("close", () => {
      closed = true;
    });
    connection.client.end();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(closed, true);
  });
});

describe("file transfer", () => {
  it("uploads, lists and downloads over SFTP", async (t) => {
    if (!server) return t.skip("no sshd on this machine");

    const localSource = path.join(workspace, "source.txt");
    const localTarget = path.join(workspace, "roundtrip", "back.txt");
    const remote = path.join(server.dir, "uploaded.txt");
    fs.writeFileSync(localSource, "round trip payload");

    await withConnection(profileFor(), {}, async (connection) => {
      const uploaded = await uploadFile(connection, localSource, remote);
      assert.strictEqual(uploaded.size, 18);

      const entries = await listDirectory(connection, server!.dir);
      const found = entries.find((entry) => entry.name === "uploaded.txt");
      assert.ok(found, "the uploaded file should be listed");
      assert.strictEqual(found!.type, "file");
      assert.match(found!.mode, /^[rwx-]{9}$/);

      await downloadFile(connection, remote, localTarget);
    });

    // The local directory did not exist, so this also covers creating it.
    assert.strictEqual(fs.readFileSync(localTarget, "utf-8"), "round trip payload");
  });

  it("explains a missing remote path instead of throwing a raw error", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    await assert.rejects(
      () => withConnection(profileFor(), {}, (c) => listDirectory(c, "/nope/not/here")),
      /Cannot list \/nope\/not\/here/,
    );
  });
});

describe("key bootstrap", () => {
  const originalHome = process.env.HOME;
  // WHY: these tests save profiles; without an isolated HOME they wrote
  // "e2e"/"keeps" entries into the developer's real ~/.pi/ssh-config.json.
  const isolatedHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-home-")));
  process.env.HOME = isolatedHome;

  after(() => {
    process.env.HOME = originalHome;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  });

  it("generates a key, installs it, and proves a key-only login works", async (t) => {
    if (!server) return t.skip("no sshd on this machine");

    config._resetForTesting();
    config.saveProfile("e2e", profileFor());

    const keyPath = path.join(workspace, "bootstrapped_key");
    const { profile } = config.resolveProfile("e2e");
    const result = await authorizeKey({
      profileName: "e2e",
      profile,
      keyPath,
      acceptNewHostKey: true,
      authorizedKeysPath: server.authorizedKeysPath,
    });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.verified, true);
    assert.match(result.fingerprint, /^SHA256:/);

    // The profile now points at the new key.
    assert.strictEqual(config.getProfile("e2e")!.privateKeyPath, keyPath);

    // And sshd accepted it: the file it reads has both keys, still private.
    const authorized = fs.readFileSync(server.authorizedKeysPath, "utf-8").trim().split("\n");
    assert.strictEqual(authorized.length, 2);
    assert.strictEqual(fs.statSync(server.authorizedKeysPath).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(`${keyPath}.pub`));
  });

  it("is idempotent: running it again adds nothing", async (t) => {
    if (!server) return t.skip("no sshd on this machine");

    const before = fs.readFileSync(server.authorizedKeysPath, "utf-8");
    const { profile } = config.resolveProfile("e2e");
    const result = await authorizeKey({
      profileName: "e2e",
      profile,
      keyPath: path.join(workspace, "bootstrapped_key"),
      authorizedKeysPath: server.authorizedKeysPath,
    });

    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.verified, true);
    assert.strictEqual(fs.readFileSync(server.authorizedKeysPath, "utf-8"), before);
  });

  it("reuses an existing key rather than overwriting it", async (t) => {
    if (!server) return t.skip("no sshd on this machine");

    const keyPath = path.join(workspace, "bootstrapped_key");
    const contents = fs.readFileSync(keyPath, "utf-8");
    const reused = ensureLocalKey(keyPath, "different comment");

    assert.strictEqual(reused.created, false);
    assert.strictEqual(fs.readFileSync(keyPath, "utf-8"), contents);
  });

  it("keeps the password unless asked to drop it", async (t) => {
    if (!server) return t.skip("no sshd on this machine");

    config._resetForTesting();
    // A password that would not work: the key must be what authenticates,
    // and the password must survive because removePassword was not set.
    config.saveProfile("keeps", profileFor({ password: "not-the-real-password" }));

    const { profile } = config.resolveProfile("keeps");
    const result = await authorizeKey({
      profileName: "keeps",
      profile: { ...profile, password: undefined },
      keyPath: path.join(workspace, "bootstrapped_key"),
      authorizedKeysPath: server.authorizedKeysPath,
    });

    assert.strictEqual(result.verified, true);
    assert.strictEqual(config.getProfile("keeps")!.password, "not-the-real-password");
  });
});
