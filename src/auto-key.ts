/**
 * First contact upgrades a password login to a key login.
 *
 * A password sitting in a config file is a password on disk, and it stays
 * there for as long as the profile exists. So the first time a profile that
 * has only a password is actually used, the key bootstrap runs first and the
 * password is replaced by the key it just installed.
 *
 * The upgrade is attempted, not enforced: a host that refuses public key
 * authentication entirely would otherwise become unusable. When it fails the
 * password is kept and the caller is told, rather than the work being blocked.
 */

import type { SshProfile } from "./types.ts";
import { authorizeKey } from "./authorize.ts";
import { getProfile } from "./config.ts";

export interface UpgradeOutcome {
  /** The profile to actually connect with. */
  readonly profile: SshProfile;
  /** Set when an upgrade was attempted, whether or not it worked. */
  readonly note?: string;
  readonly upgraded: boolean;
}

/** Does this profile still log in with a password and nothing else? */
export function needsKeyUpgrade(profile: SshProfile): boolean {
  if (profile.autoKey === false) return false;
  // A bastion login is not key-upgradable; leave its password source alone.
  if (profile.jump?.type === "jumpserver") return false;
  return Boolean(profile.password) && !profile.privateKeyPath;
}

export interface UpgradeOptions {
  readonly acceptNewHostKey?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Install a key and drop the password, then return the profile to connect
 * with. A profile that already has a key, or has opted out, is returned
 * untouched without opening any connection.
 */
export async function ensureKeyAuthentication(
  profileName: string,
  profile: SshProfile,
  options: UpgradeOptions = {},
): Promise<UpgradeOutcome> {
  if (!needsKeyUpgrade(profile)) {
    return { profile, upgraded: false };
  }

  try {
    const result = await authorizeKey({
      profileName,
      profile,
      acceptNewHostKey: options.acceptNewHostKey,
      signal: options.signal,
      // The point of the upgrade is that the password stops being stored.
      removePassword: true,
    });

    if (!result.verified) {
      return {
        profile,
        upgraded: false,
        note: `A key was installed on ${profile.host}, but a key-only login could not be verified, so the password is still being used. Fingerprint: ${result.fingerprint}`,
      };
    }

    // authorizeKey rewrote the stored profile; use what is on disk now.
    const updated = getProfile(profileName) ?? profile;
    return {
      profile: updated,
      upgraded: true,
      note: `First connection to ${profile.host}: installed a key (${result.fingerprint}) at ${result.keyPath} and removed the stored password. Logins from now on use the key.`,
    };
  } catch (err) {
    return {
      profile,
      upgraded: false,
      note: `Could not switch ${profile.host} to key authentication (${(err as Error).message}). Continuing with the password.`,
    };
  }
}
