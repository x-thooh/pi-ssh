/**
 * /jms -- run commands on JumpServer profiles straight from the prompt.
 *
 *   /jms                          list JumpServer profiles and session state
 *   /jms use <profile>            remember a default profile for this session
 *   /jms <profile>                enter the server: an interactive terminal (vim, top, ...)
 *   /jms connect <profile>        log in in the background, running nothing
 *   /jms <profile> <command>      run a command on that profile
 *   /jms <command>                run it on the default profile
 *   /jms share                    send the last result to the model
 *   /jms close [profile]          close the open session(s)
 *
 * The command runs directly (no model round-trip) through the same guard as
 * the ssh_exec tool, so confirmation, policy and audit still apply. The result
 * is shown in the transcript but kept out of the model's context until you
 * run `/jms share`.
 */

import type { SshProfile } from "./types.ts";
import type { JmsResultData } from "./jms-render.ts";

export type JmsAction =
  | { kind: "list" }
  | { kind: "use"; profile: string }
  | { kind: "close"; profile?: string }
  | { kind: "share" }
  | { kind: "shell"; profile: string }
  | { kind: "connect"; profile: string }
  | { kind: "run"; profile: string; command: string }
  | { kind: "error"; message: string };

const USAGE = "Usage: /jms [list] | <profile> | connect <profile> | use <profile> | share | close [profile] | [<profile>] <command>";

/** Pure: turn the raw argument string into an action. */
export function parseJmsArgs(
  raw: string,
  names: readonly string[],
  defaultName: string | null,
  /** Other (non-JumpServer) profile names, so a mix-up is reported, not run. */
  otherNames: readonly string[] = [],
): JmsAction {
  const text = raw.trim();
  if (!text || text === "list" || text === "ls") return { kind: "list" };

  const [head, ...restWords] = text.split(/\s+/);
  const rest = text.slice(head.length).trim();
  const known = (n: string) => names.includes(n);
  const available = names.length ? ` Available: ${names.join(", ")}.` : " No JumpServer profile is configured.";

  if (head === "share" && !rest) return { kind: "share" };

  if (head === "use") {
    if (!rest) return { kind: "error", message: `${USAGE}${available}` };
    return known(rest)
      ? { kind: "use", profile: rest }
      : { kind: "error", message: `"${rest}" is not a JumpServer profile.${available}` };
  }
  if (head === "connect") {
    if (!rest) return { kind: "error", message: `${USAGE}${available}` };
    return known(rest)
      ? { kind: "connect", profile: rest }
      : { kind: "error", message: `"${rest}" is not a JumpServer profile.${available}` };
  }
  if (head === "close") {
    if (!rest) return { kind: "close" };
    return known(rest)
      ? { kind: "close", profile: rest }
      : { kind: "error", message: `"${rest}" is not a JumpServer profile.${available}` };
  }

  if (otherNames.includes(head)) {
    return { kind: "error", message: `"${head}" is not a JumpServer profile; use /ssh or ssh_exec for it.${available}` };
  }

  if (known(head)) {
    if (restWords.length === 0) return { kind: "shell", profile: head };
    return { kind: "run", profile: head, command: rest };
  }

  const profile = defaultName && known(defaultName) ? defaultName : names.length === 1 ? names[0] : null;
  if (!profile) {
    return { kind: "error", message: `No default profile. Use /jms <profile> <command> or /jms use <profile>.${available}` };
  }
  return { kind: "run", profile, command: text };
}

export interface JmsOutcome {
  readonly output: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated?: boolean;
}

export interface JmsDeps {
  profiles(): Record<string, SshProfile>;
  hasSession(name: string): boolean;
  closeSession(name: string): boolean;
  closeAll(): void;
  /** Log in and keep the session open without running anything. */
  connect(profile: string): Promise<{ reused: boolean }>;
  /** Give the human an interactive terminal on the profile; resolves when they leave. */
  shell(profile: string): Promise<{ reason: string }>;
  /** Run through the guarded exec path; rejects when denied or failed. */
  run(profile: string, command: string): Promise<JmsOutcome>;
  /** Put a result in the transcript without sending it to the model. */
  show(entry: JmsResultData): void;
  /** Hand text to the model as a user message. */
  share(text: string): void;
  notify(message: string, level: "info" | "error"): void;
}

function jumpserverNames(profiles: Record<string, SshProfile>): string[] {
  return Object.entries(profiles)
    .filter(([, p]) => p.jump?.type === "jumpserver")
    .map(([n]) => n);
}

/** The guard's errors are written for the model; the human needs less. */
function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s*Stop; do not retry[^.]*\./, "").replace(/\s*Do not retry or work around it\./, "");
}

export function createJmsHandler(deps: JmsDeps): (args: string) => Promise<void> {
  let defaultName: string | null = null;
  let last: JmsResultData | null = null;
  let running = false;

  return async (args: string) => {
    const profiles = deps.profiles();
    const names = jumpserverNames(profiles);
    const others = Object.keys(profiles).filter((n) => !names.includes(n));
    const action = parseJmsArgs(args, names, defaultName, others);

    switch (action.kind) {
      case "error":
        deps.notify(action.message, "error");
        return;

      case "list": {
        if (names.length === 0) {
          deps.notify("No JumpServer profile configured (jump.type: \"jumpserver\"). See the README.", "info");
          return;
        }
        const lines = names.map((n) => {
          const p = profiles[n];
          const j = p.jump as { asset?: string; account?: string };
          const star = n === defaultName ? "*" : " ";
          const state = deps.hasSession(n) ? "session open" : "no session";
          return `${star} ${n}  ${p.user}@${p.host}:${p.port}  asset=${j.asset ?? "(unset)"}  account=${j.account ?? "1"}  [${state}]`;
        });
        deps.notify(`JumpServer profiles (* = default):\n${lines.join("\n")}`, "info");
        return;
      }

      case "use":
        defaultName = action.profile;
        deps.notify(`Default JumpServer profile: ${action.profile}`, "info");
        return;

      case "close": {
        if (!action.profile) {
          deps.closeAll();
          deps.notify("Closed all JumpServer sessions.", "info");
          return;
        }
        const closed = deps.closeSession(action.profile);
        deps.notify(closed ? `Closed session ${action.profile}.` : `${action.profile} has no open session.`, "info");
        return;
      }

      case "connect": {
        if (running) {
          deps.notify("A /jms command is still running.", "error");
          return;
        }
        running = true;
        deps.notify(`Connecting to ${action.profile}...`, "info");
        try {
          const { reused } = await deps.connect(action.profile);
          // WHY: entering is an explicit choice of machine, like `/jms use`, so
          // it is the one other thing that may set the default profile.
          defaultName = action.profile;
          const p = profiles[action.profile];
          const asset = (p.jump as { asset?: string }).asset ?? "(unset)";
          deps.notify(
            `${reused ? "Already connected to" : "Connected to"} ${action.profile} (${p.user}@${p.host}:${p.port}, asset=${asset}). ` +
              `No command was run. Use /jms <command> to run one, /jms close to leave.`,
            "info",
          );
        } catch (err) {
          deps.notify(`Could not connect to ${action.profile}: ${humanError(err)}`, "error");
        } finally {
          running = false;
        }
        return;
      }

      case "shell": {
        if (running) {
          deps.notify("A /jms command is still running.", "error");
          return;
        }
        running = true;
        deps.notify(`Entering ${action.profile}... (Ctrl-] leaves, exit ends the shell)`, "info");
        try {
          const { reason } = await deps.shell(action.profile);
          defaultName = action.profile; // an explicit choice of machine, like /jms use
          deps.notify(
            `Left ${action.profile} (${reason}). /jms <command> runs commands there; /jms ${action.profile} enters again.`,
            "info",
          );
        } catch (err) {
          deps.notify(`Could not enter ${action.profile}: ${humanError(err)}`, "error");
        } finally {
          running = false;
        }
        return;
      }

      case "share": {
        if (!last) {
          deps.notify("Nothing to share yet: run a /jms command first.", "error");
          return;
        }
        const r = last;
        deps.share(
          `Output of \`${r.command}\` on ${r.profile} (${r.error ? `failed: ${r.error}` : `exit ${r.exitCode}`}):\n\n${r.output}`,
        );
        return;
      }

      case "run": {
        // WHY: one command at a time per handler. A second /jms while the first
        // waits on a confirmation dialog would stack prompts on the user.
        if (running) {
          deps.notify("A /jms command is still running.", "error");
          return;
        }
        running = true;
        deps.notify(`Running on ${action.profile}...`, "info");
        try {
          const r = await deps.run(action.profile, action.command);
          last = { profile: action.profile, command: action.command, ...r };
        } catch (err) {
          last = {
            profile: action.profile,
            command: action.command,
            output: "",
            exitCode: null,
            durationMs: 0,
            error: humanError(err),
          };
        } finally {
          running = false;
        }
        deps.show(last);
        return;
      }
    }
  };
}
