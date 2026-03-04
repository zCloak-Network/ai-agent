/**
 * zCloak.ai Candid IDL Definitions — Single Source of Truth
 *
 * Contains complete interface definitions for the signatures canister and registry canister.
 * TypeScript type interfaces in types/sign-event.ts and types/registry.ts are
 * AUTO-GENERATED from these IDL definitions via `npm run generate-types`.
 *
 * When the canister API changes:
 *   1. Update the IDL definitions in this file
 *   2. Run `npm run generate-types` to regenerate TS types
 *   3. Run `npm run build` to verify compilation
 *
 * Architecture:
 *   - buildSignTypes() / buildRegistryTypes()       — named IDL type constructors (used by codegen)
 *   - buildSignService() / buildRegistryService()   — service constructors (used by codegen for shared instances)
 *   - signIdlFactory / registryIdlFactory           — IDL.InterfaceFactory (used by @dfinity/agent Actor)
 *
 * The canister's actual Candid .did schema is the upstream source; this file is derived from
 * skill.md documentation and verified against actual canister responses.
 */

import { IDL } from '@dfinity/candid';

// ========== Signatures Canister ==========

/**
 * Build named IDL types for the signatures canister.
 * Exported so that the codegen script can discover type names and their structures.
 *
 * @param I - The IDL module (passed through to allow use in both factory and codegen contexts)
 */
export function buildSignTypes(I: typeof IDL) {
  /** SignEvent record — sign event returned by canister */
  const SignEvent = I.Record({
    counter: I.Opt(I.Nat32),          // Global auto-increment counter
    id: I.Text,                        // Event unique ID (sha256 hash)
    kind: I.Nat32,                     // Event type (1-15)
    ai_id: I.Text,                     // Signer principal ID
    created_at: I.Nat64,               // Creation timestamp (nanoseconds)
    tags: I.Opt(I.Vec(I.Vec(I.Text))), // Tags array
    content: I.Opt(I.Text),            // Content (optional)
    content_hash: I.Text,              // Content SHA256 hash
  });

  /** SignParm variant — 15 signing parameter types */
  const SignParm = I.Variant({
    Kind1IdentityProfile: I.Record({ content: I.Text }),
    Kind2IdentityVerification: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind3SimpleAgreement: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind4PublicPost: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind5PrivatePost: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind6Interaction: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind7ContactList: I.Record({ tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind8MediaAsset: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind9ServiceListing: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind10JobRequest: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind11DocumentSignature: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind12PublicContract: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind13PrivateContract: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind14Review: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
    Kind15GeneralAttestation: I.Record({ content: I.Text, tags: I.Opt(I.Vec(I.Vec(I.Text))) }),
  });

  return { SignEvent, SignParm };
}

/**
 * Build the signatures canister service, reusing pre-built named types.
 * Exported for codegen to share type instances with the name registry.
 *
 * @param I     - The IDL module
 * @param types - Named types from buildSignTypes() (same instances used in the registry)
 */
export function buildSignService(
  I: typeof IDL,
  types: ReturnType<typeof buildSignTypes>,
) {
  const { SignEvent, SignParm } = types;

  return I.Service({
    // ===== Signing operations (update call, requires identity) =====

    // agent_sign: Signing with PoW (2 params: SignParm + nonce text)
    agent_sign: I.Func(
      [SignParm, I.Text],
      [I.Variant({ Ok: SignEvent, Err: I.Text })],
      []
    ),

    // sign: Direct signing (no PoW, requires canister permission)
    sign: I.Func([SignParm], [SignEvent], []),

    // mcp_sign: MCP proxy signing
    mcp_sign: I.Func([I.Principal, SignParm], [SignEvent], []),

    // ===== Query operations (query, can be anonymous) =====

    // Get global counter
    get_counter: I.Func([], [I.Nat32], ['query']),

    // Fetch events by counter range
    fetch_events_by_counter: I.Func(
      [I.Nat32, I.Nat32],
      [I.Vec(SignEvent)],
      ['query']
    ),

    // Get all sign events
    get_all_sign_events: I.Func([], [I.Vec(SignEvent)], ['query']),

    // Get user sign history (paginated)
    fetch_user_sign: I.Func(
      [I.Principal, I.Nat32, I.Nat32],
      [I.Nat32, I.Vec(SignEvent)],
      ['query']
    ),

    // Get user's latest sign event ID (PoW base)
    get_user_latest_sign_event_id: I.Func(
      [I.Principal],
      [I.Text],
      ['query']
    ),

    // Verify signature by message content
    verify_message: I.Func([I.Text], [I.Vec(SignEvent)], ['query']),

    // Verify signature by message hash
    verify_msg_hash: I.Func([I.Text], [I.Vec(SignEvent)], ['query']),

    // Verify signature by file hash
    verify_file_hash: I.Func([I.Text], [I.Vec(SignEvent)], ['query']),

    // Get sign event by ID
    get_sign_event_by_id: I.Func(
      [I.Text],
      [I.Opt(SignEvent)],
      ['query']
    ),

    // Get Kind 1 identity profile
    get_kind1_event_by_principal: I.Func(
      [I.Text],
      [I.Opt(SignEvent)],
      ['query']
    ),

    // Connection test
    greet: I.Func([I.Text], [I.Text], ['query']),
  });
}

/**
 * Signatures canister IDL factory (standard @dfinity/agent interface)
 * Canister ID:
 *   prod: jayj5-xyaaa-aaaam-qfinq-cai
 *   dev:  zpbbm-piaaa-aaaaj-a3dsq-cai
 */
export const signIdlFactory: IDL.InterfaceFactory = () => {
  return buildSignService(IDL, buildSignTypes(IDL));
};

// ========== Registry Canister ==========

/**
 * Build named IDL types for the registry canister.
 * Exported so that the codegen script can discover type names and their structures.
 *
 * @param I - The IDL module
 */
export function buildRegistryTypes(I: typeof IDL) {
  /** Position record — position information in the registry */
  const Position = I.Record({
    is_human: I.Bool,
    connection_list: I.Vec(I.Principal),
  });

  /** AI profile record */
  const AiProfile = I.Record({
    position: I.Opt(Position),
  });

  /** User profile record */
  const UserProfile = I.Record({
    username: I.Text,
    ai_profile: I.Opt(AiProfile),
    principal_id: I.Opt(I.Text),
  });

  /** Registration success result record */
  const RegisterResult = I.Record({
    username: I.Text,
  });

  return { Position, AiProfile, UserProfile, RegisterResult };
}

/**
 * Build the registry canister service, reusing pre-built named types.
 * Exported for codegen to share type instances with the name registry.
 *
 * @param I     - The IDL module
 * @param types - Named types from buildRegistryTypes() (same instances used in the registry)
 */
export function buildRegistryService(
  I: typeof IDL,
  types: ReturnType<typeof buildRegistryTypes>,
) {
  const { UserProfile, RegisterResult } = types;

  return I.Service({
    // ===== Query operations (query) =====

    // Get username by principal
    get_username_by_principal: I.Func(
      [I.Text],
      [I.Opt(I.Text)],
      ['query']
    ),

    // Get principal by username
    get_user_principal: I.Func(
      [I.Text],
      [I.Opt(I.Principal)],
      ['query']
    ),

    // Get UserProfile by username (available in dev environment)
    user_profile_get: I.Func(
      [I.Text],
      [I.Opt(UserProfile)],
      ['query']
    ),

    // Get UserProfile by principal
    user_profile_get_by_principal: I.Func(
      [I.Text],
      [I.Opt(UserProfile)],
      ['query']
    ),

    // ===== Update operations (update call, requires identity) =====

    // Register new agent name
    register_agent: I.Func(
      [I.Text],
      [I.Variant({ Ok: RegisterResult, Err: I.Text })],
      []
    ),

    // Prepare agent-owner binding (WebAuthn challenge)
    agent_prepare_bond: I.Func(
      [I.Text],
      [I.Variant({ Ok: I.Text, Err: I.Text })],
      []
    ),
  });
}

/**
 * Registry canister IDL factory (standard @dfinity/agent interface)
 * Canister ID:
 *   prod: ytmuz-nyaaa-aaaah-qqoja-cai
 *   dev:  3spie-caaaa-aaaam-ae3sa-cai
 */
export const registryIdlFactory: IDL.InterfaceFactory = () => {
  return buildRegistryService(IDL, buildRegistryTypes(IDL));
};
