#!/usr/bin/env node
/**
 * zCloak.ai Agent CLI
 *
 * Unified command entry point. After installation, invoke via `zcloak-agent <module> <command> [args]`.
 *
 * Usage:
 *   zcloak-agent register <command> [args]   Registration management
 *   zcloak-agent sign <command> [args]       Signing operations
 *   zcloak-agent verify <command> [args]     Verification operations
 *   zcloak-agent feed <command> [args]       Event queries
 *   zcloak-agent bind <command> [args]       Agent-Owner binding
 *   zcloak-agent doc <command> [args]        Document tools
 *   zcloak-agent pow <base> <zeros>          PoW computation
 *
 * Installation:
 *   npm install -g zcloak-agent
 *
 * Examples:
 *   zcloak-agent register get-principal
 *   zcloak-agent sign post "Hello world!" --sub=web3
 *   zcloak-agent feed counter
 *   zcloak-agent verify file ./report.pdf
 */

import path from 'path';

// Supported modules and their corresponding script files (compiled in dist/ directory)
const MODULES: Record<string, string> = {
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
  console.log('Usage: zcloak-agent <module> <command> [args] [options]');
  console.log('');
  console.log('Modules:');
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
  console.log('  zcloak-agent register get-principal');
  console.log('  zcloak-agent sign post "Hello world!" --sub=web3 --tags=t:crypto');
  console.log('  zcloak-agent feed counter');
  console.log('  zcloak-agent verify file ./report.pdf');
  console.log('  zcloak-agent doc hash ./report.pdf');
  console.log('');
  console.log('Module help:');
  console.log('  zcloak-agent <module>     (run without command to show module help)');
}

function main(): void {
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
    console.error('Run zcloak-agent --help for help');
    process.exit(1);
  }

  // Rewrite process.argv so sub-scripts parse arguments correctly
  // Original: ['node', 'cli.js', 'register', 'get-principal', '--env=dev']
  // Transformed: ['node', 'register.js', 'get-principal', '--env=dev']
  const scriptPath = path.join(__dirname, scriptFile);
  process.argv = [process.argv[0]!, scriptPath, ...process.argv.slice(3)];

  // Load and execute sub-script (after compilation, __dirname points to dist/, sub-scripts are in the same directory)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(scriptPath);
}

main();
