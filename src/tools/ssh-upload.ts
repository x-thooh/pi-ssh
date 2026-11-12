/**
 * ssh_upload tool -- Copy a local file to the remote host over SFTP.
 */

import { Type } from "typebox";
import { resolveForConnection, withNote } from "./shared.ts";
import { uploadFile, } from "../clients/ssh-client.ts";
import { withProfileConnection } from "../clients/run.ts";
import { formatTransfer } from "../formatting/formatters.ts";

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
      Type.Boolean({ description: "Record an unknown host key.", default: false }),
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
  ) {
    const { name, profile, note } = await resolveForConnection(params.profile, {
      acceptNewHostKey: params.acceptNewHostKey,
      signal,
    });

    const result = await withProfileConnection(
      name,
      profile,
      { signal, acceptNewHostKey: params.acceptNewHostKey },
      (connection) => uploadFile(connection, params.localPath, params.remotePath),
    );

    return {
      content: [{ type: "text" as const, text: withNote(formatTransfer(result, "up"), note) }],
      details: { profile: name, ...result },
    };
  },
};
