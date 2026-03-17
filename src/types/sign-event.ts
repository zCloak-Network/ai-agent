/**
 * AUTO-GENERATED from idl.ts — DO NOT EDIT MANUALLY
 *
 * Run `npm run generate-types` to regenerate this file.
 * Source: signIdlFactory in src/idl.ts
 * Generated: 2026-03-17T08:59:46.111Z
 *
 * These types are derived from the Candid IDL definitions and correspond to
 * the canister's runtime interface. Edit idl.ts to change type definitions.
 */

import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';

/** Candid opt type representation: [] means null, [T] means has value */
export type CandidOpt<T> = [] | [T];

/** SignEvent — sign event record returned by canister */
export interface SignEvent {
  id: string;
  content: CandidOpt<string>;
  counter: CandidOpt<number>;
  ai_id: string;
  kind: number;
  content_hash: string;
  tags: CandidOpt<string[][]>;
  created_at: bigint;
}

/** SignParm variant — signing parameter types (one-of union) */
export type SignParm =
  | { Kind13PrivateContract: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind12PublicContract: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind10JobRequest: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind1IdentityProfile: {
  content: string;
} }
  | { Kind5PrivatePost: {
  ibe_identity: string;
  encrypted_content: number[];
  tags: CandidOpt<string[][]>;
} }
  | { Kind8MediaAsset: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind6Interaction: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind9ServiceListing: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind4PublicPost: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind7ContactList: {
  tags: CandidOpt<string[][]>;
} }
  | { Kind3SimpleAgreement: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind15GeneralAttestation: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind2IdentityVerification: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind14Review: {
  content: string;
  tags: CandidOpt<string[][]>;
} }
  | { Kind11DocumentSignature: {
  content: string;
  tags: CandidOpt<string[][]>;
} };

/** Return type for canister method */
export type AgentSignResult = { Ok: SignEvent } | { Err: string };

/** Return type for canister method */
export type GrantKind5AccessResult = { Ok: bigint } | { Err: string };

/** Return type for canister method */
export type RevokeKind5AccessResult = { Ok: null } | { Err: string };

/** Backward-compatible alias for agent_sign return type */
export type SignResult = AgentSignResult;

/** Signatures canister service interface — all callable canister methods */
export interface SignService {
  agent_sign: ActorMethod<[SignParm, string], AgentSignResult>;
  derive_vetkey: ActorMethod<[string, number[]], number[]>;
  fetch_events_by_counter: ActorMethod<[number, number], SignEvent[]>;
  fetch_user_sign: ActorMethod<[Principal, number, number], [number, SignEvent[]]>;
  get_all_sign_events: ActorMethod<[], SignEvent[]>;
  get_counter: ActorMethod<[], number>;
  get_ibe_public_key: ActorMethod<[], number[]>;
  get_kind1_event_by_principal: ActorMethod<[string], CandidOpt<SignEvent>>;
  get_kind5_decryption_key: ActorMethod<[string, number[]], {
  encrypted_key: number[];
  ciphertext: number[];
  ibe_identity: string;
}>;
  get_kind5_grants_by_grantee: ActorMethod<[], ({
  event_ids: string[];
  status: { Active: null } | { Revoked: null };
  created_at: bigint;
  grantee: Principal;
  grantor: Principal;
  expires_at: bigint;
  grant_id: bigint;
})[]>;
  get_kind5_grants_by_grantor: ActorMethod<[], ({
  event_ids: string[];
  status: { Active: null } | { Revoked: null };
  created_at: bigint;
  grantee: Principal;
  grantor: Principal;
  expires_at: bigint;
  grant_id: bigint;
})[]>;
  get_sign_event_by_id: ActorMethod<[string], CandidOpt<SignEvent>>;
  get_user_latest_sign_event_id: ActorMethod<[Principal], string>;
  grant_kind5_access: ActorMethod<[{
  event_ids: string[];
  grantee: Principal;
  duration_ns: CandidOpt<bigint>;
}], GrantKind5AccessResult>;
  greet: ActorMethod<[string], string>;
  mcp_sign: ActorMethod<[Principal, SignParm], SignEvent>;
  revoke_kind5_access: ActorMethod<[bigint], RevokeKind5AccessResult>;
  sign: ActorMethod<[SignParm], SignEvent>;
  verify_file_hash: ActorMethod<[string], SignEvent[]>;
  verify_message: ActorMethod<[string], SignEvent[]>;
  verify_msg_hash: ActorMethod<[string], SignEvent[]>;
}
