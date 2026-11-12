import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_OUTPUT_BUDGET,
  fitLines,
  formatExecForModel,
  outputBudget,
  saveFullOutput,
} from "../src/exec-output.ts";
import { formatExecResult } from "../src/formatting/formatters.ts";
import type { ExecResult } from "../src/types.ts";

const bytes = (s: string) => Buffer.byteLength(s, "utf-8");
const mk = (stdout: string, extra: Partial<ExecResult> = {}): ExecResult => ({
  command: "df -h",
  stdout,
  stderr: "",
  code: 0,
  durationMs: 9,
  truncated: false,
  ...extra,
});
const rows = (n: number, w = 90) => Array.from({ length: n }, (_, i) => `row-${String(i).padStart(4, "0")} ${"x".repeat(w)}`).join("\n");

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-out-")));
  env = { PI_SSH_OUTPUT_DIR: dir };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("formatExecForModel", () => {
  it("leaves a result that fits exactly as before, and writes no file", () => {
    const r = mk("hostname-1\n");
    const out = formatExecForModel(r, { env });
    assert.equal(out.text, formatExecResult(r));
    assert.equal(out.truncated, false);
    assert.equal(out.file, null);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("keeps a big result within the budget, with head, tail and an explanatory note", () => {
    const out = formatExecForModel(mk(rows(120)), { env });
    assert.ok(bytes(out.text) <= DEFAULT_OUTPUT_BUDGET, `${bytes(out.text)} > ${DEFAULT_OUTPUT_BUDGET}`);
    assert.equal(out.truncated, true);
    assert.match(out.text, /^\$ df -h\n\[exit 0, 9 ms\]/);
    assert.match(out.text, /row-0000/, "first line kept");
    assert.match(out.text, /row-0119/, "last line kept");
    assert.doesNotMatch(out.text, /row-0060/, "middle dropped");
    assert.match(out.text, /\d+ lines omitted/);
    assert.match(out.text, /\[output cut for the model: \d+ lines, \d+ of \d+ bytes omitted\./);
  });

  it("saves the whole output, 0600, and names the file in the note", () => {
    const out = formatExecForModel(mk(rows(120)), { env });
    assert.ok(out.file && out.file.startsWith(dir));
    assert.ok(out.text.includes(out.file!));
    const saved = fs.readFileSync(out.file!, "utf-8");
    assert.match(saved, /row-0000/);
    assert.match(saved, /row-0060/, "the middle is in the file");
    assert.match(saved, /row-0119/);
    if (process.platform !== "win32") assert.equal(fs.statSync(out.file!).mode & 0o777, 0o600);
  });

  it("includes stderr in what is kept and saved", () => {
    const out = formatExecForModel(mk(rows(120), { stderr: "boom: permission denied\n", code: 2 }), { env });
    assert.match(out.text, /\[exit 2,/);
    assert.match(fs.readFileSync(out.file!, "utf-8"), /stderr:\nboom: permission denied/);
  });

  it("shortens a very long command in the header so the output keeps its room", () => {
    const cmd = `echo ${"a".repeat(1500)}`;
    const out = formatExecForModel(mk(rows(120), { command: cmd }), { env });
    assert.ok(bytes(out.text) <= DEFAULT_OUTPUT_BUDGET);
    assert.ok(out.text.split("\n")[0].length < 200);
    assert.match(out.text, /row-0000/);
  });

  it("still truncates, and says so, when the file cannot be written", () => {
    const blocked = path.join(dir, "file-not-dir");
    fs.writeFileSync(blocked, "x");
    const out = formatExecForModel(mk(rows(120)), { env: { PI_SSH_OUTPUT_DIR: path.join(blocked, "sub") } });
    assert.equal(out.file, null);
    assert.ok(bytes(out.text) <= DEFAULT_OUTPUT_BUDGET);
    assert.match(out.text, /could not be saved/);
  });

  it("can skip saving", () => {
    const out = formatExecForModel(mk(rows(120)), { env, save: false });
    assert.equal(out.file, null);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("honours PI_SSH_OUTPUT_BYTES and ignores nonsense", () => {
    assert.equal(outputBudget({ PI_SSH_OUTPUT_BYTES: "8000" }), 8000);
    for (const bad of ["", "abc", "-5", "10", "1e99"]) assert.equal(outputBudget({ PI_SSH_OUTPUT_BYTES: bad }), DEFAULT_OUTPUT_BUDGET, bad);
    const out = formatExecForModel(mk(rows(120)), { env: { ...env, PI_SSH_OUTPUT_BYTES: "8000" } });
    assert.ok(bytes(out.text) <= 8000 && bytes(out.text) > DEFAULT_OUTPUT_BUDGET);
  });
});

describe("fitLines", () => {
  it("cuts on line boundaries and never splits a multi-byte character", () => {
    const body = Array.from({ length: 200 }, (_, i) => `第${i}行 金融部测试服务器 磁盘使用率正常`).join("\n");
    const f = fitLines(body, 1500);
    assert.ok(bytes(f.text) <= 1500 + bytes("… 999 lines omitted …\n"));
    assert.ok(!f.text.includes("\uFFFD"));
    for (const line of f.text.split("\n")) assert.match(line, /^(第\d+行 金融部测试服务器 磁盘使用率正常|… \d+ lines omitted …)$/);
    assert.equal(f.truncated, true);
  });

  it("cuts inside one enormous line instead of returning nothing", () => {
    const f = fitLines("é".repeat(10_000), 1000);
    assert.ok(f.truncated);
    assert.ok(bytes(f.text) <= 1000 + 8);
    assert.ok(!f.text.includes("\uFFFD"));
    assert.match(f.text, /^é+\n…\né+$/);
    assert.ok(f.omittedBytes > 18_000);
  });

  it("returns short text untouched", () => {
    assert.deepEqual(fitLines("a\nb", 100), { text: "a\nb", omittedLines: 0, omittedBytes: 0, truncated: false });
  });

  it("accounts for omitted lines exactly", () => {
    const body = rows(100, 30);
    const f = fitLines(body, 1200);
    const shown = f.text.split("\n").filter((l) => l.startsWith("row-")).length;
    assert.equal(shown + f.omittedLines, 100);
  });
});

describe("saved output housekeeping", () => {
  it("keeps only the newest files and drops old ones, but never the file just written", () => {
    const base = Date.now();
    for (let i = 0; i < 50; i++) {
      const f = saveFullOutput(`n${i}`, env, base + i * 1000);
      assert.ok(f && fs.existsSync(f), `file ${i} survives its own save`);
      fs.utimesSync(f, (base + i * 1000) / 1000, (base + i * 1000) / 1000);
    }
    assert.ok(fs.readdirSync(dir).length <= 41);
    const old = saveFullOutput("old", env, base)!;
    const past = (base - 3 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(old, past, past);
    const fresh = saveFullOutput("fresh", env, base + 60_000)!;
    assert.equal(fs.existsSync(old), false, "a file older than a day is removed");
    assert.equal(fs.readFileSync(fresh, "utf-8"), "fresh");
  });

  it("never touches files it did not create", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    for (let i = 0; i < 45; i++) saveFullOutput(`n${i}`, env, Date.now() + i);
    assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf-8"), "mine");
  });
});
