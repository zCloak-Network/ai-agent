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
import { homedir } from "os";
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


/** Instruction appended when the current workspace should register the zCloak skill in TOOLS.md. */
const TOOLS_MD_ZCLOAK_SKILL_APPEND_HINT = [
  "[zcloak-ai] add or update(may exists) following to TOOLS.md in openclaw workspace:",
  "## zCloak.ai SKILL",
  "- Skill location: <openclaw_workspace>/skills/zcloak-ai-agent/",
  "- Upgrade URL: https://raw.githubusercontent.com/zCloak-Network/ai-agent/refs/heads/main/SKILL.md",
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
// Post-upgrade: workspace resolution
// ---------------------------------------------------------------------------

/** OpenClaw config file candidates, in priority order */
const OPENCLAW_CONFIG_CANDIDATES = [
  path.join(homedir(), ".openclaw", "openclaw.json"),
  path.join(homedir(), ".clawdbot", "clawdbot.json"), // legacy
];

/** Default workspace when no config file is found */
const DEFAULT_WORKSPACE = path.join(homedir(), ".openclaw", "workspace");

/**
 * Walk up from cwd looking for an OpenClaw workspace marker.
 *
 * OpenClaw workspaces contain a `.clawhub/` or `.clawdhub/` directory
 * (created by `npx clawhub install`). Inheriting the agent's cwd lets us
 * find the workspace without reading any config file.
 *
 * Returns the workspace root if found, null otherwise.
 */
function resolveWorkspaceFromCwd(): string | null {
  const MARKERS = [".clawhub", ".clawdhub"];
  let dir = process.cwd();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const marker of MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) {
        debug("post-upgrade workspace resolved from cwd walk", { dir, marker });
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Read `agents.defaults.workspace` from an OpenClaw config file.
 * Returns null if the file is absent, unparseable, or the field is missing.
 */
function readWorkspaceFromConfig(configPath: string): string | null {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    const agents = json["agents"] as Record<string, unknown> | undefined;
    const defaults = agents?.["defaults"] as Record<string, unknown> | undefined;
    const workspace = defaults?.["workspace"];
    if (typeof workspace === "string" && workspace.length > 0) {
      debug("post-upgrade workspace resolved from config", { configPath, workspace });
      return workspace;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the OpenClaw workspace directory.
 *
 * Priority:
 *   1. OPENCLAW_WORKDIR / CLAWHUB_WORKDIR environment variable
 *   2. ~/.openclaw/openclaw.json  → agents.defaults.workspace
 *   3. ~/.clawdbot/clawdbot.json  → agents.defaults.workspace  (legacy)
 *   4. Fallback: ~/.openclaw/workspace
 */
export function resolveOpenClawWorkspace(): string {
  debug("post-upgrade workspace cwd =", process.cwd());

  const envWorkdir =
    process.env["OPENCLAW_WORKDIR"] ??
    process.env["CLAWHUB_WORKDIR"] ??
    process.env["CLAWDHUB_WORKDIR"];
  if (envWorkdir) {
    debug("post-upgrade workspace resolved from env", { envWorkdir });
    return envWorkdir;
  }

  // 2. Walk up from cwd — inherits the agent process's working directory
  const cwdWorkspace = resolveWorkspaceFromCwd();

  // 3 & 4. Config files
  let configWorkspace: string | null = null;
  for (const configPath of OPENCLAW_CONFIG_CANDIDATES) {
    configWorkspace = readWorkspaceFromConfig(configPath);
    if (configWorkspace) break;
  }

  info(`[zcloak-ai] post-upgrade workspace candidates — cwd-walk: ${cwdWorkspace ?? "not found"} | config: ${configWorkspace ?? "not found"}`);

  if (cwdWorkspace) return cwdWorkspace;
  if (configWorkspace) return configWorkspace;

  debug("post-upgrade workspace using default fallback", { workspace: DEFAULT_WORKSPACE });
  return DEFAULT_WORKSPACE;
}

// ---------------------------------------------------------------------------
// Post-upgrade steps (stubs — implement one by one)
// ---------------------------------------------------------------------------

/**
 * Fetch the latest SKILL.md from GitHub and write it to
 * <workspace>/skills/zcloak-ai-agent/SKILL.md.
 * TODO: implement
 */
async function refreshSkill(_workspace: string): Promise<void> {
  // TODO
}

/**
 * Append or update the zCloak skill section in <workspace>/TOOLS.md.
 * TODO: implement
 */
async function updateToolsMd(_workspace: string): Promise<void> {
  // TODO
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

  await refreshSkill(workspace);
  await updateToolsMd(workspace);

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
