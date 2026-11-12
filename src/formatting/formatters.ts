/**
 * Output formatters.
 *
 * Pure functions that transform domain data into display strings.
 * No emojis, no side effects.
 */

import type {
  AuthorizeResult,
  RunningTunnel,
  TunnelDefinition,
  ExecResult,
  RemoteEntry,
  ServerIdentity,
  SshProfile,
  TransferResult,
} from "../types.ts";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** How a profile authenticates, without revealing any secret. */
import { hasJumpSession } from "../jumpserver.ts";

export function describeAuth(profile: SshProfile): string {
  const methods: string[] = [];
  if (profile.privateKeyPath) methods.push(`key ${profile.privateKeyPath}`);
  if (profile.passwordCmd) methods.push("password (from command)");
  else if (profile.passwordEnv) methods.push(`password (from env ${profile.passwordEnv})`);
  else if (profile.password) methods.push("password (stored)");
  return methods.length > 0 ? methods.join(", ") : "none configured";
}

export function formatProfileStatus(
  profiles: Record<string, SshProfile>,
  active: string | null,
): string {
  const names = Object.keys(profiles);
  if (names.length === 0) {
    return "No SSH hosts configured. Use ssh_setup with a host, user, and a password or key path.";
  }

  const lines: string[] = [];
  for (const name of names) {
    const profile = profiles[name];
    const marker = name === active ? "*" : " ";
    const port = profile.port === 22 ? "" : `:${profile.port}`;
    lines.push(`${marker} ${name}: ${profile.user}@${profile.host}${port}`);
    lines.push(`    auth: ${describeAuth(profile)}`);
    if (profile.jump?.type === "ssh") lines.push(`    jump: ssh via ${profile.jump.via}`);
    if (profile.jump?.type === "jumpserver") {
      const open = hasJumpSession(name) ? "session open" : "no open session";
      lines.push(`    jump: jumpserver${profile.jump.asset ? `, asset ${profile.jump.asset}` : ""} (${open})`);
    }
    if (profile.strictHostKey === false) {
      lines.push("    host key checking is OFF for this profile");
    }
  }

  return [`SSH hosts (${names.length}), * marks the active one:`, ...lines].join("\n");
}

export function formatIdentity(identity: ServerIdentity): string {
  return [
    `Connected: ${identity.user}@${identity.host}:${identity.port}`,
    `Authenticated with: ${identity.authMethod}`,
    `Host key: ${identity.keyType} ${identity.fingerprint} (${identity.hostKeyVerdict})`,
  ].join("\n");
}

export function formatExecResult(result: ExecResult): string {
  const sections: string[] = [];
  const status =
    result.code === 0
      ? "exit 0"
      : result.signal
        ? `killed by ${result.signal}`
        : `exit ${result.code}`;

  sections.push(`$ ${result.command}`);
  sections.push(`[${status}, ${result.durationMs} ms]`);

  if (result.stdout.trim()) {
    sections.push("", result.stdout.replace(/\s+$/, ""));
  }
  if (result.stderr.trim()) {
    sections.push("", "stderr:", result.stderr.replace(/\s+$/, ""));
  }
  if (!result.stdout.trim() && !result.stderr.trim()) {
    sections.push("", "(no output)");
  }
  return sections.join("\n");
}

export function formatDirectory(
  entries: ReadonlyArray<RemoteEntry>,
  remotePath: string,
): string {
  if (entries.length === 0) {
    return `${remotePath} is empty.`;
  }

  const lines = entries.map((entry) => {
    const suffix = entry.type === "directory" ? "/" : entry.type === "symlink" ? "@" : "";
    const size = entry.type === "directory" ? "" : ` ${formatBytes(entry.size)}`;
    const date = entry.modified ? ` ${entry.modified.slice(0, 10)}` : "";
    return `${entry.mode}${date}${size}  ${entry.name}${suffix}`;
  });

  return [`${remotePath} (${entries.length} entries):`, ...lines].join("\n");
}

export function formatTransfer(result: TransferResult, direction: "up" | "down"): string {
  return direction === "up"
    ? `Uploaded ${result.localPath} to ${result.remotePath} (${formatBytes(result.size)}).`
    : `Downloaded ${result.remotePath} to ${result.localPath} (${formatBytes(result.size)}).`;
}

export function formatAuthorizeResult(result: AuthorizeResult): string {
  const lines = [
    result.installed
      ? `Key installed on the remote host and recorded in profile "${result.profile}".`
      : `The key was already in ${result.authorizedKeysPath}; profile "${result.profile}" now uses it.`,
    "",
    `Private key: ${result.keyPath}`,
    `Public key:  ${result.publicKeyPath}`,
    `Fingerprint: ${result.fingerprint}`,
    "",
    result.verified
      ? "Verified: a fresh connection authenticated with the key alone, so no password is needed from now on."
      : "Warning: the key was installed but a key-only login could not be verified. The password is still in the profile as a fallback.",
  ];
  return lines.join("\n");
}

/** One line describing where a forward starts and where it ends. */
export function describeTunnel(definition: TunnelDefinition): string {
  const bind = definition.bind ?? "127.0.0.1";
  const listen = `${bind}:${definition.listenPort === 0 ? "(free port)" : definition.listenPort}`;
  const dest = `${definition.destHost}:${definition.destPort}`;

  return definition.kind === "local"
    ? `local ${listen} -> ${dest} (reached from the server)`
    : `remote ${listen} on the server -> ${dest} (reached from this machine)`;
}

export function formatTunnelStarted(
  tunnel: RunningTunnel,
  profile: SshProfile,
): string {
  const bind = tunnel.definition.bind ?? "127.0.0.1";
  const lines = [
    `Tunnel "${tunnel.name}" is up: ${describeTunnel(tunnel.definition)}`,
    tunnel.definition.kind === "local"
      ? `Connect to ${tunnel.listenAddress} on this machine.`
      : `On ${profile.host}, connect to ${tunnel.listenAddress}.`,
    "",
    "It keeps running in the background until you stop it with ssh_tunnel action stop"
      + (tunnel.expiresAt ? `, or automatically at ${tunnel.expiresAt.slice(11, 19)} UTC.` : ", or the pi session ends."),
  ];

  if (bind !== "127.0.0.1" && bind !== "localhost") {
    lines.push(
      "",
      `Note: this binds ${bind}, not loopback, so anything that can reach that interface can use the tunnel.`,
    );
  }
  return lines.join("\n");
}

export function formatTunnelList(
  running: ReadonlyArray<RunningTunnel>,
  defined: ReadonlyArray<{ profile: string; name: string; definition: TunnelDefinition }>,
): string {
  const sections: string[] = [];

  if (running.length === 0) {
    sections.push("No tunnels are running.");
  } else {
    sections.push(`Running tunnels (${running.length}):`);
    for (const tunnel of running) {
      sections.push(
        `- ${tunnel.profile}/${tunnel.name}: ${describeTunnel(tunnel.definition)}`,
        `  listening on ${tunnel.listenAddress}, ${tunnel.connections} connection(s) since ${tunnel.startedAt.slice(11, 19)} UTC`
          + (tunnel.expiresAt ? `, closes at ${tunnel.expiresAt.slice(11, 19)} UTC` : ""),
      );
    }
  }

  if (defined.length > 0) {
    const runningIds = new Set(running.map((tunnel) => `${tunnel.profile}:${tunnel.name}`));
    sections.push("", `Defined in profiles (${defined.length}):`);
    for (const entry of defined) {
      const state = runningIds.has(`${entry.profile}:${entry.name}`) ? " [running]" : "";
      const purpose = entry.definition.description ? ` -- ${entry.definition.description}` : "";
      sections.push(
        `- ${entry.profile}/${entry.name}${state}: ${describeTunnel(entry.definition)}${purpose}`,
      );
    }
  } else if (running.length === 0) {
    sections.push(
      "",
      "Define one with ssh_tunnel action define, so it can be started by name later.",
    );
  }

  return sections.join("\n");
}
