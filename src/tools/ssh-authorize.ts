/**
 * ssh_authorize tool -- Replace a password login with a key login.
 */

import { Type } from "typebox";
import { resolveProfile } from "../config.ts";
import { authorizeKey } from "../authorize.ts";
import { formatAuthorizeResult } from "../formatting/formatters.ts";
import { guard, withHostKeyApproval, type GuardContext } from "../guard.ts";

export const SshAuthorizeTool = {
  name: "ssh_authorize",
  label: "SSH Install Key",
  description:
    "Set up passwordless login: generate an SSH key if the profile has none, install its public key in the remote authorized_keys, point the profile at it, and verify that a key-only login works. This is what ssh-copy-id does, but it runs in process, so no ssh-keygen or ssh-copy-id has to be installed. Run it once after configuring a host with a password.",
  parameters: Type.Object({
    profile: Type.Optional(
      Type.String({ description: "SSH profile to set up. Defaults to the active one." }),
    ),
    keyPath: Type.Optional(
      Type.String({
        description:
          "Key to use or create. Default ~/.ssh/id_ed25519_pi_<profile>. An existing key at this path is reused, never overwritten.",
      }),
    ),
    comment: Type.Optional(
      Type.String({ description: "Comment for a newly generated key." }),
    ),
    authorizedKeysPath: Type.Optional(
      Type.String({
        description:
          "Absolute path of authorized_keys on the remote host. Only needed when its sshd uses a non-standard AuthorizedKeysFile; by default the remote account's ~/.ssh/authorized_keys is used.",
      }),
    ),
    removePassword: Type.Optional(
      Type.Boolean({
        description:
          "Delete the stored password once the key login is proven to work. Default false, which keeps it as a fallback.",
        default: false,
      }),
    ),
    acceptNewHostKey: Type.Optional(
      Type.Boolean({
        description: "Deprecated and ignored: unknown host keys are only recorded after the human approves a prompt.",
        default: false,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      profile?: string;
      keyPath?: string;
      comment?: string;
      authorizedKeysPath?: string;
      removePassword?: boolean;
      acceptNewHostKey?: boolean;
    },
    signal: AbortSignal,
    _onUpdate?: unknown,
    ctx?: GuardContext,
  ) {
    const { name, profile } = resolveProfile(params.profile);
    await guard(ctx, {
      tool: "ssh_authorize",
      profile: name,
      target: `install key on ${profile.user}@${profile.host}${params.removePassword ? " and remove stored password" : ""}`,
      verdict: "confirm",
      message: `Install an SSH key in authorized_keys on ${profile.user}@${profile.host}:${profile.port} (profile ${name}).${params.removePassword ? "\nThe stored password will be removed from the profile." : ""}`,
    });

    const result = await withHostKeyApproval(ctx, { name, ...profile }, (accept) =>
      authorizeKey({
        profileName: name,
        profile,
        keyPath: params.keyPath,
        comment: params.comment,
        authorizedKeysPath: params.authorizedKeysPath,
        removePassword: params.removePassword,
        acceptNewHostKey: accept,
        signal,
      }),
    );

    const note =
      result.verified && params.removePassword
        ? "\n\nThe stored password has been removed from the profile."
        : result.verified && profile.password
          ? "\n\nThe password is still stored as a fallback. Re-run with removePassword: true to drop it."
          : "";

    return {
      content: [
        { type: "text" as const, text: `${formatAuthorizeResult(result)}${note}` },
      ],
      details: { ...result, passwordRemoved: Boolean(result.verified && params.removePassword) },
    };
  },
};
