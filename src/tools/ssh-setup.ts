/**
 * ssh_setup tool -- Store the details of a host.
 *
 * A profile is set active automatically if it is the first one. Credentials
 * go to ~/.pi/ssh-config.json, readable only by the owner.
 */

import { Type } from "typebox";
import { expandPath, saveProfile } from "../config.ts";
import { guard, type GuardContext } from "../guard.ts";
import type { SetupParams, SshProfile } from "../types.ts";

export const SshSetupTool = {
  name: "ssh_setup",
  label: "SSH Setup",
  description:
    "Store an SSH host: address, user, and either a password or the path to a private key. Call this before any other ssh tool. Credentials are saved to ~/.pi/ssh-config.json (owner-readable only). If you only have a password, ssh_authorize can turn that into key-based login afterwards.",
  parameters: Type.Object({
    name: Type.String({
      description: "Profile name, e.g. 'staging', 'nas'. Short and memorable.",
    }),
    host: Type.String({ description: "Hostname or IP address." }),
    user: Type.String({ description: "Login user on the remote host." }),
    port: Type.Optional(Type.Number({ description: "SSH port. Default 22.", default: 22 })),
    password: Type.Optional(
      Type.String({
        description:
          "Password for this host. Stored in plaintext in the config file; prefer a key, or run ssh_authorize afterwards to switch to one.",
      }),
    ),
    privateKeyPath: Type.Optional(
      Type.String({
        description: "Path to a private key on this machine, e.g. ~/.ssh/id_ed25519.",
      }),
    ),
    passphrase: Type.Optional(
      Type.String({ description: "Passphrase for that private key, if it has one." }),
    ),
    autoKey: Type.Optional(
      Type.Boolean({
        description:
          "On the first connection, install an SSH key on the host and replace the stored password with it. Default true. Set false to keep using the password.",
        default: true,
      }),
    ),
    strictHostKey: Type.Optional(
      Type.Boolean({
        description:
          "Refuse hosts whose key is not in known_hosts. Default true. Turning it off removes the only protection against a machine-in-the-middle.",
        default: true,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: SetupParams,
    _signal: AbortSignal,
    _onUpdate?: unknown,
    ctx?: GuardContext,
  ) {
    if (!params.host?.trim()) throw new Error("host must not be empty.");
    if (!params.user?.trim()) throw new Error("user must not be empty.");

    const port = params.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("port must be an integer between 1 and 65535.");
    }
    if (!params.password && !params.privateKeyPath) {
      throw new Error(
        "Give either a password or a privateKeyPath -- otherwise there is no way to log in.",
      );
    }

    const profile: SshProfile = {
      host: params.host.trim(),
      user: params.user.trim(),
      port,
      ...(params.password ? { password: params.password } : {}),
      ...(params.privateKeyPath
        ? { privateKeyPath: expandPath(params.privateKeyPath) }
        : {}),
      ...(params.passphrase ? { passphrase: params.passphrase } : {}),
      ...(params.autoKey === false ? { autoKey: false } : {}),
      ...(params.strictHostKey === false ? { strictHostKey: false } : {}),
    };

    await guard(ctx, {
      tool: "ssh_setup",
      profile: params.name,
      target: `save profile ${params.name}: ${profile.user}@${profile.host}:${profile.port}`,
      verdict: "confirm",
      message: `Save SSH profile "${params.name}": ${profile.user}@${profile.host}:${profile.port}\nAuth: ${profile.password ? "password" : "key"}${profile.strictHostKey === false ? "\nWARNING: host key checking disabled" : ""}`,
    });

    saveProfile(params.name, profile);

    const advice =
      profile.password && !profile.privateKeyPath
        ? params.autoKey === false
          ? "\n\nThis profile logs in with a password and will keep doing so. Run ssh_authorize to switch to a key."
          : "\n\nThis profile logs in with a password. On the first connection a key will be installed on the host and the password removed from the config; pass autoKey: false to prevent that."
        : "";

    return {
      content: [
        {
          type: "text" as const,
          text: `SSH profile "${params.name}" saved: ${profile.user}@${profile.host}:${profile.port}.${advice}`,
        },
      ],
      details: {
        profile: params.name,
        host: profile.host,
        port: profile.port,
        user: profile.user,
        hasPassword: Boolean(profile.password),
        hasKey: Boolean(profile.privateKeyPath),
      },
    };
  },
};
