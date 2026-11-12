/**
 * Smoke test -- tool shapes, extension registration, and the skill manifest.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SshSetupTool } from "../src/tools/ssh-setup.ts";
import { SshStatusTool } from "../src/tools/ssh-status.ts";
import { SshProfileTool } from "../src/tools/ssh-profile.ts";
import { SshExecTool } from "../src/tools/ssh-exec.ts";
import { SshListTool } from "../src/tools/ssh-list.ts";
import { SshUploadTool } from "../src/tools/ssh-upload.ts";
import { SshDownloadTool } from "../src/tools/ssh-download.ts";
import { SshKeygenTool } from "../src/tools/ssh-keygen.ts";
import { SshAuthorizeTool } from "../src/tools/ssh-authorize.ts";
import { SshDoctorTool } from "../src/tools/ssh-doctor.ts";
import { SshTunnelTool } from "../src/tools/ssh-tunnel.ts";

const allTools = [
  SshSetupTool,
  SshStatusTool,
  SshProfileTool,
  SshExecTool,
  SshListTool,
  SshUploadTool,
  SshDownloadTool,
  SshKeygenTool,
  SshAuthorizeTool,
  SshDoctorTool,
  SshTunnelTool,
];

describe("Tool structure smoke test", () => {
  it("has exactly 11 tools", () => {
    assert.strictEqual(allTools.length, 11);
  });

  for (const tool of allTools) {
    it(`${tool.name} has required fields`, () => {
      assert.ok(tool.name);
      assert.ok(tool.label);
      assert.ok(tool.description);
      assert.ok(tool.parameters !== undefined);
      assert.strictEqual(typeof tool.execute, "function");
    });
  }

  it("all tool names are unique", () => {
    const names = allTools.map((tool) => tool.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  it("all tool names follow the ssh_ prefix convention", () => {
    for (const tool of allTools) {
      assert.ok(/^ssh_/.test(tool.name), `${tool.name} lacks the prefix`);
    }
  });

  it("every description explains when to use the tool", () => {
    for (const tool of allTools) {
      assert.ok(tool.description.length > 40, `${tool.name} is too terse`);
    }
  });
});

describe("Extension entry point", () => {
  it("registers every tool and command without errors", async () => {
    const registered: string[] = [];
    const commands: string[] = [];
    const mod = await import("../index.ts");

    mod.default({
      registerTool: (tool: { name: string }) => registered.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
      on: () => {},
      sendUserMessage: () => {},
    } as any);

    assert.deepStrictEqual(registered.sort(), allTools.map((t) => t.name).sort());
    assert.deepStrictEqual(commands.sort(), ["jms", "ssh", "ssh-key"]);
  });

  it("closes tunnels when the session ends, so nothing outlives pi", async () => {
    const events: string[] = [];
    const mod = await import("../index.ts");
    mod.default({
      registerTool: () => {},
      registerCommand: () => {},
      on: (event: string) => events.push(event),
      sendUserMessage: () => {},
    } as any);
    assert.ok(events.includes("session_shutdown"));
  });
});

describe("Skills", () => {
  it("ships a SKILL.md whose frontmatter is valid YAML", async () => {
    // Parsing it for real rather than pulling fields out with a regular
    // expression: pi loads these with a YAML parser, and an unquoted value
    // containing ": " is read as a nested mapping and rejected. A regex is
    // happy with that, which is exactly how a broken skill shipped once.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { parse } = await import("yaml");

    const skillsDir = path.join(import.meta.dirname, "..", "skills");
    const names = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    assert.ok(names.length >= 1);

    for (const name of names) {
      const file = path.join(skillsDir, name, "SKILL.md");
      assert.ok(fs.existsSync(file), `${name} has no SKILL.md`);

      const content = fs.readFileSync(file, "utf-8");
      assert.ok(content.startsWith("---\n"), `${name} has no frontmatter`);

      const end = content.indexOf("\n---", 4);
      assert.ok(end > 0, `${name}: the frontmatter is not closed`);

      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = parse(content.slice(4, end)) as Record<string, unknown>;
      } catch (err) {
        assert.fail(`${name}: the frontmatter is not valid YAML -- ${(err as Error).message}`);
      }

      assert.strictEqual(frontmatter.name, name, `${name}: frontmatter name mismatch`);
      assert.match(String(frontmatter.name), /^[a-z0-9-]{1,64}$/);

      const description = frontmatter.description;
      assert.strictEqual(typeof description, "string", `${name}: description must be a string`);
      assert.ok(String(description).length > 0 && String(description).length <= 1024);

      if (frontmatter["allowed-tools"] !== undefined) {
        assert.strictEqual(
          typeof frontmatter["allowed-tools"],
          "string",
          `${name}: allowed-tools should parse as one string`,
        );
      }
    }
  });

  it("catches the mistake that broke a skill once", async () => {
    const { parse } = await import("yaml");
    // An unquoted value with a colon and a space is a nested mapping to YAML.
    assert.throws(
      () => parse("description: Use it on another host: deploy things\n"),
      /mapping/i,
    );
    // Quoted, or without the colon, it is a plain string again.
    assert.strictEqual(
      parse("description: Use it on another host, deploying things\n").description,
      "Use it on another host, deploying things",
    );
  });
});

describe("Portability", () => {
  it("never shells out, so Windows behaves like the rest", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
      });

    const sources = [
      ...walk(path.join(import.meta.dirname, "..", "src")),
      path.join(import.meta.dirname, "..", "index.ts"),
    ];

    for (const file of sources) {
      // credentials.ts runs the user's own passwordCmd; nothing else may spawn.
      if (path.basename(file) === "credentials.ts") continue;
      const content = fs.readFileSync(file, "utf-8");
      assert.ok(
        !/from "node:child_process"/.test(content),
        `${path.basename(file)} spawns a process; keys and SSH must stay in process`,
      );
    }
  });
});
