import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startMockJumpServer, type MockServer } from "./mock-jumpserver.ts";
import { closeAllJumpSessions } from "../src/jumpserver.ts";
import * as config from "../src/config.ts";
import { buildServerModePrompt } from "../src/jms-mode.ts";

const PASSWORD = "{{SECRET_4gh4lm24}}";

describe("buildServerModePrompt", () => {
  const p = buildServerModePrompt("web", {
    host: "jump.example.com",
    port: 2222,
    user: "alice",
    passwordCmd: "echo topsecret",
    jump: { type: "jumpserver", asset: "10.0.0.5" },
  } as any);

  it("names the profile, host and asset, and tells the AI to use ssh_exec with that profile", () => {
    assert.match(p, /profile "web" \(alice@jump\.example\.com:2222, JumpServer asset 10\.0\.0\.5\)/);
    assert.match(p, /ssh_exec and pass profile "web" every time/);
  });
  it("states the limits: no SFTP/tunnel, no TTY, local tools are local, denial means stop", () => {
    assert.match(p, /ssh_upload.*do not work through JumpServer/);
    assert.match(p, /No TTY|no TTY/);
    assert.match(p, /bash, read, write and edit tools act on the user's own machine/);
    assert.match(p, /If they deny it, stop/);
  });
  it("never includes credentials", () => {
    assert.doesNotMatch(p, /topsecret|passwordCmd|echo /);
  });
});

describe("/jms server mode through the extension", () => {
  let server: MockServer;
  let home: string;
  const originalHome = process.env.HOME;
  const originalAudit = process.env.PI_SSH_AUDIT_FILE;

  before(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-mode-")));
    process.env.HOME = home;
    process.env.PI_SSH_AUDIT_FILE = path.join(home, "audit.jsonl");
    server = await startMockJumpServer({ password: PASSWORD });
    config._resetForTesting();
    const base = {
      host: "127.0.0.1",
      port: server.port,
      user: "u",
      password: PASSWORD,
      autoKey: false,
      strictHostKey: false,
      knownHostsFile: path.join(home, "known_hosts"),
    };
    config.saveProfile("m", { ...base, jump: { type: "jumpserver", asset: "web1" } } as any);
    config.saveProfile("other", { ...base, jump: { type: "jumpserver", asset: "web1" } } as any);
    config.saveProfile("direct", { host: "h", port: 22, user: "u" });
  });
  after(async () => {
    closeAllJumpSessions();
    await server.close();
    process.env.HOME = originalHome;
    if (originalAudit === undefined) delete process.env.PI_SSH_AUDIT_FILE;
    else process.env.PI_SSH_AUDIT_FILE = originalAudit;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function load(entries: any[] = []) {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const commands: Record<string, any> = {};
    const appended: Array<{ type: string; data: any }> = [];
    const pi: any = {
      registerTool() {},
      registerCommand: (n: string, o: any) => (commands[n] = o),
      registerEntryRenderer() {},
      on: (e: string, fn: any) => (handlers[e] = fn),
      appendEntry: (type: string, data: any) => appended.push({ type, data }),
      sendUserMessage() {},
    };
    (await import("../index.ts")).default(pi);
    const notes: string[] = [];
    const status: Array<string | undefined> = [];
    const ctx: any = {
      mode: "tui",
      hasUI: true,
      sessionManager: { getEntries: () => entries },
      ui: {
        notify: (m: string) => notes.push(m),
        setStatus: (_k: string, v?: string) => status.push(v),
        select: async () => undefined,
        confirm: async () => false,
        setWidget() {},
      },
    };
    return { handlers, commands, appended, notes, status, ctx };
  }
  const turn = async (h: any) => (await h.handlers.before_agent_start({ systemPrompt: "BASE" }))?.systemPrompt;
  const call = (h: any, input: any, tool = "ssh_exec") => {
    const event = { toolName: tool, input };
    return h.handlers.tool_call(event).then(() => event.input);
  };

  it("adds nothing to the prompt and touches no tool call until a server is entered", async () => {
    const h = await load();
    assert.equal(await turn(h), undefined);
    assert.deepEqual(await call(h, { command: "ls" }), { command: "ls" });
  });

  it("entering tells the AI which server it is on, every turn, and points ssh_exec at it", async () => {
    const h = await load();
    await h.commands.jms.handler("m", h.ctx);
    assert.match(h.notes.at(-1)!, /Entered m .*Nothing was run/);
    assert.deepEqual(h.status.at(-1), "jms:m");
    assert.deepEqual(h.appended.at(-1), { type: "jms-mode", data: { profile: "m" } });

    const prompt = await turn(h);
    assert.ok(prompt.startsWith("BASE\n\n## Remote server mode"));
    assert.match(prompt, /profile "m"/);
    assert.equal(await turn(h) !== undefined, true, "still there on the next turn");

    // forgotten profile -> the entered server, not the global active profile
    assert.deepEqual(await call(h, { command: "ls" }), { command: "ls", profile: "m" });
    // an explicit profile is respected; other tools are untouched
    assert.deepEqual(await call(h, { command: "ls", profile: "other" }), { command: "ls", profile: "other" });
    assert.deepEqual(await call(h, { path: "/" }, "ssh_list"), { path: "/" });
  });

  it("exit removes the prompt and the fallback", async () => {
    const h = await load();
    await h.commands.jms.handler("m", h.ctx);
    await h.commands.jms.handler("exit", h.ctx);
    assert.equal(await turn(h), undefined);
    assert.deepEqual(await call(h, { command: "ls" }), { command: "ls" });
    assert.deepEqual(h.status.at(-1), undefined);
    assert.deepEqual(h.appended.at(-1), { type: "jms-mode", data: { profile: null } });
  });

  it("switching servers re-points the AI", async () => {
    const h = await load();
    await h.commands.jms.handler("m", h.ctx);
    await h.commands.jms.handler("other", h.ctx);
    assert.match(await turn(h), /profile "other"/);
    assert.deepEqual(await call(h, { command: "ls" }), { command: "ls", profile: "other" });
  });

  it("a failed login does not enter the server", async () => {
    const h = await load();
    config.saveProfile("bad", { ...config.getProfile("m")!, password: "wrong", jump: { type: "jumpserver", asset: "web1" } } as any);
    await h.commands.jms.handler("bad", h.ctx);
    assert.match(h.notes.at(-1)!, /Could not enter bad/);
    assert.equal(await turn(h), undefined);
    assert.doesNotMatch(h.notes.join("\n"), /wrong/);
    config.deleteProfile("bad");
  });

  it("the mode survives /reload: it is restored from the session entries", async () => {
    const entries = [
      { type: "custom", customType: "jms-mode", data: { profile: "other" } },
      { type: "custom", customType: "jms-mode", data: { profile: "m" } },
    ];
    const h = await load(entries);
    await h.handlers.session_start({}, h.ctx);
    assert.match(await turn(h), /profile "m"/, "the last entry wins");
    assert.deepEqual(h.status.at(-1), "jms:m");
  });

  it("a restored mode is dropped if the profile is gone or no longer a JumpServer host", async () => {
    for (const name of ["vanished", "direct"]) {
      const h = await load([{ type: "custom", customType: "jms-mode", data: { profile: name } }]);
      await h.handlers.session_start({}, h.ctx);
      assert.equal(await turn(h), undefined, name);
    }
    const left = await load([
      { type: "custom", customType: "jms-mode", data: { profile: "m" } },
      { type: "custom", customType: "jms-mode", data: { profile: null } },
    ]);
    await left.handlers.session_start({}, left.ctx);
    assert.equal(await turn(left), undefined, "an exit entry ends the mode");
  });

  it("a session without readable entries starts with no mode instead of crashing", async () => {
    const h = await load();
    await h.handlers.session_start({}, { ui: h.ctx.ui });
    assert.equal(await turn(h), undefined);
  });
});
