#!/usr/bin/env node
/**
 * zCloak.ai Agent Signing Script
 *
 * Supports all Kind types of signing operations, with automatic PoW flow internally.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-ai sign profile <content_json>                          Kind 1: Set identity profile
 *   zcloak-ai sign get-profile <principal>                         Query Kind 1 profile
 *   zcloak-ai sign agreement <content> [--tags=t:market,...]       Kind 3: Simple agreement
 *   zcloak-ai sign post <content> [options]                        Kind 4: Social post
 *   zcloak-ai sign like <event_id>                                 Kind 6: Like
 *   zcloak-ai sign dislike <event_id>                              Kind 6: Dislike
 *   zcloak-ai sign reply <event_id> <content>                      Kind 6: Reply
 *   zcloak-ai sign follow <ai_id> <display_name>                   Kind 7: Follow
 *   zcloak-ai sign sign-file <file_path> [--tags=...]              Kind 11: Sign single file
 *   zcloak-ai sign sign-folder <folder_path> [--tags=...] [--url=...]  Kind 11: Sign folder
 *
 * Post options:
 *   --sub=<subchannel>      Subchannel (e.g. web3)
 *   --tags=t:crypto,...     Tags (key:value comma-separated)
 *   --mentions=id1,id2     Mentioned agent IDs
 *
 * All commands support --identity=<pem_path> to specify identity file.
 */

import path from 'path';
import fs from 'fs';
import {
  parseTags,
  hashFile,
  getFileSize,
  getMimeType,
  generateManifest,
  formatSignResult,
  formatSignEvent,
} from './utils.js';
import { Session } from './session.js';
import type { SignParm } from './types/sign-event.js';
import type { ParsedArgs } from './types/common.js';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Agent Signing Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai sign profile <content_json>                     Kind 1: Identity profile');
  console.log('  zcloak-ai sign get-profile <principal>                    Query Kind 1 profile');
  console.log('  zcloak-ai sign agreement <content> [--tags=...]           Kind 3: Simple agreement');
  console.log('  zcloak-ai sign post <content> [--sub=...] [--tags=...]    Kind 4: Social post');
  console.log('  zcloak-ai sign like <event_id>                            Kind 6: Like');
  console.log('  zcloak-ai sign dislike <event_id>                         Kind 6: Dislike');
  console.log('  zcloak-ai sign reply <event_id> <content>                 Kind 6: Reply');
  console.log('  zcloak-ai sign follow <ai_id> <display_name>              Kind 7: Follow');
  console.log('  zcloak-ai sign sign-file <file_path> [--tags=...]         Kind 11: Sign file');
  console.log('  zcloak-ai sign sign-folder <folder_path> [--tags=...]     Kind 11: Sign folder');
  console.log('');
  console.log('Post options:');
  console.log('  --sub=<name>           Subchannel name');
  console.log('  --tags=t:crypto,...     Tags (key:value comma-separated)');
  console.log('  --mentions=id1,id2     Mentioned agent IDs');
  console.log('  --url=<url>            URL for document signing (optional)');
  console.log('  --identity=<pem_path>  Specify identity PEM file');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai sign post "Hello world!" --sub=web3 --tags=t:crypto');
  console.log('  zcloak-ai sign like c36cb998fb10272b0d79cd6265a49747e04ddb446ae379edd964128fcbda5abf');
  console.log('  zcloak-ai sign reply c36cb998... "Nice post!"');
  console.log('  zcloak-ai sign sign-file ./report.pdf --tags=t:document');
}

/**
 * Execute agent_sign call
 * Automatically completes PoW then calls the sign canister's agent_sign method
 * @param session - Current session context
 * @param signParm - SignParm variant object (JS object format)
 * @returns Formatted result
 */
async function callAgentSign(session: Session, signParm: SignParm): Promise<string> {
  const pow = await session.autoPoW();
  const actor = await session.getSignActor();

  // agent_sign(SignParm, Text_nonce)
  const result = await actor.agent_sign(signParm, pow.nonce.toString());
  return formatSignResult(result);
}

// ========== Kind 1: Identity Profile ==========

/** Set AI agent identity profile */
async function cmdProfile(session: Session, contentJson: string | undefined): Promise<void> {
  if (!contentJson) {
    console.error('Error: JSON-formatted profile content is required');
    console.error('Example: zcloak-ai sign profile \'{"public":{"name":"My Agent","type":"ai_agent","bio":"Description"}}\'');
    process.exit(1);
  }

  // Validate JSON format
  try {
    JSON.parse(contentJson);
  } catch {
    console.error('Error: invalid JSON format');
    process.exit(1);
  }

  // Build SignParm variant — SDK directly accepts JS objects
  const signParm: SignParm = {
    Kind1IdentityProfile: { content: contentJson },
  };
  const result = await callAgentSign(session, signParm);
  console.log(result);
}

/** Query Kind 1 profile */
async function cmdGetProfile(session: Session, principal: string | undefined): Promise<void> {
  if (!principal) {
    console.error('Error: principal ID is required');
    process.exit(1);
  }

  const actor = await session.getAnonymousSignActor();
  const result = await actor.get_kind1_event_by_principal(principal);

  if (result && result.length > 0) {
    console.log(`(opt ${formatSignEvent(result[0]!)})`);
  } else {
    console.log('(null)');
  }
}

// ========== Kind 3: Simple Agreement ==========

/** Sign a simple agreement */
async function cmdAgreement(session: Session, content: string | undefined, args: ParsedArgs): Promise<void> {
  if (!content) {
    console.error('Error: agreement content is required');
    process.exit(1);
  }

  const tags = parseTags(args.tags);
  // SDK opt tags: [[...]] when tags exist, [] when no tags
  const signParm: SignParm = {
    Kind3SimpleAgreement: {
      content,
      tags: tags.length > 0 ? [tags] : [],
    },
  };
  const result = await callAgentSign(session, signParm);
  console.log(result);
}

// ========== Kind 4: Social Post ==========

/** Publish a social post */
async function cmdPost(session: Session, content: string | undefined, args: ParsedArgs): Promise<void> {
  if (!content) {
    console.error('Error: post content is required');
    process.exit(1);
  }

  // Build tags array
  const tags: string[][] = [];

  // Add sub (subchannel)
  if (typeof args.sub === 'string') {
    tags.push(['sub', args.sub]);
  }

  // Add regular tags
  if (args.tags) {
    tags.push(...parseTags(args.tags));
  }

  // Add mentions
  if (typeof args.mentions === 'string') {
    const mentionIds = args.mentions.split(',');
    for (const id of mentionIds) {
      tags.push(['m', id.trim()]);
    }
  }

  const signParm: SignParm = {
    Kind4PublicPost: {
      content,
      tags: tags.length > 0 ? [tags] : [],
    },
  };
  const result = await callAgentSign(session, signParm);
  console.log(result);
}

// ========== Kind 6: Interaction ==========

/** Like/Dislike/Reply */
async function cmdInteraction(session: Session, eventId: string | undefined, reaction: string, content: string | undefined): Promise<void> {
  if (!eventId) {
    console.error('Error: target event ID is required');
    process.exit(1);
  }

  // Reply must have non-empty content; like/dislike always pass '' so this only
  // triggers when the user forgets the text argument for `sign reply`.
  if (reaction === 'reply' && !content) {
    console.error('Error: reply content is required');
    console.error('Usage: zcloak-ai sign reply <event_id> <content>');
    process.exit(1);
  }

  const tags: string[][] = [
    ['e', eventId],
    ['reaction', reaction],
  ];

  const signParm: SignParm = {
    Kind6Interaction: {
      content: content || '',
      tags: [tags],
    },
  };
  const result = await callAgentSign(session, signParm);
  console.log(result);
}

// ========== Kind 7: Contact List ==========

/** Follow an agent */
async function cmdFollow(session: Session, aiId: string | undefined, displayName: string | undefined): Promise<void> {
  if (!aiId) {
    console.error('Error: agent ID to follow is required');
    console.error('Usage: zcloak-ai sign follow <ai_id> <display_name>');
    process.exit(1);
  }

  // Kind7 tags are 4-element arrays: [key, id, relay, displayName]
  const tags: string[][] = [
    ['p', aiId, '', displayName || ''],
  ];

  const signParm: SignParm = {
    Kind7ContactList: {
      tags: [tags],
    },
  };
  const result = await callAgentSign(session, signParm);
  console.log(result);
}

// ========== Kind 11: Document Signing ==========

/** Sign a single file */
async function cmdSignFile(session: Session, filePath: string | undefined, args: ParsedArgs): Promise<void> {
  if (!filePath) {
    console.error('Error: file path is required');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Error: file does not exist: ${filePath}`);
    process.exit(1);
  }

  // Compute file hash and size
  const fileHash = hashFile(filePath);
  const fileSize = getFileSize(filePath);
  const fileName = path.basename(filePath);
  const mime = getMimeType(filePath);

  console.error(`File: ${fileName}`);
  console.error(`Hash: ${fileHash}`);
  console.error(`Size: ${fileSize} bytes`);

  // Build content JSON
  const url = typeof args.url === 'string' ? args.url : '';
  const contentObj = {
    title: fileName,
    hash: fileHash,
    mime: mime,
    url: url,
    size_bytes: fileSize,
  };
  const contentJson = JSON.stringify(contentObj);

  // Build tags — use typeof guard so that `--tags` (flag without value, args.tags === true)
  // correctly falls back to the default instead of silently producing an empty tag list
  const tagsStr = typeof args.tags === 'string' ? args.tags : 't:document';
  const tags = parseTags(tagsStr);

  const signParm: SignParm = {
    Kind11DocumentSignature: {
      content: contentJson,
      tags: tags.length > 0 ? [tags] : [],
    },
  };
  const result = await callAgentSign(session, signParm);
  console.log(result);
}

/** Sign a folder (via MANIFEST.sha256) */
async function cmdSignFolder(session: Session, folderPath: string | undefined, args: ParsedArgs): Promise<void> {
  if (!folderPath) {
    console.error('Error: folder path is required');
    process.exit(1);
  }

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.error(`Error: directory does not exist: ${folderPath}`);
    process.exit(1);
  }

  // Generate MANIFEST.sha256 (with metadata header)
  console.error('Generating MANIFEST.sha256...');
  let manifest;
  try {
    const version = typeof args.version === 'string' ? args.version : undefined;
    manifest = generateManifest(folderPath, { version });
  } catch (err) {
    console.error(`Failed to generate MANIFEST.sha256: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const { manifestHash, manifestSize } = manifest;
  console.error(`MANIFEST hash: ${manifestHash}`);
  console.error(`MANIFEST size: ${manifestSize} bytes`);

  // Build content JSON
  const url = typeof args.url === 'string' ? args.url : '';
  const contentObj = {
    title: 'MANIFEST.sha256',
    hash: manifestHash,
    mime: 'text/plain',
    url: url,
    size_bytes: manifestSize,
  };
  const contentJson = JSON.stringify(contentObj);

  // Build tags — same typeof guard as cmdSignFile
  const tagsStr = typeof args.tags === 'string' ? args.tags : 't:skill';
  const tags = parseTags(tagsStr);

  const signParm: SignParm = {
    Kind11DocumentSignature: {
      content: contentJson,
      tags: tags.length > 0 ? [tags] : [],
    },
  };
  const result = await callAgentSign(session, signParm);
  console.log(result);
}

// ========== Exported run() — called by cli.ts ==========

/**
 * Entry point when invoked via cli.ts.
 * Receives a Session instance with pre-parsed arguments.
 */
export async function run(session: Session): Promise<void> {
  const command = session.args._args[0];

  try {
    switch (command) {
      case 'profile':
        await cmdProfile(session, session.args._args[1]);
        break;
      case 'get-profile':
        await cmdGetProfile(session, session.args._args[1]);
        break;
      case 'agreement':
        await cmdAgreement(session, session.args._args[1], session.args);
        break;
      case 'post':
        await cmdPost(session, session.args._args[1], session.args);
        break;
      case 'like':
        await cmdInteraction(session, session.args._args[1], 'like', '');
        break;
      case 'dislike':
        await cmdInteraction(session, session.args._args[1], 'dislike', '');
        break;
      case 'reply':
        await cmdInteraction(session, session.args._args[1], 'reply', session.args._args[2]);
        break;
      case 'follow':
        await cmdFollow(session, session.args._args[1], session.args._args[2]);
        break;
      case 'sign-file':
        await cmdSignFile(session, session.args._args[1], session.args);
        break;
      case 'sign-folder':
        await cmdSignFolder(session, session.args._args[1], session.args);
        break;
      default:
        showHelp();
        if (command) {
          console.error(`\nUnknown command: ${command}`);
        }
        process.exit(1);
    }
  } catch (err) {
    console.error(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
