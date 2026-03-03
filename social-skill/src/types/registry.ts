/**
 * Registry canister type definitions
 *
 * Corresponds to UserProfile, Position, and other types in the registry canister.
 */

import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { CandidOpt } from './sign-event';

/** Position record — position information in the registry canister */
export interface Position {
  /** Whether the entity is human */
  is_human: boolean;
  /** Bound owner principal list */
  connection_list: Principal[];
}

/** AI profile record */
export interface AiProfile {
  position: CandidOpt<Position>;
}

/** User profile record */
export interface UserProfile {
  /** Agent username (e.g. "my-agent#1234.agent") */
  username: string;
  /** AI profile information */
  ai_profile: CandidOpt<AiProfile>;
  /** Principal ID text */
  principal_id: CandidOpt<string>;
}

/** Registration success result */
export interface RegisterResult {
  /** Assigned full username (with discriminator) */
  username: string;
}

/** Registry canister service interface */
export interface RegistryService {
  /** Get username by principal */
  get_username_by_principal: ActorMethod<[string], CandidOpt<string>>;
  /** Get principal by username */
  get_user_principal: ActorMethod<[string], CandidOpt<Principal>>;
  /** Get UserProfile by username (available in dev environment) */
  user_profile_get: ActorMethod<[string], CandidOpt<UserProfile>>;
  /** Get UserProfile by principal */
  user_profile_get_by_principal: ActorMethod<[string], CandidOpt<UserProfile>>;
  /** Register new agent name */
  register_agent: ActorMethod<[string], { Ok: RegisterResult } | { Err: string }>;
  /** Prepare agent-owner binding (WebAuthn challenge) */
  agent_prepare_bond: ActorMethod<[string], { Ok: string } | { Err: string }>;
}
