/**
 * Plain-text rendering of a /jms result for the pi transcript.
 *
 * Pure and dependency-free (no pi-tui import) so it runs in tests. pi throws if
 * a rendered line is wider than the terminal, so lines are wrapped by display
 * width, counting CJK/fullwidth characters as two columns.
 */

export interface JmsResultData {
  readonly profile: string;
  readonly command: string;
  readonly output: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated?: boolean;
  /** Set instead of output when the command did not run (denied, login failed...). */
  readonly error?: string;
}

/** Lines shown before the result is folded; the rest opens with the expand key. */
export const COLLAPSED_LINES = 40;

// WHY: ranges are the East Asian Wide/Fullwidth blocks that matter in practice.
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

export function charWidth(ch: string): number {
  return WIDE.test(ch) ? 2 : 1;
}

/** Remove escape sequences and control characters that would corrupt the TUI. */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function wrapLine(line: string, width: number): string[] {
  const w = Math.max(width, 4);
  const out: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of line) {
    const cw = charWidth(ch);
    if (curW + cw > w) {
      out.push(cur);
      cur = "";
      curW = 0;
    }
    cur += ch;
    curW += cw;
  }
  out.push(cur);
  return out;
}

export function renderJmsResult(
  data: JmsResultData,
  width: number,
  expanded: boolean,
  style: { dim(s: string): string; ok(s: string): string; bad(s: string): string; accent(s: string): string } = {
    dim: (s) => s,
    ok: (s) => s,
    bad: (s) => s,
    accent: (s) => s,
  },
  expandHint = "expand",
): string[] {
  const lines: string[] = [];
  // Every line goes through here so none can exceed the terminal width.
  const add = (text: string, paint: (s: string) => string = (x) => x) => {
    for (const l of wrapLine(text, width)) lines.push(paint(l));
  };
  const cmd = sanitize(data.command).replace(/\n/g, " ⏎ ");
  add(`jms:${data.profile} $ ${cmd}`, style.accent);

  if (data.error) {
    for (const l of sanitize(data.error).split("\n")) add(l, style.bad);
    return lines;
  }

  const body = sanitize(data.output).replace(/\n+$/, "");
  const all = body.length ? body.split("\n").flatMap((l) => wrapLine(l, width)) : [];
  const folded = !expanded && all.length > COLLAPSED_LINES;
  lines.push(...(folded ? all.slice(0, COLLAPSED_LINES) : all));
  if (all.length === 0) add("(no output)", style.dim);
  if (folded) add(`… ${all.length - COLLAPSED_LINES} more lines (${expandHint})`, style.dim);

  const code = data.exitCode === null ? "no exit code" : `exit ${data.exitCode}`;
  const status = `${code} · ${data.durationMs} ms${data.truncated ? " · output truncated" : ""}`;
  add(status, data.exitCode === 0 ? style.ok : style.bad);
  return lines;
}
