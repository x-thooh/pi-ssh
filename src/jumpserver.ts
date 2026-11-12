/**
 * JumpServer (Koko) bastion support.
 *
 * A bastion offers a menu, not a shell, so the login is an expect-style
 * script over a PTY shell channel. After the last menu step the channel is a
 * shell on the target host; commands are then run through that single
 * persistent shell using a unique sentinel line to find the end of output and
 * the exit code.
 *
 * Behaviour worth knowing (also in the README):
 *  - stderr is merged into stdout (`2>&1` inside the shell),
 *  - `cd` persists between calls (one shell per profile),
 *  - one command at a time per profile (calls are queued),
 *  - the session closes after `idleTimeoutMs` without use.
 */

import * as crypto from "node:crypto";
import type { ExecResult, JumpConfig, JumpStep, SshProfile } from "./types.ts";
import { RemoteCommandError } from "./types.ts";
import { connect, MAX_OUTPUT_CHARS, shellQuote, type Connection } from "./clients/ssh-client.ts";
import { resolvePassword } from "./credentials.ts";

const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 30_000;
const RESYNC_TIMEOUT_MS = 5_000;
const TAIL_CHARS = 400;

type JumpServerConfig = Extract<JumpConfig, { type: "jumpserver" }>;

// --- Pure helpers (unit tested) -------------------------------------------

/** Remove ANSI/VT escape sequences and bare carriage returns. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

/**
 * Find `\n__PI_<token>__<code>\n` in the buffer. Returns the output before it
 * (without the one newline the sentinel's printf added) and the exit code.
 */
export function findSentinel(
  buffer: string,
  token: string,
): { output: string; code: number } | null {
  const marker = `\n__PI_${token}__`;
  const at = buffer.indexOf(marker);
  if (at < 0) return null;
  const m = /^(\d+)\n/.exec(buffer.slice(at + marker.length));
  if (!m) return null;
  return { output: buffer.slice(0, at), code: Number(m[1]) };
}

export function defaultSteps(): JumpStep[] {
  return [
    { expect: "Opt>", send: "p" },
    { expect: "\\[Host\\]>", send: "{asset}" },
    { expect: "ID>", send: "{account}" },
  ];
}

const newToken = () => crypto.randomBytes(9).toString("hex");

// --- Session ---------------------------------------------------------------

interface Waiter {
  check(): boolean;
  fail(err: Error): void;
}

export interface JumpRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly acceptNewHostKey?: boolean;
  /** Overall login timeout; default 30s. */
  readonly loginTimeoutMs?: number;
}

export class JumpSession {
  readonly name: string;
  private readonly profile: SshProfile;
  private readonly config: JumpServerConfig;
  private conn: Connection | null = null;
  private stream: NodeJS.ReadWriteStream | null = null;
  private buf = "";
  private waiter: Waiter | null = null;
  private secrets: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly ready: Promise<void>;

  constructor(name: string, profile: SshProfile, options: JumpRunOptions) {
    this.name = name;
    this.profile = profile;
    this.config = profile.jump as JumpServerConfig;
    this.ready = this.login(options);
    this.ready.catch(() => this.close());
  }

  get alive(): boolean {
    return !this.closed;
  }

  // -- low level IO --

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf-8");
    this.waiter?.check();
  }

  private write(text: string): void {
    this.stream?.write(text);
  }

  private wait(check: () => boolean, timeoutMs: number, onTimeout: () => Error): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.waiter = null;
      };
      const timer = setTimeout(() => {
        done();
        reject(onTimeout());
      }, timeoutMs);
      this.waiter = {
        check: () => {
          if (!check()) return false;
          done();
          resolve();
          return true;
        },
        fail: (err) => {
          done();
          reject(err);
        },
      };
      this.waiter.check();
    });
  }

  private tail(): string {
    const clean = redact(stripAnsi(this.buf), this.secrets);
    return clean.slice(-TAIL_CHARS);
  }

  // -- login --

  private async login(options: JumpRunOptions): Promise<void> {
    const password = await resolvePassword(this.profile);
    if (password) this.secrets.push(password);
    const asset = this.config.asset;
    const account = this.config.account ?? "1";
    const steps = this.config.steps ?? defaultSteps();

    // The password was resolved above; do not resolve (run) the command twice.
    this.conn = await connect(
      { ...this.profile, jump: undefined, password, passwordCmd: undefined, passwordEnv: undefined },
      { signal: options.signal, acceptNewHostKey: options.acceptNewHostKey },
    );
    const client = this.conn.client;
    client.on("close", () => this.close());
    client.on("error", () => this.close());

    this.stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      client.shell({ term: "dumb" }, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
    this.stream.on("data", (c: Buffer) => this.onData(c));
    this.stream.on("close", () => {
      this.waiter?.fail(new Error(`JumpServer closed the session. Last output:\n${this.tail()}`));
      this.close();
    });

    const deadline = Date.now() + (options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    const left = () => Math.max(deadline - Date.now(), 1);
    let answeredYesNo = false;

    for (const [i, step] of steps.entries()) {
      const re = new RegExp(step.expect);
      await this.wait(
        () => {
          const text = stripAnsi(this.buf);
          if (!answeredYesNo && /\(yes\/no[^)]*\)\??/.test(text)) {
            answeredYesNo = true;
            this.buf = "";
            this.write("yes\r");
            return false;
          }
          return re.test(text);
        },
        left(),
        () =>
          new Error(
            `JumpServer login timed out at step ${i + 1}/${steps.length} (waiting for /${step.expect}/). Last output:\n${this.tail()}`,
          ),
      );
      const reply = step.send.replace(/\{(asset|account|password)\}/g, (_m, key: string) => {
        const value = key === "asset" ? asset : key === "account" ? account : password;
        if (value === undefined) {
          throw new Error(`Step ${i + 1} uses {${key}} but it is not configured (jump.${key}).`);
        }
        return value;
      });
      if (step.secret) this.secrets.push(reply);
      this.buf = "";
      this.write(`${reply}\r`);
    }

    const ready = newToken();
    this.write(
      `stty -echo 2>/dev/null; export PS1= PS2= TERM=dumb; unset PROMPT_COMMAND; printf '\\n__PI_${ready}__%d\\n' $?\n`,
    );
    await this.wait(
      () => findSentinel(stripAnsi(this.buf), ready) !== null,
      left(),
      () =>
        new Error(
          `JumpServer login: the target shell did not become ready (wrong asset/account or menu mismatch?). Last output:\n${this.tail()}`,
        ),
    );
    this.buf = "";
    this.touch();
  }

  // -- idle handling --

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.config.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    this.idleTimer = setTimeout(() => this.close(), ms);
    this.idleTimer.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.waiter?.fail(new Error("JumpServer session closed."));
    try {
      this.stream?.end();
    } catch {
      /* already gone */
    }
    this.conn?.client.end();
    if (sessions.get(this.name) === this) sessions.delete(this.name);
  }

  // -- commands --

  run(command: string, options: JumpRunOptions = {}): Promise<ExecResult> {
    const result = this.queue.then(() => this.runNow(command, options));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async runNow(command: string, options: JumpRunOptions): Promise<ExecResult> {
    await this.ready;
    if (this.closed) throw new Error("JumpServer session is closed.");
    if (this.idleTimer) clearTimeout(this.idleTimer);

    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const token = newToken();
    const body = options.cwd ? `cd ${shellQuote(options.cwd)} && ${command}` : command;
    const line = `{ ${body} ; } 2>&1; printf '\\n__PI_${token}__%d\\n' $?\n`;

    this.buf = "";
    let truncated = false;
    // Bound memory: keep head and tail of runaway output.
    const bound = () => {
      if (this.buf.length > MAX_OUTPUT_CHARS * 2) {
        truncated = true;
        this.buf = this.buf.slice(0, MAX_OUTPUT_CHARS) + this.buf.slice(-1024);
      }
    };

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      this.waiter?.fail(new Error("Command cancelled."));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (out: string, code: number | null): ExecResult => {
      let text = out.replace(/\r/g, "");
      if (text.startsWith(line)) text = text.slice(line.length);
      if (text.length > MAX_OUTPUT_CHARS) {
        text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated at ${MAX_OUTPUT_CHARS} characters]`;
        truncated = true;
      }
      return {
        command,
        stdout: text,
        stderr: "",
        code,
        durationMs: Date.now() - started,
        truncated,
      };
    };

    try {
      this.write(line);
      await this.wait(
        () => {
          this.buf = this.buf.replace(/\r/g, "");
          bound();
          return findSentinel(this.buf, token) !== null;
        },
        timeoutMs,
        () => new Error("timeout"),
      );
      const found = findSentinel(this.buf, token) as { output: string; code: number };
      this.buf = "";
      return finish(found.output, found.code);
    } catch (err) {
      if (this.closed) throw err;
      const partial = this.buf;
      const isTimeout = (err as Error).message === "timeout";
      if (!isTimeout && !aborted) throw err;
      const ok = await this.resync();
      if (!ok) this.close();
      if (aborted) throw new Error("Command cancelled.");
      throw new RemoteCommandError(
        `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}${ok ? "" : " (session was reset)"}`,
        finish(partial, null),
      );
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (!this.closed) this.touch();
    }
  }

  /** After Ctrl-C, prove the shell is responsive again with a fresh sentinel. */
  private async resync(): Promise<boolean> {
    const token = newToken();
    this.write("\x03");
    await new Promise((r) => setTimeout(r, 100));
    this.buf = "";
    this.write(`printf '\\n__PI_${token}__%d\\n' 0\n`);
    try {
      await this.wait(
        () => {
          this.buf = this.buf.replace(/\r/g, "");
          return findSentinel(this.buf, token) !== null;
        },
        RESYNC_TIMEOUT_MS,
        () => new Error("resync failed"),
      );
      this.buf = "";
      return true;
    } catch {
      return false;
    }
  }
}

// --- Registry --------------------------------------------------------------

const sessions = new Map<string, JumpSession>();

export function hasJumpSession(name: string): boolean {
  return sessions.get(name)?.alive ?? false;
}

export function closeAllJumpSessions(): void {
  for (const session of [...sessions.values()]) session.close();
  sessions.clear();
}

export async function runOnJumpServer(
  name: string,
  profile: SshProfile,
  command: string,
  options: JumpRunOptions = {},
): Promise<ExecResult> {
  let session = sessions.get(name);
  if (!session?.alive) {
    session = new JumpSession(name, profile, options);
    sessions.set(name, session);
  }
  return session.run(command, options);
}
