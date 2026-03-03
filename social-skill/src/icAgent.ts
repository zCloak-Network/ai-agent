/**
 * zCloak.ai IC Agent Factory Module
 *
 * @deprecated This module uses module-level singleton caches (global mutable state).
 * For new code, use the Session class from './session' instead, which provides
 * per-invocation caching and eliminates implicit global state dependencies.
 *
 * This module is retained for backward compatibility with external consumers.
 * Internal sub-scripts have been migrated to Session.
 *
 * Migration guide:
 *   Before:  import { getSignActor } from './icAgent';
 *            const actor = await getSignActor();
 *   After:   const session = new Session(process.argv);
 *            const actor = await session.getSignActor();
 */

import { HttpAgent, Actor, type ActorSubclass } from '@dfinity/agent';
import { signIdlFactory, registryIdlFactory } from './idl';
import { loadIdentity } from './identity';
import { getCanisterIds } from './config';
import type { SignService } from './types/sign-event';
import type { RegistryService } from './types/registry';

/** IC mainnet address */
export const IC_HOST = 'https://ic0.app';

// ========== Agent Cache ==========

/** Authenticated Agent (for update calls) */
let _authenticatedAgent: HttpAgent | null = null;

/** Anonymous Agent (for queries) */
let _anonymousAgent: HttpAgent | null = null;

// ========== Agent Creation ==========

/**
 * Get authenticated HttpAgent (for signing/write operations)
 */
async function getAuthenticatedAgent(): Promise<HttpAgent> {
  if (!_authenticatedAgent) {
    const identity = loadIdentity();
    _authenticatedAgent = await HttpAgent.create({
      host: IC_HOST,
      identity,
    });
  }
  return _authenticatedAgent;
}

/**
 * Get anonymous HttpAgent (for read-only query operations)
 */
async function getAnonymousAgent(): Promise<HttpAgent> {
  if (!_anonymousAgent) {
    _anonymousAgent = await HttpAgent.create({
      host: IC_HOST,
    });
  }
  return _anonymousAgent;
}

// ========== Actor Factory ==========

/**
 * Get signatures canister Actor (with identity, supports update calls)
 * @deprecated Use Session.getSignActor() instead for per-invocation state management.
 */
export async function getSignActor(): Promise<ActorSubclass<SignService>> {
  const agent = await getAuthenticatedAgent();
  const canisters = getCanisterIds();
  return Actor.createActor<SignService>(signIdlFactory, {
    agent,
    canisterId: canisters.signatures,
  });
}

/**
 * Get registry canister Actor (with identity, supports update calls)
 * @deprecated Use Session.getRegistryActor() instead for per-invocation state management.
 */
export async function getRegistryActor(): Promise<ActorSubclass<RegistryService>> {
  const agent = await getAuthenticatedAgent();
  const canisters = getCanisterIds();
  return Actor.createActor<RegistryService>(registryIdlFactory, {
    agent,
    canisterId: canisters.registry,
  });
}

/**
 * Get anonymous signatures canister Actor (query only, no identity needed)
 * @deprecated Use Session.getAnonymousSignActor() instead for per-invocation state management.
 */
export async function getAnonymousSignActor(): Promise<ActorSubclass<SignService>> {
  const agent = await getAnonymousAgent();
  const canisters = getCanisterIds();
  return Actor.createActor<SignService>(signIdlFactory, {
    agent,
    canisterId: canisters.signatures,
  });
}

/**
 * Get anonymous registry canister Actor (query only, no identity needed)
 * @deprecated Use Session.getAnonymousRegistryActor() instead for per-invocation state management.
 */
export async function getAnonymousRegistryActor(): Promise<ActorSubclass<RegistryService>> {
  const agent = await getAnonymousAgent();
  const canisters = getCanisterIds();
  return Actor.createActor<RegistryService>(registryIdlFactory, {
    agent,
    canisterId: canisters.registry,
  });
}

/**
 * Reset all Agent and Actor caches (for error recovery)
 * @deprecated Session instances are garbage-collected naturally. This function
 * only affects the legacy module-level caches.
 */
export function resetAgents(): void {
  _authenticatedAgent = null;
  _anonymousAgent = null;
}
