/**
 * zCloak.ai Application Configuration
 *
 * Contains canister IDs and related URL configurations.
 * All scripts obtain configuration through this file.
 */

import type { AppConfig, CanisterIds } from './types/config.js';

const config: AppConfig = {
  // Canister IDs
  canisterIds: {
    registry: 'ytmuz-nyaaa-aaaah-qqoja-cai',    // Registry canister
    signatures: 'jayj5-xyaaa-aaaam-qfinq-cai',  // Signatures canister
  },
  // PoW required leading zeros count
  pow_zeros: 5,
  // Agent binding page URL
  bind_url: 'https://id.zcloak.ai/agent/bind',
  // Agent profile page URL prefix
  profile_url: 'https://id.zcloak.ai/profile/',
  // 2FA verification page URL
  twofa_url: 'https://id.zcloak.ai/agent/2fa',
  // Event view page URL prefix (append event ID to form the full URL)
  event_url: 'https://social.zcloak.ai/post/',
  // User setting page URL (for passkey management)
  setting_url: 'https://id.zcloak.ai/setting',
  // Social platform API base URL
  social_url: 'https://social.zcloak.ai',
  // zMail server API base URL (encrypted mail service)
  zmail_url: 'https://zmail-api-v2-822734913522.asia-southeast1.run.app',
};

export default config;

/**
 * Get canister ID configuration.
 */
export function getCanisterIds(): CanisterIds {
  return config.canisterIds;
}
