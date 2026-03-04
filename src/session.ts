/**
 * Session — Single CLI Invocation Context
 *
 * Replaces global mutable state (process.argv rewriting, module-level caches)
 * with an explicit, per-invocation context object. All sub-scripts receive a
 * Session instance instead of reading process.argv or relying on module singletons.
 *
 * Lifecycle:
 *   1. cli.ts (or standalone script) creates a Session from argv
 *   2. Session is passed to the sub-script's run() function
 *   3. Sub-script uses session.getSignActor(), session.autoPoW(), etc.
 *   4. Session is garbage-collected when the process exits
 *
 * Lazy initialization:
 *   Identity, HttpAgent, and Actor instances are created on first use and cached
 *   within the Session. This avoids unnecessary PEM reads or HTTP connections
 *   for commands that don't need them (e.g. `doc hash`).
 */

import { HttpAgent, Actor, type ActorSubclass } from '@dfinity/agent';
import type { Secp256k1KeyIdentity } from '@dfinity/identity-secp256k1';
import type { Principal } from '@dfinity/principal';
import { signIdlFactory, registryIdlFactory } from './idl.js';
import { getPemPath, loadIdentityFromPath } from './identity.js';
import { getCanisterIds } from './config.js';
import { parseArgs, computePow } from './utils.js';
import config from './config.js';
import type { SignService } from './types/sign-event.js';
import type { RegistryService } from './types/registry.js';
import type { ParsedArgs, AutoPowResult } from './types/common.js';
import type { CanisterIds } from './types/config.js';

/** IC mainnet host address */
const IC_HOST = 'https://ic0.app';

/**
 * Session encapsulates all state for a single CLI command invocation.
 *
 * It holds:
 * - Parsed arguments and configuration (immutable after construction)
 * - Lazy-loaded identity, HTTP agents, and canister actors (cached per session)
 *
 * This design eliminates:
 * - process.argv rewriting in cli.ts
 * - Module-level singleton caches (_identity, _authenticatedAgent, _anonymousAgent)
 * - Implicit global state reads in domain functions
 */
export class Session {
  /** Raw argv array (preserved for functions that need it, like getPemPath) */
  private readonly _argv: string[];

  /** Parsed command-line arguments */
  readonly args: ParsedArgs;

  /** Canister IDs */
  readonly canisterIds: CanisterIds;

  // --- Lazy-initialized stateful resources (per-session cache) ---
  private _identity: Secp256k1KeyIdentity | null = null;
  private _authenticatedAgent: HttpAgent | null = null;
  private _anonymousAgent: HttpAgent | null = null;

  /**
   * Create a new Session from a raw argv array.
   *
   * @param argv - Full argument array (same format as process.argv).
   *               The first two elements (node binary, script path) are skipped
   *               by parseArgs. Global options (--identity) are extracted
   *               by getPemPath.
   */
  constructor(argv: string[]) {
    this._argv = argv;
    this.args = parseArgs(argv);
    this.canisterIds = getCanisterIds();
  }

  // ========== Identity ==========

  /**
   * Get the resolved PEM file path for this session.
   * Uses the same resolution priority as getIdentity():
   *   --identity=<path> > ZCLOAK_IDENTITY env > dfx default location
   */
  getPemPath(): string {
    return getPemPath(this._argv);
  }

  /**
   * Get the ECDSA secp256k1 identity for this session.
   * Loaded from PEM file on first call, then cached.
   *
   * PEM path resolution: --identity=<path> > ZCLOAK_IDENTITY env > dfx default location
   */
  getIdentity(): Secp256k1KeyIdentity {
    if (!this._identity) {
      const pemPath = getPemPath(this._argv);
      this._identity = loadIdentityFromPath(pemPath);
    }
    return this._identity;
  }

  /** Get the current identity's Principal ID as text */
  getPrincipal(): string {
    return this.getIdentity().getPrincipal().toText();
  }

  /** Get the current identity's Principal object */
  getPrincipalObj(): Principal {
    return this.getIdentity().getPrincipal();
  }

  // ========== HTTP Agents ==========

  /**
   * Get an authenticated HttpAgent (with identity, for update calls).
   * Created on first call, then cached for the session duration.
   */
  async getAuthenticatedAgent(): Promise<HttpAgent> {
    if (!this._authenticatedAgent) {
      const identity = this.getIdentity();
      this._authenticatedAgent = await HttpAgent.create({
        host: IC_HOST,
        identity,
      });
    }
    return this._authenticatedAgent;
  }

  /**
   * Get an anonymous HttpAgent (no identity, for query calls).
   * Created on first call, then cached for the session duration.
   */
  async getAnonymousAgent(): Promise<HttpAgent> {
    if (!this._anonymousAgent) {
      this._anonymousAgent = await HttpAgent.create({
        host: IC_HOST,
      });
    }
    return this._anonymousAgent;
  }

  // ========== Actor Factories ==========

  /** Get authenticated signatures canister Actor (supports update calls) */
  async getSignActor(): Promise<ActorSubclass<SignService>> {
    const agent = await this.getAuthenticatedAgent();
    return Actor.createActor<SignService>(signIdlFactory, {
      agent,
      canisterId: this.canisterIds.signatures,
    });
  }

  /** Get authenticated registry canister Actor (supports update calls) */
  async getRegistryActor(): Promise<ActorSubclass<RegistryService>> {
    const agent = await this.getAuthenticatedAgent();
    return Actor.createActor<RegistryService>(registryIdlFactory, {
      agent,
      canisterId: this.canisterIds.registry,
    });
  }

  /** Get anonymous signatures canister Actor (query only) */
  async getAnonymousSignActor(): Promise<ActorSubclass<SignService>> {
    const agent = await this.getAnonymousAgent();
    return Actor.createActor<SignService>(signIdlFactory, {
      agent,
      canisterId: this.canisterIds.signatures,
    });
  }

  /** Get anonymous registry canister Actor (query only) */
  async getAnonymousRegistryActor(): Promise<ActorSubclass<RegistryService>> {
    const agent = await this.getAnonymousAgent();
    return Actor.createActor<RegistryService>(registryIdlFactory, {
      agent,
      canisterId: this.canisterIds.registry,
    });
  }

  // ========== PoW ==========

  /**
   * Automatically fetch PoW base and compute nonce.
   * Complete PoW flow: get latest sign event ID → compute nonce.
   */
  async autoPoW(): Promise<AutoPowResult> {
    const principal = this.getPrincipalObj();
    const actor = await this.getSignActor();

    // Fetch PoW base (user's latest sign event ID)
    console.error('Fetching PoW base...');
    const base = await actor.get_user_latest_sign_event_id(principal);

    // The canister always returns a string. Empty string "" is valid (first-time user).
    if (typeof base !== 'string') {
      throw new Error(`Failed to fetch PoW base: unexpected value ${JSON.stringify(base)}`);
    }

    // Compute PoW nonce
    console.error(`Computing PoW (zeros=${config.pow_zeros})...`);
    const result = computePow(base, config.pow_zeros);
    console.error(`PoW completed: nonce=${result.nonce}, took ${result.timeMs}ms`);

    return { nonce: result.nonce, hash: result.hash, base };
  }

  // ========== URL Helpers ==========

  /** Get the bind URL */
  getBindUrl(): string {
    return config.bind_url;
  }

  /** Get the profile URL prefix */
  getProfileUrl(): string {
    return config.profile_url;
  }

  /** Get the 2FA verification URL */
  getTwoFAUrl(): string {
    return config.twofa_url;
  }
}
