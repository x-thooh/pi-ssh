---
name: ssh-remote-work
description: Work on a remote machine over SSH - run commands, inspect logs and configuration, and move files with SFTP. Use whenever the task belongs on another host, for example deploying or restarting a service, reading logs on a server, checking disk or process state, copying a build artefact to or from a machine, or anything the user describes as "on the server", "on the NAS", "on staging", or by a hostname. Also covers what to do when a connection fails and how to read a host key warning.
allowed-tools: ssh_status, ssh_profile, ssh_exec, ssh_list, ssh_upload, ssh_download, ssh_doctor
---

# Working on a remote host

Commands run through `ssh_exec` land on someone's actual machine. That is the
whole value and also the whole risk: there is no undo, and the blast radius is
whatever the account can reach.

## Before the first command

`ssh_status` shows which hosts are configured and which one is active. **When
more than one exists, pass `profile` explicitly** rather than relying on
whichever was active from an earlier session - "restart nginx" on the wrong
host is not recoverable by apologising.

If the user names a host you have no profile for, say so and ask for the
details rather than guessing at a hostname.

## Running commands

`ssh_exec` opens a connection, runs one command, and closes it. There is no
persistent shell, which has two consequences worth remembering:

- **State does not carry over.** `cd /var/log` in one call does not affect the
  next. Use the `cwd` parameter, or chain with `&&` in a single command.
- **There is no TTY.** Anything interactive hangs until the timeout: `sudo`
  that prompts for a password, `top`, `vim`, `apt` without `-y`. Use
  non-interactive forms (`sudo -n`, `apt-get -y`, `systemctl --no-pager`), and
  if a password prompt is genuinely needed, tell the user rather than trying to
  feed it in.

Read the exit code, not just the output. A command that printed nothing and
exited 1 failed; reporting "done" because stdout was empty is wrong.

## Confirmation and safety

Read-only commands (`ls`, `cat`, `grep`, `df`, `systemctl status`, `docker ps`,
...) run directly. Anything else prompts the human, and so do uploads, tunnel
starts and credential changes. A denial means stop: do not retry, rephrase or
split the command to get around it. Never obfuscate a command (variable
assignments, `$(...)`, encoding, `sh -c`) to dodge classification; that only
makes it prompt. With no UI everything non-read-only is denied. Every call is
logged to `~/.pi/ssh-audit.jsonl`.

## JumpServer and jump hosts

A profile with `jump.type: "jumpserver"` is reached through a bastion menu. Only `ssh_exec` works: the shell is persistent (a `cd` sticks), stderr is merged into stdout, and commands run one at a time. Uploads, downloads, listings and tunnels are refused for it. Profiles with `jump.type: "ssh"` hop through another profile and support everything except tunnels. If a JumpServer login fails, the error shows the last output of the menu: compare it with `jump.steps`.

## Reading before writing

Prefer commands that observe over commands that change, and look before you
act: `systemctl status` before `systemctl restart`, `ls` before `rm`, a diff
before an overwrite.

For anything destructive or disruptive - deleting files, restarting services,
changing configuration, `chmod`/`chown` on system paths, package installs,
anything with `sudo` - **say what you are about to run and why, and let the
user confirm**, unless they already asked for exactly that. Piping a remote
script into a shell (`curl ... | sh`) is not something to do on someone's
server on your own initiative.

## Files

`ssh_list` gives a structured listing with sizes, modes and dates - use it
rather than parsing `ls` output. `ssh_download` and `ssh_upload` move files
over SFTP; prefer them over `cat`-ing a file through `ssh_exec`, which mangles
binaries and pushes the whole content through the model for nothing.

## When it does not connect

The error usually says which layer failed. Work from it rather than retrying:

- **"not in known_hosts"** - the host has never been seen. The tool itself
  prompts the human to trust the fingerprint; `acceptNewHostKey` is ignored,
  so do not pass it. If the human rejects, stop.
- **"HOST KEY CHANGED"** - stop. This is either a reinstalled server or
  someone between you and it. Never work around it by disabling host key
  checking. Relay the message; the user has to resolve it deliberately.
- **"rejected the credentials"** - user name, password or key is wrong, or the
  key is not in the remote authorized_keys. `ssh_authorize` fixes the last one.
- **"refused the connection"** - nothing is listening: wrong port, or sshd is
  down.
- Something about the local environment - run `ssh_doctor`, which reports what
  is missing and what to do about it.

## Tunnels

`ssh_tunnel` is the one tool here whose effect outlives the call: a forward
keeps running until stopped, its time limit expires, or the session ends.

- Start one only when something actually needs it, and tell the user it is
  running and how to reach it.
- Open tunnels are shown in pi's widget above the editor and summarised in the
  footer for as long as they last, so the user can see them without asking.
  `ssh_tunnel action list` and `ssh_status` give the same information on
  demand; check one of them before starting another tunnel for the same
  purpose.
- Stop tunnels when the work that needed them is done rather than leaving them
  open for the rest of the session.
- `bind` defaults to loopback. Do not set it to `0.0.0.0` unless the user asked
  for the service to be reachable from other machines, and say plainly what
  that exposes when you do.

## What to report back

Give the user the command's actual output and its exit code. When a command
failed, quote stderr rather than summarising it - the exact message is what
they need. Say which host you ran it on.

`/jms <profile>` opens an interactive terminal for the human only. It is not available to you as a tool: never suggest running it yourself, and for commands use ssh_exec.
