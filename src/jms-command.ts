/**
 * /jms -- a slash command for JumpServer profiles, the counterpart of /ssh.
 *
 *   /jms                          list JumpServer profiles and session state
 *   /jms use <profile>            remember a default profile for this session
 *   /jms <profile> <command>      run a command on that profile
 *   /jms <command>                run it on the default profile
 *   /jms close [profile]          close the open session(s)
 *
 * Like /ssh it only asks the model to call ssh_exec, so every command still
 * passes the confirmation policy inside the tool. Nothing here runs a command.
 */

import type { SshProfile } from "./types.ts";

export type JmsAction =
  | { kind: "list" }
  | { kind: "use"; profile: string }
  | { kind: "close"; profile?: string }
  | { kind: "run"; profile: string; command: string }
  | { kind: "error"; message: string };

const USAGE = "Usage: /jms [list] | use <profile> | close [profile] | [<profile>] <command>";

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

  if (head === "use") {
    if (!rest) return { kind: "error", message: `${USAGE}${available}` };
    return known(rest)
      ? { kind: "use", profile: rest }
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
    if (restWords.length === 0) {
      return { kind: "error", message: `Missing command. Use /jms ${head} <command>, or /jms use ${head}.` };
    }
    return { kind: "run", profile: head, command: rest };
  }

  const profile = defaultName && known(defaultName) ? defaultName : names.length === 1 ? names[0] : null;
  if (!profile) {
    return { kind: "error", message: `No default profile. Use /jms <profile> <command> or /jms use <profile>.${available}` };
  }
  return { kind: "run", profile, command: text };
}

export interface JmsDeps {
  profiles(): Record<string, SshProfile>;
  hasSession(name: string): boolean;
  closeSession(name: string): boolean;
  closeAll(): void;
  /** Ask the model to do something (same mechanism /ssh uses). */
  send(message: string): void;
  notify(message: string, level: "info" | "error"): void;
}

function jumpserverNames(profiles: Record<string, SshProfile>): string[] {
  return Object.entries(profiles)
    .filter(([, p]) => p.jump?.type === "jumpserver")
    .map(([n]) => n);
}

export function createJmsHandler(deps: JmsDeps): (args: string) => void {
  let defaultName: string | null = null;

  return (args: string) => {
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

      case "run": {
        // WHY: the default is only ever set by an explicit `/jms use`. Setting
        // it from the last run would send a mistyped profile name to the wrong
        // server as a command.
        // WHY: spell the command out verbatim and forbid retries, so the model
        // cannot "improve" it around a denial. The tool still enforces policy.
        deps.send(
          `Run exactly this command with ssh_exec using profile "${action.profile}" (a JumpServer profile). ` +
            `Do not change it, do not add flags, and if the user denies it, stop. Show me the output:\n${action.command}`,
        );
        deps.notify(`Running on ${action.profile}...`, "info");
        return;
      }
    }
  };
}
