import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DETACH_KEY, RESET_TERMINAL, pumpShell } from "../src/jms-shell.ts";

function fakes() {
  const channel = Object.assign(new EventEmitter(), {
    written: [] as string[],
    ended: false,
    windows: [] as number[][],
    write(d: string | Buffer) {
      this.written.push(d.toString());
    },
    end() {
      this.ended = true;
    },
    setWindow(r: number, c: number, h: number, w: number) {
      this.windows.push([r, c, h, w]);
    },
  });
  const input = new EventEmitter();
  const output = Object.assign(new EventEmitter(), {
    out: [] as string[],
    columns: 100,
    rows: 30,
    write(d: string | Buffer) {
      this.out.push(d.toString());
    },
  });
  return { channel, input, output, io: { input, output } };
}

describe("pumpShell", () => {
  it("forwards keystrokes to the remote and remote output to the screen", async () => {
    const { channel, input, output, io } = fakes();
    const done = pumpShell(channel as any, io as any);
    input.emit("data", Buffer.from("ls\r"));
    channel.emit("data", Buffer.from("file1\r\n"));
    assert.deepEqual(channel.written, ["ls\r"]);
    assert.deepEqual(output.out, ["file1\r\n"]);
    channel.emit("close");
    assert.equal(await done, "remote-exit");
  });

  it("Ctrl-] detaches: ends the channel, does not send the key, and says so", async () => {
    const { channel, input, output, io } = fakes();
    const done = pumpShell(channel as any, io as any);
    input.emit("data", Buffer.from(`ab${DETACH_KEY}`));
    assert.equal(await done, "detached");
    assert.equal(channel.ended, true);
    assert.deepEqual(channel.written, []);
    assert.match(output.out.join(""), /\[detached\]/);
  });

  it("passes terminal resizes to the remote PTY", async () => {
    const { channel, output, io } = fakes();
    const done = pumpShell(channel as any, io as any);
    output.columns = 120;
    output.rows = 40;
    output.emit("resize");
    assert.deepEqual(channel.windows, [[40, 120, 0, 0]]);
    channel.emit("close");
    await done;
  });

  it("removes every listener when it ends, so the next TUI start is clean", async () => {
    const { channel, input, output, io } = fakes();
    const done = pumpShell(channel as any, io as any);
    channel.emit("close");
    await done;
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(output.listenerCount("resize"), 0);
    assert.equal(channel.listenerCount("data"), 0);
    assert.equal(channel.listenerCount("close"), 0);
    // input after the end must not reach the remote
    input.emit("data", Buffer.from("x"));
    assert.deepEqual(channel.written, []);
  });

  it("the terminal reset leaves the alternate screen and shows the cursor", () => {
    assert.match(RESET_TERMINAL, /\?1049l/);
    assert.match(RESET_TERMINAL, /\?25h/);
  });
});
