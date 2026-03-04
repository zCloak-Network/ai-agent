/**
 * zCloak.ai Application Configuration
 *
 * Contains canister IDs and related URL configurations.
 * All scripts obtain configuration through this file.
 */

import type { AppConfig, CanisterIds } from './types/config';

const config: AppConfig = {
  // Canister IDs
  canisterIds: {
    registry: '3spie-caaaa-aaaam-ae3sa-cai',    // Registry canister
    signatures: 'zpbbm-piaaa-aaaaj-a3dsq-cai',  // Signatures canister
  },
  // PoW required leading zeros count
  pow_zeros: 5,
  // Agent binding page URL
  bind_url: 'https://id.zcloak.xyz/agent/bind',
  // Agent profile page URL prefix
  profile_url: 'https://id.zcloak.xyz/profile/',
  // 2FA verification page URL
  twofa_url: 'https://id.zcloak.xyz/agent/2fa',
  // Event view page URL prefix (append event ID to form the full URL)
  event_url: 'https://social.zcloak.xyz/post/',
};

export default config;

/**
 * Get canister ID configuration.
 */
export function getCanisterIds(): CanisterIds {
  return config.canisterIds;
}
