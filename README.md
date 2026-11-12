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

**JumpServer.** After SSH login to the bastion (its host key is checked against known_hosts as usual) pi answers the menu like an `expect` script: `Opt>` -> `p`, `[Host]>` -> asset, `ID>` -> account (default `1`). A `(yes/no)` prompt is answered with `yes`. Override the script for other versions with `jump.steps`: `[{ "expect": "regex", "send": "text with {asset} {account} {password}", "secret": true }]`. Login times out after 30s and the error shows the last 400 characters of sanitized output (password redacted). `idleTimeoutMs` (default 300000) closes an unused session; sessions also close when pi shuts down.

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

## Skills

| Skill | Purpose |
|-------|---------|
| `ssh-remote-work` | Choosing the right host, the absence of a shell and a TTY, reading before writing, and what each connection error actually means. |
| `ssh-key-setup` | The password-to-key switch, why an existing key is never overwritten, and why the password stays until the key is proven. |

## Host key verification

Host keys are checked against `~/.ssh/known_hosts` — the same file OpenSSH uses, so hosts you have already visited with `ssh` are recognised, and hosts recorded here are recognised by `ssh`. Hashed entries (`ssh-keygen -H`) and `[host]:port` forms are both understood.

- **Unknown host** → the connection is refused and the fingerprint shown. Confirm it, then re-run with `acceptNewHostKey: true` to record it.
- **Changed key** → a hard failure with both fingerprints. This is what a machine-in-the-middle looks like; it is also what a reinstalled server looks like. It has to be resolved deliberately with `ssh-keygen -R <host>`.
- **Revoked key** (`@revoked` in known_hosts) → always refused.

`strictHostKey: false` in a profile turns the check off. It removes the only protection SSH has against an attacker on the network path, so it exists for throwaway lab machines and nothing else.

## Configuration

Profiles live in `~/.pi/ssh-config.json`, written atomically with mode `0600` because it can hold passwords and key passphrases.

```json
{
  "profiles": {
    "staging": {
      "host": "staging.example.com",
      "port": 22,
      "user": "deploy",
      "privateKeyPath": "/home/pat/.ssh/id_ed25519_pi_staging"
    }
  },
  "activeProfile": "staging"
}
```

Every tool also takes a one-off `profile` parameter, so several hosts can be used in one session without switching.

### Editing the file by hand

The file is safe to edit while pi is running, and safe to share with a second pi session:

- **Writes merge.** Every write re-reads the file first and applies only its own change, so a host you added by hand — or one another session added — is not erased by an unrelated write from pi.
- **Outside edits are picked up** without restarting pi; the next tool call sees them.
- **Unknown keys survive.** A top-level key this version does not understand, or an extra field inside a profile such as a comment, is written back untouched.
- **Nothing is rewritten needlessly.** A save that would not change the contents does not touch the file, so mtimes stay put and file watchers stay quiet.

Writes are atomic: the new contents go to a private temporary file that is renamed into place, so an interrupted write cannot truncate the config.

## Platform support

Windows, macOS and Linux behave the same. Nothing in this package spawns a process — SSH comes from [ssh2](https://github.com/mscdex/ssh2) in pure JavaScript, keys are generated with Node's crypto, and there are no POSIX-only paths. A test asserts all three, so a change that introduces one fails the suite rather than only failing on someone else's machine.

One difference is real and worth knowing: **file permissions are not enforced on Windows.** The config file and private keys are written with mode `0600`, but Windows governs access through ACLs and `chmod` only toggles the read-only bit. `ssh_doctor` reports this as a note on Windows rather than staying quiet about it. The practical answer is the same as everywhere: let the first connection replace the stored password with a key, so the file stops holding a secret at all.

The end-to-end tests need an `sshd` to run against and skip themselves where there is none, which includes Windows.

## Development

```bash
npm install
npm test
npm run test:coverage
```

The suite runs end-to-end against a real OpenSSH server: it starts `sshd` on a loopback port with a host key generated by this package, then exercises the handshake, host key verification (including a simulated key change), exit codes, SFTP, the full key bootstrap, and both tunnel directions with real traffic flowing through them. Those tests skip themselves on machines without `sshd` rather than failing.

## License

MIT
