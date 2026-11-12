/**
 * Fit an ssh_exec result into what the model can actually use.
 *
 * WHY: context-mode replaces any tool result over 4096 bytes with a ~96 byte
 * preview, so a plain `df -h` or `ls -al` reached the model as one line. Cutting
 * the output ourselves keeps the useful head and tail, says what was left out,
 * and keeps the whole thing in a local file the model can read in ranges
 * (range reads are not replaced).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecResult } from "./types.ts";
import { formatExecResult } from "./formatting/formatters.ts";

export const DEFAULT_OUTPUT_BUDGET = 3800;
const MAX_COMMAND_IN_HEADER = 160;
const KEEP_FILES = 40;
const KEEP_MS = 24 * 60 * 60 * 1000;

const bytes = (s: string) => Buffer.byteLength(s, "utf-8");

export function outputBudget(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PI_SSH_OUTPUT_BYTES);
  return Number.isSafeInteger(n) && n >= 512 ? n : DEFAULT_OUTPUT_BUDGET;
}

export function outputDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_SSH_OUTPUT_DIR) return env.PI_SSH_OUTPUT_DIR;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".pi", "ssh-output");
}

/** Largest prefix of `text` that fits `limit` bytes without splitting a character. */
function takeHead(text: string, limit: number): string {
  if (limit <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = bytes(ch);
    if (used + b > limit) break;
    out += ch;
    used += b;
  }
  return out;
}

function takeTail(text: string, limit: number): string {
  if (limit <= 0) return "";
  const chars = [...text];
  let used = 0;
  let i = chars.length;
  while (i > 0) {
    const b = bytes(chars[i - 1]);
    if (used + b > limit) break;
    used += b;
    i -= 1;
  }
  return chars.slice(i).join("");
}

export interface Fitted {
  readonly text: string;
  readonly omittedLines: number;
  readonly omittedBytes: number;
  readonly truncated: boolean;
}

/**
 * Keep whole lines from the start and the end, about 60/40, within `limit`
 * bytes. A single line longer than its share is cut mid-line instead.
 */
export function fitLines(body: string, limit: number): Fitted {
  if (bytes(body) <= limit) return { text: body, omittedLines: 0, omittedBytes: 0, truncated: false };

  const lines = body.split("\n");
  const headLimit = Math.floor(limit * 0.6);
  const tailLimit = limit - headLimit;

  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    const b = bytes(line) + 1;
    if (used + b > headLimit) break;
    head.push(line);
    used += b;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const b = bytes(lines[i]) + 1;
    if (used + b > tailLimit) break;
    tail.unshift(lines[i]);
    used += b;
  }

  // A line too long to fit either side: cut it rather than return nothing.
  if (head.length === 0 && tail.length === 0) {
    const h = takeHead(body, headLimit);
    const t = takeTail(body, tailLimit);
    const omittedBytes = bytes(body) - bytes(h) - bytes(t);
    return { text: `${h}\n…\n${t}`, omittedLines: 0, omittedBytes, truncated: true };
  }

  const omittedLines = lines.length - head.length - tail.length;
  const kept = [...head, ...tail].join("\n");
  return { text: [...head, `… ${omittedLines} lines omitted …`, ...tail].join("\n"), omittedLines, omittedBytes: bytes(body) - bytes(kept), truncated: true };
}

function pruneOutputs(dir: string, now: number, keepFile: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("exec-") && f.endsWith(".txt"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    // WHY: the file just written is never a candidate; with equal mtimes it
    // could otherwise sort last and be deleted before the caller reads it.
    files.forEach(({ f, t }, i) => {
      const full = path.join(dir, f);
      if (full === keepFile) return;
      if (i >= KEEP_FILES || now - t > KEEP_MS) fs.rmSync(full, { force: true });
    });
  } catch {
    /* pruning is best effort */
  }
}

/** Save the full output (0600) for later range reads. Returns the path, or null on failure. */
export function saveFullOutput(text: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | null {
  try {
    const dir = outputDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const file = path.join(dir, `exec-${stamp}-${randomBytes(4).toString("hex")}.txt`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    pruneOutputs(dir, now, file);
    return file;
  } catch {
    return null;
  }
}

export interface ModelOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly file: string | null;
  readonly omittedBytes: number;
}

/** What ssh_exec returns to the model: the usual format when it fits, else head + tail + a note. */
export function formatExecForModel(
  result: ExecResult,
  options: { budget?: number; env?: NodeJS.ProcessEnv; save?: boolean } = {},
): ModelOutput {
  const budget = options.budget ?? outputBudget(options.env);
  const full = formatExecResult(result);
  if (bytes(full) <= budget) return { text: full, truncated: false, file: null, omittedBytes: 0 };

  const status =
    result.code === 0 ? "exit 0" : result.signal ? `killed by ${result.signal}` : `exit ${result.code}`;
  const command =
    result.command.length > MAX_COMMAND_IN_HEADER
      ? `${result.command.slice(0, MAX_COMMAND_IN_HEADER)}…`
      : result.command;
  const header = `$ ${command}\n[${status}, ${result.durationMs} ms]\n\n`;

  const body = [
    result.stdout.replace(/\s+$/, ""),
    result.stderr.trim() ? `stderr:\n${result.stderr.replace(/\s+$/, "")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const file = options.save === false ? null : saveFullOutput(`${full}\n`, options.env);
  const noteFor = (f: Fitted) =>
    `\n\n[output cut for the model: ${f.omittedLines > 0 ? `${f.omittedLines} lines, ` : ""}${f.omittedBytes} of ${bytes(body)} bytes omitted. ` +
    (file
      ? `Full output: ${file} (read it with offset/limit). `
      : "The full output could not be saved. ") +
    `Or re-run with grep, head, tail or awk to narrow it.]`;

  // The note's size depends on the numbers in it; size the body against a worst-case note.
  const reserve = bytes(noteFor({ text: "", omittedLines: 99999, omittedBytes: 9999999, truncated: true }));
  const fitted = fitLines(body, Math.max(budget - bytes(header) - reserve, 256));
  return {
    text: `${header}${fitted.text}${noteFor(fitted)}`,
    truncated: true,
    file,
    omittedBytes: fitted.omittedBytes,
  };
}
