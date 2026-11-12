/**
 * ssh_exec tool -- Run a command on the remote host.
 */

import { Type } from "typebox";
import { resolveForConnection, withNote } from "./shared.ts";
import { runCommandOnProfile } from "../clients/run.ts";
import { formatExecResult } from "../formatting/formatters.ts";

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
          "Record the host key if this host is not yet known. Only pass this once the fingerprint has been checked.",
        default: false,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      command: string;
      cwd?: string;
      timeoutSeconds?: number;
      profile?: string;
      acceptNewHostKey?: boolean;
    },
    signal: AbortSignal,
  ) {
    if (!params.command?.trim()) throw new Error("command must not be empty.");

    const { name, profile, note } = await resolveForConnection(params.profile, {
      acceptNewHostKey: params.acceptNewHostKey,
      signal,
    });
    const timeoutMs = Math.min(Math.max(params.timeoutSeconds ?? 120, 1), 3600) * 1000;

    const result = await runCommandOnProfile(name, profile, params.command, {
      cwd: params.cwd,
      timeoutMs,
      signal,
      acceptNewHostKey: params.acceptNewHostKey,
    });

    return {
      content: [{ type: "text" as const, text: withNote(formatExecResult(result), note) }],
      details: {
        profile: name,
        host: profile.host,
        exitCode: result.code,
        signal: result.signal,
        durationMs: result.durationMs,
        truncated: result.truncated,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      },
    };
  },
};
