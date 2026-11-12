/**
 * pi SSH Extension
 *
 * Runs commands and moves files on remote hosts over SSH, and can turn a
 * password login into a key login without any external tooling.
 *
 * Tools:
 *   - ssh_setup: Store a host, user and credentials
 *   - ssh_status: List configured hosts, optionally testing a connection
 *   - ssh_profile: List, switch or delete hosts
 *   - ssh_exec: Run a command and return its output and exit code
 *   - ssh_list: List a remote directory over SFTP
 *   - ssh_upload: Copy a file to the remote host
 *   - ssh_download: Copy a file from the remote host
 *   - ssh_keygen: Create an ed25519 key pair in process
 *   - ssh_authorize: Install a key on a host and stop needing the password
 *   - ssh_doctor: Report what the environment can do and what needs fixing
 *   - ssh_tunnel: Open, close and list port forwards, and store named ones
 *
 * Nothing here shells out: ssh2 is a pure JavaScript SSH implementation and
 * keys are generated with Node's own crypto, so Windows, macOS and Linux all
 * work without ssh, ssh-keygen or ssh-copy-id being installed.
 *
 * Data-oriented design:
 *   - All domain data is represented as plain immutable interfaces (types.ts)
 *   - I/O is isolated in the client module (clients/)
 *   - Pure helpers have no sockets in them (keys.ts, known-hosts.ts, formatting/)
 *   - Each tool is a single-responsibility module (tools/)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, getConfig, getProfiles } from "./src/config.ts";
import { SshSetupTool } from "./src/tools/ssh-setup.ts";
import { SshStatusTool } from "./src/tools/ssh-status.ts";
import { SshProfileTool } from "./src/tools/ssh-profile.ts";
import { SshExecTool } from "./src/tools/ssh-exec.ts";
import { SshListTool } from "./src/tools/ssh-list.ts";
import { SshUploadTool } from "./src/tools/ssh-upload.ts";
import { SshDownloadTool } from "./src/tools/ssh-download.ts";
import { SshKeygenTool } from "./src/tools/ssh-keygen.ts";
import { SshAuthorizeTool } from "./src/tools/ssh-authorize.ts";
import { SshDoctorTool } from "./src/tools/ssh-doctor.ts";
import { SshTunnelTool } from "./src/tools/ssh-tunnel.ts";
import { listTunnels, onTunnelsChanged, stopAllTunnels } from "./src/tunnels.ts";
import { closeAllJumpSessions, closeJumpSession, hasJumpSession } from "./src/jumpserver.ts";
import { createJmsHandler } from "./src/jms-command.ts";
import { createTunnelIndicator } from "./src/ui.ts";

export default function (pi: ExtensionAPI) {
  // Load saved hosts on startup
  loadConfig();

  // Register all tools
  pi.registerTool(SshSetupTool);
  pi.registerTool(SshStatusTool);
  pi.registerTool(SshProfileTool);
  pi.registerTool(SshExecTool);
  pi.registerTool(SshListTool);
  pi.registerTool(SshUploadTool);
  pi.registerTool(SshDownloadTool);
  pi.registerTool(SshKeygenTool);
  pi.registerTool(SshAuthorizeTool);
  pi.registerTool(SshDoctorTool);
  pi.registerTool(SshTunnelTool);

  // A tunnel is the one thing here that outlives its tool call, so it must
  // not outlive the session that opened it.
  pi.on("session_shutdown", async () => {
    closeAllJumpSessions();
    await stopAllTunnels();
  });

  // ...and while it is open it stays on screen. The context carrying the
  // interface only arrives with an event, so the indicator is wired up on the
  // first one and refreshed whenever a tunnel comes or goes.
  let showTunnels: ((tunnels: ReturnType<typeof listTunnels>) => void) | null = null;
  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    showTunnels = createTunnelIndicator(ctx as never);
    showTunnels(listTunnels());
  });
  onTunnelsChanged((tunnels) => showTunnels?.(tunnels));

  // Run something on the active host without spelling out the tool call
  pi.registerCommand("ssh", {
    description: "Run a command on the active SSH host",
    handler: async (args, ctx) => {
      if (!getConfig()) {
        ctx.ui.notify("No SSH host configured. Use the ssh_setup tool first.", "error");
        return;
      }

      const command = args.trim();
      if (!command) {
        ctx.ui.notify("Usage: /ssh <command to run on the remote host>", "info");
        return;
      }

      pi.sendUserMessage(
        `Run this on the active SSH host with ssh_exec and show me the output: ${command}`,
        { deliverAs: "steer" },
      );
      ctx.ui.notify("Running on the remote host...", "info");
    },
  });

  // Like /ssh, but for JumpServer profiles: /jms [<profile>] <command>
  let jmsCtx: { ui: { notify(m: string, l?: string): void } } | null = null;
  const jms = createJmsHandler({
    profiles: getProfiles,
    hasSession: hasJumpSession,
    closeSession: closeJumpSession,
    closeAll: closeAllJumpSessions,
    send: (message) => pi.sendUserMessage(message, { deliverAs: "steer" }),
    notify: (message, level) => jmsCtx?.ui.notify(message, level),
  });
  pi.registerCommand("jms", {
    description: "Run a command on a JumpServer profile (/jms [profile] <command>, list, use, close)",
    getArgumentCompletions: (prefix: string) => {
      const names = Object.entries(getProfiles())
        .filter(([, p]) => p.jump?.type === "jumpserver")
        .map(([n]) => n);
      const words = ["list", "use", "close", ...names];
      const items = words.filter((w) => w.startsWith(prefix)).map((w) => ({ value: w, label: w }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      jmsCtx = ctx as never;
      jms(args);
    },
  });

  // The one-time setup people forget until they are typing a password again
  pi.registerCommand("ssh-key", {
    description: "Set up passwordless login for the active SSH host",
    handler: async (_args, ctx) => {
      if (!getConfig()) {
        ctx.ui.notify("No SSH host configured. Use the ssh_setup tool first.", "error");
        return;
      }

      pi.sendUserMessage(
        "Use ssh_authorize on the active SSH profile to generate a key, install it on the host and verify that a key-only login works. Tell me the fingerprint and whether the verification succeeded.",
        { deliverAs: "steer" },
      );
      ctx.ui.notify("Setting up key-based login...", "info");
    },
  });
}
