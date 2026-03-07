/**
 * Tests for vetkey.ts encrypted messaging commands (send-msg / recv-msg).
 *
 * Covers:
 * 1. Signed envelope generation for text/file payloads
 * 2. File payload decryption writes bytes to disk instead of UTF-8 coercion
 * 3. Envelope signature verification before daemon access
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Secp256k1KeyIdentity } from '@dfinity/identity-secp256k1';
import type { Session } from '../session.js';

const {
  mockCreateConnection,
  mockCreateInterface,
  mockFindRunningDaemon,
  mockIbeEncrypt,
} = vi.hoisted(() => ({
  mockCreateConnection: vi.fn(),
  mockCreateInterface: vi.fn(({ input }: { input: EventEmitter }) => input),
  mockFindRunningDaemon: vi.fn(() => '/tmp/mail.sock'),
  mockIbeEncrypt: vi.fn(() => new Uint8Array([1, 2, 3, 4])),
}));

let daemonResponse: Record<string, unknown>;
let lastSocketRequest: Record<string, unknown> | undefined;

vi.mock('net', () => ({
  createConnection: mockCreateConnection,
}));

vi.mock('readline', () => ({
  createInterface: mockCreateInterface,
}));

vi.mock('../daemon.js', () => ({
  findRunningDaemon: mockFindRunningDaemon,
}));

vi.mock('../crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto.js')>();
  return {
    ...actual,
    ibeEncrypt: mockIbeEncrypt,
  };
});

import { run } from '../vetkey.js';

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

function installSocketMock(): void {
  mockCreateConnection.mockImplementation(() => {
    const conn = new EventEmitter() as EventEmitter & {
      write(data: string): boolean;
      end(): void;
      destroy(): void;
    };

    conn.write = (data: string) => {
      lastSocketRequest = JSON.parse(data.trim());
      queueMicrotask(() => {
        conn.emit('line', JSON.stringify(daemonResponse));
      });
      return true;
    };
    conn.end = () => {
      queueMicrotask(() => conn.emit('close'));
    };
    conn.destroy = () => {
      queueMicrotask(() => conn.emit('close'));
    };

    queueMicrotask(() => conn.emit('connect'));
    return conn;
  });
}

function mockSession(
  positionalArgs: string[],
  namedArgs: Record<string, string | boolean>,
  identity: Secp256k1KeyIdentity,
  overrides: Record<string, unknown> = {},
): Session {
  const signActor = {
    get_ibe_public_key: vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9])),
  };

  return {
    args: { _args: positionalArgs, ...namedArgs },
    getIdentity: vi.fn().mockReturnValue(identity),
    getPrincipal: vi.fn().mockReturnValue(identity.getPrincipal().toText()),
    getSignActor: vi.fn().mockResolvedValue(signActor),
    getAnonymousRegistryActor: vi.fn().mockResolvedValue({
      get_user_principal: vi.fn().mockResolvedValue([]),
    }),
    ...overrides,
  } as unknown as Session;
}

function readLastJsonLog(): Record<string, unknown> {
  const last = mockLog.mock.calls.at(-1)?.[0];
  if (typeof last !== 'string') {
    throw new Error('Expected last console.log call to be a JSON string');
  }
  return JSON.parse(last) as Record<string, unknown>;
}

describe('vetkey encrypted messaging', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-vetkey-test-'));
    daemonResponse = {
      id: 1,
      result: {
        data_base64: '',
        plaintext_size: 0,
      },
    };
    lastSocketRequest = undefined;
    installSocketMock();
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('send-msg emits a signed envelope for text payloads', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate().getPrincipal().toText();
    const session = mockSession(
      ['send-msg'],
      { to: recipient, text: 'hello mail' },
      sender,
    );

    await run(session);

    const envelope = readLastJsonLog();
    expect(envelope.v).toBeUndefined();
    expect(envelope.from).toBe(sender.getPrincipal().toText());
    expect(envelope.from_pubkey).toBe(Buffer.from(sender.getPublicKey().toDer()).toString('hex'));
    expect(envelope.payload_type).toBe('text');
    expect(envelope.filename).toBeUndefined();
    expect(envelope.ibe_id).toBe(`${recipient}:Mail`);
    expect(typeof envelope.sig).toBe('string');
    expect((envelope.sig as string).length).toBeGreaterThan(0);
  });

  it('send-msg rejects invalid raw principal recipients', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const session = mockSession(
      ['send-msg'],
      { to: 'not-a-principal', text: 'hello mail' },
      sender,
    );

    await expect(run(session)).rejects.toThrow('Invalid recipient principal');
  });

  it('send-msg rejects text payloads larger than 64 KB', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate().getPrincipal().toText();
    const session = mockSession(
      ['send-msg'],
      { to: recipient, text: 'a'.repeat(64 * 1024 + 1) },
      sender,
    );

    await expect(run(session)).rejects.toThrow('Message too large');
  });

  it('recv-msg writes file payloads to disk when output is provided', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate();
    const recipientPrincipal = recipient.getPrincipal().toText();
    const inputPath = path.join(tmpDir, 'payload.bin');
    const outputPath = path.join(tmpDir, 'decrypted.bin');
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x41]);

    fs.writeFileSync(inputPath, payload);

    const sendSession = mockSession(
      ['send-msg'],
      { to: recipientPrincipal, file: inputPath },
      sender,
    );

    await run(sendSession);
    const envelope = readLastJsonLog();

    daemonResponse = {
      id: 1,
      result: {
        data_base64: payload.toString('base64'),
        plaintext_size: payload.length,
      },
    };
    mockLog.mockClear();

    const recvSession = mockSession(
      ['recv-msg'],
      { data: JSON.stringify(envelope), output: outputPath },
      recipient,
    );

    await run(recvSession);

    expect(fs.readFileSync(outputPath)).toEqual(payload);
    expect(lastSocketRequest).toEqual({
      id: 1,
      method: 'ibe-decrypt',
      params: {
        ibe_identity: `${recipientPrincipal}:Mail`,
        ciphertext_base64: 'AQIDBA==',
      },
    });
  });

  it('recv-msg rejects a tampered envelope signature before talking to the daemon', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate();
    const recipientPrincipal = recipient.getPrincipal().toText();

    const sendSession = mockSession(
      ['send-msg'],
      { to: recipientPrincipal, text: 'hello tamper' },
      sender,
    );

    await run(sendSession);
    const envelope = readLastJsonLog();
    envelope.ct = 'AAAA';

    mockLog.mockClear();
    lastSocketRequest = undefined;

    const recvSession = mockSession(
      ['recv-msg'],
      { data: JSON.stringify(envelope) },
      recipient,
    );

    await expect(run(recvSession)).rejects.toThrow('Envelope signature verification failed');
    expect(lastSocketRequest).toBeUndefined();
  });

  it('recv-msg returns plaintext JSON for verified text payloads', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate();
    const recipientPrincipal = recipient.getPrincipal().toText();
    const plaintext = 'verified text message';

    const sendSession = mockSession(
      ['send-msg'],
      { to: recipientPrincipal, text: plaintext },
      sender,
    );

    await run(sendSession);
    const envelope = readLastJsonLog();

    daemonResponse = {
      id: 1,
      result: {
        data_base64: Buffer.from(plaintext, 'utf-8').toString('base64'),
        plaintext_size: Buffer.byteLength(plaintext, 'utf-8'),
      },
    };
    mockLog.mockClear();

    const recvSession = mockSession(
      ['recv-msg'],
      { data: JSON.stringify(envelope), json: true },
      recipient,
    );

    await run(recvSession);

    const result = readLastJsonLog();
    expect(result.payload_type).toBe('text');
    expect(result.verified_sender).toBe(true);
    expect(result.plaintext).toBe(plaintext);
    expect(result.output_file).toBeUndefined();
  });

  it('recv-msg accepts empty plaintext results', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate();
    const recipientPrincipal = recipient.getPrincipal().toText();

    const sendSession = mockSession(
      ['send-msg'],
      { to: recipientPrincipal, text: '' },
      sender,
    );

    await run(sendSession);
    const envelope = readLastJsonLog();

    daemonResponse = {
      id: 1,
      result: {
        data_base64: '',
        plaintext_size: 0,
      },
    };
    mockLog.mockClear();

    const recvSession = mockSession(
      ['recv-msg'],
      { data: JSON.stringify(envelope), json: true },
      recipient,
    );

    await run(recvSession);

    const result = readLastJsonLog();
    expect(result.plaintext).toBe('');
    expect(result.plaintext_size).toBe(0);
  });
});
