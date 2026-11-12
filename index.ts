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

import { loadConfig, getConfig, getProfile, getProfiles } from "./src/config.ts";
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
import { renderJmsResult } from "./src/jms-render.ts";
import { buildServerModePrompt } from "./src/jms-mode.ts";
import { openGuardedSession, openGuardedShell, runGuardedExec } from "./src/tools/ssh-exec.ts";
import { RESET_TERMINAL, pumpShell } from "./src/jms-shell.ts";

const JMS_ENTRY = "jms-result";
const JMS_MODE_ENTRY = "jms-mode";
const JMS_STATUS = "jms";
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
    restoreServerMode(ctx as any);
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

  // "Inside a server": while set, every turn tells the AI which JumpServer host
  // it is operating, and ssh_exec calls that forget the profile are pointed at it.
  let aiTarget: string | null = null;
  const showTarget = (ui: any) => ui?.setStatus?.(JMS_STATUS, aiTarget ? `jms:${aiTarget}` : undefined);

  function restoreServerMode(ctx: any) {
    // WHY: /reload rebuilds the extension, so the mode is read back from the
    // last jms-mode entry of the session. A profile that no longer exists or is
    // no longer a JumpServer host is dropped rather than trusted.
    try {
      let last: string | null = null;
      for (const e of ctx?.sessionManager?.getEntries?.() ?? []) {
        if (e?.type === "custom" && e.customType === JMS_MODE_ENTRY) last = e.data?.profile ?? null;
      }
      aiTarget = last && getProfile(last)?.jump?.type === "jumpserver" ? last : null;
    } catch {
      aiTarget = null;
    }
    showTarget(ctx?.ui);
  }

  pi.on("before_agent_start", async (event: any) => {
    const profile = aiTarget ? getProfile(aiTarget) : null;
    if (!aiTarget || !profile) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${buildServerModePrompt(aiTarget, profile)}` };
  });

  pi.on("tool_call", async (event: any) => {
    // WHY: a forgotten profile would otherwise fall back to the global active
    // profile, which can be a different machine than the one the user entered.
    if (aiTarget && event.toolName === "ssh_exec" && !event.input?.profile) {
      event.input.profile = aiTarget;
    }
    return undefined;
  });

  // Like /ssh, but for JumpServer profiles: /jms [<profile>] <command>.
  // Runs the command itself (no model round-trip) and shows the raw output.
  let cmdCtx: any = null;
  const jms = createJmsHandler({
    profiles: getProfiles,
    hasSession: hasJumpSession,
    closeSession: closeJumpSession,
    closeAll: closeAllJumpSessions,
    connect: async (profile) => {
      const { reused } = await openGuardedSession(
        { profile },
        cmdCtx?.signal ?? new AbortController().signal,
        cmdCtx,
      );
      return { reused };
    },
    setTarget: (profile) => {
      aiTarget = profile;
      pi.appendEntry(JMS_MODE_ENTRY, { profile });
      showTarget(cmdCtx?.ui);
    },
    shell: async (profile) => {
      const ctx = cmdCtx;
      if (ctx?.mode !== "tui") {
        throw new Error(
          "An interactive shell needs the pi terminal UI. Use /jms connect <profile> or /jms <profile> <command> here.",
        );
      }
      const sh = await openGuardedShell(
        { profile, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 },
        ctx.signal ?? new AbortController().signal,
        ctx,
      );
      let reason = "error";
      try {
        // WHY: ui.custom hands us the TUI. Stopping it releases the terminal,
        // then stdin/stdout are wired straight to the remote channel until it
        // ends; restarting redraws pi. Same technique as pi's interactive-shell example.
        reason = await ctx.ui.custom<string>((tui: any, _theme: unknown, _kb: unknown, done: (r: string) => void) => {
          tui.stop();
          process.stdout.write("\x1b[2J\x1b[H");
          if (sh.buffered) process.stdout.write(sh.buffered);
          process.stdin.setRawMode?.(true);
          process.stdin.resume();
          pumpShell(sh.stream as any, { input: process.stdin, output: process.stdout })
            .catch(() => "remote-exit" as const)
            .then((r) => {
              process.stdin.setRawMode?.(false);
              process.stdin.pause();
              process.stdout.write(`${RESET_TERMINAL}\x1b[2J\x1b[H`);
              tui.start();
              tui.requestRender(true);
              done(r);
            });
          return { render: () => [], invalidate: () => {} };
        });
      } finally {
        sh.close();
        sh.ended(reason);
      }
      return { reason };
    },
    run: async (profile, command) => {
      const { result } = await runGuardedExec(
        { profile, command },
        cmdCtx?.signal ?? new AbortController().signal,
        cmdCtx,
      );
      return {
        output: result.stdout + (result.stderr ? `\n${result.stderr}` : ""),
        exitCode: result.code,
        durationMs: result.durationMs,
        truncated: result.truncated,
      };
    },
    show: (entry) => pi.appendEntry(JMS_ENTRY, entry),
    share: (text) => pi.sendUserMessage(text),
    notify: (message, level) => cmdCtx?.ui.notify(message, level),
  });
  pi.registerEntryRenderer(JMS_ENTRY, (entry: any, options: any, theme: any) => ({
    render: (width: number) =>
      renderJmsResult(entry.data, width, Boolean(options?.expanded), {
        dim: (s) => theme.fg("dim", s),
        ok: (s) => theme.fg("success", s),
        bad: (s) => theme.fg("error", s),
        accent: (s) => theme.fg("accent", s),
      }, options?.keyHint?.("app.tools.expand", "expand") ?? "expand"),
    invalidate: () => {},
  }));
  pi.registerCommand("jms", {
    description: "Run a command on a JumpServer profile and show its output (/jms <profile> enters a server for the AI to operate; exit, shell, use, share, close; /jms [profile] <command> runs one directly)",
    getArgumentCompletions: (prefix: string) => {
      const names = Object.entries(getProfiles())
        .filter(([, p]) => p.jump?.type === "jumpserver")
        .map(([n]) => n);
      const words = ["list", "exit", "shell", "use", "share", "close", ...names];
      const items = words.filter((w) => w.startsWith(prefix)).map((w) => ({ value: w, label: w }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      cmdCtx = ctx;
      await jms(args);
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
