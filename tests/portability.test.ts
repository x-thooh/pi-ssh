/**
 * Assumptions that would only break on another platform.
 *
 * The suite runs on one operating system at a time, so the things that differ
 * between them are asserted here directly on the source and on the pure
 * helpers, rather than being discovered by whoever first runs this on Windows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describePermissionSupport } from "../src/doctor.ts";
import { expandPath } from "../src/config.ts";

function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });
  return [
    ...walk(path.join(import.meta.dirname, "..", "src")),
    path.join(import.meta.dirname, "..", "index.ts"),
  ];
}

describe("no external tooling", () => {
  it("never spawns a process", () => {
    for (const file of sourceFiles()) {
      // credentials.ts runs the user's own passwordCmd; nothing else may spawn.
      if (path.basename(file) === "credentials.ts") continue;
      const content = fs.readFileSync(file, "utf-8");
      assert.ok(
        !/from "node:child_process"/.test(content),
        `${path.basename(file)} spawns a process; SSH and keys must stay in process`,
      );
    }
  });

  it("hardcodes no POSIX paths", () => {
    // A path like /usr/bin or /tmp in the source is a Windows failure waiting
    // to happen. Remote paths are a different matter and live in strings that
    // start with ~ or are supplied by the user.
    const forbidden = /["'`](\/usr\/|\/etc\/|\/var\/|\/tmp\/|\/dev\/)/;
    for (const file of sourceFiles()) {
      const content = fs.readFileSync(file, "utf-8");
      const match = forbidden.exec(content);
      assert.ok(!match, `${path.basename(file)} contains a POSIX-only path: ${match?.[0]}`);
    }
  });
});

describe("locating the home directory", () => {
  it("always has a real fallback, never a literal tilde", () => {
    // A "~" used as an actual directory name creates a folder called ~ in the
    // working directory instead of failing.
    for (const file of sourceFiles()) {
      const content = fs.readFileSync(file, "utf-8");
      assert.ok(
        !/process\.env\.USERPROFILE \|\| "~"/.test(content),
        `${path.basename(file)} falls back to a literal "~" instead of os.homedir()`,
      );
    }
  });

  it("considers USERPROFILE, which is what Windows sets", () => {
    const users = sourceFiles().filter((file) =>
      /process\.env\.HOME/.test(fs.readFileSync(file, "utf-8")),
    );
    assert.ok(users.length > 0);

    for (const file of users) {
      const content = fs.readFileSync(file, "utf-8");
      assert.ok(
        /process\.env\.HOME \|\| process\.env\.USERPROFILE/.test(content),
        `${path.basename(file)} reads HOME without falling back to USERPROFILE`,
      );
    }
  });
});

describe("expandPath", () => {
  it("expands a tilde with either separator", () => {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    assert.strictEqual(expandPath("~/.ssh/id"), path.join(home, ".ssh/id"));
    // Windows users type backslashes.
    assert.strictEqual(expandPath("~\\.ssh\\id"), path.join(home, ".ssh\\id"));
  });

  it("produces an absolute path from a relative one", () => {
    assert.ok(path.isAbsolute(expandPath("relative/path")));
  });
});

describe("file permissions", () => {
  it("are reported as enforced on POSIX", () => {
    const check = describePermissionSupport("linux");
    assert.strictEqual(check.status, "ok");
    assert.match(check.detail, /0600/);
  });

  it("are reported as unenforced on Windows, with what to do about it", () => {
    const check = describePermissionSupport("win32");
    assert.strictEqual(check.status, "note");
    assert.match(check.detail, /ACLs/);
    assert.ok(check.remedy, "a limitation without advice is not much use");
    assert.match(check.remedy!, /ssh_authorize|password/);
  });

  it("does not call a Windows machine broken over it", () => {
    // It is a limitation to know about, not a reason to refuse to work.
    assert.notStrictEqual(describePermissionSupport("win32").status, "problem");
  });
});

describe("the sshd-backed tests", () => {
  it("skip themselves where there is no sshd, rather than failing", async () => {
    const { findSshd } = await import("./sshd.ts");
    if (process.platform === "win32") {
      assert.strictEqual(findSshd(), null, "Windows has no sshd at these paths");
    } else {
      // On POSIX it may or may not be installed; either is fine, but the
      // answer has to be a decision rather than an exception.
      assert.ok(findSshd() === null || typeof findSshd() === "string");
    }
  });
});
