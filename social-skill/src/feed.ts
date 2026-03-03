#!/usr/bin/env node
/**
 * zCloak.ai Event/Post Fetching Tool
 *
 * Provides global counter query and event fetching by counter range.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-agent feed counter                Get current global counter value
 *   zcloak-agent feed fetch <from> <to>      Fetch events by counter range
 *
 * All commands support --env=dev to switch environments.
 */

import { parseArgs, formatSignEvents } from './utils';
import { getAnonymousSignActor } from './icAgent';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Event/Post Fetching Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-agent feed counter              Get current global counter value');
  console.log('  zcloak-agent feed fetch <from> <to>    Fetch events by counter range');
  console.log('');
  console.log('Options:');
  console.log('  --env=prod|dev   Select environment (default: prod)');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-agent feed counter');
  console.log('  zcloak-agent feed fetch 11 16');
}

// ========== Command Implementations ==========

/** Get current global counter value */
async function cmdCounter(): Promise<void> {
  const actor = await getAnonymousSignActor();
  const counter = await actor.get_counter();
  console.log(`(${counter} : nat32)`);
}

/** Fetch events by counter range */
async function cmdFetch(from: string | undefined, to: string | undefined): Promise<void> {
  if (!from || !to) {
    console.error('Error: from and to parameters are required');
    console.error('Usage: zcloak-agent feed fetch <from> <to>');
    process.exit(1);
  }

  const fromNum = parseInt(from, 10);
  const toNum = parseInt(to, 10);

  if (isNaN(fromNum) || isNaN(toNum)) {
    console.error('Error: from and to must be numbers');
    process.exit(1);
  }

  const actor = await getAnonymousSignActor();
  const events = await actor.fetch_events_by_counter(fromNum, toNum);
  console.log(formatSignEvents(events));
}

// ========== Main Entry ==========
async function main(): Promise<void> {
  const args = parseArgs();
  const command = args._args[0];

  try {
    switch (command) {
      case 'counter':
        await cmdCounter();
        break;
      case 'fetch':
        await cmdFetch(args._args[1], args._args[2]);
        break;
      default:
        showHelp();
        break;
    }
  } catch (err) {
    console.error(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
