/**
 * Tests for serve.ts — JSON-RPC daemon via Unix Domain Socket
 *
 * These tests verify:
 * 1. UDS daemon startup and shutdown
 * 2. Encrypt/decrypt inline data via UDS connection
 * 3. Encrypt/decrypt file data via UDS connection
 * 4. Status query
 * 5. Unknown method handling
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createConnection } from 'net';
import { createInterface } from 'readline';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import { KeyStore } from '../key-store.js';
import { runDaemonUds } from '../serve.js';
import { socketPath, pidPath } from '../daemon.js';

// ============================================================================
// Helpers
// ============================================================================

/** Send a JSON-RPC request to a Unix socket and return the response */
function sendRpc(sockPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(sockPath);
    let done = false;

    conn.on('connect', () => {
      conn.write(JSON.stringify(request) + '\n');
    });

    const rl = createInterface({ input: conn });

    rl.on('line', (line: string) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`Invalid JSON: ${line}`));
        }
        conn.end();
      }
    });

    conn.on('error', (err) => {
      if (!done) { done = true; clearTimeout(timer); reject(err); }
    });

    const timer = setTimeout(() => {
      if (!done) { done = true; conn.destroy(); reject(new Error('Timeout')); }
    }, 5000);
  });
}

/** Wait for a socket to become connectable */
function waitForSocket(sockPath: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const conn = createConnection(sockPath);
      conn.on('connect', () => { conn.end(); resolve(); });
      conn.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Socket not ready'));
        } else {
          setTimeout(tryConnect, 50);
        }
      });
    };
    tryConnect();
  });
}

/** Force cleanup a daemon's socket and PID files */
function forceCleanupDaemon(derivationId: string): void {
  const sock = socketPath(derivationId);
  const pid = pidPath(derivationId);
  for (const f of [sock, pid]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}

// ============================================================================
// UDS Daemon Tests
// ============================================================================

describe('UDS Daemon', () => {
  // Track all daemons started in tests for reliable cleanup
  const startedDaemons: Array<{
    derivationId: string;
    keyStore: KeyStore;
    daemonPromise: Promise<void>;
  }> = [];

  afterEach(async () => {
    // Force shutdown any daemons still running after test completes
    for (const daemon of startedDaemons) {
      const sock = socketPath(daemon.derivationId);

      // Try graceful shutdown first
      if (existsSync(sock)) {
        try {
          await sendRpc(sock, { id: 999, method: 'shutdown' });
          // Give daemon a moment to finish
          await Promise.race([
            daemon.daemonPromise,
            new Promise(r => setTimeout(r, 2000)),
          ]);
        } catch {
          // Graceful shutdown failed — force cleanup files
        }
      }

      // Ensure key is destroyed
      try { daemon.keyStore.destroy(); } catch { /* already destroyed */ }

      // Force remove any leftover files
      forceCleanupDaemon(daemon.derivationId);
    }
    startedDaemons.length = 0;
  });

  /** Helper to start a daemon and register it for cleanup */
  function startDaemon(derivationId?: string) {
    const derivId = derivationId ?? `test-uds-${crypto.randomBytes(4).toString('hex')}`;
    const ks = KeyStore.createForTest(derivId);
    const daemonPromise = runDaemonUds(ks, 'test-principal', derivId);
    startedDaemons.push({ derivationId: derivId, keyStore: ks, daemonPromise });
    return { derivId, ks, daemonPromise };
  }

  it('should start, respond to status, and shutdown', async () => {
    const { derivId, daemonPromise } = startDaemon();
    const sockPath = socketPath(derivId);
    await waitForSocket(sockPath);

    // Send status request
    const statusResp = await sendRpc(sockPath, { id: 1, method: 'status' });
    expect(statusResp.id).toBe(1);
    expect((statusResp.result as Record<string, unknown>).status).toBe('running');
    expect((statusResp.result as Record<string, unknown>).principal).toBe('test-principal');

    // Shutdown
    const shutdownResp = await sendRpc(sockPath, { id: 2, method: 'shutdown' });
    expect(shutdownResp.id).toBe(2);

    await daemonPromise;
  });

  it('should encrypt and decrypt inline data via UDS', async () => {
    const { derivId, daemonPromise } = startDaemon();
    const sockPath = socketPath(derivId);
    await waitForSocket(sockPath);

    // Encrypt
    const testData = Buffer.from('Hello, encrypted world!').toString('base64');
    const encResp = await sendRpc(sockPath, {
      id: 1,
      method: 'encrypt',
      params: { data_base64: testData },
    });
    expect(encResp.error).toBeUndefined();
    const encResult = encResp.result as Record<string, unknown>;
    expect(encResult.data_base64).toBeDefined();
    expect(encResult.plaintext_size).toBe(23); // "Hello, encrypted world!" = 23 bytes
    // Inline mode should also return output_file with auto-generated path
    expect(encResult.output_file).toBeDefined();
    expect(typeof encResult.output_file).toBe('string');
    expect(existsSync(encResult.output_file as string)).toBe(true);

    // Decrypt
    const decResp = await sendRpc(sockPath, {
      id: 2,
      method: 'decrypt',
      params: { data_base64: encResult.data_base64 },
    });
    expect(decResp.error).toBeUndefined();
    const decResult = decResp.result as Record<string, unknown>;
    const decrypted = Buffer.from(decResult.data_base64 as string, 'base64').toString('utf-8');
    expect(decrypted).toBe('Hello, encrypted world!');

    // Cleanup auto-generated encrypted file
    try { unlinkSync(encResult.output_file as string); } catch { /* ignore */ }

    // Shutdown
    await sendRpc(sockPath, { id: 99, method: 'shutdown' });
    await daemonPromise;
  });

  it('should encrypt and decrypt file data via UDS', async () => {
    const { derivId, daemonPromise } = startDaemon();
    const sockPath = socketPath(derivId);
    await waitForSocket(sockPath);

    // Write test file
    const inputPath = join(tmpdir(), `vetkey-test-input-${crypto.randomBytes(4).toString('hex')}.txt`);
    const encPath = inputPath + '.enc';
    const outputPath = inputPath + '.dec';
    writeFileSync(inputPath, 'File encryption test content');

    try {
      // Encrypt file
      const encResp = await sendRpc(sockPath, {
        id: 1,
        method: 'encrypt',
        params: { input_file: inputPath, output_file: encPath },
      });
      expect(encResp.error).toBeUndefined();
      expect(existsSync(encPath)).toBe(true);

      // Decrypt file
      const decResp = await sendRpc(sockPath, {
        id: 2,
        method: 'decrypt',
        params: { input_file: encPath, output_file: outputPath },
      });
      expect(decResp.error).toBeUndefined();
      expect(readFileSync(outputPath, 'utf-8')).toBe('File encryption test content');
    } finally {
      // Cleanup temp files
      for (const f of [inputPath, encPath, outputPath]) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
      await sendRpc(sockPath, { id: 99, method: 'shutdown' });
      await daemonPromise;
    }
  });

  it('should handle unknown method gracefully', async () => {
    const { derivId, daemonPromise } = startDaemon();
    const sockPath = socketPath(derivId);
    await waitForSocket(sockPath);

    const resp = await sendRpc(sockPath, { id: 1, method: 'nonexistent' });
    expect(resp.error).toContain('Unknown method');

    await sendRpc(sockPath, { id: 99, method: 'shutdown' });
    await daemonPromise;
  });

  it('should reject ibe-decrypt when daemon has no IBE support', async () => {
    const { derivId, daemonPromise } = startDaemon();
    const sockPath = socketPath(derivId);
    await waitForSocket(sockPath);

    const resp = await sendRpc(sockPath, {
      id: 1,
      method: 'ibe-decrypt',
      params: { ibe_identity: 'test:Mail', ciphertext_base64: 'AAAA' },
    });
    expect(resp.error).toBeDefined();
    expect(resp.error).toContain('IBE support');

    await sendRpc(sockPath, { id: 99, method: 'shutdown' });
    await daemonPromise;
  });

  it('should reject ibe-decrypt with missing params', async () => {
    const { derivId, daemonPromise } = startDaemon();
    const sockPath = socketPath(derivId);
    await waitForSocket(sockPath);

    const resp = await sendRpc(sockPath, { id: 1, method: 'ibe-decrypt' });
    expect(resp.error).toBeDefined();
    expect(resp.error).toContain('Missing');

    await sendRpc(sockPath, { id: 99, method: 'shutdown' });
    await daemonPromise;
  });

  it('should reject ibe-decrypt when ibe_identity does not match the daemon derivation id', async () => {
    // Start daemon with IBE support
    const derivId = `test-uds-ibe-${crypto.randomBytes(4).toString('hex')}`;
    const vetkeyBytes = crypto.randomBytes(48);
    const dpkBytes = new Uint8Array(96);
    const ks = KeyStore.createForTestWithIbe(derivId, vetkeyBytes, dpkBytes);
    const daemonPromise = runDaemonUds(ks, 'test-principal', derivId);
    startedDaemons.push({ derivationId: derivId, keyStore: ks, daemonPromise });

    const sockPath = socketPath(derivId);
    await waitForSocket(sockPath);

    const resp = await sendRpc(sockPath, {
      id: 1,
      method: 'ibe-decrypt',
      params: { ibe_identity: 'someone-else:Mail', ciphertext_base64: 'QUJDRA==' },
    });
    expect(resp.error).toContain('ibe_identity mismatch');

    await sendRpc(sockPath, { id: 99, method: 'shutdown' });
    await daemonPromise;
  });

  it('should reject ibe-decrypt with invalid base64 ciphertext', async () => {
    // Start daemon with IBE support
    const derivId = `test-uds-b64-${crypto.randomBytes(4).toString('hex')}`;
    const vetkeyBytes = crypto.randomBytes(48);
    const dpkBytes = new Uint8Array(96);
    const ks = KeyStore.createForTestWithIbe(derivId, vetkeyBytes, dpkBytes);
    const daemonPromise = runDaemonUds(ks, 'test-principal', derivId);
    startedDaemons.push({ derivationId: derivId, keyStore: ks, daemonPromise });

    const sockPath = socketPath(derivId);
    await waitForSocket(sockPath);

    const resp = await sendRpc(sockPath, {
      id: 1,
      method: 'ibe-decrypt',
      params: { ibe_identity: derivId, ciphertext_base64: '@@@' },
    });
    expect(resp.error).toContain('Invalid base64 ciphertext');

    await sendRpc(sockPath, { id: 99, method: 'shutdown' });
    await daemonPromise;
  });

  it('should handle invalid JSON gracefully', async () => {
    const { derivId, daemonPromise } = startDaemon();
    const sockPath = socketPath(derivId);
    await waitForSocket(sockPath);

    // Send raw invalid JSON over socket
    await new Promise<void>((resolve, reject) => {
      const conn = createConnection(sockPath);
      // Track timeout so we can clear it on success/failure to avoid leaked handles
      const timer = setTimeout(() => reject(new Error('Timeout')), 5000);

      conn.on('connect', () => {
        conn.write('this is not json\n');
      });

      const rl = createInterface({ input: conn });
      rl.on('line', (line: string) => {
        try {
          const parsed = JSON.parse(line);
          expect(parsed.error).toBeDefined();
          expect(typeof parsed.error).toBe('string');
          expect(parsed.error).toContain('Invalid JSON');
          clearTimeout(timer);
          conn.end();
          resolve();
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    await sendRpc(sockPath, { id: 99, method: 'shutdown' });
    await daemonPromise;
  });
});

