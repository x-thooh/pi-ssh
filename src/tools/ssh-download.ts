/**
 * ssh_download tool -- Copy a remote file to this machine over SFTP.
 */

import { Type } from "typebox";
import { resolveForConnection, withNote } from "./shared.ts";
import { downloadFile, } from "../clients/ssh-client.ts";
import { withProfileConnection } from "../clients/run.ts";
import { formatTransfer } from "../formatting/formatters.ts";

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
      Type.Boolean({ description: "Record an unknown host key.", default: false }),
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
  ) {
    const { name, profile, note } = await resolveForConnection(params.profile, {
      acceptNewHostKey: params.acceptNewHostKey,
      signal,
    });

    const result = await withProfileConnection(
      name,
      profile,
      { signal, acceptNewHostKey: params.acceptNewHostKey },
      (connection) => downloadFile(connection, params.remotePath, params.localPath),
    );

    return {
      content: [{ type: "text" as const, text: withNote(formatTransfer(result, "down"), note) }],
      details: { profile: name, ...result },
    };
  },
};
