#!/usr/bin/env node
/**
 * zCloak.ai Agent CLI
 *
 * Unified command entry point. After installation, invoke via `zcloak-ai <module> <command> [args]`.
 *
 * Usage:
 *   zcloak-ai identity <command> [args]   Identity key management (generate PEM, show principal)
 *   zcloak-ai register <command> [args]   Registration management
 *   zcloak-ai sign <command> [args]       Signing operations
 *   zcloak-ai verify <command> [args]     Verification operations
 *   zcloak-ai feed <command> [args]       Event queries
 *   zcloak-ai bind <command> [args]       Agent-Owner binding
 *   zcloak-ai doc <command> [args]        Document tools
 *   zcloak-ai pow <base> <zeros>          PoW computation
 *   zcloak-ai vetkey <command> [args]     VetKey encryption/decryption
 *   zcloak-ai social <command> [args]     Social profile query
 *   zcloak-ai zmail <command> [args]      Encrypted mail (register, sync, inbox, sent, ack, policy, allow, block)
 *
 * Architecture:
 *   cli.ts creates a Session from a constructed sub-argv array and passes it
 *   to the sub-script's run(session) function. This eliminates the previous
 *   process.argv rewriting (global mutable state) while preserving the same
 *   argument-parsing behavior in each sub-script.
 *
 * Examples:
 *   zcloak-ai register get-principal
 *   zcloak-ai sign post "Hello world!" --sub=web3
 *   zcloak-ai feed counter
 *   zcloak-ai verify file ./report.pdf
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Session } from "./session.js";
import { preCheck } from "./pre-check.js";
import { runOnboard } from "./onboard.js";
import { getPemPath, loadIdentityFromPath } from "./identity.js";
import { startDaemonBackground, stopAllDaemons } from "./vetkey.js";
import { isDaemonAlive, runtimeDir, sanitizeDerivationId } from "./daemon.js";
import * as log from "./log.js";

/** ESM equivalent of __dirname */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_START_LOCK_TTL_MS = 30_000;

/** Supported modules and their corresponding script files (compiled in dist/ directory) */
const MODULES: Record<string, string> = {
  identity: "identity_cmd",
  register: "register",
  sign: "sign",
  verify: "verify",
  feed: "feed",
  bind: "bind",
  delete: "delete",
  doc: "doc",
  pow: "pow",
  vetkey: "vetkey",
  social: "social",
  zmail: "zmail",
};

function daemonStartLockPath(derivationId: string): string {
  return path.join(
    runtimeDir(),
    `${sanitizeDerivationId(derivationId)}.starting.lock`,
  );
}

function tryAcquireDaemonStartLock(derivationId: string): boolean {
  const lockPath = daemonStartLockPath(derivationId);

  try {
    fs.mkdirSync(runtimeDir(), { recursive: true });
  } catch (error) {
    log.warn(
      "Failed to ensure daemon runtime directory before acquiring start lock",
      {
        derivationId,
        lockPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return false;
  }

  try {
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < DAEMON_START_LOCK_TTL_MS) {
      return false;
    }
    fs.unlinkSync(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== "ENOENT") {
      log.warn(
        "Failed while checking or cleaning an existing daemon start lock",
        {
          derivationId,
          lockPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    // No existing lock (or unreadable lock) — continue and try to create one.
  }

  try {
    fs.writeFileSync(lockPath, String(Date.now()), { flag: "wx" });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== "EEXIST") {
      log.warn("Failed to create daemon start lock", {
        derivationId,
        lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }
}

function resolveWarmUpContext(
  argv: string[],
): { pemPath: string; principal: string } | null {
  const identityArg = argv.find((a) => a.startsWith("--identity="));
  const pemPath = getPemPath(argv);


  if (!fs.existsSync(pemPath)) {
    log.debug(
      "Daemon warm-up context unavailable because PEM file does not exist",
      {
        pemPath,
      },
    );
    return null;
  }

  try {
    const identity = loadIdentityFromPath(pemPath);
    const context = {
      pemPath,
      principal: identity.getPrincipal().toText(),
    };
    return context;
  } catch (error) {
    log.warn(
      "Daemon warm-up context resolution failed while loading identity",
      {
        pemPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    log.debug(
      "Daemon warm-up context resolution failed while loading identity",
      {
        pemPath,
      },
    );
    return null;
  }
}

function warmUpDaemonForCurrentIdentity(argv: string[]): void {
  const context = resolveWarmUpContext(argv);
  if (!context) {
    log.debug("Daemon warm-up aborted because context could not be resolved");
    return;
  }

  const { pemPath, principal } = context;

  if (isDaemonAlive(principal)) {
    log.debug("Daemon warm-up skipped [already running]");
    return;
  }
  if (!tryAcquireDaemonStartLock(principal)) {
    log.debug("Daemon warm-up skipped because start lock is already held", {
      principal,
      lockPath: daemonStartLockPath(principal),
    });
    return;
  }

  try {
    log.debug("Daemon warm-up starting background daemon", {
      principal,
      pemPath,
    });
    const pid = startDaemonBackground(pemPath, principal);
    log.debug("Daemon warm-up background spawn result", {
      principal,
      pid: pid ?? null,
    });
  } catch (error) {
    log.warn("Daemon warm-up background spawn threw unexpectedly", {
      principal,
      pemPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function showHelp(): void {
  console.log("zCloak.ai Agent CLI");
  console.log("");
  console.log("Usage: zcloak-ai <module> <command> [args] [options]");
  console.log("");
  console.log("Modules:");
  console.log("  identity    Identity key management (generate, show)");
  console.log(
    "  register    Registration management (get-principal, lookup, register, ...)",
  );
  console.log(
    "  sign        Signing operations (post, like, reply, profile, sign-file, ...)",
  );
  console.log(
    "  verify      Verification operations (message, file, folder, profile)",
  );
  console.log("  feed        Event queries (counter, fetch)");
  console.log("  bind        Agent-Owner binding (prepare, check-passkey)");
  console.log(
    "  delete      File deletion with 2FA verification (prepare, check, confirm)",
  );
  console.log(
    "  doc         Document tools (manifest, verify-manifest, hash, info)",
  );
  console.log("  pow         PoW computation (<base_string> <zeros>)");
  console.log(
    "  vetkey      VetKey encryption/decryption (encrypt-sign, decrypt, ...)",
  );
  console.log("  social      Social profile query (get-profile)");
  console.log(
    "  zmail       Encrypted mail (register, sync, inbox, sent, ack, policy, allow, block)",
  );
  console.log("");
  console.log("Global options:");
  console.log("  --identity=<pem_path>     Specify identity PEM file");
  console.log("");
  console.log("Examples:");
  console.log("  zcloak-ai register get-principal");
  console.log(
    '  zcloak-ai sign post "Hello world!" --sub=web3 --tags=t:crypto',
  );
  console.log("  zcloak-ai feed counter");
  console.log("  zcloak-ai verify file ./report.pdf");
  console.log("  zcloak-ai doc hash ./report.pdf");
  console.log("");
  console.log("Module help:");
  console.log(
    "  zcloak-ai <module>     (run without command to show module help)",
  );
}

/**
 * CLI entry point.
 *
 * Instead of rewriting process.argv (global mutable state), we construct a
 * synthetic sub-argv array that looks like what the sub-script would see if
 * invoked directly, and pass it via a Session instance.
 *
 * Original process.argv: ['node', 'cli.js', 'register', 'get-principal']
 * Constructed sub-argv:  ['node', 'register.js', 'get-principal']
 *
 * The Session constructor calls parseArgs(subArgv) which skips [0] and [1],
 * so the sub-script receives the same parsed arguments as before.
 */
async function main(): Promise<void> {
  // Get module name (skip node and script path)
  const moduleName = process.argv[2];

  if (!moduleName || moduleName === "--help" || moduleName === "-h") {
    showHelp();
    process.exit(0);
  }

  if (moduleName === "onboard") {
    await runOnboard();
    process.exit(0);
  }

  if (moduleName === "pre-check") {
    const checkResult = await preCheck(process.argv);
    if (checkResult.updated) {
      try {
        await stopAllDaemons();
      } catch {
        // Best-effort — don't block upgrade on daemon stop failure
      }

      warmUpDaemonForCurrentIdentity(process.argv);
    }
    if (checkResult.message) {
      log.info(checkResult.message);
    } else {
      log.info("Pre-check complete. No updates were applied.");
    }
    process.exit(0);
  }

  // Find the corresponding script
  const scriptFile = MODULES[moduleName];
  if (!scriptFile) {
    console.error(`Unknown module: ${moduleName}`);
    console.error("");
    console.error("Available modules: " + Object.keys(MODULES).join(", "));
    console.error("Run zcloak-ai --help for help");
    process.exit(1);
  }

  // Automatic pre-check for normal commands: compare local CLI version against
  // npm registry, update the npm package if needed, and stop so the caller can
  // reload context and re-run on the updated CLI bits.
  const checkResult = await preCheck(process.argv);
  if (checkResult.updated) {
    // Stop all running daemons after a successful upgrade — the background
    // daemons still point at the old package bits. They will be auto-restarted
    // on the next command invocation via the warm-up logic below.
    try {
      await stopAllDaemons();
    } catch {
      // Best-effort — don't block upgrade on daemon stop failure
    }

    // Immediately warm the current principal daemon back up on the updated
    // bits so the next CLI command does not pay another cold-start cost.
    warmUpDaemonForCurrentIdentity(process.argv);

    log.info(checkResult.message);
    process.exit(0);
  }
  if (checkResult.message) {
    log.warn(checkResult.message);
  }

  // Construct sub-argv without mutating process.argv.
  // Format: [node_binary, script_path, ...remaining_args]
  // This preserves the same index layout that parseArgs() expects (skips first 2 elements).
  const scriptPath = path.join(__dirname, `${scriptFile}.js`);
  const subArgv = [process.argv[0]!, scriptPath, ...process.argv.slice(3)];

  // Create a Session from the constructed argv
  const session = new Session(subArgv);

  // ── Daemon warm-up (best-effort, never blocks main command) ──────
  // Each step is independent: fail at any step → skip the rest silently.
  (() => {
    // Step 1: Skip commands that conflict with daemon warm-up
    const skipWarmUp =
      (moduleName === "vetkey" && process.argv[3] === "serve") ||
      (moduleName === "vetkey" && process.argv[3] === "stop") ||
      (moduleName === "vetkey" && process.argv[3] === "status") ||
      (moduleName === "identity" && process.argv[3] === "generate");
    log.debug("Daemon warm-up checking whether to skip based on command", {
      moduleName,
      command: process.argv[3],
      skipWarmUp,
    });
    if (skipWarmUp) return;
    warmUpDaemonForCurrentIdentity(process.argv);
  })();

  // Load and execute sub-script's run() function.
  // After compilation, __dirname points to dist/, sub-scripts are in the same directory.
  const mod = await import(scriptPath);
  await mod.run(session);
}

main().catch((err: unknown) => {
  log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
