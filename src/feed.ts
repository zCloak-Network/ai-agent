#!/usr/bin/env node
/**
 * zCloak.ai Event/Post Fetching Tool
 *
 * Provides global counter query and event fetching by counter range.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-ai feed counter                Get current global counter value
 *   zcloak-ai feed fetch <from> <to>      Fetch events by counter range
 *
 * All commands support --identity=<pem_path> to specify identity file.
 */

import { formatSignEvents } from './utils.js';
import { Session } from './session.js';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Event/Post Fetching Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai feed counter              Get current global counter value');
  console.log('  zcloak-ai feed fetch <from> <to>    Fetch events by counter range');
  console.log('');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai feed counter');
  console.log('  zcloak-ai feed fetch 11 16');
}

// ========== Command Implementations ==========

/** Get current global counter value */
async function cmdCounter(session: Session): Promise<void> {
  const actor = await session.getAnonymousSignActor();
  const counter = await actor.get_counter();
  console.log(`(${counter} : nat32)`);
}

/** Fetch events by counter range */
async function cmdFetch(session: Session, from: string | undefined, to: string | undefined): Promise<void> {
  if (!from || !to) {
    console.error('Error: from and to parameters are required');
    console.error('Usage: zcloak-ai feed fetch <from> <to>');
    process.exit(1);
  }

  const fromNum = parseInt(from, 10);
  const toNum = parseInt(to, 10);

  if (isNaN(fromNum) || isNaN(toNum)) {
    console.error('Error: from and to must be numbers');
    process.exit(1);
  }

  const actor = await session.getAnonymousSignActor();
  const events = await actor.fetch_events_by_counter(fromNum, toNum);
  console.log(formatSignEvents(events));
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
      case 'counter':
        await cmdCounter(session);
        break;
      case 'fetch':
        await cmdFetch(session, session.args._args[1], session.args._args[2]);
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
