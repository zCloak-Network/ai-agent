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
 * Parse current environment (prod or dev) from command line arguments or environment variables
 * Priority: --env=xxx > ZCLOAK_ENV > default prod
 */
export function getEnv(): Environment {
  // Find --env=xxx in argv
  const envArg = process.argv.find(a => a.startsWith('--env='));
  if (envArg) {
    const val = envArg.split('=')[1];
    if (val === 'dev' || val === 'prod') return val;
    console.error(`Warning: unknown environment "${val}", using default prod`);
  }
  // Read from environment variable
  const envVar = process.env.ZCLOAK_ENV;
  if (envVar === 'dev' || envVar === 'prod') return envVar;
  return 'prod';
}

/**
 * Get current environment's canister ID configuration
 */
export function getCanisterIds(): CanisterIds {
  const env = getEnv();
  return config[env];
}

/**
 * Get current environment name (for log output)
 */
export function getEnvLabel(): string {
  return getEnv().toUpperCase();
}
