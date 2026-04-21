/**
 * Onboard Command
 *
 * One-shot setup for a fresh zCloak.ai agent installation:
 *   1. Resolve OpenClaw workspace path
 *   2. Install SKILL.md into workspace/skills/zcloak-ai-agent/
 *   3. Update TOOLS.md in the workspace
 *   4. Initialize identity (load existing or generate new)
 *   5. Register with zMail
 *
 * Invoked via:
 *   npx @zcloak/ai-agent@latest onboard
 */

import { createHash } from "crypto";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import * as log from "./log.js";
import { resolveOpenClawWorkspace } from "./workspace.js";
import { refreshSkill, updateToolsMd } from "./pre-check.js";
import { ensureIdentityFile, loadIdentityFromPath, DEFAULT_PEM_PATH } from "./identity.js";
import { schnorrPubkeyFromSpki } from "./vetkey.js";
import config from "./config.js";

// ---------------------------------------------------------------------------
// Step 4 — Initialize identity
// ---------------------------------------------------------------------------

/** Load existing identity or generate a new one. Returns pemPath and principal. */
async function initIdentity(): Promise<{ pemPath: string; principal: string }> {
  const { path: pemPath, created } = ensureIdentityFile(DEFAULT_PEM_PATH);
  const identity = loadIdentityFromPath(pemPath);
  const principal = identity.getPrincipal().toText();
  if (created) {
    log.info(`[zcloak-ai] onboard [4/5] identity generated: ${principal}`);
  } else {
    log.info(`[zcloak-ai] onboard [4/5] identity loaded: ${principal}`);
  }
  return { pemPath, principal };
}

// ---------------------------------------------------------------------------
// Step 5 — Register with zMail
// ---------------------------------------------------------------------------

/** Register this agent with the zMail server. Returns zMail status string. */
async function registerZmail(pemPath: string): Promise<string> {
  const identity = loadIdentityFromPath(pemPath);
  const principal = identity.getPrincipal().toText();
  const spkiHex = Buffer.from(identity.getPublicKey().toDer()).toString("hex");
  const schnorrPubkey = schnorrPubkeyFromSpki(spkiHex);
  const privateKeyHex = ((identity as unknown as { toJSON(): [string, string] }).toJSON())[1];

  const zmailUrl = (process.env["ZMAIL_URL"] ?? config.zmail_url).replace(/\/+$/, "");
  const timestamp = Math.floor(Date.now() / 1000);
  const challenge = `register:${principal}:${spkiHex}:${schnorrPubkey}:${timestamp}`;
  const msgHash = createHash("sha256").update(challenge, "utf8").digest("hex");
  const sig = bytesToHex(schnorr.sign(msgHash, privateKeyHex));

  const res = await fetch(`${zmailUrl}/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ai_id: principal, public_key_spki: spkiHex, schnorr_pubkey: schnorrPubkey, timestamp, sig }),
  });

  if (res.status === 201) {
    log.info(`[zcloak-ai] onboard [5/5] zMail registered: ${principal}`);
    return "registered";
  } else if (res.status === 409) {
    log.info(`[zcloak-ai] onboard [5/5] zMail already registered`);
    return "already registered";
  } else {
    const body = await res.json() as Record<string, unknown>;
    throw new Error(`zMail registration failed: ${String(body["error"] ?? `HTTP ${res.status}`)}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runOnboard(): Promise<void> {
  log.info("[zcloak-ai] onboard starting...");

  const workspace = resolveOpenClawWorkspace();

  await refreshSkill(workspace);
  await updateToolsMd(workspace);

  const { pemPath, principal } = await initIdentity();
  const zmailStatus = await registerZmail(pemPath);

  log.info("[zcloak-ai] onboard complete.");

  // Print structured summary to stdout so the agent knows exactly what to do next.
  console.log([
    "",
    "=== zCloak.ai Onboard Complete ===",
    `AI ID:   ${principal}`,
    `zMail:   ${zmailStatus}`,
    `Skill:   ${workspace}/skills/zcloak-ai-agent/SKILL.md`,
    "",
    "Next steps for agent:",
    "1. Check owner binding: zcloak-ai register get-owner",
    "   - No owner bound → ask user for their .ai name or AI ID to start binding.",
    "2. Check Agent AI Name: zcloak-ai register lookup --ai-id=" + principal,
    "   - No Agent AI Name → recommend registering one (e.g. runner#8939.agent).",
    "",
  ].join("\n"));
}
