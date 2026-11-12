/**
 * SSH connection, command execution and SFTP.
 *
 * All I/O lives here. The connection lifecycle is owned by `withConnection`,
 * which is the single place that opens, hands over, and always closes a
 * connection -- an SSH session left open is a file descriptor and a server
 * side process that nobody will clean up.
 *
 * ssh2 is a pure JavaScript implementation, so nothing here depends on an
 * `ssh` binary being installed. That matters on Windows, where one often
 * is not.
 */

import * as fs from "node:fs";
import * as path from "node:path";
// ssh2 is CommonJS, so its exports come off the default object.
import ssh2 from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";

const { Client } = ssh2;
import type {
  ExecResult,
  RemoteEntry,
  ServerIdentity,
  SshProfile,
  TransferResult,
} from "../types.ts";
import {
  HostKeyChangedError,
  RemoteCommandError,
  SshAuthError,
  UnknownHostKeyError,
} from "../types.ts";
import {
  addKnownHost,
  checkHostKey,
  defaultKnownHostsPath,
  describeChangedKey,
} from "../known-hosts.ts";
import { expandPath } from "../config.ts";
import { resolvePassword } from "../credentials.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
/**
 * SSH-level keepalives.
 *
 * ssh2 sends none by default. A connection that carries a tunnel can sit idle
 * for a long time, and anything doing NAT or stateful filtering in between
 * will eventually drop an idle flow without telling either end -- the tunnel
 * then looks alive and silently is not. Four unanswered probes at 15s means a
 * dead connection is noticed within about a minute and closed properly.
 */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 4;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
/** Enough to be useful, small enough not to swamp a context window. */
export const MAX_OUTPUT_CHARS = 200_000;

export interface ConnectOptions {
  /** Record an unknown host key instead of refusing. Trust on first use. */
  readonly acceptNewHostKey?: boolean;
  /** Restrict authentication to one method, e.g. to force a password login. */
  readonly only?: "password" | "key";
  readonly signal?: AbortSignal;
  /** An already-open stream to use instead of dialing (jump hosts). */
  readonly sock?: NodeJS.ReadableStream;
}

export interface Connection {
  readonly client: Client;
  readonly identity: ServerIdentity;
  readonly profile: SshProfile;
}

function readPrivateKey(profile: SshProfile): Buffer | null {
  if (!profile.privateKeyPath) return null;
  const resolved = expandPath(profile.privateKeyPath);
  try {
    return fs.readFileSync(resolved);
  } catch {
    throw new SshAuthError(
      `Private key not readable: ${resolved}. Check the path, or use ssh_authorize to create one.`,
    );
  }
}

/** The authentication methods to offer, in the order they should be tried. */
export function buildAuthMethods(
  profile: SshProfile,
  only: ConnectOptions["only"],
): Array<{ type: string; label: string; key?: Buffer; passphrase?: string; password?: string }> {
  const methods: Array<{
    type: string;
    label: string;
    key?: Buffer;
    passphrase?: string;
    password?: string;
  }> = [];

  const key = only === "password" ? null : readPrivateKey(profile);
  if (key) {
    methods.push({
      type: "publickey",
      label: "key",
      key,
      passphrase: profile.passphrase,
    });
  }
  if (only !== "key" && profile.password) {
    methods.push({ type: "password", label: "password", password: profile.password });
  }

  if (methods.length === 0) {
    throw new SshAuthError(
      only === "key"
        ? "This profile has no private key configured."
        : "This profile has neither a password nor a private key. Add one with ssh_setup.",
    );
  }
  return methods;
}

/**
 * Open a connection, verifying the host key first.
 *
 * The host key check happens during the handshake, so its outcome is captured
 * in a closure and turned into a proper error afterwards -- ssh2 itself only
 * reports a generic handshake failure.
 */
export async function connect(
  profile: SshProfile,
  options: ConnectOptions = {},
): Promise<Connection> {
  // Resolved only now and only held in this call; never written anywhere.
  const password = await resolvePassword(profile);
  const effective: SshProfile = password ? { ...profile, password } : profile;
  const connection = await connectResolved(effective, options);
  return { ...connection, profile };
}

function connectResolved(
  profile: SshProfile,
  options: ConnectOptions,
): Promise<Connection> {
  const knownHostsFile = profile.knownHostsFile
    ? expandPath(profile.knownHostsFile)
    : defaultKnownHostsPath();
  const strict = profile.strictHostKey !== false;
  const methods = buildAuthMethods(profile, options.only);

  return new Promise((resolve, reject) => {
    const client = new Client();
    let hostKeyError: Error | null = null;
    let identity: Omit<ServerIdentity, "authMethod"> | null = null;
    let usedMethod = methods[0]?.label ?? "unknown";
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err);
    };

    const queue = [...methods];
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.user,
      readyTimeout: profile.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      ...(options.sock ? { sock: options.sock as never } : {}),

      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        const check = checkHostKey(profile.host, profile.port, key, knownHostsFile);
        identity = {
          host: profile.host,
          port: profile.port,
          user: profile.user,
          fingerprint: check.fingerprint,
          keyType: check.keyType,
          hostKeyVerdict: check.verdict,
        };

        if (check.verdict === "match") {
          verify(true);
          return;
        }
        if (check.verdict === "changed") {
          hostKeyError = new HostKeyChangedError(
            describeChangedKey(check, profile.host),
            check.fingerprint,
          );
          verify(false);
          return;
        }
        if (check.verdict === "revoked") {
          hostKeyError = new HostKeyChangedError(
            `The host key for ${profile.host} is marked as revoked in ${check.file}. Refusing to connect.`,
            check.fingerprint,
          );
          verify(false);
          return;
        }

        // Unknown host.
        if (!strict || options.acceptNewHostKey) {
          try {
            addKnownHost(profile.host, profile.port, key, knownHostsFile);
          } catch {
            /* an unwritable known_hosts must not block the connection */
          }
          verify(true);
          return;
        }

        hostKeyError = new UnknownHostKeyError(
          [
            `The host key of ${profile.host}:${profile.port} is not in ${check.file}.`,
            "",
            `Offered: ${check.keyType} ${check.fingerprint}`,
            "",
            "Check that fingerprint against the server, then re-run with acceptNewHostKey to record it.",
          ].join("\n"),
          check.fingerprint,
        );
        verify(false);
      },

      // Controlling the order also reveals which method succeeded: whatever
      // was offered last is what the server accepted.
      authHandler: (_authsLeft: unknown, _partial: unknown, next: (m: unknown) => void) => {
        const method = queue.shift();
        if (!method) {
          next(false);
          return;
        }
        usedMethod = method.label;
        if (method.type === "publickey") {
          next({
            type: "publickey",
            username: profile.user,
            key: method.key,
            ...(method.passphrase ? { passphrase: method.passphrase } : {}),
          });
          return;
        }
        next({ type: "password", username: profile.user, password: method.password });
      },
    };

    client.on("ready", () => {
      if (settled) return;
      settled = true;
      resolve({
        client,
        profile,
        identity: { ...(identity as Omit<ServerIdentity, "authMethod">), authMethod: usedMethod },
      });
    });

    client.on("error", (err: Error & { level?: string }) => {
      // A rejected host key surfaces as a handshake error, so the specific
      // reason captured above wins over ssh2's generic message.
      if (hostKeyError) {
        fail(hostKeyError);
        return;
      }
      if (err.level === "client-authentication") {
        const tried = methods.map((method) => method.label).join(" and ");
        fail(
          new SshAuthError(
            `${profile.user}@${profile.host} rejected the credentials (tried ${tried}). Check the user name, password or key.`,
          ),
        );
        return;
      }
      if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        fail(new Error(`${profile.host}:${profile.port} refused the connection. Is sshd running and the port right?`));
        return;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOTFOUND") {
        fail(new Error(`Host not found: ${profile.host}.`));
        return;
      }
      fail(err);
    });

    if (options.signal) {
      const abort = () => fail(new Error("Connection cancelled."));
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    }

    try {
      client.connect(config);
    } catch (err) {
      fail(err as Error);
    }
  });
}

/** Open a connection, run `fn`, and close it whatever happens. */
export async function withConnection<T>(
  profile: SshProfile,
  options: ConnectOptions,
  fn: (connection: Connection) => Promise<T>,
): Promise<T> {
  const connection = await connect(profile, options);
  try {
    return await fn(connection);
  } finally {
    connection.client.end();
  }
}

// --- Commands -------------------------------------------------------------

function clamp(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated at ${MAX_OUTPUT_CHARS} characters]`,
    truncated: true,
  };
}

export interface ExecOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

/** Quote a path for a POSIX shell, so a space or quote cannot break out. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function execCommand(
  connection: Connection,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const full = options.cwd ? `cd ${shellQuote(options.cwd)} && ${command}` : command;
  const started = Date.now();

  return new Promise((resolve, reject) => {
    connection.client.exec(full, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = "";
      let stderr = "";
      let code: number | null = null;
      let signalName: string | undefined;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.close();
        reject(
          new RemoteCommandError(
            `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`,
            {
              command,
              stdout: clamp(stdout).text,
              stderr: clamp(stderr).text,
              code: null,
              durationMs: Date.now() - started,
              truncated: false,
            },
          ),
        );
      }, timeoutMs);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.close();
        reject(new Error("Command cancelled."));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += chunk.toString("utf-8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += chunk.toString("utf-8");
      });

      stream.on("exit", (exitCode: number | null, exitSignal?: string) => {
        code = exitCode;
        signalName = exitSignal;
      });

      stream.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);

        const out = clamp(stdout);
        const errOut = clamp(stderr);
        resolve({
          command,
          stdout: out.text,
          stderr: errOut.text,
          code,
          signal: signalName,
          durationMs: Date.now() - started,
          truncated: out.truncated || errOut.truncated,
        });
      });
    });
  });
}

// --- SFTP -----------------------------------------------------------------

export function openSftp(connection: Connection): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    connection.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function describeType(entry: { attrs: { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean } }): RemoteEntry["type"] {
  if (entry.attrs.isDirectory()) return "directory";
  if (entry.attrs.isSymbolicLink()) return "symlink";
  if (entry.attrs.isFile()) return "file";
  return "other";
}

/** Render a mode as the rwx string people expect from ls. */
export function formatMode(mode: number): string {
  const bits = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i += 1) {
    out += mode & (1 << (8 - i)) ? bits[i] : "-";
  }
  return out;
}

export async function listDirectory(
  connection: Connection,
  remotePath: string,
): Promise<RemoteEntry[]> {
  const sftp = await openSftp(connection);
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) {
        reject(new Error(`Cannot list ${remotePath}: ${err.message}`));
        return;
      }
      const entries = list.map((entry) => ({
        name: entry.filename,
        type: describeType(entry),
        size: entry.attrs.size,
        modified: entry.attrs.mtime
          ? new Date(entry.attrs.mtime * 1000).toISOString()
          : undefined,
        mode: formatMode(entry.attrs.mode),
      }));
      entries.sort((a, b) => a.name.localeCompare(b.name));
      resolve(entries);
    });
  });
}

export async function uploadFile(
  connection: Connection,
  localPath: string,
  remotePath: string,
): Promise<TransferResult> {
  const local = expandPath(localPath);
  const stat = fs.statSync(local);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${local}`);
  }

  const sftp = await openSftp(connection);
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remotePath, (err) => {
      if (err) {
        reject(new Error(`Upload to ${remotePath} failed: ${err.message}`));
        return;
      }
      resolve({ localPath: local, remotePath, size: stat.size });
    });
  });
}

export async function downloadFile(
  connection: Connection,
  remotePath: string,
  localPath: string,
): Promise<TransferResult> {
  const local = expandPath(localPath);
  fs.mkdirSync(path.dirname(local), { recursive: true });

  const sftp = await openSftp(connection);
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, local, (err) => {
      if (err) {
        reject(new Error(`Download of ${remotePath} failed: ${err.message}`));
        return;
      }
      resolve({ localPath: local, remotePath, size: fs.statSync(local).size });
    });
  });
}
