/**
 * Hand a JumpServer shell to the person at the keyboard.
 *
 * pumpShell wires the real terminal to the remote channel until the remote
 * side ends or the person presses Ctrl-]. It is pure plumbing over injected
 * streams so it can be tested without a TTY; the pi/TUI handover lives in
 * index.ts.
 */

/** Ctrl-]: leave without ending the remote shell cleanly (same key as telnet). */
export const DETACH_KEY = "\x1d";

/** Undo whatever a remote full-screen program may have left switched on. */
export const RESET_TERMINAL =
  "\x1b[0m\x1b[?25h\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l";

export interface RemoteChannel {
  on(event: "data", fn: (chunk: Buffer) => void): unknown;
  on(event: "close", fn: () => void): unknown;
  removeListener(event: string, fn: (...args: any[]) => void): unknown;
  write(data: string | Buffer): unknown;
  end(): unknown;
  /** ssh2 ClientChannel resize; absent on plain streams. */
  setWindow?(rows: number, cols: number, height: number, width: number): unknown;
}

export interface ShellIO {
  input: {
    on(event: "data", fn: (chunk: Buffer) => void): unknown;
    removeListener(event: string, fn: (...args: any[]) => void): unknown;
  };
  output: {
    write(data: string | Buffer): unknown;
    columns?: number;
    rows?: number;
    on(event: "resize", fn: () => void): unknown;
    removeListener(event: string, fn: (...args: any[]) => void): unknown;
  };
}

export type ShellEnd = "remote-exit" | "detached";

export function pumpShell(channel: RemoteChannel, io: ShellIO): Promise<ShellEnd> {
  return new Promise((resolve) => {
    let finished = false;

    const finish = (reason: ShellEnd) => {
      if (finished) return;
      finished = true;
      io.input.removeListener("data", onInput);
      io.output.removeListener("resize", onResize);
      channel.removeListener("data", onRemote);
      channel.removeListener("close", onClose);
      resolve(reason);
    };

    const onInput = (chunk: Buffer) => {
      if (chunk.includes(DETACH_KEY)) {
        io.output.write(`\r\n[detached]\r\n`);
        channel.end();
        finish("detached");
        return;
      }
      channel.write(chunk);
    };
    const onRemote = (chunk: Buffer) => {
      io.output.write(chunk);
    };
    const onClose = () => finish("remote-exit");
    const onResize = () => {
      const { columns, rows } = io.output;
      if (columns && rows) channel.setWindow?.(rows, columns, 0, 0);
    };

    channel.on("data", onRemote);
    channel.on("close", onClose);
    io.input.on("data", onInput);
    io.output.on("resize", onResize);
  });
}
