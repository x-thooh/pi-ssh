/**
 * ssh_download tool -- Copy a remote file to this machine over SFTP.
 */

import { Type } from "typebox";
import { resolveForConnection, withNote } from "./shared.ts";
import { downloadFile } from "../clients/ssh-client.ts";
import { assertNotJumpServer, withProfileConnection } from "../clients/run.ts";
import fs from "node:fs";
import { expandPath } from "../config.ts";
import { formatTransfer } from "../formatting/formatters.ts";
import { resolveProfile } from "../config.ts";
import { guard, withHostKeyApproval, type GuardContext } from "../guard.ts";

export const SshDownloadTool = {
  name: "ssh_download",
  label: "SSH Download File",
  description:
    "Copy a file from the remote host to this machine over SFTP. Missing local directories are created. Prefer this over cat-ing a file through ssh_exec: it handles binary content and does not pass the file through the model.",
  parameters: Type.Object({
    remotePath: Type.String({ description: "File on the remote host." }),
    localPath: Type.String({
      description: "Destination on this machine, including the file name.",
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
      remotePath: string;
      localPath: string;
      profile?: string;
      acceptNewHostKey?: boolean;
    },
    signal: AbortSignal,
    _onUpdate?: unknown,
    ctx?: GuardContext,
  ) {
    const resolved = resolveProfile(params.profile);
    assertNotJumpServer(resolved.profile, "ssh_download");
    // Only an overwrite changes anything on this machine worth asking about.
    if (fs.existsSync(expandPath(params.localPath))) {
      await guard(ctx, {
        tool: "ssh_download",
        profile: resolved.name,
        target: `${params.remotePath} -> ${params.localPath}`,
        verdict: "confirm",
        message: `Profile: ${resolved.name}\nRemote: ${params.remotePath}\nLocal: ${params.localPath}\nThe local file already exists and will be OVERWRITTEN.`,
      });
    }

    const { name, note, result } = await withHostKeyApproval(
      ctx,
      { name: resolved.name, ...resolved.profile },
      async (accept) => {
        const c = await resolveForConnection(params.profile, { acceptNewHostKey: accept, signal });
        const result = await withProfileConnection(
          c.name,
          c.profile,
          { signal, acceptNewHostKey: accept },
          (connection) => downloadFile(connection, params.remotePath, params.localPath),
        );
        return { ...c, result };
      },
    );

    return {
      content: [{ type: "text" as const, text: withNote(formatTransfer(result, "down"), note) }],
      details: { profile: name, ...result },
    };
  },
};
