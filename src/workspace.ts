/**
 * OpenClaw Workspace Resolution
 *
 * Locates the OpenClaw workspace directory using the following priority:
 *   1. OPENCLAW_WORKDIR / CLAWHUB_WORKDIR env var
 *   2. Walk up from cwd looking for .clawhub/ marker (agent-spawned processes)
 *   3. ~/.openclaw/openclaw.json → agents.defaults.workspace (direct terminal use)
 *   4. ~/.clawdbot/clawdbot.json → agents.defaults.workspace (legacy)
 *   5. ~/.openclaw/workspace (fallback)
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { info } from "./log.js";

const OPENCLAW_CONFIG_CANDIDATES = [
  path.join(homedir(), ".openclaw", "openclaw.json"),
  path.join(homedir(), ".clawdbot", "clawdbot.json"), // legacy
];

const DEFAULT_WORKSPACE = path.join(homedir(), ".openclaw", "workspace");

function readWorkspaceFromConfig(configPath: string): string | null {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    const agents = json["agents"] as Record<string, unknown> | undefined;
    const defaults = agents?.["defaults"] as Record<string, unknown> | undefined;
    const workspace = defaults?.["workspace"];
    if (typeof workspace === "string" && workspace.length > 0) return workspace;
    return null;
  } catch { return null; }
}

/** Walk up from cwd looking for a .clawhub/.clawdhub marker directory. */
function resolveWorkspaceFromCwd(): string | null {
  const MARKERS = [".clawhub", ".clawdhub"];
  let dir = process.cwd();
  while (true) {
    for (const marker of MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveOpenClawWorkspace(): string {
  const envWorkdir =
    process.env["OPENCLAW_WORKDIR"] ??
    process.env["CLAWHUB_WORKDIR"] ??
    process.env["CLAWDHUB_WORKDIR"];
  if (envWorkdir) {
    info(`[zcloak-ai] workspace (env): ${envWorkdir}`);
    return envWorkdir;
  }

  const cwdWorkspace = resolveWorkspaceFromCwd();
  if (cwdWorkspace) {
    info(`[zcloak-ai] workspace (cwd): ${cwdWorkspace}`);
    return cwdWorkspace;
  }

  for (const configPath of OPENCLAW_CONFIG_CANDIDATES) {
    const workspace = readWorkspaceFromConfig(configPath);
    if (workspace) {
      info(`[zcloak-ai] workspace (config): ${workspace}`);
      return workspace;
    }
  }

  info(`[zcloak-ai] workspace (fallback): ${DEFAULT_WORKSPACE}`);
  return DEFAULT_WORKSPACE;
}
