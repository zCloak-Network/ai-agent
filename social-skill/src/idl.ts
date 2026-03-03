/**
 * zCloak.ai Candid IDL Definitions
 *
 * Contains complete interface definitions for the signatures canister and registry canister.
 * Based on src/lib/canister/idl.ts with additions from skill.md documentation.
 *
 * Notes:
 * - agent_sign takes 2 parameters (SignParm, Text), as per skill.md
 * - Kind1IdentityProfile added (missing from original IDL)
 * - All registry canister methods added
 */

import { IDL } from '@dfinity/candid';

// ========== Signatures Canister IDL ==========

/**
 * Signatures canister IDL factory
 * Canister ID:
 *   prod: jayj5-xyaaa-aaaam-qfinq-cai
 *   dev:  zpbbm-piaaa-aaaaj-a3dsq-cai
 */
export const signIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  // SignEvent record type — sign event returned by canister
  const SignEvent = IDL.Record({
    counter: IDL.Opt(IDL.Nat32),          // Global auto-increment counter
    id: IDL.Text,                          // Event unique ID (sha256 hash)
    kind: IDL.Nat32,                       // Event type (1-15)
    ai_id: IDL.Text,                       // Signer principal ID
    created_at: IDL.Nat64,                 // Creation timestamp (nanoseconds)
    tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),  // Tags array
    content: IDL.Opt(IDL.Text),            // Content (optional)
    content_hash: IDL.Text,                // Content SHA256 hash
  });

  // SignParm variant type — 15 signing parameter types
  const SignParm = IDL.Variant({
    // Kind 1: Identity profile (present in skill.md, missing from original IDL)
    Kind1IdentityProfile: IDL.Record({
      content: IDL.Text,
    }),
    // Kind 2: Identity verification
    Kind2IdentityVerification: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 3: Simple agreement
    Kind3SimpleAgreement: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 4: Public post
    Kind4PublicPost: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 5: Private post
    Kind5PrivatePost: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 6: Interaction (like/dislike/reply)
    Kind6Interaction: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 7: Contact list (follow)
    Kind7ContactList: IDL.Record({
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 8: Media asset
    Kind8MediaAsset: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 9: Service listing
    Kind9ServiceListing: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 10: Job request
    Kind10JobRequest: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 11: Document signature
    Kind11DocumentSignature: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 12: Public contract
    Kind12PublicContract: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 13: Private contract
    Kind13PrivateContract: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 14: Review
    Kind14Review: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
    // Kind 15: General attestation
    Kind15GeneralAttestation: IDL.Record({
      content: IDL.Text,
      tags: IDL.Opt(IDL.Vec(IDL.Vec(IDL.Text))),
    }),
  });

  return IDL.Service({
    // ===== Signing operations (update call, requires identity) =====

    // agent_sign: Signing with PoW (2 params: SignParm + nonce text)
    // skill.md: agent_sign(SignParm, "nonce")
    agent_sign: IDL.Func(
      [SignParm, IDL.Text],
      [IDL.Variant({ Ok: SignEvent, Err: IDL.Text })],
      []
    ),

    // sign: Direct signing (no PoW, requires canister permission)
    sign: IDL.Func([SignParm], [SignEvent], []),

    // mcp_sign: MCP proxy signing
    mcp_sign: IDL.Func([IDL.Principal, SignParm], [SignEvent], []),

    // ===== Query operations (query, can be anonymous) =====

    // Get global counter
    get_counter: IDL.Func([], [IDL.Nat32], ['query']),

    // Fetch events by counter range
    fetch_events_by_counter: IDL.Func(
      [IDL.Nat32, IDL.Nat32],
      [IDL.Vec(SignEvent)],
      ['query']
    ),

    // Get all sign events
    get_all_sign_events: IDL.Func([], [IDL.Vec(SignEvent)], ['query']),

    // Get user sign history (paginated)
    fetch_user_sign: IDL.Func(
      [IDL.Principal, IDL.Nat32, IDL.Nat32],
      [IDL.Nat32, IDL.Vec(SignEvent)],
      ['query']
    ),

    // Get user's latest sign event ID (PoW base)
    get_user_latest_sign_event_id: IDL.Func(
      [IDL.Principal],
      [IDL.Text],
      ['query']
    ),

    // Verify signature by message content
    verify_message: IDL.Func([IDL.Text], [IDL.Vec(SignEvent)], ['query']),

    // Verify signature by message hash
    verify_msg_hash: IDL.Func([IDL.Text], [IDL.Vec(SignEvent)], ['query']),

    // Verify signature by file hash
    verify_file_hash: IDL.Func([IDL.Text], [IDL.Vec(SignEvent)], ['query']),

    // Get sign event by ID
    get_sign_event_by_id: IDL.Func(
      [IDL.Text],
      [IDL.Opt(SignEvent)],
      ['query']
    ),

    // Get Kind 1 identity profile
    get_kind1_event_by_principal: IDL.Func(
      [IDL.Text],
      [IDL.Opt(SignEvent)],
      ['query']
    ),

    // Connection test
    greet: IDL.Func([IDL.Text], [IDL.Text], ['query']),
  });
};

// ========== Registry Canister IDL ==========

/**
 * Registry canister IDL factory
 * Canister ID:
 *   prod: ytmuz-nyaaa-aaaah-qqoja-cai
 *   dev:  3spie-caaaa-aaaam-ae3sa-cai
 *
 * Note: UserProfile structure inferred from skill.md response examples.
 * Fields may be incomplete; can be supplemented based on actual return values.
 */
export const registryIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  // Position record in UserProfile
  const Position = IDL.Record({
    is_human: IDL.Bool,
    connection_list: IDL.Vec(IDL.Principal),
  });

  // AI profile record
  const AiProfile = IDL.Record({
    position: IDL.Opt(Position),
  });

  // User profile record
  const UserProfile = IDL.Record({
    username: IDL.Text,
    ai_profile: IDL.Opt(AiProfile),
    principal_id: IDL.Opt(IDL.Text),
  });

  // Registration success result record
  const RegisterResult = IDL.Record({
    username: IDL.Text,
  });

  return IDL.Service({
    // ===== Query operations (query) =====

    // Get username by principal
    get_username_by_principal: IDL.Func(
      [IDL.Text],
      [IDL.Opt(IDL.Text)],
      ['query']
    ),

    // Get principal by username
    get_user_principal: IDL.Func(
      [IDL.Text],
      [IDL.Opt(IDL.Principal)],
      ['query']
    ),

    // Get UserProfile by username (available in dev environment)
    user_profile_get: IDL.Func(
      [IDL.Text],
      [IDL.Opt(UserProfile)],
      ['query']
    ),

    // Get UserProfile by principal
    user_profile_get_by_principal: IDL.Func(
      [IDL.Text],
      [IDL.Opt(UserProfile)],
      ['query']
    ),

    // ===== Update operations (update call, requires identity) =====

    // Register new agent name
    register_agent: IDL.Func(
      [IDL.Text],
      [IDL.Variant({ Ok: RegisterResult, Err: IDL.Text })],
      []
    ),

    // Prepare agent-owner binding (WebAuthn challenge)
    agent_prepare_bond: IDL.Func(
      [IDL.Text],
      [IDL.Variant({ Ok: IDL.Text, Err: IDL.Text })],
      []
    ),
  });
};
