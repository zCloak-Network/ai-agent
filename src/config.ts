/**
 * zCloak.ai Environment Configuration
 *
 * Contains prod and dev canister IDs, and related URL configurations.
 * All scripts obtain current environment configuration through this file.
 *
 * Also includes environment detection functions (getEnv, getCanisterIds, getEnvLabel),
 * moved here from utils.ts to eliminate circular dependencies.
 */

import type { AppConfig, CanisterIds, Environment } from './types/config';

const config: AppConfig = {
  // Production environment canister IDs
  prod: {
    registry: 'ytmuz-nyaaa-aaaah-qqoja-cai',   // Registry canister
    signatures: 'jayj5-xyaaa-aaaam-qfinq-cai',  // Signatures canister
  },
  // Development environment canister IDs
  dev: {
    registry: '3spie-caaaa-aaaam-ae3sa-cai',    // Registry canister (dev)
    signatures: 'zpbbm-piaaa-aaaaj-a3dsq-cai',  // Signatures canister (dev)
  },
  // PoW required leading zeros count
  pow_zeros: 5,
  // Agent binding page URL
  bind_url: {
    prod: 'https://id.zcloak.ai/agent/bind',
    dev: 'https://id.zcloak.xyz/agent/bind',
  },
  // Agent profile page URL prefix
  profile_url: {
    prod: 'https://id.zcloak.ai/profile/',
    dev: 'https://id.zcloak.xyz/profile/',
  },
};

export default config;

// ========== Environment Management (moved from utils.ts) ==========

/**
 * Parse current environment (prod or dev) from command line arguments or environment variables.
 * Priority: --env=xxx > ZCLOAK_ENV > default prod
 *
 * SAFETY: Throws on unknown values to prevent typos from silently targeting production.
 * This is a fail-closed design — write operations (register, sign, bind) must never
 * accidentally hit production due to a misspelled environment name.
 *
 * When called with an explicit argv array, uses that instead of process.argv.
 * This enables deterministic, testable behavior without global state dependency.
 *
 * @param argv - Optional explicit argument array (defaults to process.argv)
 * @throws {Error} If --env= or ZCLOAK_ENV specifies an unrecognized value
 */
export function getEnv(argv?: string[]): Environment {
  // 1. Check --env=xxx command line argument
  const effectiveArgv = argv ?? process.argv;
  const envArg = effectiveArgv.find(a => a.startsWith('--env='));
  if (envArg) {
    const val = envArg.split('=')[1];
    if (val === 'dev' || val === 'prod') return val;
    throw new Error(
      `Unknown environment "${val}". Valid values: prod, dev`
    );
  }
  // 2. Check ZCLOAK_ENV environment variable
  const envVar = process.env.ZCLOAK_ENV;
  if (envVar === 'dev' || envVar === 'prod') return envVar;
  if (envVar !== undefined && envVar !== '') {
    throw new Error(
      `Unknown ZCLOAK_ENV value "${envVar}". Valid values: prod, dev`
    );
  }
  // 3. Default to prod (when no explicit env is specified)
  return 'prod';
}

/**
 * Get current environment's canister ID configuration
 * @param argv - Optional explicit argument array (passed through to getEnv)
 */
export function getCanisterIds(argv?: string[]): CanisterIds {
  const env = getEnv(argv);
  return config[env];
}

/**
 * Get current environment name (for log output)
 * @param argv - Optional explicit argument array (passed through to getEnv)
 */
export function getEnvLabel(argv?: string[]): string {
  return getEnv(argv).toUpperCase();
}
