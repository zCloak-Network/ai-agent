/**
 * Pre-flight Update Check
 *
 * Runs before every CLI command to ensure the CLI package is up-to-date.
 * When a new npm version is available, we update both the npm package and the
 * workspace SKILL.md together, then ask the caller to re-run.
 *
 * Flow:
 *   1. Read ~/.config/zcloak/.last-update-check timestamp
 *   2. If last check was < 15 minutes ago → skip (return immediately)
 *   3. If >= 15 minutes or file missing →
 *      a. Query npm registry for latest published version
 *      b. Compare local package.json version against the registry version
 *      c. If outdated → update npm package and workspace SKILL.md
 *      d. Write current timestamp to .last-update-check
 *
 * Design principles:
 *   - Network failures are silently ignored (never block command execution)
 *   - All output goes to stderr (never pollute stdout / command output)
 *   - Timeout on npm commands (10s for version query, 60s for install)
 */

import fs from "fs";
import https from "https";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { debug } from "./log.js";
import { configDir as getConfigDir, lastUpdateCheckPath } from "./paths.js";

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

/** Workspace SKILL.md path expected by openClaw. */
const WORKSPACE_SKILL_PATH = path.resolve(
  process.cwd(),
  "skills",
  "zcloak-ai-agent",
  "SKILL.md",
);

/** Optional workspace TOOLS.md path in the current working directory. */
const WORKSPACE_TOOLS_PATH = path.resolve(process.cwd(), "TOOLS.md");

/** Marker string that indicates TOOLS.md already references the zCloak skill. */
const TOOLS_MD_ZCLOAK_SKILL_MARKER = "zcloak-ai-agent";

/** Instruction appended when the current workspace TOOLS.md is missing the zCloak skill entry. */
const TOOLS_MD_ZCLOAK_SKILL_APPEND_HINT = [
  "append <claw_workspace>/TOOLS.md：",
  "## zCloak.ai SKILL",
  "- Skill path: /home/ubuntu/clawd/skills/zcloak-ai-agent/SKILL.md",
  "- Used for all zCloak-related operations: zMail, identity creation, signing, 2FA-protected delete, on-chain actions, encryption, etc.",
].join("\n");

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

/** Canonical remote SKILL.md URL */
const SKILL_MD_URL =
  "https://raw.githubusercontent.com/zCloak-Network/ai-agent/refs/heads/main/SKILL.md";

/** Raw SKILL.md fetch timeout (milliseconds) */
const SKILL_FETCH_TIMEOUT_MS = 10_000;

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

interface ToolsMdStatus {
  exists: boolean;
  mentionsZcloakAiAgent: boolean;
  readError: boolean;
}

function readToolsMdStatus(): ToolsMdStatus {
  try {
    const exists = fs.existsSync(WORKSPACE_TOOLS_PATH);
    const content = exists ? fs.readFileSync(WORKSPACE_TOOLS_PATH, "utf-8") : "";
    return {
      exists,
      mentionsZcloakAiAgent: content.includes(TOOLS_MD_ZCLOAK_SKILL_MARKER),
      readError: false,
    };
  } catch {
    return {
      exists: false,
      mentionsZcloakAiAgent: false,
      readError: true,
    };
  }
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
    debug("pre-check local CLI version =", version ?? "null");
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
    debug("pre-check querying npm latest version for", NPM_PACKAGE_NAME);
    const output = execSync(`npm view ${NPM_PACKAGE_NAME} version`, {
      stdio: "pipe",
      timeout: NPM_VIEW_TIMEOUT_MS,
      encoding: "utf-8",
    });
    const version = output.trim() || null;
    debug("pre-check npm latest version =", version ?? "null");
    return version;
  } catch {
    debug("pre-check npm version query failed");
    return null;
  }
}

/**
 * Attempt to update the globally-installed CLI package via npm.
 *
 * This may fail if the user doesn't have write permissions to the global
 * node_modules directory (e.g. needs sudo).
 *
 * @returns true when npm install completed successfully, false otherwise
 */
function updateCli(): boolean {
  try {
    debug("pre-check updating npm package", NPM_PACKAGE_NAME);
    execSync(`npm install -g ${NPM_PACKAGE_NAME}@latest`, {
      stdio: "pipe", // suppress npm output
      timeout: NPM_INSTALL_TIMEOUT_MS,
    });
    debug("pre-check npm package update completed", NPM_PACKAGE_NAME);
    return true;
  } catch {
    // Non-critical — the current command can still continue on older bits
    debug("pre-check npm package update failed", NPM_PACKAGE_NAME);
    return false;
  }
}

/**
 * Download a text file over HTTPS.
 * Returns null on any network or timeout failure.
 */
function downloadText(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }

      res.setEncoding("utf8");
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve(body);
      });
    });

    req.setTimeout(SKILL_FETCH_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });

    req.on("error", () => {
      resolve(null);
    });
  });
}

/**
 * Refresh the workspace SKILL.md from the canonical raw GitHub URL.
 *
 * Network failures or filesystem failures are silently ignored.
 */
async function updateSkill(): Promise<void> {
  debug("pre-check starting workspace", process.cwd());
  debug("pre-check refreshing workspace SKILL.md from", SKILL_MD_URL);
  const remoteContent = await downloadText(SKILL_MD_URL);
  if (!remoteContent) {
    debug("pre-check SKILL.md download returned empty");
    return;
  }

  try {
    const targetDir = path.dirname(WORKSPACE_SKILL_PATH);
    const tempPath = `${WORKSPACE_SKILL_PATH}.tmp`;
    debug("pre-check writing workspace SKILL.md", {
      target: WORKSPACE_SKILL_PATH,
      temp: tempPath,
    });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempPath, remoteContent, "utf-8");
    fs.renameSync(tempPath, WORKSPACE_SKILL_PATH);
    debug("pre-check workspace SKILL.md refreshed", WORKSPACE_SKILL_PATH);
  } catch {
    // Non-critical — the current command can still continue on older bits
    debug("pre-check workspace SKILL.md refresh failed", WORKSPACE_SKILL_PATH);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the pre-flight update check.
 *
 * Called by cli.ts before dispatching any sub-command. If an update is
 * detected and applied successfully, the returned result contains a descriptive
 * message (for stderr) and `updated: true`.
 *
 * When `updated` is true the caller should exit and prompt the agent /
 * user to re-run the command (the running binary and SKILL.md are stale).
 */
export async function preCheck(): Promise<PreCheckResult> {
  const toolsMdStatus = readToolsMdStatus();
  debug("pre-check workspace TOOLS.md", {
    path: WORKSPACE_TOOLS_PATH,
    ...toolsMdStatus,
  });

  // --- Gate: skip if last check was recent enough ---
  if (!shouldCheck()) {
    debug("pre-check skipped because interval not reached");
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
    debug("pre-check found CLI already up-to-date", remoteVersion);
    recordCheckTime();
    return { updated: false, message: "" };
  }

  // --- Version mismatch → first update the CLI package itself ---
  debug("pre-check update required", {
    localVersion,
    remoteVersion,
    skillPath: WORKSPACE_SKILL_PATH,
  });
  const cliUpdated = updateCli();
  if (!cliUpdated) {
    recordCheckTime();
    return {
      updated: false,
      message: [
        "[zcloak-ai] Version update detected, but automatic CLI update failed.",
        `[zcloak-ai] CLI: ${localVersion ?? "unknown"} → ${remoteVersion} (not installed)`,
        `[zcloak-ai] Tried: npm install -g ${NPM_PACKAGE_NAME}@latest`,
        "[zcloak-ai] Continuing with the current CLI version.",
      ].join("\n"),
    };
  }

  // CLI upgrade succeeded → refresh workspace SKILL.md as best-effort follow-up.
  await updateSkill();
  recordCheckTime();

  return {
    updated: true,
    message: [
      "[zcloak-ai] Version update detected!",
      `[zcloak-ai] CLI: ${localVersion ?? "unknown"} → ${remoteVersion} (updated)`,
      `[zcloak-ai] Workspace SKILL.md target: ${WORKSPACE_SKILL_PATH}`,
      `[zcloak-ai] if updated, tell the user version changed. and 1.  ${WORKSPACE_SKILL_PATH} maybe not the claw workingspace, you may move the SKILL.md to <claw_workingspace>/skills/zcloak-ai-agent/SKILL.md"; 2. also you must reload the updated SKILL.md and re-run the previous command because of those changes.`,
      ...(!toolsMdStatus.mentionsZcloakAiAgent ? [TOOLS_MD_ZCLOAK_SKILL_APPEND_HINT] : []),
    ].join("\n"),
  };
}
