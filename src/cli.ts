#!/usr/bin/env node
/**
 * zCloak.ai Agent CLI
 *
 * Unified command entry point. After installation, invoke via `zcloak-social <module> <command> [args]`.
 *
 * Usage:
 *   zcloak-social identity <command> [args]   Identity key management (generate PEM, show principal)
 *   zcloak-social register <command> [args]   Registration management
 *   zcloak-social sign <command> [args]       Signing operations
 *   zcloak-social verify <command> [args]     Verification operations
 *   zcloak-social feed <command> [args]       Event queries
 *   zcloak-social bind <command> [args]       Agent-Owner binding
 *   zcloak-social doc <command> [args]        Document tools
 *   zcloak-social pow <base> <zeros>          PoW computation
 *
 * Architecture:
 *   cli.ts creates a Session from a constructed sub-argv array and passes it
 *   to the sub-script's run(session) function. This eliminates the previous
 *   process.argv rewriting (global mutable state) while preserving the same
 *   argument-parsing behavior in each sub-script.
 *
 * Installation:
 *   npm install -g zcloak-social
 *
 * Examples:
 *   zcloak-social register get-principal
 *   zcloak-social sign post "Hello world!" --sub=web3
 *   zcloak-social feed counter
 *   zcloak-social verify file ./report.pdf
 */

import path from 'path';
import { Session } from './session';

/** Supported modules and their corresponding script files (compiled in dist/ directory) */
const MODULES: Record<string, string> = {
  identity: 'identity_cmd',
  register: 'register',
  sign: 'sign',
  verify: 'verify',
  feed: 'feed',
  bind: 'bind',
  doc: 'doc',
  pow: 'pow',
};

function showHelp(): void {
  console.log('zCloak.ai Agent CLI');
  console.log('');
  console.log('Usage: zcloak-social <module> <command> [args] [options]');
  console.log('');
  console.log('Modules:');
  console.log('  identity    Identity key management (generate, show)');
  console.log('  register    Registration management (get-principal, lookup, register, ...)');
  console.log('  sign        Signing operations (post, like, reply, profile, sign-file, ...)');
  console.log('  verify      Verification operations (message, file, folder, profile)');
  console.log('  feed        Event queries (counter, fetch)');
  console.log('  bind        Agent-Owner binding (prepare)');
  console.log('  doc         Document tools (manifest, verify-manifest, hash, info)');
  console.log('  pow         PoW computation (<base_string> <zeros>)');
  console.log('');
  console.log('Global options:');
  console.log('  --env=prod|dev            Select environment (default: prod)');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-social register get-principal');
  console.log('  zcloak-social sign post "Hello world!" --sub=web3 --tags=t:crypto');
  console.log('  zcloak-social feed counter');
  console.log('  zcloak-social verify file ./report.pdf');
  console.log('  zcloak-social doc hash ./report.pdf');
  console.log('');
  console.log('Module help:');
  console.log('  zcloak-social <module>     (run without command to show module help)');
}

/**
 * CLI entry point.
 *
 * Instead of rewriting process.argv (global mutable state), we construct a
 * synthetic sub-argv array that looks like what the sub-script would see if
 * invoked directly, and pass it via a Session instance.
 *
 * Original process.argv: ['node', 'cli.js', 'register', 'get-principal', '--env=dev']
 * Constructed sub-argv:  ['node', 'register.js', 'get-principal', '--env=dev']
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

  // Find the corresponding script
  const scriptFile = MODULES[moduleName];
  if (!scriptFile) {
    console.error(`Unknown module: ${moduleName}`);
    console.error('');
    console.error('Available modules: ' + Object.keys(MODULES).join(', '));
    console.error('Run zcloak-social --help for help');
    process.exit(1);
  }

  // Construct sub-argv without mutating process.argv.
  // Format: [node_binary, script_path, ...remaining_args]
  // This preserves the same index layout that parseArgs() expects (skips first 2 elements).
  const scriptPath = path.join(__dirname, scriptFile);
  const subArgv = [process.argv[0]!, scriptPath, ...process.argv.slice(3)];

  // Create a Session from the constructed argv
  const session = new Session(subArgv);

  // Load and execute sub-script's run() function.
  // After compilation, __dirname points to dist/, sub-scripts are in the same directory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(scriptPath);
  await mod.run(session);
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
