/**
 * ssh_list tool -- List a directory on the remote host over SFTP.
 */

import { Type } from "typebox";
import { resolveForConnection, withNote } from "./shared.ts";
import { listDirectory, } from "../clients/ssh-client.ts";
import { withProfileConnection } from "../clients/run.ts";
import { formatDirectory } from "../formatting/formatters.ts";

export const SshListTool = {
  name: "ssh_list",
  label: "SSH List Directory",
  description:
    "List a directory on the remote host with sizes, permissions and dates, over SFTP. Use this instead of running ls, because the result is structured.",
  parameters: Type.Object({
    path: Type.String({ description: "Remote directory, e.g. /var/log or ." }),
    profile: Type.Optional(
      Type.String({ description: "SSH profile to use. Defaults to the active one." }),
    ),
    acceptNewHostKey: Type.Optional(
      Type.Boolean({ description: "Record an unknown host key.", default: false }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { path: string; profile?: string; acceptNewHostKey?: boolean },
    signal: AbortSignal,
  ) {
    const { name, profile, note } = await resolveForConnection(params.profile, {
      acceptNewHostKey: params.acceptNewHostKey,
      signal,
    });
    const remotePath = params.path?.trim() || ".";

    const entries = await withProfileConnection(
      name,
      profile,
      { signal, acceptNewHostKey: params.acceptNewHostKey },
      (connection) => listDirectory(connection, remotePath),
    );

    return {
      content: [
        { type: "text" as const, text: withNote(formatDirectory(entries, remotePath), note) },
      ],
      details: {
        profile: name,
        path: remotePath,
        count: entries.length,
        directories: entries.filter((entry) => entry.type === "directory").length,
      },
    };
  },
};
