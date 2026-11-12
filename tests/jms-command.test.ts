import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJmsHandler, parseJmsArgs, type JmsOutcome } from "../src/jms-command.ts";
import type { JmsResultData } from "../src/jms-render.ts";
import type { SshProfile } from "../src/types.ts";

const NAMES = ["s", "s-fin-test"];

describe("parseJmsArgs", () => {
  const cases: Array<[string, string | null, unknown]> = [
    ["", null, { kind: "list" }],
    ["  list ", null, { kind: "list" }],
    ["use s", null, { kind: "use", profile: "s" }],
    ["close", null, { kind: "close" }],
    ["share", null, { kind: "share" }],
    ["close s-fin-test", null, { kind: "close", profile: "s-fin-test" }],
    ["s-fin-test", null, { kind: "enter", profile: "s-fin-test" }],
    ["  s  ", null, { kind: "enter", profile: "s" }],
    ["s-fin-test hostname", null, { kind: "run", profile: "s-fin-test", command: "hostname" }],
    ["s-fin-test  ls -la /etc | head", null, { kind: "run", profile: "s-fin-test", command: "ls -la /etc | head" }],
    ["hostname", "s", { kind: "run", profile: "s", command: "hostname" }],
    ["id; uptime", "s-fin-test", { kind: "run", profile: "s-fin-test", command: "id; uptime" }],
    // a default that no longer exists is ignored
    ["hostname", "gone", { kind: "error" }],
  ];
  for (const [input, def, want] of cases) {
    it(`parses ${JSON.stringify(input)} (default ${def})`, () => {
      const got = parseJmsArgs(input, NAMES, def) as Record<string, unknown>;
      for (const [k, v] of Object.entries(want as Record<string, unknown>)) assert.equal(got[k], v);
    });
  }

  it("rejects unknown profiles for use/close and missing commands", () => {
    assert.equal(parseJmsArgs("use nope", NAMES, null).kind, "error");
    assert.equal(parseJmsArgs("use", NAMES, null).kind, "error");
    assert.equal(parseJmsArgs("close nope", NAMES, null).kind, "error");
  });

  it("uses the only JumpServer profile as an implicit default", () => {
    assert.deepEqual(parseJmsArgs("hostname", ["only"], null), { kind: "run", profile: "only", command: "hostname" });
  });

  it("does not guess when several profiles exist and no default is set", () => {
    assert.equal(parseJmsArgs("hostname", NAMES, null).kind, "error");
  });
});

function setup(profiles: Record<string, SshProfile>, run?: (p: string, c: string) => Promise<JmsOutcome>) {
  const shown: JmsResultData[] = [];
  const shared: string[] = [];
  const notes: string[] = [];
  const ran: string[] = [];
  const open = new Set<string>(["s"]);
  const connected: string[] = [];
  let connectError: Error | null = null;
  const handler = createJmsHandler({
    profiles: () => profiles,
    hasSession: (n) => open.has(n),
    closeSession: (n) => open.delete(n),
    closeAll: () => open.clear(),
    connect: async (p) => {
      if (connectError) throw connectError;
      connected.push(p);
      return { reused: connected.filter((x) => x === p).length > 1 };
    },
    run: async (p, c) => {
      ran.push(`${p}:${c}`);
      return run ? run(p, c) : { output: "out\n", exitCode: 0, durationMs: 7 };
    },
    show: (e) => shown.push(e),
    share: (t) => shared.push(t),
    notify: (m) => notes.push(m),
  });
  return { handler, shown, shared, notes, ran, open, connected, failConnect: (e: Error) => (connectError = e) };
}

const jms = (asset?: string): SshProfile => ({
  host: "jump.example.com",
  port: 2222,
  user: "u",
  jump: { type: "jumpserver", asset, account: "1" },
});
const direct: SshProfile = { host: "h", port: 22, user: "u" };

describe("/jms handler", () => {
  it("lists only JumpServer profiles with asset and session state, never secrets", async () => {
    const { handler, notes } = setup({ s: { ...jms(), passwordCmd: "echo topsecret" }, "s-fin-test": jms("1.2.3.4"), direct });
    await handler("");
    const out = notes[0];
    assert.match(out, /s {2}u@jump\.example\.com:2222 {2}asset=\(unset\)/);
    assert.match(out, /s-fin-test.*asset=1\.2\.3\.4.*no session/);
    assert.doesNotMatch(out, /direct|topsecret|echo/);
    assert.match(out, /\[session open\]/);
  });

  it("runs the command itself and shows the raw result without involving the model", async () => {
    const { handler, shown, shared, ran } = setup({ s: jms("a"), "s-fin-test": jms("b") }, async () => ({
      output: "line1\nline2\n",
      exitCode: 2,
      durationMs: 12,
    }));
    await handler("s-fin-test ls -al /etc");
    assert.deepEqual(ran, ["s-fin-test:ls -al /etc"]);
    assert.equal(shared.length, 0);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].profile, "s-fin-test");
    assert.equal(shown[0].command, "ls -al /etc");
    assert.equal(shown[0].output, "line1\nline2\n");
    assert.equal(shown[0].exitCode, 2);
    assert.equal(shown[0].error, undefined);
  });

  it("shows a denial or failure as an error entry, without model-directed wording", async () => {
    const { handler, shown } = setup({ s: jms("a"), t: jms("b") }, async () => {
      throw new Error("ssh_exec was denied by the user. Stop; do not retry or try to get around it.");
    });
    await handler("s touch /tmp/x");
    assert.equal(shown.length, 1);
    assert.equal(shown[0].exitCode, null);
    assert.match(shown[0].error!, /denied by the user/);
    assert.doesNotMatch(shown[0].error!, /do not retry|get around/i);
  });

  it("only an explicit /jms use sets the default; a run never does", async () => {
    const { handler, ran, notes } = setup({ s: jms("a"), "s-fin-test": jms("b") });
    await handler("s-fin-test hostname");
    await handler("uptime"); // no default yet: must NOT silently reuse s-fin-test
    assert.deepEqual(ran, ["s-fin-test:hostname"]);
    assert.match(notes.at(-1)!, /No default profile/);
    await handler("use s-fin-test");
    await handler("uptime");
    assert.deepEqual(ran, ["s-fin-test:hostname", "s-fin-test:uptime"]);
  });

  it("a mistyped profile is never run as a command", async () => {
    const { handler, ran, notes } = setup({ s: jms("a"), "s-fin-test": jms("b") });
    await handler("s-fn-test rm -rf /tmp/x");
    assert.equal(ran.length, 0);
    assert.match(notes[0], /No default profile/);
  });

  it("names a non-JumpServer profile instead of running it", async () => {
    const { handler, ran, notes } = setup({ direct, s: jms("a") });
    await handler("direct hostname");
    assert.equal(ran.length, 0);
    assert.match(notes[0], /not a JumpServer profile/);
  });

  it("a bare profile name enters the server: logs in, runs nothing, becomes the default", async () => {
    const { handler, connected, ran, shown, notes } = setup({ s: jms("a"), "s-fin-test": jms("1.2.3.4") });
    await handler("s-fin-test");
    assert.deepEqual(connected, ["s-fin-test"]);
    assert.equal(ran.length, 0);
    assert.equal(shown.length, 0);
    assert.match(notes.at(-1)!, /Connected to s-fin-test .*asset=1\.2\.3\.4\)\. No command was run/);
    await handler("uptime"); // default now set by entering
    assert.deepEqual(ran, ["s-fin-test:uptime"]);
  });

  it("entering twice reports the session as reused", async () => {
    const { handler, notes } = setup({ s: jms("a") });
    await handler("s");
    await handler("s");
    assert.match(notes.at(-1)!, /Already connected to s/);
  });

  it("a failed login is reported and does not become the default", async () => {
    const { handler, failConnect, ran, notes } = setup({ s: jms("a"), t: jms("b") });
    failConnect(new Error("JumpServer login timed out at step 2/4"));
    await handler("t");
    assert.match(notes.at(-1)!, /Could not connect to t: JumpServer login timed out/);
    await handler("hostname");
    assert.equal(ran.length, 0);
    assert.match(notes.at(-1)!, /No default profile/);
  });

  it("entering a non-JumpServer profile is refused", async () => {
    const { handler, connected, notes } = setup({ direct, s: jms("a") });
    await handler("direct");
    assert.equal(connected.length, 0);
    assert.match(notes[0], /not a JumpServer profile/);
  });

  it("share sends the last result to the model, and only then", async () => {
    const { handler, shared, notes } = setup({ s: jms("a") });
    await handler("share");
    assert.equal(shared.length, 0);
    assert.match(notes[0], /Nothing to share/);
    await handler("hostname");
    assert.equal(shared.length, 0);
    await handler("share");
    assert.equal(shared.length, 1);
    assert.match(shared[0], /`hostname` on s \(exit 0\)/);
    assert.match(shared[0], /out/);
  });

  it("refuses a second command while one is waiting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { handler, ran, notes } = setup({ s: jms("a") }, async () => {
      await gate;
      return { output: "", exitCode: 0, durationMs: 1 };
    });
    const first = handler("hostname");
    await handler("uptime");
    assert.match(notes.at(-1)!, /still running/);
    release();
    await first;
    assert.equal(ran.length, 1);
  });

  it("closes one or all sessions", async () => {
    const { handler, open, notes } = setup({ s: jms("a"), "s-fin-test": jms("b") });
    await handler("close s");
    assert.equal(open.has("s"), false);
    assert.match(notes.at(-1)!, /Closed session s/);
    await handler("close s-fin-test");
    assert.match(notes.at(-1)!, /no open session/);
    open.add("s");
    await handler("close");
    assert.equal(open.size, 0);
  });

  it("explains when nothing is configured", async () => {
    const { handler, notes } = setup({ direct });
    await handler("list");
    assert.match(notes[0], /No JumpServer profile configured/);
  });
});
