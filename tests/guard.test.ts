import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-guard-"));
const originalHome = process.env.HOME;
process.env.HOME = home;
process.env.PI_SSH_AUDIT_FILE = path.join(home, "audit.jsonl");
fs.mkdirSync(path.join(home, ".pi"), { recursive: true });

const { guard, _resetGuardForTesting } = await import("../src/guard.ts");
const { SshExecTool } = await import("../src/tools/ssh-exec.ts");
const { SshProfileTool } = await import("../src/tools/ssh-profile.ts");
const { SshTunnelTool } = await import("../src/tools/ssh-tunnel.ts");
const config = await import("../src/config.ts");

const signal = new AbortController().signal;
const auditFile = process.env.PI_SSH_AUDIT_FILE!;
const lines = () =>
  fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

function fakeCtx(answer: "allow" | "session" | "deny") {
  const calls: string[] = [];
  return {
    calls,
    hasUI: true,
    ui: {
      confirm: async (_t: string, m: string) => (calls.push(m), answer !== "deny"),
      select: async (_t: string, o: string[]) => {
        calls.push(o.join("|"));
        return answer === "allow" ? o[0] : answer === "session" ? o[1] : o[o.length - 1];
      },
    },
  };
}

before(() => {
  // Port 1 is closed: reaching the network would surface as a connection error.
  config.saveProfile("p", { host: "127.0.0.1", port: 1, user: "u", password: "SUPERSECRET", autoKey: false });
});
after(() => {
  process.env.HOME = originalHome;
  delete process.env.PI_SSH_AUDIT_FILE;
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  _resetGuardForTesting();
  fs.rmSync(auditFile, { force: true });
});

const req = { tool: "t", profile: "p", target: "x", verdict: "confirm" as const, message: "m" };

describe("guard", () => {
  it("denies with no UI and audits it", async () => {
    await assert.rejects(() => guard(undefined, req), /no interactive UI/);
    await assert.rejects(() => guard({ hasUI: false }, req), /no interactive UI/);
    assert.equal(lines()[0].decision, "no-ui-deny");
  });

  it("auto verdict needs no UI", async () => {
    const r = await guard(undefined, { ...req, verdict: "auto" });
    assert.equal(r.decision, "auto");
  });

  it("policy deny throws without prompting", async () => {
    const ctx = fakeCtx("allow");
    await assert.rejects(() => guard(ctx, { ...req, verdict: "deny" }), /refused by policy/);
    assert.equal(ctx.calls.length, 0);
    assert.equal(lines()[0].decision, "policy-deny");
  });

  it("a deny choice throws", async () => {
    await assert.rejects(() => guard(fakeCtx("deny"), req), /denied by the user/);
    assert.equal(lines()[0].decision, "human-deny");
  });

  it("session allow prompts once per key", async () => {
    const ctx = fakeCtx("session");
    const r = { ...req, sessionKey: "k" };
    assert.equal((await guard(ctx, r)).decision, "human-allow-session");
    assert.equal((await guard(ctx, r)).decision, "human-allow-session");
    assert.equal(ctx.calls.length, 1);
    await guard(ctx, { ...r, sessionKey: "other" });
    assert.equal(ctx.calls.length, 2);
  });
});

describe("tools use the guard", () => {
  it("ssh_exec: readonly command skips the prompt (reaches the network)", async () => {
    const ctx = fakeCtx("deny");
    await assert.rejects(() => SshExecTool.execute("1", { command: "ls -la", profile: "p" }, signal, undefined, ctx), (e: Error) => !/denied by the user|human confirmation/.test(e.message));
    assert.equal(ctx.calls.length, 0);
    assert.equal(lines()[0].decision, "auto");
  });

  it("ssh_exec: denied command never reaches the network", async () => {
    await assert.rejects(
      () => SshExecTool.execute("1", { command: "rm x", profile: "p" }, signal, undefined, fakeCtx("deny")),
      /denied by the user/,
    );
    await assert.rejects(
      () => SshExecTool.execute("1", { command: "rm x", profile: "p" }, signal),
      /no interactive UI/,
    );
  });

  it("ssh_exec: hard-deny commands are refused even if the human would allow", async () => {
    const ctx = fakeCtx("allow");
    await assert.rejects(() => SshExecTool.execute("1", { command: "rm -rf /", profile: "p" }, signal, undefined, ctx), /refused by policy/);
    assert.equal(ctx.calls.length, 0);
  });

  it("ssh_exec: readonly mode rejects confirm-class commands without prompting", async () => {
    config.updateProfile("p", { policy: { mode: "readonly" } });
    const ctx = fakeCtx("allow");
    await assert.rejects(() => SshExecTool.execute("1", { command: "touch x", profile: "p" }, signal, undefined, ctx), /refused by policy/);
    assert.equal(ctx.calls.length, 0);
    config.updateProfile("p", { policy: { mode: "confirm-all" } });
    await assert.rejects(() => SshExecTool.execute("1", { command: "ls", profile: "p" }, signal, undefined, fakeCtx("deny")), /denied by the user/);
    config.updateProfile("p", { policy: undefined });
  });

  it("ssh_exec: allow-session reuses the approval for the same command", async () => {
    const ctx = fakeCtx("session");
    const run = () => SshExecTool.execute("1", { command: "touch x", profile: "p" }, signal, undefined, ctx);
    await assert.rejects(run, (e: Error) => !/denied|confirmation/.test(e.message));
    await assert.rejects(run, (e: Error) => !/denied|confirmation/.test(e.message));
    assert.equal(ctx.calls.length, 1);
  });

  it("ssh_profile delete and ssh_tunnel start need approval; tunnel list does not", async () => {
    await assert.rejects(() => SshProfileTool.execute("1", { action: "delete", name: "p" }, signal), /no interactive UI/);
    assert.ok(config.getProfile("p"));
    await assert.rejects(
      () => SshTunnelTool.execute("1", { action: "start", name: "t", destHost: "h", destPort: 1, listenPort: 0, bind: "0.0.0.0", profile: "p" }, signal, undefined, fakeCtx("deny")),
      /denied by the user/,
    );
    const ctx = fakeCtx("deny");
    await SshTunnelTool.execute("1", { action: "list" }, signal, undefined, ctx);
    assert.equal(ctx.calls.length, 0);
  });

  it("the tunnel prompt warns about a non-loopback bind", async () => {
    const ctx = fakeCtx("deny");
    await assert.rejects(() =>
      SshTunnelTool.execute("1", { action: "start", name: "t", destHost: "h", destPort: 1, listenPort: 5, bind: "0.0.0.0", profile: "p" }, signal, undefined, ctx),
    );
    assert.equal(ctx.calls.length, 1);
  });
});

describe("audit", () => {
  it("is 0600, one JSON per line, and never holds secrets", async () => {
    await guard(fakeCtx("allow"), req);
    await assert.rejects(() => SshExecTool.execute("1", { command: "touch x", profile: "p" }, signal, undefined, fakeCtx("deny")));
    const text = fs.readFileSync(auditFile, "utf-8");
    assert.ok(!text.includes("SUPERSECRET"));
    assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600);
    const l = lines();
    assert.equal(l[0].decision, "human-allow");
    assert.match(l[0].ts, /^\d{4}-/);
    assert.ok(l[0].id);
  });

  it("swallows write failures", async () => {
    process.env.PI_SSH_AUDIT_FILE = path.join(auditFile, "nope", "x");
    fs.writeFileSync(auditFile, "");
    await guard(undefined, { ...req, verdict: "auto" });
    process.env.PI_SSH_AUDIT_FILE = auditFile;
  });
});

describe("config", () => {
  it("preserves a top-level policy and per-profile policy across writes", () => {
    const cfg = path.join(home, ".pi", "ssh-config.json");
    const raw = JSON.parse(fs.readFileSync(cfg, "utf-8"));
    fs.writeFileSync(cfg, JSON.stringify({ ...raw, policy: { mode: "confirm-all" } }));
    config.loadConfig();
    config.saveProfile("q", { host: "h", port: 22, user: "u", policy: { deny: ["x"] } });
    const after = JSON.parse(fs.readFileSync(cfg, "utf-8"));
    assert.deepEqual(after.policy, { mode: "confirm-all" });
    assert.deepEqual(after.profiles.q.policy, { deny: ["x"] });
    assert.deepEqual(config.getGlobalPolicy(), { mode: "confirm-all" });
  });
});
