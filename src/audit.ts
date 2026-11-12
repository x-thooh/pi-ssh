/**
 * Append-only audit trail of guarded calls (~/.pi/ssh-audit.jsonl).
 *
 * Never records secrets (callers pass only commands, paths and specs) and
 * never throws: a broken audit log must not break a tool.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Decision =
  | "auto"
  | "human-allow"
  | "human-allow-session"
  | "human-deny"
  | "policy-deny"
  | "no-ui-deny";

export interface AuditEntry {
  readonly id: string;
  readonly profile: string;
  readonly tool: string;
  readonly target?: string;
  readonly decision?: Decision;
  readonly exitCode?: number | null;
}

export function auditPath(): string {
  if (process.env.PI_SSH_AUDIT_FILE) return process.env.PI_SSH_AUDIT_FILE;
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".pi", "ssh-audit.jsonl");
}

export function audit(entry: AuditEntry): void {
  try {
    const file = auditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, {
      mode: 0o600,
    });
  } catch {
    /* swallow */
  }
}
