/**
 * Tests for idl.ts — IDL type builders and factory functions
 */

import { describe, it, expect } from 'vitest';
import { IDL } from '@dfinity/candid';
import {
  buildSignTypes,
  buildRegistryTypes,
  buildSignService,
  buildRegistryService,
  signIdlFactory,
  registryIdlFactory,
} from '../idl';

// ========== buildSignTypes ==========

describe('buildSignTypes', () => {
  it('returns SignEvent and SignParm types', () => {
    const types = buildSignTypes(IDL);
    expect(types.SignEvent).toBeDefined();
    expect(types.SignParm).toBeDefined();
  });

  it('SignEvent is an IDL Record type', () => {
    const types = buildSignTypes(IDL);
    // IDL types have an accept method (Visitor pattern)
    expect(typeof types.SignEvent.accept).toBe('function');
  });

  it('SignParm is an IDL Variant type', () => {
    const types = buildSignTypes(IDL);
    expect(typeof types.SignParm.accept).toBe('function');
  });
});

// ========== buildRegistryTypes ==========

describe('buildRegistryTypes', () => {
  it('returns all expected types', () => {
    const types = buildRegistryTypes(IDL);
    expect(types.Position).toBeDefined();
    expect(types.AiProfile).toBeDefined();
    expect(types.UserProfile).toBeDefined();
    expect(types.RegisterResult).toBeDefined();
  });
});

// ========== buildSignService ==========

describe('buildSignService', () => {
  it('returns an IDL Service with expected methods', () => {
    const types = buildSignTypes(IDL);
    const service = buildSignService(IDL, types);

    // Service should be an IDL type
    expect(typeof service.accept).toBe('function');

    // Verify it contains key method names via _fields (Array<[name, type]>)
    const fields = (service as unknown as { _fields: Array<[string, unknown]> })._fields;
    expect(fields).toBeDefined();
    const methodNames = fields.map(([name]: [string, unknown]) => name);
    expect(methodNames).toContain('agent_sign');
    expect(methodNames).toContain('get_counter');
    expect(methodNames).toContain('verify_message');
    expect(methodNames).toContain('greet');
  });
});

// ========== buildRegistryService ==========

describe('buildRegistryService', () => {
  it('returns an IDL Service with expected methods', () => {
    const types = buildRegistryTypes(IDL);
    const service = buildRegistryService(IDL, types);

    const fields = (service as unknown as { _fields: Array<[string, unknown]> })._fields;
    expect(fields).toBeDefined();
    const methodNames = fields.map(([name]: [string, unknown]) => name);
    expect(methodNames).toContain('register_agent');
    expect(methodNames).toContain('get_username_by_principal');
    expect(methodNames).toContain('user_profile_get');
  });
});

// ========== IDL Factories ==========

describe('signIdlFactory', () => {
  it('is callable and returns a service', () => {
    const service = signIdlFactory();
    expect(service).toBeDefined();
    expect(typeof service.accept).toBe('function');
  });
});

describe('registryIdlFactory', () => {
  it('is callable and returns a service', () => {
    const service = registryIdlFactory();
    expect(service).toBeDefined();
    expect(typeof service.accept).toBe('function');
  });
});
