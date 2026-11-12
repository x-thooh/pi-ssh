/**
 * Tool-level tests.
 *
 * Argument validation is checked directly; everything that touches a host is
 * driven against the same real sshd the end-to-end tests use, so the tool
 * layer is exercised the way pi will call it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-tools-"));
const originalHome = process.env.HOME;
process.env.HOME = testHome;
fs.mkdirSync(path.join(testHome, ".pi"), { recursive: true, mode: 0o700 });

const { SshSetupTool } = await import("../src/tools/ssh-setup.ts");
const { SshStatusTool } = await import("../src/tools/ssh-status.ts");
const { SshProfileTool } = await import("../src/tools/ssh-profile.ts");
const { SshExecTool } = await import("../src/tools/ssh-exec.ts");
const { SshListTool } = await import("../src/tools/ssh-list.ts");
const { SshUploadTool } = await import("../src/tools/ssh-upload.ts");
const { SshDownloadTool } = await import("../src/tools/ssh-download.ts");
const { SshKeygenTool } = await import("../src/tools/ssh-keygen.ts");
const { SshAuthorizeTool } = await import("../src/tools/ssh-authorize.ts");
const { SshDoctorTool } = await import("../src/tools/ssh-doctor.ts");
const config = await import("../src/config.ts");
const { startTestServer } = await import("./sshd.ts");
type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const signal = new AbortController().signal;
let server: TestServer = null;

/** A fake pi context whose human approves everything (and trusts new hosts). */
const allow = { hasUI: true, ui: { confirm: async () => true, select: async (_t: string, o: string[]) => o[0] } };
const reject = { hasUI: true, ui: { confirm: async () => false, select: async (_t: string, o: string[]) => o[o.length - 1] } };

before(async () => {
  server = await startTestServer();
});

after(() => {
  server?.stop();
  process.env.HOME = originalHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("ssh_setup validation", async () => {
  it("refuses an empty host or user", async () => {
    await assert.rejects(
      () => SshSetupTool.execute("1", { name: "a", host: "  ", user: "u", password: "p" }, signal, undefined, allow),
      /host must not be empty/,
    );
    await assert.rejects(
      () => SshSetupTool.execute("1", { name: "a", host: "h", user: " ", password: "p" }, signal, undefined, allow),
      /user must not be empty/,
    );
  });

  it("refuses an impossible port", async () => {
    await assert.rejects(
      () => SshSetupTool.execute("1", { name: "a", host: "h", user: "u", password: "p", port: 0 }, signal, undefined, allow),
      /between 1 and 65535/,
    );
  });

  it("refuses a profile with no way to log in", async () => {
    await assert.rejects(
      () => SshSetupTool.execute("1", { name: "a", host: "h", user: "u" }, signal, undefined, allow),
      /password or a privateKeyPath/,
    );
  });

  it("announces that a password-only profile will be upgraded to a key", async () => {
    const result = await SshSetupTool.execute(
      "1",
      { name: "pw", host: "h", user: "u", password: "p" },
      signal, undefined, allow);
    assert.match(result.content[0].text, /a key will be installed/);
    assert.match(result.content[0].text, /password removed from the config/);
    assert.strictEqual(result.details.hasPassword, true);
    assert.strictEqual(result.details.hasKey, false);
  });

  it("points at ssh_authorize instead when the upgrade is switched off", async () => {
    const result = await SshSetupTool.execute(
      "1",
      { name: "pw-manual", host: "h", user: "u", password: "p", autoKey: false },
      signal, undefined, allow);
    assert.match(result.content[0].text, /keep doing so/);
    assert.match(result.content[0].text, /ssh_authorize/);
    assert.strictEqual(config.getProfile("pw-manual")!.autoKey, false);
  });

  it("expands a tilde in the key path", async () => {
    const result = await SshSetupTool.execute(
      "1",
      { name: "keyed", host: "h", user: "u", privateKeyPath: "~/.ssh/id_test" },
      signal, undefined, allow);
    assert.strictEqual(result.details.hasKey, true);
    assert.strictEqual(
      config.getProfile("keyed")!.privateKeyPath,
      path.join(testHome, ".ssh/id_test"),
    );
  });
});

describe("ssh_profile", async () => {
  it("lists profiles without arguments", async () => {
    const result = await SshProfileTool.execute("1", {}, signal, undefined, allow);
    assert.ok(result.details.profiles.includes("pw"));
  });

  it("requires a name for use and delete", async () => {
    await assert.rejects(() => SshProfileTool.execute("1", { action: "use" }, signal, undefined, allow), /requires a profile name/);
  });

  it("rejects an unknown action", async () => {
    await assert.rejects(
      () => SshProfileTool.execute("1", { action: "rename", name: "pw" }, signal, undefined, allow),
      /Unknown action/,
    );
  });

  it("reports a missing profile on delete", async () => {
    const result = await SshProfileTool.execute("1", { action: "delete", name: "ghost" }, signal, undefined, allow);
    assert.strictEqual(result.details.deleted, false);
  });
});

describe("ssh_doctor", async () => {
  it("reports the environment and finds no blocking problem", async () => {
    const result = SshDoctorTool.execute("1", {}, signal);
    assert.deepStrictEqual(result.details.problems, []);
    assert.match(result.content[0].text, /Nothing needs to be installed/);
  });
});

describe("ssh_keygen", async () => {
  it("writes both halves with sane permissions", async () => {
    const target = path.join(testHome, "keys", "generated");
    const result = await SshKeygenTool.execute("1", { path: target, comment: "unit test" }, signal, undefined, allow);

    assert.ok(fs.existsSync(target));
    assert.ok(fs.existsSync(`${target}.pub`));
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
    }
    assert.match(result.details.fingerprint, /^SHA256:/);
    assert.match(result.details.publicKey, /^ssh-ed25519 .* unit test$/);
  });

  it("refuses to overwrite an existing key", async () => {
    const target = path.join(testHome, "keys", "generated");
    await assert.rejects(
      () => SshKeygenTool.execute("1", { path: target }, signal, undefined, allow),
      /already exists/,
    );
  });

  it("overwrites only when told to", async () => {
    const target = path.join(testHome, "keys", "generated");
    const before = fs.readFileSync(target, "utf-8");
    await SshKeygenTool.execute("1", { path: target, overwrite: true }, signal, undefined, allow);
    assert.notStrictEqual(fs.readFileSync(target, "utf-8"), before);
  });

  it("refuses to attach the key to a profile that does not exist", async () => {
    await assert.rejects(
      () =>
        SshKeygenTool.execute(
          "1",
          { path: path.join(testHome, "keys", "other"), profile: "ghost" },
          signal, undefined, allow),
      /does not exist/,
    );
  });

  it("records the key in a profile when asked", async () => {
    const target = path.join(testHome, "keys", "attached");
    await SshKeygenTool.execute("1", { path: target, profile: "pw" }, signal, undefined, allow);
    assert.strictEqual(config.getProfile("pw")!.privateKeyPath, target);
  });
});

describe("tools against a real server", async () => {
  before(() => {
    if (!server) return;
    config.saveProfile("live", {
      host: "127.0.0.1",
      port: server.port,
      user: server.user,
      privateKeyPath: server.clientKeyPath,
      knownHostsFile: path.join(testHome, "known_hosts"),
      strictHostKey: true,
    });
  });

  it("ssh_status verifies a connection when asked", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    // First contact has to record the host key, which status does not do.
    await SshExecTool.execute(
      "1",
      { command: "true", profile: "live" },
      signal, undefined, allow);

    const result = await SshStatusTool.execute("1", { profile: "live", connect: true }, signal);
    assert.strictEqual(result.details.reachable, true);
    assert.match(result.content[0].text, /Authenticated with: key/);
  });

  it("ssh_exec returns output and the exit code", async (t) => {
    if (!server) return t.skip("no sshd on this machine");
    const result = await SshExecTool.execute(
      "1",
      { command: "echo from-the-tool; exit 7", profile: "live" },
      signal, undefined, allow);
    assert.strictEqual(result.details.exitCode, 7);
    assert.match(result.content[0].text, /from-the-tool/);
  });

  it("ssh_exec rejects an empty command", async () => {
    await assert.rejects(
      () => SshExecTool.execute("1", { command: "   ", profile: "live" }, signal, undefined, allow),
      /must not be empty/,
    );
  });

  it("ssh_list, ssh_upload and ssh_download work together", async (t) => {
    if (!server) return t.skip("no sshd on this machine");

    const local = path.join(testHome, "payload.txt");
    const remote = path.join(server.dir, "payload.txt");
    const back = path.join(testHome, "returned", "payload.txt");
    fs.writeFileSync(local, "tool round trip");

    const uploaded = await SshUploadTool.execute(
      "1",
      { localPath: local, remotePath: remote, profile: "live" },
      signal, undefined, allow);
    assert.strictEqual(uploaded.details.size, 15);

    const listed = await SshListTool.execute("1", { path: server.dir, profile: "live" }, signal, undefined, allow);
    assert.ok(listed.details.count > 0);
    assert.match(listed.content[0].text, /payload\.txt/);

    await SshDownloadTool.execute(
      "1",
      { remotePath: remote, localPath: back, profile: "live" },
      signal, undefined, allow);
    assert.strictEqual(fs.readFileSync(back, "utf-8"), "tool round trip");
  });

  it("ssh_authorize sets up a key login through the tool layer", async (t) => {
    if (!server) return t.skip("no sshd on this machine");

    const result = await SshAuthorizeTool.execute(
      "1",
      {
        profile: "live",
        keyPath: path.join(testHome, "keys", "via_tool"),
        authorizedKeysPath: server.authorizedKeysPath,
      },
      signal, undefined, allow);

    assert.strictEqual(result.details.installed, true);
    assert.strictEqual(result.details.verified, true);
    assert.strictEqual(result.details.passwordRemoved, false);
    assert.match(result.content[0].text, /no password is needed from now on/);
  });

  it("an unknown host is refused rather than trusted silently", async (t) => {
    if (!server) return t.skip("no sshd on this machine");

    config.saveProfile("fresh", {
      host: "127.0.0.1",
      port: server.port,
      user: server.user,
      privateKeyPath: server.clientKeyPath,
      knownHostsFile: path.join(testHome, "empty_known_hosts"),
      strictHostKey: true,
    });

    await assert.rejects(
      () => SshExecTool.execute("1", { command: "true", profile: "fresh" }, signal, undefined, reject),
      /denied by the user/,
    );
    assert.ok(!fs.existsSync(path.join(testHome, "empty_known_hosts")));

    // Without a UI nothing is trusted either, and acceptNewHostKey alone is ignored.
    await assert.rejects(
      () => SshExecTool.execute("1", { command: "true", profile: "fresh", acceptNewHostKey: true }, signal),
      /no interactive UI/,
    );
    await assert.rejects(
      () => SshListTool.execute("1", { path: ".", profile: "fresh", acceptNewHostKey: true }, signal),
      /no interactive UI/,
    );

    // The human approving the prompt records the key and the call proceeds.
    const result = await SshExecTool.execute("1", { command: "true", profile: "fresh" }, signal, undefined, allow);
    assert.strictEqual(result.details.exitCode, 0);
    assert.ok(fs.readFileSync(path.join(testHome, "empty_known_hosts"), "utf-8").length > 0);
  });
});
