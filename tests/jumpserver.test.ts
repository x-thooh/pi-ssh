import { afterEach, before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startMockJumpServer, startMockSshd, type MockServer } from "./mock-jumpserver.ts";
import { closeAllJumpSessions, findSentinel, hasJumpSession, openJumpSession, redact, stripAnsi } from "../src/jumpserver.ts";
import { runCommandOnProfile } from "../src/clients/run.ts";
import { formatExecResult, formatProfileStatus } from "../src/formatting/formatters.ts";
import { needsKeyUpgrade } from "../src/auto-key.ts";
import { MAX_OUTPUT_CHARS } from "../src/clients/ssh-client.ts";
import type { SshProfile } from "../src/types.ts";

const PASSWORD = "s3cret-pw-xyz";
const knownHostsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jk-")), "known_hosts");

function jumpProfile(port: number, extra: Partial<SshProfile> = {}, jump: object = {}): SshProfile {
  return {
    host: "127.0.0.1",
    port,
    user: "u",
    password: PASSWORD,
    strictHostKey: false,
    knownHostsFile,
    jump: { type: "jumpserver", asset: "web1", ...jump },
    ...extra,
  } as SshProfile;
}

describe("helpers", () => {
  it("strips ANSI escapes and carriage returns", () => {
    assert.equal(stripAnsi("\x1b[1;32mHi\x1b[0m\r\nthere\x1b]0;title\x07"), "Hi\nthere");
  });
  it("redacts secrets", () => {
    assert.equal(redact("pw=abc and abc", ["abc"]), "pw=*** and ***");
  });
  it("parses the sentinel and exit code", () => {
    assert.deepEqual(findSentinel("out\n\n__PI_t__7\nrest", "t"), { output: "out\n", code: 7 });
    assert.equal(findSentinel("out\n__PI_t__7", "t"), null);
    assert.equal(findSentinel("out\n__PI_other__0\n", "t"), null);
    // the echoed printf text (literal backslash-n) must not match
    assert.equal(findSentinel("printf '\\n__PI_t__%d\\n' $?\n", "t"), null);
  });
  it("never upgrades a jumpserver profile to key auth", () => {
    assert.equal(needsKeyUpgrade(jumpProfile(1)), false);
    assert.equal(needsKeyUpgrade({ host: "h", port: 22, user: "u", password: "p" }), true);
  });
});

describe("JumpServer sessions", () => {
  let server: MockServer;
  before(async () => {
    server = await startMockJumpServer({ password: PASSWORD });
  });
  after(async () => {
    closeAllJumpSessions();
    await server.close();
  });
  afterEach(() => closeAllJumpSessions());

  it("logs in through the menu, runs a command, propagates exit codes", async () => {
    const p = jumpProfile(server.port);
    const ok = await runCommandOnProfile("j-ok", p, "echo hello", {});
    assert.equal(ok.stdout, "hello\n");
    assert.equal(ok.code, 0);
    const bad = await runCommandOnProfile("j-ok", p, "exit_code() { return 3; }; exit_code", {});
    assert.equal(bad.code, 3);
  });

  it("waits for a slowly drawn account menu before answering ID>", async () => {
    const slow = await startMockJumpServer({ password: PASSWORD, slowAccountMenu: true });
    try {
      const r = await runCommandOnProfile("j-slow", jumpProfile(slow.port), "echo hi", {});
      assert.equal(r.stdout, "hi\n");
      assert.equal(r.code, 0);
    } finally {
      closeAllJumpSessions();
      await slow.close();
    }
  });

  it("re-sends the shell init until a slow target shell is up, without leaking sentinels", async () => {
    const slow = await startMockJumpServer({ password: PASSWORD, shellStartDelayMs: 1200 });
    try {
      const r = await runCommandOnProfile("j-boot", jumpProfile(slow.port), "echo hi", {});
      assert.equal(r.stdout, "hi\n");
      assert.equal(r.code, 0);
    } finally {
      closeAllJumpSessions();
      await slow.close();
    }
  });

  it("opens a session without running a command, and later commands reuse it", async () => {
    const p = jumpProfile(server.port);
    const before = server.logins();
    assert.equal(hasJumpSession("j-enter"), false);
    assert.deepEqual(await openJumpSession("j-enter", p), { reused: false });
    assert.equal(hasJumpSession("j-enter"), true);
    assert.equal(server.logins() - before, 1);
    assert.deepEqual(await openJumpSession("j-enter", p), { reused: true });
    const r = await runCommandOnProfile("j-enter", p, "echo inside", {});
    assert.equal(r.stdout, "inside\n");
    assert.equal(server.logins() - before, 1, "entering and running share one login");
  });

  it("a failed open leaves no session behind", async () => {
    const bad = { ...jumpProfile(server.port), password: "wrong" };
    await assert.rejects(() => openJumpSession("j-enter-bad", bad));
    assert.equal(hasJumpSession("j-enter-bad"), false);
  });

  it("merges stderr into stdout", async () => {
    const r = await runCommandOnProfile("j-err", jumpProfile(server.port), "echo out; echo err 1>&2", {});
    assert.equal(r.stdout, "out\nerr\n");
    assert.equal(r.stderr, "");
  });

  it("reuses one login for several commands", async () => {
    const before = server.logins();
    const p = jumpProfile(server.port);
    await runCommandOnProfile("j-reuse", p, "true", {});
    await runCommandOnProfile("j-reuse", p, "true", {});
    assert.equal(server.logins() - before, 1);
    assert.equal(hasJumpSession("j-reuse"), true);
  });

  it("queues concurrent commands without mixing output", async () => {
    const p = jumpProfile(server.port);
    const [a, b] = await Promise.all([
      runCommandOnProfile("j-q", p, "sleep 0.2; echo A", {}),
      runCommandOnProfile("j-q", p, "echo B", {}),
    ]);
    assert.equal(a.stdout, "A\n");
    assert.equal(b.stdout, "B\n");
  });

  it("closes an idle session and logs in again on demand", async () => {
    const before = server.logins();
    const p = jumpProfile(server.port, {}, { idleTimeoutMs: 150 });
    await runCommandOnProfile("j-idle", p, "true", {});
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(hasJumpSession("j-idle"), false);
    await runCommandOnProfile("j-idle", p, "true", {});
    assert.equal(server.logins() - before, 2);
  });

  it("times out, interrupts, and the session stays usable", async () => {
    const before = server.logins();
    const p = jumpProfile(server.port);
    await assert.rejects(
      runCommandOnProfile("j-to", p, "sleep 3", { timeoutMs: 400 }),
      /timed out after/,
    );
    const r = await runCommandOnProfile("j-to", p, "echo alive", {});
    assert.equal(r.stdout, "alive\n");
    assert.equal(server.logins() - before, 1, "resync should keep the same session");
  });

  it("persists cd across calls and honours cwd", async () => {
    const p = jumpProfile(server.port);
    fs.mkdirSync(path.join(server.dir, "sub dir"));
    const cwd = await runCommandOnProfile("j-cd", p, "basename \"$PWD\"", { cwd: "sub dir" });
    assert.equal(cwd.stdout, "sub dir\n");
    const again = await runCommandOnProfile("j-cd", p, "basename \"$PWD\"", {});
    assert.equal(again.stdout, "sub dir\n");
  });

  it("caps output at MAX_OUTPUT_CHARS", async () => {
    const r = await runCommandOnProfile(
      "j-cap",
      jumpProfile(server.port),
      "head -c 600000 /dev/zero | tr '\\0' a",
      {},
    );
    assert.equal(r.truncated, true);
    assert.ok(r.stdout.length < MAX_OUTPUT_CHARS + 100);
    assert.equal(r.code, 0);
  });

  it("reports a wrong password clearly without leaking it", async () => {
    const wrong = "wrong-pw-abc";
    await assert.rejects(
      runCommandOnProfile("j-bad", jumpProfile(server.port, { password: wrong }), "true", {}),
      (err: Error) => {
        assert.match(err.message, /rejected the credentials/);
        assert.ok(!err.message.includes(wrong));
        return true;
      },
    );
  });

  it("shows the sanitized tail of the output on a menu mismatch", async () => {
    const p = jumpProfile(server.port, {}, { steps: [{ expect: "Nope>", send: "x" }] });
    await assert.rejects(
      runCommandOnProfile("j-mm", p, "true", { loginTimeoutMs: 500 }),
      (err: Error) => {
        assert.match(err.message, /timed out at step 1\/1/);
        assert.match(err.message, /Opt>/);
        assert.ok(!err.message.includes("\x1b"));
        assert.ok(!err.message.includes(PASSWORD));
        return true;
      },
    );
  });

  it("redacts secret step replies from the error tail", async () => {
    const p = jumpProfile(server.port, {}, {
      steps: [
        { expect: "Opt>", send: "{password}", secret: true },
        { expect: "Never>", send: "x" },
      ],
    });
    await assert.rejects(
      runCommandOnProfile("j-red", p, "true", { loginTimeoutMs: 600 }),
      (err: Error) => !err.message.includes(PASSWORD),
    );
  });

  it("resolves passwordCmd > passwordEnv > password, and never leaks it", async () => {
    process.env.JUMP_TEST_PW = "wrong-env";
    const p = jumpProfile(server.port, {
      password: "wrong-stored",
      passwordEnv: "JUMP_TEST_PW",
      passwordCmd: `printf '%s\\n' '${PASSWORD}'`,
    });
    const r = await runCommandOnProfile("j-pc", p, "echo hi", {});
    assert.equal(r.code, 0);
    closeAllJumpSessions();

    process.env.JUMP_TEST_PW = PASSWORD;
    const env = jumpProfile(server.port, { password: "wrong-stored", passwordEnv: "JUMP_TEST_PW" });
    assert.equal((await runCommandOnProfile("j-pe", env, "echo hi", {})).code, 0);

    const all = JSON.stringify(r) + formatExecResult(r) + formatProfileStatus({ a: p, b: env }, "a");
    assert.ok(!all.includes(PASSWORD));
    assert.match(formatProfileStatus({ a: p }, "a"), /jumpserver/);
    delete process.env.JUMP_TEST_PW;
  });

  it("fails clearly when passwordCmd fails", async () => {
    const p = jumpProfile(server.port, { passwordCmd: "echo leakme-123 >&2; exit 1" });
    await assert.rejects(runCommandOnProfile("j-pf", p, "true", {}), (err: Error) => {
      assert.match(err.message, /passwordCmd failed/);
      assert.ok(!err.message.includes("leakme-123"));
      return true;
    });
  });
});

describe("ssh hops", () => {
  let hop: MockServer;
  let target: MockServer;
  before(async () => {
    hop = await startMockSshd({ password: "hop-pw" });
    target = await startMockSshd({ password: "target-pw" });
  });
  after(async () => {
    await hop.close();
    await target.close();
  });

  const hopProfile = (): SshProfile => ({
    host: "127.0.0.1", port: hop.port, user: "u", password: "hop-pw", strictHostKey: false, knownHostsFile,
  });
  const targetProfile = (via = "hop"): SshProfile => ({
    host: "127.0.0.1", port: target.port, user: "u", password: "target-pw", strictHostKey: false, knownHostsFile,
    jump: { type: "ssh", via },
  });

  it("runs a command on the target through the hop", async () => {
    const lookup = (n: string) => (n === "hop" ? hopProfile() : null);
    const r = await runCommandOnProfile("t", targetProfile(), "pwd; echo out; echo err >&2; exit 4", { lookup });
    assert.equal(r.code, 4);
    assert.match(r.stdout, /out/);
    assert.match(r.stderr, /err/);
  });

  it("reports a missing via profile", async () => {
    await assert.rejects(
      runCommandOnProfile("t", targetProfile("nope"), "true", { lookup: () => null }),
      /does not exist/,
    );
  });

  it("detects via cycles", async () => {
    const a = targetProfile("b");
    const b = targetProfile("a");
    await assert.rejects(
      runCommandOnProfile("a", a, "true", { lookup: (n) => (n === "b" ? b : a) }),
      /cycle/,
    );
  });

  it("limits the hop depth", async () => {
    const lookup = (n: string) => targetProfile(`h${Number(n.slice(1)) + 1}`);
    await assert.rejects(
      runCommandOnProfile("h0", targetProfile("h1"), "true", { lookup }),
      /Too many jump hops/,
    );
  });
});
