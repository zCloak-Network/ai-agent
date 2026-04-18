/**
 * Pre-flight Update Check
 *
 * Runs before every CLI command to ensure the CLI package is up-to-date.
 * When a new npm version is available, we update the CLI package and then ask
 * the caller to re-run. Skill packages are upgraded separately via clawhub.
 *
 * Flow:
 *   1. Read ~/.config/zcloak/.last-update-check timestamp
 *   2. If last check was < 15 minutes ago → skip (return immediately)
 *   3. If >= 15 minutes or file missing →
 *      a. Query npm registry for latest published version
 *      b. Compare local package.json version against the registry version
 *      c. If outdated → update npm package
 *      d. Write current timestamp to .last-update-check
 *
 * Design principles:
 *   - Network failures are silently ignored (never block command execution)
 *   - All output goes to stderr (never pollute stdout / command output)
 *   - Timeout on npm commands (10s for version query, 60s for install)
 */

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { debug, info } from "./log.js";
import { configDir as getConfigDir, lastUpdateCheckPath } from "./paths.js";

/** Environment variable set when a new process is spawned after a CLI upgrade */
const JUST_UPGRADED_ENV = "ZCLOAK_JUST_UPGRADED";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

/** ESM equivalent of __dirname */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Package root directory (one level up from dist/) */
const PACKAGE_ROOT = path.resolve(__dirname, "..");

/** Local package.json path */
const LOCAL_PACKAGE_JSON = path.join(PACKAGE_ROOT, "package.json");

/** Directory for zCloak configuration files */
const CONFIG_DIR = getConfigDir();

/** Timestamp file recording when we last checked for updates */
const CHECK_FILE = lastUpdateCheckPath();


// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Minimum interval between update checks: 15 minutes (in milliseconds) */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** npm view timeout (milliseconds) */
const NPM_VIEW_TIMEOUT_MS = 10_000;

/** npm install timeout (milliseconds) */
const NPM_INSTALL_TIMEOUT_MS = 60_000;

/** npm package name for version queries */
const NPM_PACKAGE_NAME = "@zcloak/ai-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by preCheck() to the caller (cli.ts) */
export interface PreCheckResult {
  /** Whether the CLI package was successfully updated (requires re-execution) */
  updated: boolean;
  /** Human / agent-readable message (empty string when nothing noteworthy happened) */
  message: string;
}

// ---------------------------------------------------------------------------
// Local version helper
// ---------------------------------------------------------------------------

/**
 * Read the local CLI version from package.json.
 * Returns null if the file doesn't exist or can't be parsed.
 */
function getLocalCliVersion(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(LOCAL_PACKAGE_JSON, "utf-8"));
    const version = pkg.version ?? null;
    return version;
  } catch {
    debug(
      "pre-check failed to read local package version from",
      LOCAL_PACKAGE_JSON,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Timestamp management
// ---------------------------------------------------------------------------

/**
 * Determine whether we should perform an update check right now.
 *
 * Returns true when:
 *   - The timestamp file doesn't exist (first run)
 *   - The file content is invalid
 *   - More than CHECK_INTERVAL_MS has elapsed since the last check
 */
function shouldCheck(): boolean {
  try {
    if (!fs.existsSync(CHECK_FILE)) return true;
    const raw = fs.readFileSync(CHECK_FILE, "utf-8").trim();
    const timestamp = parseInt(raw, 10);
    if (isNaN(timestamp)) return true;
    const delta = Date.now() - timestamp;
    const should = delta >= CHECK_INTERVAL_MS;
    debug("pre-check timestamp read", {
      file: CHECK_FILE,
      timestamp,
      deltaMs: delta,
      intervalMs: CHECK_INTERVAL_MS,
      shouldCheck: should,
    });
    return should;
  } catch {
    debug("pre-check timestamp read failed, forcing check");
    return true;
  }
}

/**
 * Record the current time as the last-check timestamp.
 * Creates the config directory if it doesn't exist yet.
 */
function recordCheckTime(): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CHECK_FILE, String(Date.now()), "utf-8");
    debug("pre-check timestamp recorded", CHECK_FILE);
  } catch {
    // Non-critical — silently ignore write failures
    debug("pre-check failed to record timestamp", CHECK_FILE);
  }
}

// ---------------------------------------------------------------------------
// npm helpers
// ---------------------------------------------------------------------------

/**
 * Query the npm registry for the latest published version of the CLI package.
 *
 * Uses `npm view <pkg> version` which is fast and doesn't require authentication.
 * Returns null on any failure (network, timeout, npm not found).
 */
function getNpmLatestVersion(): string | null {
  try {
    const output = execSync(`npm view ${NPM_PACKAGE_NAME} version`, {
      stdio: "pipe",
      timeout: NPM_VIEW_TIMEOUT_MS,
      encoding: "utf-8",
    });
    const version = output.trim() || null;
    return version;
  } catch {
    debug("pre-check npm version query failed");
    return null;
  }
}

/**
 * Attempt to update the globally-installed CLI package via npm.
 * Failures are silently ignored — post-upgrade actions always proceed.
 */
function updateCli(): void {
  try {
    execSync(`npm install -g ${NPM_PACKAGE_NAME}@latest`, {
      stdio: "pipe", // suppress npm output
      timeout: NPM_INSTALL_TIMEOUT_MS,
    });
    debug("pre-check npm package update completed", NPM_PACKAGE_NAME);
  } catch {
    debug("pre-check npm package update failed", NPM_PACKAGE_NAME);
  }
}

/**
 * Spawn a new `zcloak-ai pre-check` process using the freshly installed CLI
 * binary, passing ZCLOAK_JUST_UPGRADED=1 so the new version knows to run
 * post-upgrade actions.
 *
 * Waits for the child process to complete before returning.
 */
function spawnPostUpgradeCheck(): void {
  debug("pre-check spawning post-upgrade check with new CLI binary");
  spawnSync("zcloak-ai", ["pre-check"], {
    stdio: "inherit",
    env: { ...process.env, [JUST_UPGRADED_ENV]: "1" },
  });
  debug("pre-check post-upgrade spawn completed");
}

// ---------------------------------------------------------------------------
// Post-upgrade: workspace + skill helpers (shared with onboard.ts)
// ---------------------------------------------------------------------------

const SKILL_REMOTE_URL =
  "https://raw.githubusercontent.com/zCloak-Network/ai-agent/refs/heads/main/SKILL.md";

const TOOLS_MD_SECTION = [
  "## zCloak.ai SKILL",
  "- Skill location: <openclaw_workspace>/skills/zcloak-ai-agent/",
  "- Upgrade URL: https://raw.githubusercontent.com/zCloak-Network/ai-agent/refs/heads/main/SKILL.md",
  "- Used for all zCloak-related operations: zMail, identity creation, signing, 2FA-protected delete, on-chain actions, encryption, etc.",
].join("\n");

/** Returns the OpenClaw workspace — inherited cwd from the agent process. */
export function resolveOpenClawWorkspace(): string {
  const workspace = process.cwd();
  info(`[zcloak-ai] workspace: ${workspace}`);
  return workspace;
}

// ---------------------------------------------------------------------------
// Reserved: config-file / cwd-walk workspace resolution (may be needed later)
// ---------------------------------------------------------------------------
// const OPENCLAW_CONFIG_CANDIDATES = [
//   path.join(homedir(), ".openclaw", "openclaw.json"),
//   path.join(homedir(), ".clawdbot", "clawdbot.json"), // legacy
// ];
// const DEFAULT_WORKSPACE = path.join(homedir(), ".openclaw", "workspace");
//
// function readWorkspaceFromConfig(configPath: string): string | null {
//   try {
//     const raw = fs.readFileSync(configPath, "utf-8");
//     const json = JSON.parse(raw) as Record<string, unknown>;
//     const agents = json["agents"] as Record<string, unknown> | undefined;
//     const defaults = agents?.["defaults"] as Record<string, unknown> | undefined;
//     const workspace = defaults?.["workspace"];
//     if (typeof workspace === "string" && workspace.length > 0) return workspace;
//     return null;
//   } catch { return null; }
// }
//
// function resolveWorkspaceFromCwd(): string | null {
//   const MARKERS = [".clawhub", ".clawdhub"];
//   let dir = process.cwd();
//   while (true) {
//     for (const marker of MARKERS) {
//       if (fs.existsSync(path.join(dir, marker))) return dir;
//     }
//     const parent = path.dirname(dir);
//     if (parent === dir) break;
//     dir = parent;
//   }
//   return null;
// }
//
// Full priority chain when process.cwd() is not sufficient:
//   1. OPENCLAW_WORKDIR / CLAWHUB_WORKDIR env var
//   2. resolveWorkspaceFromCwd()  — walk up from cwd looking for .clawhub/
//   3. readWorkspaceFromConfig()  — ~/.openclaw/openclaw.json → agents.defaults.workspace
//   4. readWorkspaceFromConfig()  — ~/.clawdbot/clawdbot.json (legacy)
//   5. DEFAULT_WORKSPACE          — ~/.openclaw/workspace

/** Fetch latest SKILL.md from GitHub and write to <workspace>/skills/zcloak-ai-agent/SKILL.md. */
export async function refreshSkill(workspace: string): Promise<void> {
  const targetDir = path.join(workspace, "skills", "zcloak-ai-agent");
  const targetFile = path.join(targetDir, "SKILL.md");
  const res = await fetch(SKILL_REMOTE_URL);
  if (!res.ok) throw new Error(`Failed to fetch SKILL.md: ${res.status}`);
  const content = await res.text();
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, content, "utf-8");
  info(`[zcloak-ai] SKILL.md → ${targetFile}`);
}

/** Add or update the zCloak.ai SKILL section in <workspace>/TOOLS.md. */
export async function updateToolsMd(workspace: string): Promise<void> {
  const toolsPath = path.join(workspace, "TOOLS.md");
  let existing = "";
  try { existing = fs.readFileSync(toolsPath, "utf-8"); } catch { /* not yet created */ }

  const updated = existing.includes("## zCloak.ai SKILL")
    ? existing.replace(/## zCloak\.ai SKILL[\s\S]*?(?=\n## |\s*$)/, TOOLS_MD_SECTION)
    : (existing ? `${existing.trimEnd()}\n\n${TOOLS_MD_SECTION}\n` : `${TOOLS_MD_SECTION}\n`);

  fs.writeFileSync(toolsPath, updated, "utf-8");
  info(`[zcloak-ai] TOOLS.md → ${toolsPath}`);
}

// ---------------------------------------------------------------------------
// Post-upgrade entry point
// ---------------------------------------------------------------------------

/**
 * Run post-upgrade actions using the current (new) CLI version.
 * Called when ZCLOAK_JUST_UPGRADED=1 is detected in the environment.
 *
 * Add future post-upgrade steps here — they will always run on the
 * newly installed version, never on stale code.
 */
async function runPostUpgradeActions(): Promise<void> {
  debug("pre-check running post-upgrade actions (new version)");

  const workspace = resolveOpenClawWorkspace();
  info(`[zcloak-ai] post-upgrade workspace: ${workspace}`);

  try { await refreshSkill(workspace); } catch (e) { debug("post-upgrade refreshSkill failed", e); }
  try { await updateToolsMd(workspace); } catch (e) { debug("post-upgrade updateToolsMd failed", e); }

  debug("pre-check post-upgrade actions completed");
}

/**
 * Run the pre-flight update check.
 *
 * Called by cli.ts before dispatching any sub-command. If an update is
 * detected and applied successfully, the returned result contains a descriptive
 * message (for stderr) and `updated: true`.
 *
 * When `updated` is true the caller should exit and prompt the agent /
 * user to re-run the command because the running CLI binary is stale.
 */
export async function preCheck(
  argv: string[] = process.argv,
): Promise<PreCheckResult> {
  // --- Post-upgrade path: spawned by old version after npm install ---
  if (process.env[JUST_UPGRADED_ENV] === "1") {
    debug("pre-check detected JUST_UPGRADED env, running post-upgrade actions");
    await runPostUpgradeActions();
    return { updated: false, message: "" };
  }

  // --- Gate: skip if last check was recent enough ---
  if (!shouldCheck()) {
    // debug("pre-check skipped because interval not reached");
    return { updated: false, message: "" };
  }

  // --- Read local version from package.json ---
  const localVersion = getLocalCliVersion();

  // --- Query npm registry for latest version ---
  const remoteVersion = getNpmLatestVersion();

  // Query failed → network unreachable; move on
  if (!remoteVersion) {
    debug("pre-check remote version unavailable, skipping update flow");
    recordCheckTime();
    return { updated: false, message: "" };
  }

  // --- Already up-to-date ---
  if (remoteVersion === localVersion) {
    recordCheckTime();
    return { updated: false, message: "" };
  }

  // --- Version mismatch → update CLI then run post-upgrade actions ---
  debug("pre-check update required", {
    localVersion,
    remoteVersion,
  });
  updateCli();
  recordCheckTime();
  spawnPostUpgradeCheck();

  return {
    updated: true,
    message: [
      "[zcloak-ai] Version update detected!",
      `[zcloak-ai] CLI: ${localVersion ?? "unknown"} → ${remoteVersion} (updated)`,
      "[zcloak-ai] Re-run the previous command on the updated CLI.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
