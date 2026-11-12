/**
 * ssh_keygen tool -- Create an SSH key pair without ssh-keygen.
 */

import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandPath, getProfile, updateProfile } from "../config.ts";
import { guard, type GuardContext } from "../guard.ts";
import { defaultKeyComment, generateKeyPair } from "../keys.ts";

export const SshKeygenTool = {
  name: "ssh_keygen",
  label: "SSH Generate Key",
  description:
    "Create an ed25519 SSH key pair on this machine. Works on Windows, macOS and Linux alike because the key is generated in process -- ssh-keygen does not need to be installed. The result is a normal OpenSSH key that the ssh command can use too. To also install it on a host, use ssh_authorize instead.",
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({
        description:
          "Where to write the private key. Default ~/.ssh/id_ed25519_pi. The public key goes next to it with a .pub suffix.",
      }),
    ),
    comment: Type.Optional(
      Type.String({ description: "Comment stored in the key, e.g. an email or host name." }),
    ),
    profile: Type.Optional(
      Type.String({
        description: "Record the new key in this SSH profile so it is used for logins.",
      }),
    ),
    overwrite: Type.Optional(
      Type.Boolean({
        description:
          "Replace an existing key at that path. Default false: overwriting invalidates every host that already trusts the old key.",
        default: false,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { path?: string; comment?: string; profile?: string; overwrite?: boolean },
    _signal: AbortSignal,
    _onUpdate?: unknown,
    ctx?: GuardContext,
  ) {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const privateKeyPath = expandPath(
      params.path ?? path.join(home, ".ssh", "id_ed25519_pi"),
    );
    const publicKeyPath = `${privateKeyPath}.pub`;

    if (fs.existsSync(privateKeyPath) && !params.overwrite) {
      throw new Error(
        `A key already exists at ${privateKeyPath}. Pass overwrite: true to replace it, but note that every host trusting the old key will stop accepting it.`,
      );
    }

    if (params.profile && !getProfile(params.profile)) {
      throw new Error(`Profile "${params.profile}" does not exist.`);
    }

    if (params.overwrite) {
      await guard(ctx, {
        tool: "ssh_keygen",
        profile: params.profile ?? "",
        target: `overwrite key ${privateKeyPath}`,
        verdict: "confirm",
        message: `Overwrite the existing private key ${privateKeyPath}. Every host trusting the old key will stop accepting it.`,
      });
    }

    const comment =
      params.comment ?? defaultKeyComment(os.userInfo().username, os.hostname());
    const pair = generateKeyPair(comment);

    fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(privateKeyPath, pair.privateKey, { mode: 0o600 });
    fs.chmodSync(privateKeyPath, 0o600);
    fs.writeFileSync(publicKeyPath, `${pair.publicKey}\n`, { mode: 0o644 });

    if (params.profile) {
      updateProfile(params.profile, { privateKeyPath });
    }

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Created an ed25519 key pair.`,
            `Private: ${privateKeyPath} (owner only)`,
            `Public:  ${publicKeyPath}`,
            `Fingerprint: ${pair.fingerprint}`,
            params.profile ? `Recorded in profile "${params.profile}".` : "",
            "",
            "Public key to install on a host:",
            pair.publicKey,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      details: {
        privateKeyPath,
        publicKeyPath,
        fingerprint: pair.fingerprint,
        publicKey: pair.publicKey,
        profile: params.profile ?? null,
      },
    };
  },
};
