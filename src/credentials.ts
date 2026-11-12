/**
 * Lazy password resolution: passwordCmd > passwordEnv > password.
 * The resolved value is returned to the caller and never stored or logged.
 */

import { execFile } from "node:child_process";
import type { SshProfile } from "./types.ts";

const CMD_TIMEOUT_MS = 10_000;

export async function resolvePassword(profile: SshProfile): Promise<string | undefined> {
  if (profile.passwordCmd) {
    return new Promise((resolve, reject) => {
      execFile(
        "/bin/sh",
        ["-c", profile.passwordCmd as string],
        { timeout: CMD_TIMEOUT_MS, encoding: "utf-8" },
        (err, stdout) => {
          // Deliberately no command output or command text in the message.
          if (err) return reject(new Error("passwordCmd failed or timed out (output not shown)."));
          const value = stdout.trim();
          if (!value) return reject(new Error("passwordCmd produced no output."));
          resolve(value);
        },
      );
    });
  }
  if (profile.passwordEnv) {
    const value = process.env[profile.passwordEnv];
    if (!value) throw new Error(`Environment variable ${profile.passwordEnv} is not set.`);
    return value;
  }
  return profile.password;
}

export function hasPasswordSource(profile: SshProfile): boolean {
  return Boolean(profile.passwordCmd || profile.passwordEnv || profile.password);
}
