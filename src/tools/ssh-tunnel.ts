/**
 * ssh_tunnel tool -- Port forwarding, and the named forwards a profile keeps.
 *
 * Both the running tunnels and their stored definitions live here because
 * they are the same subject from a user's point of view: define a forward
 * once, then start and stop it by name.
 */

import { Type } from "typebox";
import { getProfiles, resolveProfile, updateProfile } from "../config.ts";
import { resolveForConnection, withNote } from "./shared.ts";
import { guard, withHostKeyApproval, type GuardContext } from "../guard.ts";
import {
  listTunnels,
  startTunnel,
  stopAllTunnels,
  stopTunnel,
  validateDefinition,
} from "../tunnels.ts";
import { formatTunnelList, formatTunnelStarted } from "../formatting/formatters.ts";
import type { TunnelDefinition } from "../types.ts";
import { TunnelError } from "../types.ts";

const ACTIONS = new Set(["start", "stop", "stop-all", "list", "define", "forget"]);

function buildDefinition(params: {
  kind?: string;
  listenPort?: number;
  bind?: string;
  destHost?: string;
  destPort?: number;
  description?: string;
}): TunnelDefinition {
  const definition: TunnelDefinition = {
    kind: (params.kind ?? "local") as TunnelDefinition["kind"],
    listenPort: params.listenPort ?? 0,
    destHost: params.destHost ?? "",
    destPort: params.destPort ?? 0,
    ...(params.bind ? { bind: params.bind } : {}),
    ...(params.description ? { description: params.description } : {}),
  };
  validateDefinition(definition);
  return definition;
}

export const SshTunnelTool = {
  name: "ssh_tunnel",
  label: "SSH Tunnel",
  description:
    "Open, close and list SSH port forwards, and store named ones in a profile. A local tunnel makes a service behind the server reachable on this machine (like ssh -L); a remote tunnel makes something on this machine reachable from the server (like ssh -R). Unlike the other tools, a tunnel keeps running after the call returns, until it is stopped, its time limit expires, or the pi session ends.",
  parameters: Type.Object({
    action: Type.Optional(
      Type.String({
        description:
          "One of: start, stop, stop-all, list, define, forget. Defaults to list. 'define' stores a named tunnel in the profile; 'start' runs one, by name or from the ports given here.",
        default: "list",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Name of the tunnel. Required for define, forget and stop; for start it selects a stored definition.",
      }),
    ),
    kind: Type.Optional(
      Type.String({
        description:
          "local (this machine listens, the server reaches the destination) or remote (the server listens, this machine reaches the destination). Default local.",
        default: "local",
      }),
    ),
    listenPort: Type.Optional(
      Type.Number({
        description:
          "Port the tunnel accepts connections on: local to this machine for a local tunnel, on the server for a remote one. 0 picks a free port.",
      }),
    ),
    bind: Type.Optional(
      Type.String({
        description:
          "Interface that port binds to. Default 127.0.0.1. Using 0.0.0.0 exposes the forwarded service to the whole network, and for a remote tunnel the server also needs GatewayPorts enabled.",
      }),
    ),
    destHost: Type.Optional(
      Type.String({
        description:
          "Host the traffic is delivered to, resolved from the server for a local tunnel and from this machine for a remote one.",
      }),
    ),
    destPort: Type.Optional(Type.Number({ description: "Port on destHost." })),
    description: Type.Optional(
      Type.String({ description: "What this tunnel is for, shown in listings." }),
    ),
    durationSeconds: Type.Optional(
      Type.Number({
        description: "Close the tunnel automatically after this long. Default: no limit.",
      }),
    ),
    profile: Type.Optional(
      Type.String({ description: "SSH profile to use. Defaults to the active one." }),
    ),
    acceptNewHostKey: Type.Optional(
      Type.Boolean({ description: "Deprecated and ignored: unknown host keys are only recorded after the human approves a prompt.", default: false }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      action?: string;
      name?: string;
      kind?: string;
      listenPort?: number;
      bind?: string;
      destHost?: string;
      destPort?: number;
      description?: string;
      durationSeconds?: number;
      profile?: string;
      acceptNewHostKey?: boolean;
    },
    signal: AbortSignal,
    _onUpdate?: unknown,
    ctx?: GuardContext,
  ) {
    const action = (params.action ?? "list").toLowerCase();
    if (!ACTIONS.has(action)) {
      throw new TunnelError(
        `Unknown action "${params.action}". Use start, stop, stop-all, list, define or forget.`,
      );
    }

    if (action === "list") {
      const running = listTunnels();
      const defined = Object.entries(getProfiles()).flatMap(([profileName, profile]) =>
        Object.entries(profile.tunnels ?? {}).map(([name, definition]) => ({
          profile: profileName,
          name,
          definition,
        })),
      );
      return {
        content: [{ type: "text" as const, text: formatTunnelList(running, defined) }],
        details: { running: running.length, defined: defined.length, tunnels: running },
      };
    }

    if (action === "stop-all") {
      const stopped = await stopAllTunnels();
      return {
        content: [
          {
            type: "text" as const,
            text: stopped === 0 ? "No tunnels were running." : `Stopped ${stopped} tunnel(s).`,
          },
        ],
        details: { stopped },
      };
    }

    if (!params.name) {
      throw new TunnelError(`The "${action}" action requires a tunnel name.`);
    }

    if (action === "define") {
      const { name: profileName, profile } = resolveProfile(params.profile);
      const definition = buildDefinition(params);
      updateProfile(profileName, {
        tunnels: { ...(profile.tunnels ?? {}), [params.name]: definition },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Tunnel "${params.name}" defined for profile "${profileName}". Start it with ssh_tunnel action start, name ${params.name}.`,
          },
        ],
        details: { profile: profileName, name: params.name, definition },
      };
    }

    if (action === "forget") {
      const { name: profileName, profile } = resolveProfile(params.profile);
      const tunnels = { ...(profile.tunnels ?? {}) };
      const existed = params.name in tunnels;
      delete tunnels[params.name];
      updateProfile(profileName, { tunnels });
      return {
        content: [
          {
            type: "text" as const,
            text: existed
              ? `Tunnel "${params.name}" removed from profile "${profileName}".`
              : `Profile "${profileName}" has no tunnel called "${params.name}".`,
          },
        ],
        details: { profile: profileName, name: params.name, removed: existed },
      };
    }

    if (action === "stop") {
      const { name: profileName } = resolveProfile(params.profile);
      const stopped = await stopTunnel(profileName, params.name);
      return {
        content: [
          {
            type: "text" as const,
            text: stopped
              ? `Tunnel "${params.name}" stopped.`
              : `No running tunnel called "${params.name}" for profile "${profileName}".`,
          },
        ],
        details: { profile: profileName, name: params.name, stopped },
      };
    }

    // start
    const resolved = resolveProfile(params.profile);
    const stored = resolved.profile.tunnels?.[params.name];
    if (resolved.profile.jump) {
      throw new Error(
        "ssh_tunnel is not supported for profiles with a jump configuration (JumpServer or ssh hop).",
      );
    }
    const definition =
      params.destHost || params.destPort ? buildDefinition(params) : stored;

    if (!definition) {
      const available = Object.keys(resolved.profile.tunnels ?? {});
      throw new TunnelError(
        `No tunnel called "${params.name}" is defined for profile "${resolved.name}"${
          available.length > 0 ? ` (available: ${available.join(", ")})` : ""
        }, and no destHost/destPort were given to build one.`,
      );
    }
    validateDefinition(definition);

    const bind = definition.bind ?? "127.0.0.1";
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(bind);
    const spec = `${definition.kind} ${bind}:${definition.listenPort} -> ${definition.destHost}:${definition.destPort}`;
    await guard(ctx, {
      tool: "ssh_tunnel",
      profile: resolved.name,
      target: spec,
      verdict: "confirm",
      message: `Profile: ${resolved.name}\nKind: ${definition.kind}\nBind: ${bind}\nListen port: ${definition.listenPort}\nDestination: ${definition.destHost}:${definition.destPort}${
        loopback ? "" : `\n\n!!! WARNING: bind ${bind} is not loopback: this exposes the forwarded service to the network !!!`
      }`,
    });

    const { profileName, profile, note, running } = await withHostKeyApproval(
      ctx,
      { name: resolved.name, ...resolved.profile },
      async (accept) => {
        const c = await resolveForConnection(params.profile, { acceptNewHostKey: accept, signal });
        const running = await startTunnel({
          profileName: c.name,
          profile: c.profile,
          name: params.name as string,
          definition,
          acceptNewHostKey: accept,
          durationSeconds: params.durationSeconds,
          signal,
        });
        return { profileName: c.name, profile: c.profile, note: c.note, running };
      },
    );

    return {
      content: [
        { type: "text" as const, text: withNote(formatTunnelStarted(running, profile), note) },
      ],
      details: { profile: profileName, ...running },
    };
  },
};
