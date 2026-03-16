/**
 * AUTO-GENERATED from idl.ts — DO NOT EDIT MANUALLY
 *
 * Run `npm run generate-types` to regenerate this file.
 * Source: registryIdlFactory in src/idl.ts
 * Generated: 2026-03-16T01:36:27.466Z
 *
 * These types are derived from the Candid IDL definitions and correspond to
 * the canister's runtime interface. Edit idl.ts to change type definitions.
 */

import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { CandidOpt } from './sign-event.js';

/** Position record — position information in the registry canister */
export interface Position {
  is_human: boolean;
  connection_list: Principal[];
}

/** AI profile record */
export interface AiProfile {
  is_free: boolean;
  bio: CandidOpt<string>;
  default_name: CandidOpt<{
  id: string;
  domain: CandidOpt<{ AI: null } | { ORG: null } | { AGENT: null }>;
  index: CandidOpt<bigint>;
}>;
  ai_name: CandidOpt<{
  id: string;
  domain: CandidOpt<{ AI: null } | { ORG: null } | { AGENT: null }>;
  index: CandidOpt<bigint>;
}>;
  valid_time: CandidOpt<bigint>;
  position: CandidOpt<Position>;
}

/** User profile record */
export interface UserProfile {
  modify_time: bigint;
  username: string;
  passkey_name: string[];
  display_name: string;
  ai_profile: CandidOpt<AiProfile>;
  create_time: bigint;
  principal_id: CandidOpt<string>;
}

/** Registration success result */
export interface RegisterResult {
  username: string;
}

/** 2FA verification record — tracks a pending or completed 2FA request */
export interface TwoFARecord {
  request_timestamp: bigint;
  content: string;
  confirm_timestamp: CandidOpt<bigint>;
  confirm_owner: CandidOpt<string>;
  caller: string;
  owner_list: string[];
}

/** Return type for canister method */
export type AgentPrepareBondResult = { Ok: string } | { Err: string };

/** Return type for canister method */
export type Prepare2faInfoResult = { Ok: string } | { Err: string };

/** Return type for canister method */
export type RegisterAgentResult = { Ok: RegisterResult } | { Err: string };

/** Registry canister service interface */
export interface RegistryService {
  agent_prepare_bond: ActorMethod<[string], AgentPrepareBondResult>;
  get_user_principal: ActorMethod<[string], CandidOpt<Principal>>;
  get_username_by_principal: ActorMethod<[string], CandidOpt<string>>;
  prepare_2fa_info: ActorMethod<[string], Prepare2faInfoResult>;
  query_2fa_result_by_challenge: ActorMethod<[string], CandidOpt<TwoFARecord>>;
  register_agent: ActorMethod<[string], RegisterAgentResult>;
  user_profile_get: ActorMethod<[string], CandidOpt<UserProfile>>;
  user_profile_get_by_id: ActorMethod<[{
  id: string;
  domain: CandidOpt<{ AI: null } | { ORG: null } | { AGENT: null }>;
  index: CandidOpt<bigint>;
}], CandidOpt<UserProfile>>;
  user_profile_get_by_principal: ActorMethod<[string], CandidOpt<UserProfile>>;
}
