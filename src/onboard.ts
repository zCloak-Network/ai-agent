/**
 * Onboard Command
 *
 * One-shot setup for a fresh zCloak.ai agent installation:
 *   1. Resolve OpenClaw workspace path
 *   2. Install SKILL.md into workspace/skills/zcloak-ai-agent/
 *   3. Update TOOLS.md in the workspace
 *   4. Initialize identity (show existing or generate new)
 *   5. Register with zMail
 *
 * Invoked via:
 *   npx @zcloak/ai-agent@latest onboard
 *
 * Workspace resolution is shared with runPostUpgradeActions() in pre-check.ts.
 */

import * as log from "./log.js";
import { resolveOpenClawWorkspace, refreshSkill, updateToolsMd } from "./pre-check.js";

// ---------------------------------------------------------------------------
// Steps (stubs — implement one by one)
// ---------------------------------------------------------------------------

/** Show existing identity or generate a new one. TODO: implement */
async function initIdentity(): Promise<void> {
  // TODO
}

/** Register this agent with the zMail server. TODO: implement */
async function registerZmail(): Promise<void> {
  // TODO
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runOnboard(): Promise<void> {
  log.info("[zcloak-ai] onboard starting...");

  const workspace = resolveOpenClawWorkspace();

  await refreshSkill(workspace);
  await updateToolsMd(workspace);
  await initIdentity();
  await registerZmail();

  log.info("[zcloak-ai] onboard complete.");
}
