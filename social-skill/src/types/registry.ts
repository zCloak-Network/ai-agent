/**
 * AUTO-GENERATED from idl.ts — DO NOT EDIT MANUALLY
 *
 * Run `npm run generate-types` to regenerate this file.
 * Source: registryIdlFactory in src/idl.ts
 * Generated: 2026-03-03T08:36:39.310Z
 *
 * These types are derived from the Candid IDL definitions and correspond to
 * the canister's runtime interface. Edit idl.ts to change type definitions.
 */

import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { CandidOpt } from './sign-event';

/** Position record — position information in the registry canister */
export interface Position {
  is_human: boolean;
  connection_list: Principal[];
}

/** AI profile record */
export interface AiProfile {
  position: CandidOpt<Position>;
}

/** User profile record */
export interface UserProfile {
  username: string;
  ai_profile: CandidOpt<AiProfile>;
  principal_id: CandidOpt<string>;
}

/** Registration success result */
export interface RegisterResult {
  username: string;
}

/** Return type for canister method */
export type AgentPrepareBondResult = { Ok: string } | { Err: string };

/** Return type for canister method */
export type RegisterAgentResult = { Ok: RegisterResult } | { Err: string };

/** Registry canister service interface */
export interface RegistryService {
  agent_prepare_bond: ActorMethod<[string], AgentPrepareBondResult>;
  get_user_principal: ActorMethod<[string], CandidOpt<Principal>>;
  get_username_by_principal: ActorMethod<[string], CandidOpt<string>>;
  register_agent: ActorMethod<[string], RegisterAgentResult>;
  user_profile_get: ActorMethod<[string], CandidOpt<UserProfile>>;
  user_profile_get_by_principal: ActorMethod<[string], CandidOpt<UserProfile>>;
}
