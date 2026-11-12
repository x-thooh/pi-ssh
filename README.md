# pi-ssh

SSH client extension for the [pi coding agent](https://github.com/earendil-works/pi).

Run commands on remote hosts, move files over SFTP, and turn a password login into a key login — all from a pi session.

**Nothing has to be installed.** No `ssh`, no `ssh-keygen`, no `ssh-copy-id`. The SSH protocol comes from [ssh2](https://github.com/mscdex/ssh2), a pure JavaScript implementation, and keys are generated with Node's own crypto. Windows, macOS and Linux behave identically.

## Installation

```bash
# Install from npm
pi install npm:git:github.com/x-thooh/pi-ssh

# Install from local path during development
pi install /path/to/pi-ssh
```

## Quick Start

```
ssh_setup:
  name: staging
  host: staging.example.com
  user: deploy
  password: <password>

ssh_authorize          # generates a key, installs it, verifies passwordless login

ssh_exec:
  command: systemctl status nginx --no-pager
```

The password is only used once. On the **first connection** the extension installs a key on the host and removes the password from the config — see below.

## The password is not kept

A password in a config file stays there for as long as the profile does. So the first time a password-only profile is actually used — the first `ssh_exec`, `ssh_list`, tunnel, anything that connects — the extension:

1. generates an ed25519 key,
2. installs its public key in the remote `~/.ssh/authorized_keys`,
3. opens a second connection using **only** the key to prove it works,
4. writes the key path into the profile and **deletes the stored password**,
5. and then does what you actually asked for.

The tool output says so when this happened, including the fingerprint and where the key was written.

If the upgrade fails — a host with `PubkeyAuthentication no`, an unwritable home directory — the password is kept and the work continues, with the reason in the output. The upgrade is attempted, not enforced: a server that refuses keys would otherwise become unusable.

To keep using a password, set `autoKey: false` in `ssh_setup`. `ssh_authorize` then remains available to do the switch by hand.

## Tools

| Tool | Description |
|------|-------------|
| `ssh_setup` | Store a host: address, user, and a password or key path. |
| `ssh_status` | List configured hosts and how each authenticates; optionally test a connection. |
| `ssh_profile` | List, switch, or delete hosts. |
| `ssh_exec` | Run a command and return its output and exit code. |
| `ssh_list` | List a remote directory with sizes, permissions and dates over SFTP. |
| `ssh_upload` | Copy a file to the remote host. |
| `ssh_download` | Copy a file from the remote host. |
| `ssh_keygen` | Create an ed25519 key pair in process. |
| `ssh_authorize` | Install a key on a host and stop needing the password. |
| `ssh_doctor` | Report what this machine can do and what needs fixing. |
| `ssh_tunnel` | Open, close and list port forwards, and store named ones in a profile. |

### Passwordless login

`ssh_authorize` is `ssh-copy-id` without the binary:

```yaml
ssh_authorize:
  # profile: staging          # defaults to the active one
  # keyPath: ~/.ssh/id_ed25519_pi_staging
  # removePassword: true      # only after verification succeeds
  # authorizedKeysPath: /custom/authorized_keys
```

It generates a key if the profile has none, appends the public key to the remote `~/.ssh/authorized_keys` with the permissions sshd requires, points the profile at the key, and then opens a **second connection using only the key** to prove it works before reporting success. Running it twice is safe: the key is appended only once.

An existing key at the target path is reused, never overwritten — overwriting would invalidate every other host that already trusts it.

### Running commands

```yaml
ssh_exec:
  command: journalctl -u api --since "1 hour ago" --no-pager
  # cwd: /srv/app
  # timeoutSeconds: 120
```

Each call opens a connection, runs one command, and closes it. There is no persistent shell, so `cd` does not carry over — use `cwd` or chain with `&&`. There is also no TTY: anything interactive (a `sudo` password prompt, `top`, an editor) will hang until the timeout.

Output is capped at 200,000 characters per stream and marked as truncated rather than silently cut.

### Files

```yaml
ssh_list:     { path: /var/log }
ssh_download: { remotePath: /var/log/app.log, localPath: ./logs/app.log }
ssh_upload:   { localPath: ./dist/app.tar.gz, remotePath: /tmp/app.tar.gz }
```

Missing local directories are created on download. Prefer these over `cat` through `ssh_exec`: SFTP handles binary content and does not push the file through the model.

### Tunnels

A tunnel is the one thing here that keeps running after its tool call returns — that is what a tunnel is for. It stays up until it is stopped, its time limit expires, or the pi session ends, at which point all of them are closed.

There are two directions, and the difference is whose machine each side refers to:

| Kind | Who listens | Who reaches the destination | OpenSSH equivalent |
|------|-------------|-----------------------------|--------------------|
| `local` | this machine, on `bind:listenPort` | the server, to `destHost:destPort` | `ssh -L` |
| `remote` | the server, on `bind:listenPort` | this machine, to `destHost:destPort` | `ssh -R` |

**Local** is the common case: reach a database, admin interface or internal service that only the server can see.

```yaml
ssh_tunnel:
  action: start
  name: db
  kind: local
  listenPort: 5432          # 0 picks a free port
  destHost: db.internal     # resolved from the server
  destPort: 5432
  # durationSeconds: 3600   # close automatically after an hour
```

Then connect to `127.0.0.1:5432` on this machine as if the database were local.

**Remote** goes the other way: make something running here reachable from the server.

```yaml
ssh_tunnel:
  action: start
  name: preview
  kind: remote
  listenPort: 8080          # the server listens on this
  destHost: 127.0.0.1       # resolved from this machine
  destPort: 3000
```

#### Named tunnels in the profile

Rather than repeating ports, store a tunnel under a name and start it by that name later. Definitions live in the profile in `~/.pi/ssh-config.json`.

```yaml
ssh_tunnel:
  action: define
  name: db
  kind: local
  listenPort: 5432
  destHost: db.internal
  destPort: 5432
  description: production database, read replica
```

```yaml
ssh_tunnel: { action: start, name: db }     # everything else comes from the profile
ssh_tunnel: { action: stop,  name: db }
ssh_tunnel: { action: forget, name: db }    # remove the definition
```

The stored form is plain JSON, so it can be written by hand too:

```json
{
  "profiles": {
    "staging": {
      "host": "staging.example.com",
      "port": 22,
      "user": "deploy",
      "privateKeyPath": "/home/pat/.ssh/id_ed25519_pi_staging",
      "tunnels": {
        "db": {
          "kind": "local",
          "listenPort": 5432,
          "bind": "127.0.0.1",
          "destHost": "db.internal",
          "destPort": 5432,
          "description": "production database, read replica"
        },
        "preview": {
          "kind": "remote",
          "listenPort": 8080,
          "destHost": "127.0.0.1",
          "destPort": 3000
        }
      }
    }
  },
  "activeProfile": "staging"
}
```

| Field | Meaning |
|-------|---------|
| `kind` | `local` or `remote`, per the table above. |
| `listenPort` | Port the tunnel accepts connections on. `0` picks a free one. |
| `bind` | Interface that port binds to. Defaults to `127.0.0.1`. |
| `destHost` / `destPort` | Where traffic is delivered. |
| `description` | Free text, shown in listings. |

#### Always visible while it is open

An open tunnel is shown in pi itself, not only when you ask for it. Each one appears in the widget above the editor:

```
SSH tunnel staging/db: 127.0.0.1:5432 -> db.internal:5432
SSH tunnel staging/preview: 127.0.0.1:8080 <- 127.0.0.1:3000 until 11:30Z
```

and the footer carries a short summary (`SSH tunnel db on 127.0.0.1:5432`, or `2 SSH tunnels open`). Both are cleared the moment the last tunnel closes, so nothing claims a forward is open when it is not.

This is deliberate rather than decorative: a forgotten tunnel is a port on your machine reaching into someone else's network, and a listing that has scrolled out of view does not remind you of it.

In modes without an interface — `rpc`, `json`, `print` — nothing is drawn and nothing fails.

#### Seeing and stopping them

```yaml
ssh_tunnel: { action: list }        # running tunnels and stored definitions
ssh_tunnel: { action: "stop-all" }
```

`ssh_status` also lists anything currently running, so a forgotten tunnel does not stay invisible.

#### Binding to something other than loopback

`bind` defaults to `127.0.0.1`, which means only this machine (or only the server, for a remote tunnel) can use the tunnel. Setting it to `0.0.0.0` publishes the forwarded service to the whole network — the tool output says so when you do. For a remote tunnel, binding anything but loopback additionally needs `GatewayPorts` enabled in the server's `sshd_config`; without it sshd silently binds loopback instead.

#### How long it stays up

A tunnel holds its own SSH connection open and keeps listening after the tool call returns. It ends when:

- you stop it (`action: stop` or `stop-all`),
- its `durationSeconds` expires,
- the underlying SSH connection drops, or
- the pi session ends.

Each tunnel owns its own SSH connection. Sharing one would be tidier on the wire, but a single dropped connection would take every tunnel down with it.

SSH-level keepalives are enabled (every 15s, four unanswered probes before giving up). ssh2 sends none by default, and without them an idle tunnel behind a NAT or a stateful firewall keeps looking alive long after the path has been dropped. With them, a dead connection is noticed within about a minute, the local listener is closed, and the tunnel disappears from `ssh_tunnel list` — rather than accepting connections that silently go nowhere.

There is no automatic reconnect: a tunnel that dies stays dead and has to be started again.

## JumpServer and jump hosts

A profile can reach its host through a JumpServer (Koko) bastion, or by hopping through another profile. Use placeholders below; never commit real hosts or passwords.

```json
{
  "corp-web": {
    "host": "jump.example.com",
    "port": 2222,
    "user": "alice",
    "passwordCmd": "security find-generic-password -s jms -w",
    "jump": { "type": "jumpserver", "asset": "web-01", "account": "1" }
  },
  "inner": {
    "host": "10.0.0.5",
    "port": 22,
    "user": "deploy",
    "privateKeyPath": "~/.ssh/id_ed25519",
    "jump": { "type": "ssh", "via": "gateway" }
  }
}
```

**JumpServer.** After SSH login to the bastion (its host key is checked against known_hosts as usual) pi answers the menu like an `expect` script: `Opt>` -> `p`, `[Host]>` -> asset, `ID>` -> account (default `1`). A `(yes/no)` prompt is answered with `yes`. Override the script for other versions with `jump.steps`: `[{ "expect": "regex", "send": "text with {asset} {account} {password}", "secret": true }]`. Some assets show a protocol menu (`ssh`/`telnet`) before the account menu, and both prompt `ID>`. Pin each one with its own step:

```json
"steps": [
  { "expect": "Opt>", "send": "p" },
  { "expect": "\\[Host\\]>", "send": "{asset}" },
  { "expect": "协议ID[\\s\\S]*ID>", "send": "1" },
  { "expect": "账号ID[\\s\\S]*ID>", "send": "{account}" }
]
```

Use a hostname/IP search string as `asset` (menu row numbers are per page and change); it must match exactly one asset. After each match pi waits for the screen to go quiet before answering, and re-sends its shell init line until the target shell (still printing its MOTD) answers. Login times out after 30s and the error shows the last 800 characters of sanitized output (password redacted). `idleTimeoutMs` (default 300000) closes an unused session; sessions also close when pi shuts down.

**Passwords.** `passwordCmd` (run via `/bin/sh -c`, 10s timeout, trimmed stdout) beats `passwordEnv` (environment variable name), which beats `password`. They are resolved at connect time only and never stored, printed or logged. Profiles with a `jump` of type `jumpserver` are never auto-upgraded to key login.

**Limitations of JumpServer sessions**
- stderr is merged into stdout (`stderr` is always empty).
- One persistent shell per profile: `cd` (including `cwd`) persists between calls, as do exported variables.
- One command at a time per profile; calls are queued. On timeout pi sends Ctrl-C and resyncs; if that fails the session is dropped and the next call logs in again.
- No SFTP (`ssh_upload`/`ssh_download`/`ssh_list`) and no `ssh_tunnel` through JumpServer; use `ssh_exec`.
- Everything is recorded by JumpServer's own session audit.

**SSH hops** (`"type": "ssh"`): pi connects to the `via` profile, forwards to the target, and verifies the target's host key itself. Up to 3 hops; cycles are rejected. `ssh_exec`, `ssh_upload`, `ssh_download` and `ssh_list` work; `ssh_tunnel` does not.

## Commands

| Command | Description |
|---------|-------------|
| `/ssh <command>` | Run a command on the active host. |
| `/ssh-key` | Set up passwordless login for the active host. |
| `/jms` | List JumpServer profiles, their asset and whether a session is open. |
| `/jms <profile>` | **Enter the server**: logs in, runs nothing, and from then on the AI works on that host for you. Just write what you want ("how full is the disk?", "show the last errors in the nginx log"); the AI runs it with `ssh_exec` on that profile. `/jms exit` leaves. |
| `/jms exit` | Leave the server and close its session. |
| `/jms <profile> <command>` | Run one command yourself and show the raw output in the transcript (no model involved). |
| `/jms shell <profile>` | A real interactive terminal for **you** (`vim`, `top`, Ctrl-C ...). `exit` ends it, **Ctrl-]** leaves at once. See below. |
| `/jms use <profile>` | Set the default profile for `/jms <command>`. Entering a server sets it too; running a command never does, so a mistyped name cannot reach the wrong server. |
| `/jms share` | Send the last direct `/jms` result to the model (it is otherwise kept out of its context). |
| `/jms close [profile]` | Close one or all background sessions. |

### Server mode (`/jms <profile>`)

While you are inside a server:

- Every turn the AI is told which host it is on and how to work there: use `ssh_exec` with that profile, no SFTP/tunnels, no TTY (`top -bn1`, not `top`), the shell is persistent and shared, local `bash`/`read`/`write` act on **your** machine, not the server. This is added to the system prompt per turn and disappears when you leave; it is not stored in the conversation.
- An `ssh_exec` call that forgets the profile is pointed at the entered server instead of falling back to the global active profile, which may be a different machine. An explicit profile is respected.
- The footer shows `jms:<profile>`. The mode survives `/reload`.
- Safety is unchanged: read-only commands run, everything else asks you first, hard-denied commands are refused, and every call is audited. Entering shows no prompt (it changes nothing); a new host key still needs your approval.

The AI can read anything the login account can read, so a root profile exposes secrets in files like `.netrc` or `.bash_history`. The prompt tells it not to open credential files unless you ask; that is guidance, not enforcement. For production hosts set the profile's `policy.mode` to `confirm-all`.

### Interactive terminal (`/jms shell <profile>`)

The terminal is opened with its own login to the bastion, separate from the background session used by `/jms <command>`; it is never registered for reuse and is closed when you leave. The model has no tool for this and server mode does not use it: only you can start it, and your keystrokes are the confirmation, so nothing is asked and the command policy does not apply (it cannot, there is no command to classify). pi's audit log records that a shell was opened and how it ended (`jms_shell`); what you type is recorded by JumpServer itself.

Handover works like pi's `interactive-shell` example: the TUI is stopped, stdin/stdout are wired to the remote channel, and the TUI is restarted afterwards. Terminal resizes are passed on. Anything a remote full-screen program leaves switched on (alternate screen, mouse reporting, hidden cursor) is reset when you return.
