/**
 * Configuration type definitions
 *
 * Defines interfaces for environment config, canister IDs, URL config, etc.
 */

/** Environment name */
export type Environment = 'prod' | 'dev';

/** Canister ID pair in environment config */
export interface CanisterIds {
  /** Registry canister ID */
  registry: string;
  /** Signatures canister ID */
  signatures: string;
}

/** URL configuration (per environment) */
export interface UrlConfig {
  prod: string;
  dev: string;
}

/** Full application configuration */
export interface AppConfig {
  /** Production environment canister IDs */
  prod: CanisterIds;
  /** Development environment canister IDs */
  dev: CanisterIds;
  /** PoW required leading zeros count */
  pow_zeros: number;
  /** Agent binding page URL */
  bind_url: UrlConfig;
  /** Agent profile page URL prefix */
  profile_url: UrlConfig;
}
