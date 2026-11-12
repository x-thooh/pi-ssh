/**
 * Command classification for the confirmation layer. Pure: no I/O.
 *
 * The rule is "when unsure, confirm". A command is read-only only if it
 * parses cleanly, contains nothing that can smuggle in a second command or a
 * write, and every pipeline/list segment starts with an allowlisted program
 * used in an allowlisted way.
 */

export type Verdict = "readonly" | "confirm" | "deny";
export interface Classification {
  readonly verdict: Verdict;
  readonly reason: string;
}

export type PolicyMode = "confirm-writes" | "confirm-all" | "readonly";
export interface PolicyConfig {
  readonly mode?: PolicyMode;
  /** Regex strings; a segment matching one is treated as read-only. */
  readonly extraReadOnly?: string[];
  /** Regex strings; a command matching one is refused outright. */
  readonly deny?: string[];
}
export interface ResolvedPolicy {
  readonly mode: PolicyMode;
  readonly extraReadOnly: string[];
  readonly deny: string[];
}

const MODES = new Set(["confirm-writes", "confirm-all", "readonly"]);

/** Profile overrides global; `deny` lists are combined (never weaker). */
export function resolvePolicy(global?: PolicyConfig, profile?: PolicyConfig): ResolvedPolicy {
  const pick = (p?: PolicyConfig) => (p && MODES.has(p.mode as string) ? p.mode : undefined);
  const strs = (a?: unknown) => (Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
  return {
    mode: pick(profile) ?? pick(global) ?? "confirm-writes",
    extraReadOnly: profile?.extraReadOnly ? strs(profile.extraReadOnly) : strs(global?.extraReadOnly),
    deny: [...strs(global?.deny), ...strs(profile?.deny)],
  };
}

const HARD_DENY: Array<[RegExp, string]> = [
  [/:\s*\(\s*\)\s*\{/, "fork bomb"],
  [/\bmkfs(\.\w+)?(?=\s|$|[;&|])/, "mkfs formats a filesystem"],
  [/\bdd\b[^;&|\n]*\bof=\/dev\//, "dd writing to a device"],
  [/>\s*\/dev\/(sd|hd|vd|nvme|xvd|mmcblk)\w*/, "redirect to a block device"],
];

function deniedRmRoot(cmd: string): boolean {
  const re = /\brm\s+((?:-{1,2}[\w-]+\s+)+)["']?\/\*?["']?(?=\s|$|[;&|)])/g;
  for (const m of cmd.matchAll(re)) {
    if (/(^|\s)(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(\s|$)/.test(m[1])) return true;
  }
  return false;
}

const ALLOWED_REDIRECT = /^(?:>>?\s*\/dev\/null|>&\s*\d)(?![\w/.-])/;

interface Parsed {
  segments: string[][];
  force?: string;
}

/** Split into segments of words, noting anything that forces confirmation. */
function parse(cmd: string): Parsed {
  if (cmd.includes("\n") || cmd.includes("\r")) return { segments: [], force: "contains a newline" };
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const rest = cmd.slice(i);
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "`") return { segments, force: "command substitution" };
    if (c === "$" && cmd[i + 1] === "(") return { segments, force: "command substitution" };
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < cmd.length) word += cmd[++i];
      else word += c;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= cmd.length) return { segments, force: "dangling backslash" };
      word += cmd[++i];
      inWord = true;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === ";" || c === "|" || c === "&") {
      endSeg();
    } else if (c === ">" || (c === "<" && (cmd[i + 1] === "(" || cmd[i + 1] === "<"))) {
      if (c === "<") return { segments, force: "process substitution or here-doc" };
      const m = ALLOWED_REDIRECT.exec(rest);
      if (!m) return { segments, force: "output redirection" };
      // Digits right before an allowed redirect (2>&1) are part of it.
      if (/^\d+$/.test(word) && inWord) {
        word = "";
        inWord = false;
      }
      i += m[0].length - 1;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) return { segments, force: "unbalanced quotes" };
  endSeg();
  return { segments };
}

const SIMPLE = new Set(
  "ls cat head tail grep rg df du ps uname uptime free ss whoami id wc stat file pwd echo".split(" "),
);
const flagless = (args: string[]) => args.filter((a) => !a.startsWith("-"));
const sub = (args: string[], allowed: string[]) => allowed.includes(flagless(args)[0] ?? "");

/** Returns a reason when the segment is NOT read-only, else null. */
function segmentProblem(w: string[]): string | null {
  const [cmd, ...args] = w;
  if (SIMPLE.has(cmd)) {
    if (cmd === "rg" && args.some((a) => a === "--pre" || a.startsWith("--pre="))) return "rg --pre runs a command";
    if (cmd === "ss" && args.some((a) => /^-[a-zA-Z]*K/.test(a))) return "ss -K kills sockets";
    return null;
  }
  switch (cmd) {
    case "find":
      return args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(a))
        ? "find with an action that runs or writes"
        : null;
    case "hostname":
      return flagless(args).length ? "hostname with an argument sets it" : null;
    case "date":
      return args.some((a) => a.startsWith("--set") || /^-[a-zA-Z]*s/.test(a))
        ? "date -s sets the clock"
        : null;
    case "env":
      return args.length ? "env with arguments can run commands" : null;
    case "ip":
      return args.some((a) => /^(add|del|delete|set|flush|change|replace|append|up|down)$/.test(a))
        ? "ip changing network state"
        : null;
    case "journalctl":
      return args.some((a) => /^--(vacuum|rotate|flush|sync|relinquish)/.test(a)) ? "journalctl maintenance" : null;
    case "systemctl":
      return sub(args, ["status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "show", "cat"])
        ? null
        : "systemctl subcommand not read-only";
    case "docker":
      return sub(args, ["ps", "logs", "inspect", "images", "stats", "version", "info"])
        ? null
        : "docker subcommand not read-only";
    case "kubectl": {
      const f = flagless(args);
      return ["get", "describe", "logs", "top", "version"].includes(f[0]) || (f[0] === "config" && f[1] === "view")
        ? null
        : "kubectl subcommand not read-only";
    }
    case "lxc":
    case "lxd": {
      const f = flagless(args);
      return ["list", "info"].includes(f[0]) || (f[0] === "config" && f[1] === "show")
        ? null
        : "lxc subcommand not read-only";
    }
    case "git": {
      const s = args[0];
      if (args.some((a) => a.startsWith("--output") || a.startsWith("--open-files-in-pager") || a === "-c"))
        return "git option that writes or runs commands";
      if (["status", "log", "diff", "show"].includes(s)) return null;
      if (s === "branch" && args.length === 1) return null;
      if (s === "remote" && args.length === 2 && args[1] === "-v") return null;
      return "git subcommand not read-only";
    }
    default:
      return `"${cmd}" is not in the read-only allowlist`;
  }
}

function compile(list: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const s of list) {
    try {
      out.push(new RegExp(s));
    } catch {
      /* ignore invalid pattern */
    }
  }
  return out;
}

export function classifyCommand(cmd: string, policy?: Partial<ResolvedPolicy>): Classification {
  for (const [re, why] of HARD_DENY) if (re.test(cmd)) return { verdict: "deny", reason: `blocked: ${why}` };
  if (deniedRmRoot(cmd)) return { verdict: "deny", reason: "blocked: recursive delete of /" };
  for (const re of compile(policy?.deny ?? [])) {
    if (re.test(cmd)) return { verdict: "deny", reason: `blocked by policy deny pattern ${re}` };
  }

  const parsed = parse(cmd);
  if (parsed.force) return { verdict: "confirm", reason: parsed.force };
  if (parsed.segments.length === 0) return { verdict: "confirm", reason: "empty command" };

  const extra = compile(policy?.extraReadOnly ?? []);
  for (const words of parsed.segments) {
    const text = words.join(" ");
    if (extra.some((re) => re.test(text))) continue;
    const problem = segmentProblem(words);
    if (problem) return { verdict: "confirm", reason: problem };
  }
  return { verdict: "readonly", reason: "all segments are read-only" };
}
