/**
 * Tests for serve.ts — JSON-RPC daemon via UDS and stdio modes
 *
 * These tests verify:
 * 1. UDS daemon startup and shutdown
 * 2. Encrypt/decrypt inline data via UDS connection
 * 3. Encrypt/decrypt file data via UDS connection
 * 4. Status query
 * 5. Unknown method handling
 * 6. Stdio daemon startup, encrypt/decrypt, and shutdown
 * 7. Stdio daemon graceful exit on input stream close (EOF)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createConnection } from 'net';
import { createInterface } from 'readline';
import { PassThrough } from 'stream';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import { KeyStore } from '../key-store.js';
import { runDaemonUds, runDaemonStdio } from '../serve.js';
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
    expect((statusResp.result as Record<string, unknown>).mode).toBe('uds');

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
});

// ============================================================================
// Stdio Daemon Tests
// ============================================================================

describe('Stdio Daemon', () => {
  /**
   * Helper: wait until the output stream has at least `count` complete JSON lines.
   * Uses polling since PassThrough doesn't emit line-level events.
   */
  function waitForLines(output: PassThrough, count: number, timeoutMs = 3000): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let timer: ReturnType<typeof setTimeout>;
      let resolved = false;

      const finish = (lines: string[]) => {
        if (resolved) return;
        resolved = true;
        output.removeListener('data', onData);
        clearTimeout(timer);
        resolve(lines.map(l => JSON.parse(l)));
      };

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n').filter(Boolean);
        if (lines.length >= count) {
          finish(lines);
        }
      };

      output.on('data', onData);

      // Resume so we get 'data' events (PassThrough starts paused)
      output.resume();

      timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        output.removeListener('data', onData);
        const lines = buffer.split('\n').filter(Boolean);
        reject(new Error(`Timeout: only got ${lines.length}/${count} lines`));
      }, timeoutMs);
    });
  }

  it('should emit ready message and respond to status', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const ks = KeyStore.createForTest('stdio-test:default');
    const daemonPromise = runDaemonStdio(ks, 'test-principal', 'stdio-test:default', input, output);

    // First line should be the ready message
    const [readyMsg] = await waitForLines(output, 1);
    expect(readyMsg.ready).toBe(true);
    expect(readyMsg.derivation_id).toBe('stdio-test:default');
    expect(readyMsg.principal).toBe('test-principal');

    // Send status request
    input.write('{"id":1,"method":"status"}\n');
    const [statusResp] = await waitForLines(output, 1);
    expect(statusResp.id).toBe(1);
    expect((statusResp.result as Record<string, unknown>).status).toBe('running');
    expect((statusResp.result as Record<string, unknown>).mode).toBe('stdio');

    // Quit
    input.write('{"id":2,"method":"quit"}\n');
    await daemonPromise;
  });

  it('should encrypt and decrypt inline data in stdio mode', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const ks = KeyStore.createForTest('stdio-enc:default');
    const daemonPromise = runDaemonStdio(ks, 'test-principal', 'stdio-enc:default', input, output);

    // Skip ready message
    await waitForLines(output, 1);

    // Encrypt
    const testData = Buffer.from('stdio encrypt test').toString('base64');
    input.write(JSON.stringify({ id: 1, method: 'encrypt', params: { data_base64: testData } }) + '\n');

    const [encResp] = await waitForLines(output, 1);
    expect(encResp.error).toBeUndefined();
    const encResult = encResp.result as Record<string, unknown>;
    expect(encResult.data_base64).toBeDefined();

    // Decrypt
    input.write(JSON.stringify({ id: 2, method: 'decrypt', params: { data_base64: encResult.data_base64 } }) + '\n');

    const [decResp] = await waitForLines(output, 1);
    expect(decResp.error).toBeUndefined();
    const decResult = decResp.result as Record<string, unknown>;
    const decrypted = Buffer.from(decResult.data_base64 as string, 'base64').toString('utf-8');
    expect(decrypted).toBe('stdio encrypt test');

    // Quit
    input.write('{"id":99,"method":"quit"}\n');
    await daemonPromise;
  });

  it('should exit gracefully on input stream close (EOF)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const ks = KeyStore.createForTest('stdio-eof:default');
    const daemonPromise = runDaemonStdio(ks, 'test-principal', 'stdio-eof:default', input, output);

    // Wait for ready
    await waitForLines(output, 1);

    // Close stdin (EOF) — daemon should exit gracefully
    input.end();
    await daemonPromise;
    // If we get here without timeout, the daemon handled EOF correctly
  });

  it('should handle invalid JSON gracefully', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const ks = KeyStore.createForTest('stdio-err:default');
    const daemonPromise = runDaemonStdio(ks, 'test-principal', 'stdio-err:default', input, output);

    // Skip ready
    await waitForLines(output, 1);

    // Send invalid JSON
    input.write('this is not json\n');

    const [errorResp] = await waitForLines(output, 1);
    expect(errorResp.error).toBeDefined();
    expect(typeof errorResp.error).toBe('string');
    expect((errorResp.error as string)).toContain('Invalid JSON');

    // Quit
    input.write('{"id":1,"method":"quit"}\n');
    await daemonPromise;
  });
});
