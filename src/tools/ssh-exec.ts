/**
 * ssh_exec tool -- Run a command on the remote host.
 */

import { Type } from "typebox";
import { resolveForConnection, withNote } from "./shared.ts";
import { runCommandOnProfile } from "../clients/run.ts";
import { JumpSession, openJumpSession } from "../jumpserver.ts";
import { formatExecForModel } from "../exec-output.ts";
import { resolveProfile, getGlobalPolicy } from "../config.ts";
import { classifyCommand, resolvePolicy } from "../policy.ts";
import { guard, withHostKeyApproval, type GuardContext } from "../guard.ts";
import { audit } from "../audit.ts";

export interface ExecParams {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
  profile?: string;
  acceptNewHostKey?: boolean;
}

/**
 * Classify, confirm, run and audit one command. Shared by the ssh_exec tool
 * and the /jms command, so both go through exactly the same guard.
 */
export async function runGuardedExec(
  params: ExecParams,
  signal: AbortSignal,
  ctx?: GuardContext,
) {
    if (!params.command?.trim()) throw new Error("command must not be empty.");

    const resolved = resolveProfile(params.profile);
    const policy = resolvePolicy(getGlobalPolicy(), resolved.profile.policy);
    const cls = classifyCommand(params.command, policy);
    let verdict: "auto" | "confirm" | "deny" =
      cls.verdict === "readonly" ? "auto" : cls.verdict;
    if (policy.mode === "confirm-all" && verdict === "auto") verdict = "confirm";
    if (policy.mode === "readonly" && verdict === "confirm") verdict = "deny";
    const where = `${resolved.profile.user}@${resolved.profile.host}:${resolved.profile.port}`;
    const { id } = await guard(ctx, {
      tool: "ssh_exec",
      profile: resolved.name,
      target: params.command,
      verdict,
      message:
        verdict === "deny"
          ? `${cls.reason} (policy mode: ${policy.mode})`
          : `Profile: ${resolved.name}\nHost: ${where}\nCwd: ${params.cwd ?? "(login directory)"}\nWhy: ${cls.reason}\nCommand:\n${params.command}`,
      sessionKey: `${resolved.name}\0${params.cwd ?? ""}\0${params.command}`,
    });
    const timeoutMs = Math.min(Math.max(params.timeoutSeconds ?? 120, 1), 3600) * 1000;

    const { name, profile, note, result } = await withHostKeyApproval(
      ctx,
      { name: resolved.name, ...resolved.profile },
      async (accept) => {
        const c = await resolveForConnection(params.profile, { acceptNewHostKey: accept, signal });
        const result = await runCommandOnProfile(c.name, c.profile, params.command, {
          cwd: params.cwd,
          timeoutMs,
          signal,
          acceptNewHostKey: accept,
        });
        return { ...c, result };
      },
    );
    audit({ id, profile: name, tool: "ssh_exec", exitCode: result.code });
    return { name, profile, note, result };
}

/**
 * Log in to a JumpServer profile and keep the session open, running nothing.
 * Same host-key approval and audit trail as a command; no confirmation is
 * needed because logging in changes nothing on the server.
 */
export async function openGuardedSession(
  params: { profile?: string },
  signal: AbortSignal,
  ctx?: GuardContext,
) {
  const resolved = resolveProfile(params.profile);
  if (resolved.profile.jump?.type !== "jumpserver") {
    throw new Error(`"${resolved.name}" is not a JumpServer profile.`);
  }
  const asset = (resolved.profile.jump as { asset?: string }).asset ?? "(unset)";
  await guard(ctx, {
    tool: "jms_connect",
    profile: resolved.name,
    target: `login ${resolved.profile.user}@${resolved.profile.host}:${resolved.profile.port} asset=${asset}`,
    verdict: "auto",
    message: "",
  });
  return withHostKeyApproval(ctx, { name: resolved.name, ...resolved.profile }, async (accept) => {
    const c = await resolveForConnection(params.profile, { acceptNewHostKey: accept, signal });
    const { reused } = await openJumpSession(c.name, c.profile, {
      signal,
      acceptNewHostKey: accept,
    });
    return { name: c.name, profile: c.profile, reused };
  });
}

/**
 * Log in to a JumpServer profile for a human to type into. The model never
 * gets this: it is only reachable from the /jms command, and the human's own
 * keystrokes are the confirmation. What they type is recorded by JumpServer,
 * not here; the audit log only notes that a shell was opened and how it ended.
 */
export async function openGuardedShell(
  params: { profile?: string; cols: number; rows: number },
  signal: AbortSignal,
  ctx?: GuardContext,
) {
  const resolved = resolveProfile(params.profile);
  if (resolved.profile.jump?.type !== "jumpserver") {
    throw new Error(`"${resolved.name}" is not a JumpServer profile.`);
  }
  const asset = (resolved.profile.jump as { asset?: string }).asset ?? "(unset)";
  const { id } = await guard(ctx, {
    tool: "jms_shell",
    profile: resolved.name,
    target: `interactive shell ${resolved.profile.user}@${resolved.profile.host}:${resolved.profile.port} asset=${asset}`,
    verdict: "auto",
    message: "",
  });
  const { name, session } = await withHostKeyApproval(
    ctx,
    { name: resolved.name, ...resolved.profile },
    async (accept) => {
      const c = await resolveForConnection(params.profile, { acceptNewHostKey: accept, signal });
      const session = new JumpSession(c.name, c.profile, {
        signal,
        acceptNewHostKey: accept,
        interactive: { cols: params.cols, rows: params.rows },
      });
      await session.whenReady();
      return { name: c.name, session };
    },
  );
  const { stream, buffered } = session.detach();
  return {
    id,
    name,
    stream,
    buffered,
    close: () => session.close(),
    ended: (reason: string) => audit({ id, profile: name, tool: "jms_shell", target: `ended: ${reason}` }),
  };
}

export const SshExecTool = {
  name: "ssh_exec",
  label: "SSH Run Command",
  description:
    "Run a shell command on the configured remote host and return its output and exit code. The connection is opened for this command and closed again. Commands run non-interactively, so anything that expects input or a TTY (sudo with a password prompt, an editor, top) will hang until the timeout.",
  parameters: Type.Object({
    command: Type.String({ description: "The command line to run on the remote host." }),
    cwd: Type.Optional(
      Type.String({ description: "Directory to run it in. Default: the login directory." }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "Give up after this long. Default 120.", default: 120 }),
    ),
    profile: Type.Optional(
      Type.String({ description: "SSH profile to use. Defaults to the active one." }),
    ),
    acceptNewHostKey: Type.Optional(
      Type.Boolean({
        description:
          "Deprecated and ignored: unknown host keys are only recorded after the human approves a prompt.",
        default: false,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: ExecParams,
    signal: AbortSignal,
    _onUpdate?: unknown,
    ctx?: GuardContext,
  ) {
    const { name, profile, note, result } = await runGuardedExec(params, signal, ctx);
    const shown = formatExecForModel(result);

    return {
      content: [{ type: "text" as const, text: withNote(shown.text, note) }],
      details: {
        profile: name,
        host: profile.host,
        exitCode: result.code,
        signal: result.signal,
        durationMs: result.durationMs,
        truncated: result.truncated,
        outputCut: shown.truncated,
        outputFile: shown.file,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      },
    };
  },
};
