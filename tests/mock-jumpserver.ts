/**
 * In-process mock servers for the jump tests. No real sshd, no network
 * beyond loopback.
 *
 * - startMockJumpServer: password auth, Koko-like menu, then a shell backed by
 *   a persistent /bin/sh in a temp dir.
 * - startMockSshd: password auth, exec channels, and tcpip forwarding.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;

export interface MockServer {
  readonly port: number;
  readonly dir: string;
  /** Number of completed shell logins (menu passed). */
  readonly logins: () => number;
  close(): Promise<void>;
}

interface Options {
  readonly user?: string;
  readonly password: string;
  readonly asset?: string;
  readonly account?: string;
}

function listen(server: InstanceType<typeof Server>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

function base(options: Options, onSession: (session: any, dir: string) => void, forward: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mockjump-"));
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const conns = new Set<any>();
  const server = new Server({ hostKeys: [hostKey] }, (client: any) => {
    conns.add(client);
    client.on("error", () => {});
    client.on("close", () => conns.delete(client));
    client.on("authentication", (ctx: any) => {
      if (
        ctx.method === "password" &&
        ctx.username === (options.user ?? "u") &&
        ctx.password === options.password
      ) {
        ctx.accept();
      } else {
        ctx.reject(["password"]);
      }
    });
    client.on("ready", () => {
      client.on("session", (accept: () => any) => onSession(accept(), dir));
      if (forward) {
        client.on("tcpip", (accept: () => any, reject: () => void, info: any) => {
          const socket = net.connect(info.destPort, info.destIP, () => {
            const channel = accept();
            channel.pipe(socket).pipe(channel);
            channel.on("close", () => socket.destroy());
          });
          socket.on("error", () => reject());
        });
      }
    });
  });
  return { server, dir, conns };
}

async function finish(
  built: ReturnType<typeof base>,
  logins: () => number,
  cleanup: () => void,
): Promise<MockServer> {
  const port = await listen(built.server);
  return {
    port,
    dir: built.dir,
    logins,
    close: () =>
      new Promise<void>((resolve) => {
        cleanup();
        for (const c of built.conns) c.end();
        built.server.close(() => resolve());
        fs.rmSync(built.dir, { recursive: true, force: true });
      }),
  };
}

export async function startMockJumpServer(options: Options): Promise<MockServer> {
  const asset = options.asset ?? "web1";
  const account = options.account ?? "1";
  let logins = 0;
  const shells = new Set<ChildProcess>();

  const built = base(options, (session, dir) => {
    session.on("pty", (accept: () => void) => accept());
    session.on("shell", (accept: () => any) => {
      const stream = accept();
      let state: "opt" | "host" | "id" | "sh" = "opt";
      let line = "";
      let sh: ChildProcess | null = null;
      stream.write("Welcome to Mock JumpServer\r\n  p) list hosts\r\nOpt> ");

      const startShell = () => {
        logins += 1;
        sh = spawn("/bin/sh", [], { cwd: dir, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        shells.add(sh);
        sh.stdout?.on("data", (d) => stream.write(d));
        sh.stderr?.on("data", (d) => stream.write(d));
        sh.on("exit", () => stream.close());
      };

      stream.on("data", (data: Buffer) => {
        if (state === "sh") {
          const text = data.toString();
          if (text.includes("\x03") && sh?.pid) {
            spawnSync("pkill", ["-INT", "-P", String(sh.pid)]);
            return;
          }
          sh?.stdin?.write(text.replace(/\r/g, "\n"));
          return;
        }
        for (const ch of data.toString()) {
          if (ch !== "\r" && ch !== "\n") {
            line += ch;
            continue;
          }
          const input = line.trim();
          line = "";
          if (!input) continue;
          if (state === "opt") {
            if (input === "p") {
              state = "host";
              stream.write(`\x1b[1m1 ${asset}\x1b[0m\r\n[Host]> `);
            } else stream.write("Opt> ");
          } else if (state === "host") {
            if (input === asset) {
              state = "id";
              stream.write("1 root\r\nID> ");
            } else stream.write("not found\r\n[Host]> ");
          } else if (state === "id") {
            if (input === account) {
              state = "sh";
              startShell();
            } else stream.write("bad id\r\nID> ");
          }
        }
      });
      stream.on("close", () => {
        if (sh?.pid) {
          try {
            process.kill(-sh.pid, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      });
    });
  }, false);

  return finish(built, () => logins, () => {
    for (const sh of shells) {
      try {
        if (sh.pid) process.kill(-sh.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });
}

export async function startMockSshd(options: Options): Promise<MockServer> {
  const built = base(options, (session, dir) => {
    session.on("exec", (accept: () => any, _r: unknown, info: { command: string }) => {
      const stream = accept();
      const child = spawn("/bin/sh", ["-c", info.command], { cwd: dir });
      child.stdout.on("data", (d) => stream.write(d));
      child.stderr.on("data", (d) => stream.stderr.write(d));
      child.on("close", (code) => {
        stream.exit(code ?? 0);
        stream.end();
      });
    });
  }, true);
  return finish(built, () => 0, () => {});
}
