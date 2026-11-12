/**
 * Data types for the pi SSH extension.
 *
 * All domain data is represented as plain immutable-shaped interfaces.
 * No behavior, no classes, no inheritance -- just data (errors excepted).
 */

// Configuration

export interface JumpStep {
  /** Regex matched against the output received since the previous step. */
  readonly expect: string;
  /** Reply; supports {asset} {account} {password} placeholders. */
  readonly send: string;
  /** The reply is sensitive and is redacted from error output. */
  readonly secret?: boolean;
}

export type JumpConfig =
  | {
      readonly type: "jumpserver";
      readonly asset?: string;
      readonly account?: string;
      readonly steps?: readonly JumpStep[];
      /** Close the persistent session after this much inactivity. Default 300000. */
      readonly idleTimeoutMs?: number;
    }
  | { readonly type: "ssh"; readonly via: string };

export interface SshProfile {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** Password auth. Stored in plaintext, so the file is 0600. */
  readonly password?: string;
  /** Shell command whose trimmed stdout is the password. Wins over passwordEnv and password. */
  readonly passwordCmd?: string;
  /** Name of an environment variable holding the password. Wins over password. */
  readonly passwordEnv?: string;
  /** Reach this host through a JumpServer bastion or another profile. */
  readonly jump?: JumpConfig;
  /** Path to a private key on this machine. The key itself is not copied. */
  readonly privateKeyPath?: string;
  /** Passphrase for that key, when it has one. */
  readonly passphrase?: string;
  /** Override the known_hosts file for this profile. */
  readonly knownHostsFile?: string;
  /**
   * Refuse to connect to a host whose key is not on record. On by default:
   * turning it off removes the only defence against a machine-in-the-middle.
   */
  readonly strictHostKey?: boolean;
  readonly connectTimeoutMs?: number;
  /**
   * Upgrade this profile to key authentication on first use, replacing the
   * stored password. On by default; set to false to keep using the password.
   */
  readonly autoKey?: boolean;
  /** Named port forwards that ssh_tunnel can start by name. */
  readonly tunnels?: Record<string, TunnelDefinition>;
}

/** A tunnel that is currently running. */
export interface RunningTunnel {
  readonly id: string;
  readonly profile: string;
  readonly name: string;
  readonly definition: TunnelDefinition;
  /** Where it actually listens, which matters when listenPort was 0. */
  readonly listenAddress: string;
  readonly startedAt: string;
  readonly connections: number;
  /** Set when the tunnel closes itself after a fixed time. */
  readonly expiresAt?: string;
}

/**
 * A port forward, stored by name in a profile.
 *
 * The same shape describes both directions, and `kind` decides whose machine
 * each side refers to:
 *
 *   local  (ssh -L): this machine listens on bind:listenPort, and the server
 *                    opens the connection to destHost:destPort.
 *   remote (ssh -R): the server listens on bind:listenPort, and this machine
 *                    opens the connection to destHost:destPort.
 */
export interface TunnelDefinition {
  readonly kind: "local" | "remote";
  /** Port the tunnel accepts connections on. */
  readonly listenPort: number;
  /**
   * Interface to bind that port to. Defaults to 127.0.0.1: binding to
   * 0.0.0.0 publishes the forwarded service to the whole network.
   */
  readonly bind?: string;
  /** Where traffic is delivered. */
  readonly destHost: string;
  readonly destPort: number;
  readonly description?: string;
}

export interface SshProfiles {
  readonly profiles: Record<string, SshProfile>;
  readonly activeProfile: string | null;
}

// Domain

export interface ExecResult {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  /** Set when the command was killed by a signal rather than exiting. */
  readonly signal?: string;
  readonly durationMs: number;
  /** True when output was cut off at the configured limit. */
  readonly truncated: boolean;
}

export interface RemoteEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size: number;
  readonly modified?: string;
  readonly mode: string;
}

export interface TransferResult {
  readonly localPath: string;
  readonly remotePath: string;
  readonly size: number;
}

export interface ServerIdentity {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly fingerprint: string;
  readonly keyType: string;
  /** How the host key compared to known_hosts. */
  readonly hostKeyVerdict: string;
  /** Which authentication method actually succeeded. */
  readonly authMethod: string;
}

export interface AuthorizeResult {
  readonly profile: string;
  readonly keyPath: string;
  readonly publicKeyPath: string;
  readonly fingerprint: string;
  /** False when the key was already present in authorized_keys. */
  readonly installed: boolean;
  /** True when a passwordless login was confirmed afterwards. */
  readonly verified: boolean;
  readonly authorizedKeysPath: string;
}

// Tool parameter shapes

export interface SetupParams {
  readonly name: string;
  readonly host: string;
  readonly user: string;
  readonly port?: number;
  readonly password?: string;
  readonly passwordCmd?: string;
  readonly passwordEnv?: string;
  readonly jump?: JumpConfig;
  readonly privateKeyPath?: string;
  readonly passphrase?: string;
  readonly strictHostKey?: boolean;
  readonly autoKey?: boolean;
}

// Errors

export class SshNotConfiguredError extends Error {
  constructor() {
    super("No SSH host configured. Use the ssh_setup tool first (host, user, and a password or key).");
    this.name = "SshNotConfiguredError";
  }
}

export class HostKeyChangedError extends Error {
  readonly fingerprint: string;

  constructor(message: string, fingerprint: string) {
    super(message);
    this.name = "HostKeyChangedError";
    this.fingerprint = fingerprint;
  }
}

export class UnknownHostKeyError extends Error {
  readonly fingerprint: string;

  constructor(message: string, fingerprint: string) {
    super(message);
    this.name = "UnknownHostKeyError";
    this.fingerprint = fingerprint;
  }
}

export class SshAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshAuthError";
  }
}

export class TunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelError";
  }
}

export class RemoteCommandError extends Error {
  readonly result: ExecResult;

  constructor(message: string, result: ExecResult) {
    super(message);
    this.name = "RemoteCommandError";
    this.result = result;
  }
}
