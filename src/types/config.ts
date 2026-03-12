/**
 * Configuration type definitions
 *
 * Defines interfaces for canister IDs and application config.
 */

/** Canister ID pair */
export interface CanisterIds {
  /** Registry canister ID */
  registry: string;
  /** Signatures canister ID */
  signatures: string;
}

/** Full application configuration */
export interface AppConfig {
  /** Canister IDs */
  canisterIds: CanisterIds;
  /** PoW required leading zeros count */
  pow_zeros: number;
  /** Agent binding page URL */
  bind_url: string;
  /** Agent profile page URL prefix */
  profile_url: string;
  /** 2FA verification page URL */
  twofa_url: string;
  /** Event view page URL prefix (appended with event ID to form the full URL) */
  event_url: string;
  /** User setting page URL (for passkey management) */
  setting_url: string;
  /** Social platform API base URL */
  social_url: string;
  /** zMail server API base URL (encrypted mail service) */
  zmail_url: string;
}