/**
 * Tests for vetkey.ts encrypted messaging commands (send-msg / recv-msg).
 *
 * Covers:
 * 1. Kind17 envelope generation with Schnorr signature for text/file payloads
 * 2. File payload decryption writes bytes to disk instead of UTF-8 coercion
 * 3. Envelope ID integrity verification before daemon access
 */

import { createHash } from 'crypto';
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
  mockIsDaemonAlive,
  mockSocketPath,
  mockIbeEncrypt,
} = vi.hoisted(() => ({
  mockCreateConnection: vi.fn(),
  mockCreateInterface: vi.fn(({ input }: { input: EventEmitter }) => input),
  mockIsDaemonAlive: vi.fn(() => true),
  mockSocketPath: vi.fn(() => '/tmp/mail.sock'),
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
  isDaemonAlive: mockIsDaemonAlive,
  socketPath: mockSocketPath,
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

  it('send-msg emits a Kind17 signed envelope for text payloads', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate().getPrincipal().toText();
    const session = mockSession(
      ['send-msg'],
      { to: recipient, text: 'hello mail', 'no-zmail': true },
      sender,
    );

    await run(session);

    const envelope = readLastJsonLog();
    // Kind17 envelope structure
    expect(envelope.kind).toBe(17);
    expect(envelope.ai_id).toBe(sender.getPrincipal().toText());
    expect(typeof envelope.id).toBe('string');
    expect((envelope.id as string).length).toBe(64); // SHA-256 hex
    expect(typeof envelope.created_at).toBe('number');
    expect(typeof envelope.sig).toBe('string');
    expect((envelope.sig as string).length).toBeGreaterThan(0);

    // Content follows zmail-skill message composition format: {"v":1,"type":"text","ct":"<base64>"}
    expect(typeof envelope.content).toBe('string');
    const parsed = JSON.parse(envelope.content as string);
    expect(parsed.v).toBe(1);
    expect(parsed.type).toBe('text');
    expect(typeof parsed.ct).toBe('string');
    expect(parsed.ct.length).toBeGreaterThan(0);

    // Tags carry recipient, metadata, and sender's SPKI for verification
    const tags = envelope.tags as string[][];
    expect(tags).toEqual(expect.arrayContaining([
      ['to', recipient],
      ['payload_type', 'text'],
      ['ibe_id', `${recipient}:Mail`],
      ['from_pubkey', Buffer.from(sender.getPublicKey().toDer()).toString('hex')],
    ]));

    // Old top-level fields should not exist
    expect(envelope.from).toBeUndefined();
    expect(envelope.ct).toBeUndefined();
    expect(envelope.ts).toBeUndefined();
  });

  it('send-msg includes reply tag when --reply is provided', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate().getPrincipal().toText();
    const parentMsgId = 'msg_parent_abc123';
    const session = mockSession(
      ['send-msg'],
      { to: recipient, text: 'this is a reply', reply: parentMsgId, 'no-zmail': true },
      sender,
    );

    await run(session);

    const envelope = readLastJsonLog();
    const tags = envelope.tags as string[][];
    expect(tags).toEqual(expect.arrayContaining([
      ['reply', parentMsgId],
    ]));
  });

  it('send-msg omits reply tag when --reply is not provided', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate().getPrincipal().toText();
    const session = mockSession(
      ['send-msg'],
      { to: recipient, text: 'no reply', 'no-zmail': true },
      sender,
    );

    await run(session);

    const envelope = readLastJsonLog();
    const tags = envelope.tags as string[][];
    const replyTags = tags.filter(t => t[0] === 'reply');
    expect(replyTags).toHaveLength(0);
  });

  it('send-msg rejects empty --reply value', async () => {
    const sender = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate().getPrincipal().toText();
    const session = mockSession(
      ['send-msg'],
      { to: recipient, text: 'reply to nothing', reply: '', 'no-zmail': true },
      sender,
    );

    await expect(run(session)).rejects.toThrow('--reply requires a non-empty message ID');
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
    // The daemon receives the extracted ct field from the message composition JSON,
    // not the raw envelope.content (which is now {"v":1,"type":"file","ct":"AQIDBA=="})
    expect(lastSocketRequest).toEqual({
      id: 1,
      method: 'ibe-decrypt',
      params: {
        ibe_identity: `${recipientPrincipal}:Mail`,
        ciphertext_base64: 'AQIDBA==',
      },
    });
  });

  it('recv-msg rejects a tampered envelope before talking to the daemon', async () => {
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
    // Tamper with the content — ID will no longer match
    envelope.content = 'AAAA';

    mockLog.mockClear();
    lastSocketRequest = undefined;

    const recvSession = mockSession(
      ['recv-msg'],
      { data: JSON.stringify(envelope) },
      recipient,
    );

    await expect(run(recvSession)).rejects.toThrow('Envelope ID mismatch');
    expect(lastSocketRequest).toBeUndefined();
  });

  it('recv-msg rejects a forged ai_id even with recomputed id', async () => {
    const attacker = Secp256k1KeyIdentity.generate();
    const victim = Secp256k1KeyIdentity.generate();
    const recipient = Secp256k1KeyIdentity.generate();
    const recipientPrincipal = recipient.getPrincipal().toText();

    // Attacker sends a message, gets a valid envelope signed by their key
    const attackSession = mockSession(
      ['send-msg'],
      { to: recipientPrincipal, text: 'trust me' },
      attacker,
    );

    await run(attackSession);
    const envelope = readLastJsonLog();

    // Attacker replaces ai_id with the victim's principal and recomputes the ID
    // to bypass the ID integrity check. But from_pubkey tag still points to attacker's key.
    envelope.ai_id = victim.getPrincipal().toText();
    const payload = [
      0,
      envelope.ai_id,
      envelope.created_at,
      17,
      envelope.tags,
      envelope.content,
    ];
    envelope.id = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');

    mockLog.mockClear();
    lastSocketRequest = undefined;

    const recvSession = mockSession(
      ['recv-msg'],
      { data: JSON.stringify(envelope) },
      recipient,
    );

    // Verification must catch the mismatch between from_pubkey (attacker) and ai_id (victim)
    await expect(run(recvSession)).rejects.toThrow('Sender identity mismatch');
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
