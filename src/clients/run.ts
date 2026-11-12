/**
 * Run a command on a profile, whatever route it takes to get there:
 * direct, through a JumpServer menu, or hopping through another profile.
 */

import type { ExecResult, SshProfile } from "../types.ts";
import { getProfile } from "../config.ts";
import { connect, execCommand, type Connection } from "./ssh-client.ts";
import { runOnJumpServer } from "../jumpserver.ts";

const MAX_HOPS = 3;

export interface RunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly acceptNewHostKey?: boolean;
  /** Overall JumpServer login timeout (ms); default 30s. */
  readonly loginTimeoutMs?: number;
  /** Profile lookup for `jump.via`; defaults to the stored profiles. */
  readonly lookup?: (name: string) => SshProfile | null;
}

export interface ProfileConnection {
  readonly connection: Connection;
  /** Closes the connection and every hop beneath it. */
  close(): void;
}

export const JUMPSERVER_UNSUPPORTED =
  "not supported through JumpServer; use ssh_exec";

/** Throw early for operations that need a real SSH channel. */
export function assertNotJumpServer(profile: SshProfile, what: string): void {
  if (profile.jump?.type === "jumpserver") {
    throw new Error(`${what} is ${JUMPSERVER_UNSUPPORTED}.`);
  }
}

/**
 * Open a connection to `profile`, hopping through `jump.via` profiles when
 * configured. Callers must call `close()`.
 */
export async function connectProfile(
  name: string,
  profile: SshProfile,
  options: RunOptions = {},
  chain: readonly string[] = [],
): Promise<ProfileConnection> {
  const jump = profile.jump;
  if (!jump) {
    const connection = await connect(profile, options);
    return { connection, close: () => connection.client.end() };
  }
  if (jump.type === "jumpserver") {
    throw new Error(`Cannot open a raw SSH connection to "${name}" through JumpServer.`);
  }

  if (chain.includes(name)) {
    throw new Error(`Jump cycle detected: ${[...chain, name].join(" -> ")}.`);
  }
  if (chain.length >= MAX_HOPS) {
    throw new Error(`Too many jump hops (max ${MAX_HOPS}): ${[...chain, name].join(" -> ")}.`);
  }

  const via = (options.lookup ?? getProfile)(jump.via);
  if (!via) throw new Error(`Jump profile "${jump.via}" (via for "${name}") does not exist.`);
  const hop = await connectProfile(jump.via, via, options, [...chain, name]);

  try {
    const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      hop.connection.client.forwardOut("127.0.0.1", 0, profile.host, profile.port, (err, s) =>
        err ? reject(new Error(`${jump.via} could not reach ${profile.host}:${profile.port}: ${err.message}`)) : resolve(s),
      );
    });
    const connection = await connect(profile, { ...options, sock: stream });
    return {
      connection,
      close: () => {
        connection.client.end();
        hop.close();
      },
    };
  } catch (err) {
    hop.close();
    throw err;
  }
}

export async function runCommandOnProfile(
  name: string,
  profile: SshProfile,
  command: string,
  options: RunOptions = {},
): Promise<ExecResult> {
  if (profile.jump?.type === "jumpserver") {
    return runOnJumpServer(name, profile, command, options);
  }
  const target = await connectProfile(name, profile, options);
  try {
    return await execCommand(target.connection, command, options);
  } finally {
    target.close();
  }
}

/** Like withConnection, but follows `jump.via` hops. */
export async function withProfileConnection<T>(
  name: string,
  profile: SshProfile,
  options: RunOptions,
  fn: (connection: Connection) => Promise<T>,
): Promise<T> {
  assertNotJumpServer(profile, "File and directory operations");
  const target = await connectProfile(name, profile, options);
  try {
    return await fn(target.connection);
  } finally {
    target.close();
  }
}
