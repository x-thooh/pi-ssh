/**
 * Configuration persistence and state.
 *
 * Stores named host profiles in ~/.pi/ssh-config.json.
 * Supports multiple profiles with an active profile selector.
 *
 * File format:
 *   { "profiles": { "name": SshProfile, ... }, "activeProfile": "name" }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SshProfile } from "./types.ts";
import type { PolicyConfig } from "./policy.ts";
import { SshNotConfiguredError } from "./types.ts";

/**
 * The file as it exists on disk.
 *
 * `extra` holds any top-level key this version does not know about, so a
 * field added by hand or by a newer version survives a write from this one.
 */
interface Store {
  profiles: Record<string, SshProfile>;
  activeProfile: string | null;
  extra: Record<string, unknown>;
}

function emptyStore(): Store {
  return { profiles: {}, activeProfile: null, extra: {} };
}

let cache: Store = emptyStore();
/** What the file looked like when it was last read, to notice outside edits. */
let lastSeen: { mtimeMs: number; size: number } | null = null;

function configPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".pi", "ssh-config.json");
}

/** Expand a leading ~ and resolve to an absolute path. */
export function expandPath(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return raw;
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(home, raw.slice(2));
  }
  return path.resolve(raw);
}

function stampOf(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/** Read the file. A missing or unreadable file is an empty store. */
function readStore(): Store {
  const filePath = configPath();
  try {
    if (!fs.existsSync(filePath)) return emptyStore();

    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object") return emptyStore();

    const { profiles: rawProfiles, activeProfile: rawActive, ...extra } = raw as Record<
      string,
      unknown
    >;
    const profiles =
      rawProfiles && typeof rawProfiles === "object"
        ? (rawProfiles as Record<string, SshProfile>)
        : {};

    let activeProfile: string | null = null;
    if (typeof rawActive === "string" && profiles[rawActive]) {
      activeProfile = rawActive;
    } else {
      const names = Object.keys(profiles);
      activeProfile = names.length > 0 ? names[0] : null;
    }

    return { profiles, activeProfile, extra };
  } catch {
    // A corrupt file is not a reason to crash, but it must also not be
    // silently replaced: writes go through readStore too, and overwriting
    // unparseable content is the caller's decision to make explicitly.
    return emptyStore();
  }
}

function serialize(store: Store): string {
  return `${JSON.stringify(
    { profiles: store.profiles, activeProfile: store.activeProfile, ...store.extra },
    null,
    2,
  )}\n`;
}

/**
 * Write the store, but only when it would actually change the file.
 *
 * The file can hold passwords and key passphrases, so it must never be group-
 * or world-readable. writeFileSync's `mode` only applies when the file is
 * created, so an existing file keeps its old permissions -- we therefore write
 * to a private temp file and rename it into place, which is also atomic.
 */
function commit(store: Store): void {
  const filePath = configPath();
  const next = serialize(store);

  let current: string | null = null;
  try {
    current = fs.readFileSync(filePath, "utf-8");
  } catch {
    current = null;
  }
  if (current === next) {
    // Nothing to do. Rewriting an unchanged file churns mtimes, wakes file
    // watchers, and widens the window in which a concurrent write is lost.
    lastSeen = stampOf(filePath);
    return;
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, next, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
  lastSeen = stampOf(filePath);
}

/**
 * Apply a change to what is on disk right now.
 *
 * Reading immediately before writing is the whole point: the in-memory copy
 * may be minutes old, and anything added since -- by hand, or by another pi
 * session -- would otherwise be erased by an unrelated write.
 */
function mutate(change: (store: Store) => Store): Store {
  const next = change(readStore());
  commit(next);
  cache = next;
  return next;
}

/** Reload the cache when the file has changed underneath us. */
function ensureFresh(): void {
  const stamp = stampOf(configPath());
  const changed =
    (stamp === null) !== (lastSeen === null) ||
    (stamp !== null &&
      lastSeen !== null &&
      (stamp.mtimeMs !== lastSeen.mtimeMs || stamp.size !== lastSeen.size));

  if (changed) {
    cache = readStore();
    lastSeen = stamp;
  }
}

export function loadConfig(): void {
  cache = readStore();
  lastSeen = stampOf(configPath());

  // Tighten permissions on a file written by an older version or by hand.
  if (process.platform !== "win32") {
    try {
      const filePath = configPath();
      if (fs.existsSync(filePath)) {
        const mode = fs.statSync(filePath).mode & 0o777;
        if (mode !== 0o600) {
          fs.chmodSync(filePath, 0o600);
          lastSeen = stampOf(filePath);
        }
      }
    } catch {
      /* an unchangeable mode is reported by ssh_doctor, not fatal here */
    }
  }
}

/** The top-level `policy` key of the config file (kept in `extra`). */
export function getGlobalPolicy(): PolicyConfig | undefined {
  ensureFresh();
  const p = cache.extra.policy;
  return p && typeof p === "object" ? (p as PolicyConfig) : undefined;
}

export function getConfig(): SshProfile | null {
  ensureFresh();
  if (!cache.activeProfile) return null;
  return cache.profiles[cache.activeProfile] ?? null;
}

export function getProfile(name: string): SshProfile | null {
  ensureFresh();
  return cache.profiles[name] ?? null;
}

/**
 * Resolve a profile parameter: if a name is given, return that profile
 * (or throw if not found). Otherwise, return the active profile or throw.
 */
export function resolveProfile(name?: string): { name: string; profile: SshProfile } {
  ensureFresh();

  if (name) {
    const profile = cache.profiles[name];
    if (!profile) {
      throw new Error(
        `Profile "${name}" not found. Available: ${Object.keys(cache.profiles).join(", ") || "none"}`,
      );
    }
    return { name, profile };
  }

  const active = cache.activeProfile;
  const profile = active ? cache.profiles[active] : null;
  if (!profile || !active) {
    throw new SshNotConfiguredError();
  }
  return { name: active, profile };
}

export function getProfiles(): Record<string, SshProfile> {
  ensureFresh();
  return { ...cache.profiles };
}

export function getActiveProfile(): string | null {
  ensureFresh();
  return cache.activeProfile;
}

export function saveProfile(name: string, profile: SshProfile): void {
  mutate((store) => {
    const profiles = { ...store.profiles, [name]: profile };
    const activeProfile =
      !store.activeProfile || Object.keys(profiles).length === 1 ? name : store.activeProfile;
    return { ...store, profiles, activeProfile };
  });
}

/** Merge changes into an existing profile, keeping everything else. */
export function updateProfile(name: string, patch: Partial<SshProfile>): SshProfile {
  let updated: SshProfile | null = null;

  mutate((store) => {
    const existing = store.profiles[name];
    if (!existing) {
      throw new Error(`Profile "${name}" does not exist.`);
    }
    updated = { ...existing, ...patch };
    return { ...store, profiles: { ...store.profiles, [name]: updated } };
  });

  return updated!;
}

export function setActiveProfile(name: string): void {
  mutate((store) => {
    if (!store.profiles[name]) {
      throw new Error(
        `Profile "${name}" does not exist. Available: ${Object.keys(store.profiles).join(", ") || "none"}`,
      );
    }
    return { ...store, activeProfile: name };
  });
}

export function deleteProfile(name: string): boolean {
  let removed = false;

  mutate((store) => {
    if (!store.profiles[name]) return store;

    removed = true;
    const profiles = { ...store.profiles };
    delete profiles[name];

    const activeProfile =
      store.activeProfile === name
        ? (Object.keys(profiles)[0] ?? null)
        : store.activeProfile;

    return { ...store, profiles, activeProfile };
  });

  return removed;
}

/** @internal Reset state -- for testing only */
export function _resetForTesting(): void {
  cache = emptyStore();
  lastSeen = null;
}
