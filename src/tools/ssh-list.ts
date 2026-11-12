/**
 * ssh_list tool -- List a directory on the remote host over SFTP.
 */

import { Type } from "typebox";
import { resolveForConnection, withNote } from "./shared.ts";
import { listDirectory, withConnection } from "../clients/ssh-client.ts";
import { formatDirectory } from "../formatting/formatters.ts";
import { resolveProfile } from "../config.ts";
import { withHostKeyApproval, type GuardContext } from "../guard.ts";

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
      Type.Boolean({ description: "Deprecated and ignored: unknown host keys are only recorded after the human approves a prompt.", default: false }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { path: string; profile?: string; acceptNewHostKey?: boolean },
    signal: AbortSignal,
    _onUpdate?: unknown,
    ctx?: GuardContext,
  ) {
    const resolved = resolveProfile(params.profile);
    const remotePath = params.path?.trim() || ".";

    const { name, note, entries } = await withHostKeyApproval(
      ctx,
      { name: resolved.name, ...resolved.profile },
      async (accept) => {
        const c = await resolveForConnection(params.profile, { acceptNewHostKey: accept, signal });
        const entries = await withConnection(
          c.profile,
          { signal, acceptNewHostKey: accept },
          (connection) => listDirectory(connection, remotePath),
        );
        return { ...c, entries };
      },
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
