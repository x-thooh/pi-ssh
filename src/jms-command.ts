/**
 * /jms -- work on a JumpServer host, with the AI or by hand.
 *
 *   /jms                          list JumpServer profiles and their state
 *   /jms <profile>                enter the server: from now on the AI operates it
 *                                 for you (plain sentences, via ssh_exec)
 *   /jms <request>                ask the AI to do something on the current server
 *   /jms <profile> <request>      same, on that server (entering it first if needed)
 *   /jms !<command>               run one command yourself, output shown as-is
 *   /jms <profile> !<command>     same, on that server
 *   /jms exit                     leave the server
 *   /jms shell <profile>          a real interactive terminal for you (vim, top, ...)
 *   /jms use <profile>            set the default profile for /jms <command>
 *   /jms share                    send the last direct result to the model
 *   /jms close [profile]          close the open background session(s)
 *
 * Entering does not run anything. Every command the AI issues goes through the
 * ssh_exec guard: read-only commands run, everything else asks you first.
 */

import type { SshProfile } from "./types.ts";
import type { JmsResultData } from "./jms-render.ts";

export type JmsAction =
  | { kind: "list" }
  | { kind: "use"; profile: string }
  | { kind: "close"; profile?: string }
  | { kind: "share" }
  | { kind: "enter"; profile: string }
  | { kind: "leave" }
  | { kind: "shell"; profile: string }
  | { kind: "ask"; profile: string; text: string }
  | { kind: "run"; profile: string; command: string }
  | { kind: "error"; message: string };

const USAGE = "Usage: /jms [list] | <profile> | exit | shell <profile> | use <profile> | share | close [profile] | [<profile>] <request> | [<profile>] !<command>";

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
  if (head === "exit" && !rest) return { kind: "leave" };
  if (head === "shell") {
    if (!rest) return { kind: "error", message: `${USAGE}${available}` };
    return known(rest)
      ? { kind: "shell", profile: rest }
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

  // WHY: only an explicit leading "!" runs something verbatim. Everything else
  // is a request for the AI, so a sentence typed after /jms is never handed to
  // a root shell as if it were a command.
  const direct = (profile: string, body: string): JmsAction => {
    const command = body.replace(/^!\s*/, "");
    return command
      ? { kind: "run", profile, command }
      : { kind: "error", message: "Nothing to run after !. Example: /jms !df -h" };
  };

  if (known(head)) {
    if (restWords.length === 0) return { kind: "enter", profile: head };
    return rest.startsWith("!") ? direct(head, rest) : { kind: "ask", profile: head, text: rest };
  }

  const profile = defaultName && known(defaultName) ? defaultName : names.length === 1 ? names[0] : null;
  if (!profile) {
    return {
      kind: "error",
      message: `No server selected. Use /jms <profile> to enter one, or /jms <profile> <request>.${available}`,
    };
  }
  return text.startsWith("!") ? direct(profile, text) : { kind: "ask", profile, text };
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
  /** Tell the AI which server it is working on (null = none). */
  setTarget(profile: string | null): void;
  /** Give the human an interactive terminal on the profile; resolves when they leave. */
  shell(profile: string): Promise<{ reason: string }>;
  /** Hand a request to the AI as a normal user message. */
  ask(text: string): void;
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
  let target: string | null = null;
  let last: JmsResultData | null = null;
  const changeTarget = (p: string | null) => {
    target = p;
    deps.setTarget(p);
  };
  let running = false;

  /** Log in, then make the AI work on this server. False (and a message) on failure. */
  const enterServer = async (profile: string): Promise<boolean> => {
    deps.notify(`Connecting to ${profile}...`, "info");
    try {
      await deps.connect(profile);
    } catch (err) {
      deps.notify(`Could not enter ${profile}: ${humanError(err)}`, "error");
      return false;
    }
    // WHY: entering is an explicit choice of machine, so it also becomes the
    // default for direct /jms !<command> calls.
    defaultName = profile;
    changeTarget(profile);
    return true;
  };

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

      case "enter": {
        if (running) {
          deps.notify("A /jms command is still running.", "error");
          return;
        }
        running = true;
        try {
          if (await enterServer(action.profile)) {
            const p = profiles[action.profile];
            const asset = (p.jump as { asset?: string }).asset ?? "(unset)";
            deps.notify(
              `Entered ${action.profile} (${p.user}@${p.host}:${p.port}, asset=${asset}). ` +
                `Nothing was run. Tell the AI what to do on this server; changes ask you first. /jms exit leaves.`,
              "info",
            );
          }
        } finally {
          running = false;
        }
        return;
      }

      case "ask": {
        if (running) {
          deps.notify("A /jms command is still running.", "error");
          return;
        }
        running = true;
        let ready = false;
        try {
          // Already inside this server: no login, no extra message.
          ready = target === action.profile || (await enterServer(action.profile));
        } finally {
          running = false;
        }
        // WHY: sent after `running` is cleared and only on success, so a failed
        // login never turns into a request aimed at the wrong (or no) server.
        if (ready) deps.ask(action.text);
        return;
      }

      case "leave": {
        const was = target;
        if (!was) {
          deps.notify("Not in a server. /jms <profile> enters one.", "info");
          return;
        }
        changeTarget(null);
        deps.closeSession(was);
        if (defaultName === was) defaultName = null;
        deps.notify(`Left ${was}; its session is closed.`, "info");
        return;
      }

      case "shell": {
        if (running) {
          deps.notify("A /jms command is still running.", "error");
          return;
        }
        running = true;
        deps.notify(`Opening a terminal on ${action.profile}... (Ctrl-] leaves, exit ends the shell)`, "info");
        try {
          const { reason } = await deps.shell(action.profile);
          defaultName = action.profile; // an explicit choice of machine, like /jms use
          deps.notify(
            `Left ${action.profile} (${reason}). /jms <command> runs commands there; /jms shell ${action.profile} opens it again.`,
            "info",
          );
        } catch (err) {
          deps.notify(`Could not open a terminal on ${action.profile}: ${humanError(err)}`, "error");
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
