/**
 * zCloak.ai IC Agent Factory Module
 *
 * Creates and manages connections to ICP canisters.
 * Designed with reference to src/lib/canister/agent.ts, adapted for standalone script environment.
 *
 * Functions:
 *   getSignActor()     → Signatures canister Actor (with identity, supports update calls)
 *   getRegistryActor() → Registry canister Actor (with identity, supports update calls)
 *   getAnonymousSignActor()     → Anonymous signatures canister Actor (query only)
 *   getAnonymousRegistryActor() → Anonymous registry canister Actor (query only)
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
 */
export function resetAgents(): void {
  _authenticatedAgent = null;
  _anonymousAgent = null;
}
