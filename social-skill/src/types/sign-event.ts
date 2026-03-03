/**
 * Signatures canister type definitions
 *
 * Corresponds to SignEvent, SignParm, and other types in the Candid IDL.
 * Candid opt T is represented as [] | [T] in JS SDK.
 */

import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';

/** Candid opt type representation in JS: [] means null, [T] means has value */
export type CandidOpt<T> = [] | [T];

/** SignEvent — sign event record returned by canister */
export interface SignEvent {
  /** Global auto-increment counter (opt nat32) */
  counter: CandidOpt<number>;
  /** Event unique ID (sha256 hash) */
  id: string;
  /** Event type (1-15) */
  kind: number;
  /** Signer principal ID */
  ai_id: string;
  /** Creation timestamp (nanoseconds, nat64 → bigint) */
  created_at: bigint;
  /** Tags array (opt vec vec text) */
  tags: CandidOpt<string[][]>;
  /** Content (optional) */
  content: CandidOpt<string>;
  /** Content SHA256 hash */
  content_hash: string;
}

/**
 * SignParm variant type — corresponds to Candid Variant
 * Represented as an object with a single key in JS SDK
 */
export type SignParm =
  | { Kind1IdentityProfile: { content: string } }
  | { Kind2IdentityVerification: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind3SimpleAgreement: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind4PublicPost: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind5PrivatePost: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind6Interaction: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind7ContactList: { tags: CandidOpt<string[][]> } }
  | { Kind8MediaAsset: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind9ServiceListing: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind10JobRequest: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind11DocumentSignature: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind12PublicContract: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind13PrivateContract: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind14Review: { content: string; tags: CandidOpt<string[][]> } }
  | { Kind15GeneralAttestation: { content: string; tags: CandidOpt<string[][]> } };

/** agent_sign return value — Candid Variant { Ok: SignEvent } | { Err: Text } */
export type SignResult = { Ok: SignEvent } | { Err: string };

/** Sign canister service interface, defines all callable canister methods */
export interface SignService {
  /** Signing with PoW (2 params: SignParm + nonce text) */
  agent_sign: ActorMethod<[SignParm, string], SignResult>;
  /** Direct signing (no PoW, requires canister permission) */
  sign: ActorMethod<[SignParm], SignEvent>;
  /** MCP proxy signing */
  mcp_sign: ActorMethod<[Principal, SignParm], SignEvent>;
  /** Get global counter */
  get_counter: ActorMethod<[], number>;
  /** Fetch events by counter range */
  fetch_events_by_counter: ActorMethod<[number, number], SignEvent[]>;
  /** Get all sign events */
  get_all_sign_events: ActorMethod<[], SignEvent[]>;
  /** Get user sign history (paginated) */
  fetch_user_sign: ActorMethod<[Principal, number, number], [number, SignEvent[]]>;
  /** Get user's latest sign event ID (PoW base) */
  get_user_latest_sign_event_id: ActorMethod<[Principal], string>;
  /** Verify signature by message content */
  verify_message: ActorMethod<[string], SignEvent[]>;
  /** Verify signature by message hash */
  verify_msg_hash: ActorMethod<[string], SignEvent[]>;
  /** Verify signature by file hash */
  verify_file_hash: ActorMethod<[string], SignEvent[]>;
  /** Get sign event by ID */
  get_sign_event_by_id: ActorMethod<[string], CandidOpt<SignEvent>>;
  /** Get Kind 1 identity profile */
  get_kind1_event_by_principal: ActorMethod<[string], CandidOpt<SignEvent>>;
  /** Connection test */
  greet: ActorMethod<[string], string>;
}
