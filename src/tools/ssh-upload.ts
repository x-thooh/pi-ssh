/**
 * ssh_upload tool -- Copy a local file to the remote host over SFTP.
 */

import { Type } from "typebox";
import { resolveForConnection, withNote } from "./shared.ts";
import { uploadFile } from "../clients/ssh-client.ts";
import { assertNotJumpServer, withProfileConnection } from "../clients/run.ts";
import fs from "node:fs";
import { openSftp } from "../clients/ssh-client.ts";
import { expandPath } from "../config.ts";
import { formatTransfer } from "../formatting/formatters.ts";
import { resolveProfile } from "../config.ts";
import { guard, withHostKeyApproval, type GuardContext } from "../guard.ts";

export const SshUploadTool = {
  name: "ssh_upload",
  label: "SSH Upload File",
  description:
    "Copy a file from this machine to the remote host over SFTP. The remote path must include the file name; an existing file at that path is overwritten.",
  parameters: Type.Object({
    localPath: Type.String({ description: "File on this machine. Absolute paths are safest." }),
    remotePath: Type.String({
      description: "Destination path on the remote host, including the file name.",
    }),
    profile: Type.Optional(
      Type.String({ description: "SSH profile to use. Defaults to the active one." }),
    ),
    acceptNewHostKey: Type.Optional(
      Type.Boolean({ description: "Deprecated and ignored: unknown host keys are only recorded after the human approves a prompt.", default: false }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      localPath: string;
      remotePath: string;
      profile?: string;
      acceptNewHostKey?: boolean;
    },
    signal: AbortSignal,
    _onUpdate?: unknown,
    ctx?: GuardContext,
  ) {
    const resolved = resolveProfile(params.profile);
    assertNotJumpServer(resolved.profile, "ssh_upload");
    let size = "unknown";
    try {
      size = `${fs.statSync(expandPath(params.localPath)).size} bytes`;
    } catch {
      /* reported by the upload itself */
    }
    // Best effort and never prompts for trust: failure just means "unknown".
    let remoteExists = "unknown";
    try {
      remoteExists = await withProfileConnection(
        resolved.name,
        resolved.profile,
        { signal, acceptNewHostKey: false },
        async (connection) => {
          const sftp = await openSftp(connection);
          return new Promise<string>((resolve) =>
            sftp.stat(params.remotePath, (err) => resolve(err ? "no" : "YES (will be overwritten)")),
          );
        },
      );
    } catch {
      /* unknown */
    }
    await guard(ctx, {
      tool: "ssh_upload",
      profile: resolved.name,
      target: `${params.localPath} -> ${params.remotePath}`,
      verdict: "confirm",
      message: `Profile: ${resolved.name} (${resolved.profile.user}@${resolved.profile.host}:${resolved.profile.port})\nLocal: ${params.localPath}\nRemote: ${params.remotePath}\nSize: ${size}\nRemote already exists: ${remoteExists}`,
    });

    const { name, note, result } = await withHostKeyApproval(
      ctx,
      { name: resolved.name, ...resolved.profile },
      async (accept) => {
        const c = await resolveForConnection(params.profile, { acceptNewHostKey: accept, signal });
        const result = await withProfileConnection(
          c.name,
          c.profile,
          { signal, acceptNewHostKey: accept },
          (connection) => uploadFile(connection, params.localPath, params.remotePath),
        );
        return { ...c, result };
      },
    );

    return {
      content: [{ type: "text" as const, text: withNote(formatTransfer(result, "up"), note) }],
      details: { profile: name, ...result },
    };
  },
};
