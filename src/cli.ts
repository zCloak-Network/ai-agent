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
 *   zcloak-ai zmail <command> [args]      Encrypted mail (register, inbox, sent, ack)
 *   zcloak-ai pre-check                   Manually run the package/skill update pre-check
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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Session } from './session.js';
import { preCheck } from './pre-check.js';
import { DEFAULT_PEM_PATH, loadIdentityFromPath } from './identity.js';
import { STANDARD_DAEMON_KEY_NAMES, startDaemonBackground, stopAllDaemons } from './vetkey.js';
import { isDaemonAlive } from './daemon.js';
import * as log from './log.js';

/** ESM equivalent of __dirname */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Supported modules and their corresponding script files (compiled in dist/ directory) */
const MODULES: Record<string, string> = {
  identity: 'identity_cmd',
  register: 'register',
  sign: 'sign',
  verify: 'verify',
  feed: 'feed',
  bind: 'bind',
  delete: 'delete',
  doc: 'doc',
  pow: 'pow',
  vetkey: 'vetkey',
  social: 'social',
  zmail: 'zmail',
};

function showHelp(): void {
  console.log('zCloak.ai Agent CLI');
  console.log('');
  console.log('Usage: zcloak-ai <module> <command> [args] [options]');
  console.log('');
  console.log('Modules:');
  console.log('  identity    Identity key management (generate, show)');
  console.log('  register    Registration management (get-principal, lookup, register, ...)');
  console.log('  sign        Signing operations (post, like, reply, profile, sign-file, ...)');
  console.log('  verify      Verification operations (message, file, folder, profile)');
  console.log('  feed        Event queries (counter, fetch)');
  console.log('  bind        Agent-Owner binding (prepare, check-passkey)');
  console.log('  delete      File deletion with 2FA verification (prepare, check, confirm)');
  console.log('  doc         Document tools (manifest, verify-manifest, hash, info)');
  console.log('  pow         PoW computation (<base_string> <zeros>)');
  console.log('  vetkey      VetKey encryption/decryption (encrypt-sign, decrypt, ...)');
  console.log('  social      Social profile query (get-profile)');
  console.log('  zmail       Encrypted mail (register, sync, inbox, sent, ack)');
  console.log('  pre-check   Manually run the package/skill update pre-check');
  console.log('');
  console.log('Global options:');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai register get-principal');
  console.log('  zcloak-ai sign post "Hello world!" --sub=web3 --tags=t:crypto');
  console.log('  zcloak-ai feed counter');
  console.log('  zcloak-ai verify file ./report.pdf');
  console.log('  zcloak-ai doc hash ./report.pdf');
  console.log('  zcloak-ai pre-check');
  console.log('');
  console.log('Module help:');
  console.log('  zcloak-ai <module>     (run without command to show module help)');
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

  if (!moduleName || moduleName === '--help' || moduleName === '-h') {
    showHelp();
    process.exit(0);
  }

  if (moduleName === 'pre-check') {
    const checkResult = await preCheck();
    if (checkResult.message) {
      log.info(checkResult.message);
    } else {
      log.info('Pre-check complete. No updates were applied.');
    }
    process.exit(0);
  }

  // Find the corresponding script
  const scriptFile = MODULES[moduleName];
  if (!scriptFile) {
    console.error(`Unknown module: ${moduleName}`);
    console.error('');
    console.error('Available modules: ' + Object.keys(MODULES).join(', '));
    console.error('Run zcloak-ai --help for help');
    process.exit(1);
  }

  // Automatic pre-check for normal commands: compare local CLI version against
  // npm registry, update the npm package and workspace SKILL.md if needed, and
  // stop so the caller can reload context and re-run on the updated bits.
  const checkResult = await preCheck();
  if (checkResult.updated) {
    // Stop all running daemons after a successful upgrade — the background
    // daemons still point at the old package bits. They will be auto-restarted
    // on the next command invocation via the warm-up logic below.
    try {
      await stopAllDaemons();
    } catch {
      // Best-effort — don't block upgrade on daemon stop failure
    }

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
      (moduleName === 'vetkey' && process.argv[3] === 'serve') ||
      (moduleName === 'identity' && process.argv[3] === 'generate');
    if (skipWarmUp) return;

    // Step 2: Resolve PEM path
    const identityArg = process.argv.find(a => a.startsWith('--identity='));
    const pemPath = identityArg
      ? identityArg.split('=').slice(1).join('=')
      : DEFAULT_PEM_PATH;

    // Step 3: PEM file must exist (no identity → no daemon)
    if (!fs.existsSync(pemPath)) return;

    // Step 4: Load identity and extract principal
    let principal: string;
    try {
      const identity = loadIdentityFromPath(pemPath);
      principal = identity.getPrincipal().toText();
    } catch {
      return; // Identity load failed — skip warm-up
    }

    // Step 5: Check each standard daemon, start if not running
    for (const keyName of STANDARD_DAEMON_KEY_NAMES) {
      const derivationId = `${principal}:${keyName}`;
      if (isDaemonAlive(derivationId)) continue;

      try {
        startDaemonBackground(pemPath, keyName);
      } catch {
        // Best-effort — ignore spawn failures
      }
    }
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
