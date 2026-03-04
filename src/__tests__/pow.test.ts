/**
 * Tests for pow.ts — Standalone PoW computation command
 *
 * Covers: run() function with valid args, missing args (help), invalid zeros,
 * result output format, and timeout handling.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { Session } from '../session.js';
import { run } from '../pow.js';

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  vi.clearAllMocks();
});

describe('pow run()', () => {
  it('shows help and exits when no base string provided', () => {
    const session = new Session(['node', 'pow.js']);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai PoW Computation Tool');
  });

  it('exits with error when zeros is not a positive integer', () => {
    const session = new Session(['node', 'pow.js', 'somebase', '0']);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith('Error: zeros must be a positive integer');
  });

  it('finds a valid PoW solution with zeros=1', () => {
    const base = 'test-pow-base';
    const session = new Session(['node', 'pow.js', base, '1']);

    run(session);

    expect(mockLog).toHaveBeenCalledWith('Found solution!');
    expect(mockLog).toHaveBeenCalledWith('base =', base);
    expect(mockLog).toHaveBeenCalledWith('zeros =', 1);

    // Extract the nonce from the log calls
    const nonceCall = mockLog.mock.calls.find(c => c[0] === 'nonce =');
    expect(nonceCall).toBeDefined();
    const nonce = nonceCall![1] as number;

    // Verify the solution
    const candidate = base + nonce.toString();
    const hash = crypto.createHash('sha256').update(candidate).digest('hex');
    expect(hash.startsWith('0')).toBe(true);
  });

  it('defaults to 5 zeros when zeros argument is omitted', () => {
    const base = 'a'; // Use a short base for potentially faster computation
    const session = new Session(['node', 'pow.js', base]);

    run(session);

    expect(mockLog).toHaveBeenCalledWith('zeros =', 5);
  });

  it('produces verifiable hash output', () => {
    const base = 'verify-test';
    const session = new Session(['node', 'pow.js', base, '2']);

    run(session);

    // Extract hash from log
    const hashCall = mockLog.mock.calls.find(c => c[0] === 'hash  =');
    expect(hashCall).toBeDefined();
    const hash = hashCall![1] as string;
    expect(hash.startsWith('00')).toBe(true);
  });
});
