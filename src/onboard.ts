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

// ---------------------------------------------------------------------------
// Steps (stubs — implement one by one)
// ---------------------------------------------------------------------------

/**
 * Fetch the latest SKILL.md from GitHub and write it to
 * <workspace>/skills/zcloak-ai-agent/SKILL.md.
 * TODO: implement
 */
async function installSkill(_workspace: string): Promise<void> {
  // TODO
}

/**
 * Append or update the zCloak skill section in <workspace>/TOOLS.md.
 * TODO: implement
 */
async function updateToolsMd(_workspace: string): Promise<void> {
  // TODO
}

/**
 * Show existing identity or generate a new one.
 * TODO: implement
 */
async function initIdentity(): Promise<void> {
  // TODO
}

/**
 * Register this agent with the zMail server.
 * No-op if already registered.
 * TODO: implement
 */
async function registerZmail(): Promise<void> {
  // TODO
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runOnboard(): Promise<void> {
  log.info("[zcloak-ai] onboard starting...");

  const workspace = process.cwd();
  log.info(`[zcloak-ai] onboard cwd: ${workspace}`);

  await installSkill(workspace);
  await updateToolsMd(workspace);
  await initIdentity();
  await registerZmail();

  log.info("[zcloak-ai] onboard complete.");
}
