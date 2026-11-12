import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJmsHandler, parseJmsArgs } from "../src/jms-command.ts";
import type { SshProfile } from "../src/types.ts";

const NAMES = ["s", "s-fin-test"];

describe("parseJmsArgs", () => {
  const cases: Array<[string, string | null, unknown]> = [
    ["", null, { kind: "list" }],
    ["  list ", null, { kind: "list" }],
    ["use s", null, { kind: "use", profile: "s" }],
    ["close", null, { kind: "close" }],
    ["close s-fin-test", null, { kind: "close", profile: "s-fin-test" }],
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
    assert.equal(parseJmsArgs("s", NAMES, null).kind, "error");
  });

  it("uses the only JumpServer profile as an implicit default", () => {
    assert.deepEqual(parseJmsArgs("hostname", ["only"], null), { kind: "run", profile: "only", command: "hostname" });
  });

  it("does not guess when several profiles exist and no default is set", () => {
    assert.equal(parseJmsArgs("hostname", NAMES, null).kind, "error");
  });
});

function setup(profiles: Record<string, SshProfile>) {
  const sent: string[] = [];
  const notes: string[] = [];
  const open = new Set<string>(["s"]);
  const handler = createJmsHandler({
    profiles: () => profiles,
    hasSession: (n) => open.has(n),
    closeSession: (n) => open.delete(n),
    closeAll: () => open.clear(),
    send: (m) => sent.push(m),
    notify: (m) => notes.push(m),
  });
  return { handler, sent, notes, open };
}

const jms = (asset?: string): SshProfile => ({
  host: "jump.example.com",
  port: 2222,
  user: "u",
  jump: { type: "jumpserver", asset, account: "1" },
});
const direct: SshProfile = { host: "h", port: 22, user: "u" };

describe("/jms handler", () => {
  it("lists only JumpServer profiles with asset and session state, never secrets", () => {
    const { handler, notes } = setup({ s: { ...jms(), passwordCmd: "echo topsecret" }, "s-fin-test": jms("1.2.3.4"), direct });
    handler("");
    const out = notes[0];
    assert.match(out, /s {2}u@jump\.example\.com:2222 {2}asset=\(unset\)/);
    assert.match(out, /s-fin-test.*asset=1\.2\.3\.4.*no session/);
    assert.doesNotMatch(out, /direct|topsecret|echo/);
    assert.match(out, /\[session open\]/);
  });

  it("asks the model to run the command verbatim, without running anything itself", () => {
    const { handler, sent } = setup({ s: jms("a"), "s-fin-test": jms("b") });
    handler("s-fin-test hostname; id");
    assert.equal(sent.length, 1);
    assert.match(sent[0], /profile "s-fin-test"/);
    assert.match(sent[0], /Do not change it/);
    assert.match(sent[0], /stop/);
    assert.ok(sent[0].endsWith("hostname; id"));
  });

  it("only an explicit /jms use sets the default; a run never does", () => {
    const { handler, sent, notes } = setup({ s: jms("a"), "s-fin-test": jms("b") });
    handler("s-fin-test hostname");
    handler("uptime"); // no default yet: must NOT silently reuse s-fin-test
    assert.equal(sent.length, 1);
    assert.match(notes.at(-1)!, /No default profile/);
    handler("use s-fin-test");
    handler("uptime");
    assert.match(sent[1], /profile "s-fin-test"/);
  });

  it("a mistyped profile is never run as a command on the sole profile's neighbour", () => {
    const { handler, sent, notes } = setup({ s: jms("a"), "s-fin-test": jms("b") });
    handler("s-fn-test rm -rf /tmp/x");
    assert.equal(sent.length, 0);
    assert.match(notes[0], /No default profile/);
  });

  it("names a non-JumpServer profile instead of running it", () => {
    const { handler, sent, notes } = setup({ direct, s: jms("a") });
    handler("direct hostname");
    assert.equal(sent.length, 0);
    assert.match(notes[0], /not a JumpServer profile/);
  });

  it("closes one or all sessions", () => {
    const { handler, open, notes } = setup({ s: jms("a"), "s-fin-test": jms("b") });
    handler("close s");
    assert.equal(open.has("s"), false);
    assert.match(notes.at(-1)!, /Closed session s/);
    handler("close s-fin-test");
    assert.match(notes.at(-1)!, /no open session/);
    open.add("s");
    handler("close");
    assert.equal(open.size, 0);
  });

  it("explains when nothing is configured", () => {
    const { handler, notes } = setup({ direct });
    handler("list");
    assert.match(notes[0], /No JumpServer profile configured/);
  });
});
