/**
 * What the AI is told while the user is "inside" a JumpServer host (/jms <profile>).
 * Pure text, appended to the system prompt per turn and gone as soon as the
 * user leaves, so nothing about it lingers in the session history.
 */

import type { SshProfile } from "./types.ts";

export function buildServerModePrompt(name: string, profile: SshProfile): string {
  const asset = (profile.jump as { asset?: string } | undefined)?.asset ?? "(unset)";
  return `## Remote server mode

The user has entered the server profile "${name}" (${profile.user}@${profile.host}:${profile.port}, JumpServer asset ${asset}) with /jms. Requests such as "check the disk", "look at the nginx log" or "restart the service" are about THAT server unless they clearly say otherwise.

- Do the work with ssh_exec and pass profile "${name}" every time. ssh_list, ssh_upload, ssh_download and ssh_tunnel do not work through JumpServer; read files with cat, head, tail, ls and friends instead.
- Your bash, read, write and edit tools act on the user's own machine, not the server. Do not use them for server work.
- The server shell is persistent and shared: a cd sticks between calls, stderr is merged into stdout, and calls run one at a time.
- There is no TTY. Do not run vim, top, less, or anything that waits for input or a sudo password. Use non-interactive forms (top -bn1, journalctl --no-pager, cat).
- Read-only commands run straight away. Anything that changes the server asks the human first. If they deny it, stop and ask what they want instead; never rephrase, split or obfuscate a command to get past a denial.
- Look before you change: inspect, say what you intend to change and why, then do it.
- Keep output small. A result over about 3.8 KB is cut to its head and tail (the note says what was left out and where the full text is saved; read that file with offset/limit instead of running the command again). Prefer narrow commands: df -h -x tmpfs -x devtmpfs -x overlay, ps aux --sort=-%mem | head -15, ls -lA | head -40, journalctl -n 50 --no-pager, grep -c / -m. Put independent read-only checks in ONE command, e.g. hostname; uptime; free -m, instead of several calls.
- Never read or print credential files (.netrc, .npmrc, .ssh, .bash_history, env dumps) unless the user explicitly asks.`;
}
