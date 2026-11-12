/**
 * Human confirmation for anything that changes server state or trust.
 * Called from inside each tool's execute(), with the tool context (5th arg).
 * No UI means no approval: it denies, it never defaults to allow.
 */

import { randomUUID } from "node:crypto";
import { audit, type Decision } from "./audit.ts";
import { UnknownHostKeyError } from "./types.ts";

export interface GuardContext {
  readonly hasUI?: boolean;
  readonly ui?: {
    confirm(title: string, message: string): Promise<boolean>;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
}

export interface GuardRequest {
  readonly tool: string;
  readonly profile: string;
  /** What is recorded in the audit log: command, paths or tunnel spec. No secrets. */
  readonly target: string;
  readonly verdict: "auto" | "confirm" | "deny";
  /** Shown to the human on confirm; thrown as the error message on deny. */
  readonly message: string;
  /** When set, offers "Allow this exact command for this session". */
  readonly sessionKey?: string;
  /** Custom allow/deny labels (used for host key trust). */
  readonly labels?: { allow: string; deny: string };
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow this exact command for this session";
const DENY = "Deny";

const sessionAllowed = new Set<string>();
export function _resetGuardForTesting(): void {
  sessionAllowed.clear();
}

export async function guard(
  ctx: GuardContext | undefined,
  req: GuardRequest,
): Promise<{ id: string; decision: Decision }> {
  const id = randomUUID();
  const done = (decision: Decision) => {
    audit({ id, profile: req.profile, tool: req.tool, target: req.target, decision });
    return { id, decision };
  };

  if (req.verdict === "auto") return done("auto");
  if (req.verdict === "deny") {
    done("policy-deny");
    throw new Error(`${req.tool} refused by policy: ${req.message}`);
  }

  if (!ctx?.hasUI || !ctx.ui) {
    done("no-ui-deny");
    throw new Error(
      `${req.tool} needs human confirmation but no interactive UI is available, so it was denied. Do not retry or work around it.`,
    );
  }
  if (req.sessionKey && sessionAllowed.has(req.sessionKey)) return done("human-allow-session");

  const title = `Allow ${req.tool}?`;
  let decision: Decision = "human-deny";
  if (req.labels) {
    const pick = await ctx.ui.select(`${title}\n\n${req.message}`, [req.labels.allow, req.labels.deny]);
    if (pick === req.labels.allow) decision = "human-allow";
  } else if (req.sessionKey) {
    const pick = await ctx.ui.select(`${title}\n\n${req.message}`, [ALLOW_ONCE, ALLOW_SESSION, DENY]);
    if (pick === ALLOW_ONCE) decision = "human-allow";
    else if (pick === ALLOW_SESSION) {
      decision = "human-allow-session";
      sessionAllowed.add(req.sessionKey);
    }
  } else if (await ctx.ui.confirm(title, req.message)) {
    decision = "human-allow";
  }

  done(decision);
  if (decision === "human-deny") {
    throw new Error(`${req.tool} was denied by the user. Stop; do not retry or try to get around it.`);
  }
  return { id, decision };
}

/**
 * Run `attempt`; if the host key is unknown, ask the human to trust it and
 * retry once with acceptNewHostKey. The model's own acceptNewHostKey flag is
 * never consulted. Changed keys are not caught here and stay hard failures.
 */
export async function withHostKeyApproval<T>(
  ctx: GuardContext | undefined,
  profile: { name?: string; host?: string; port?: number },
  attempt: (acceptNewHostKey: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(false);
  } catch (err) {
    if (!(err instanceof UnknownHostKeyError)) throw err;
    const where = profile.host ? `${profile.host}:${profile.port ?? 22}` : "the host";
    await guard(ctx, {
      tool: "ssh_host_key_trust",
      profile: profile.name ?? "",
      target: `${where} ${err.fingerprint}`,
      verdict: "confirm",
      message: `Unknown SSH host key for ${where}\nFingerprint: ${err.fingerprint}\n${err.message}\n\nVerify it out of band before trusting.`,
      labels: { allow: "Trust and record", deny: "Reject" },
    });
    return attempt(true);
  }
}
