import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COLLAPSED_LINES, charWidth, renderJmsResult, sanitize, wrapLine } from "../src/jms-render.ts";

const width = (s: string) => [...s].reduce((n, ch) => n + charWidth(ch), 0);
const base = { profile: "p", command: "ls -al", exitCode: 0, durationMs: 9 };

describe("jms render", () => {
  it("never produces a line wider than the terminal, including CJK", () => {
    const out = "总用量 202168\n" + "金融部测试服务器".repeat(20) + "\n" + "x".repeat(300);
    for (const w of [10, 24, 80]) {
      for (const l of renderJmsResult({ ...base, output: out }, w, true)) {
        assert.ok(width(l) <= w, `width ${width(l)} > ${w}: ${l}`);
      }
    }
  });

  it("keeps all text when wrapping", () => {
    const line = "abc中文def".repeat(7);
    assert.equal(wrapLine(line, 9).join(""), line);
  });

  it("strips escape sequences, carriage returns and control characters", () => {
    assert.equal(sanitize("\x1b[1;32mgreen\x1b[0m\r\nok\x07\ttab"), "green\nok    tab");
  });

  it("shows header, output and exit status", () => {
    const lines = renderJmsResult({ ...base, output: "a\nb\n" }, 80, false);
    assert.deepEqual(lines, ["jms:p $ ls -al", "a", "b", "exit 0 · 9 ms"]);
  });

  it("folds long output until expanded, and says how many lines are hidden", () => {
    const output = Array.from({ length: COLLAPSED_LINES + 25 }, (_, i) => `row ${i}`).join("\n");
    const folded = renderJmsResult({ ...base, output }, 80, false);
    assert.equal(folded.filter((l) => l.startsWith("row ")).length, COLLAPSED_LINES);
    assert.ok(folded.some((l) => l.includes("25 more lines")));
    const full = renderJmsResult({ ...base, output }, 80, true);
    assert.equal(full.filter((l) => l.startsWith("row ")).length, COLLAPSED_LINES + 25);
    assert.ok(!full.some((l) => l.includes("more lines")));
  });

  it("reports empty output, non-zero exit and truncation", () => {
    assert.ok(renderJmsResult({ ...base, output: "" }, 80, false).includes("(no output)"));
    const bad = renderJmsResult({ ...base, output: "x", exitCode: 2, truncated: true }, 80, false);
    assert.equal(bad.at(-1), "exit 2 · 9 ms · output truncated");
  });

  it("renders an error instead of output", () => {
    const lines = renderJmsResult({ ...base, output: "", exitCode: null, durationMs: 0, error: "ssh_exec was denied by the user." }, 80, false);
    assert.deepEqual(lines, ["jms:p $ ls -al", "ssh_exec was denied by the user."]);
  });

  it("flattens a multi-line command onto one header line", () => {
    const [head] = renderJmsResult({ ...base, command: "a\nb", output: "" }, 80, false);
    assert.equal(head, "jms:p $ a ⏎ b");
  });
});
