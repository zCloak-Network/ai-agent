# Daemon Start Test

This file records the local commands and test scenarios used to verify daemon startup behavior during source-mode development.

## Entry Modes

Use one of these two forms depending on what you are testing:

```bash
npx tsx src/cli.ts <module> <command> ...
```

```bash
node --import tsx src/cli.ts <module> <command> ...
```

Notes:

- `npx tsx ...` is convenient for manual local testing.
- `node --import tsx ...` is the form used by the daemon background spawn fallback when `src/cli.js` does not exist.
- Do not use `node src/cli.ts ...` directly. Plain Node cannot execute the TypeScript source entry without the `tsx` loader.

## Basic Identity Check

Confirm the source CLI works:

```bash
npx tsx src/cli.ts identity show
```

Expected:

- Prints PEM path
- Prints Principal ID

## Stop / Status Sanity

Stop the daemon:

```bash
npx tsx src/cli.ts vetkey stop
```

Check status:

```bash
npx tsx src/cli.ts vetkey status
```

Expected when stopped:

```text
Daemon is not running. Wait 5~10 seconds for it to start.
```

Important:

- `vetkey stop` and `vetkey status` should not trigger daemon warm-up.
- Run them serially, not in parallel, otherwise `status` may catch the shutdown window.

## Daemon Start Scenarios

### Scenario 1: Normal command triggers warm-up, but does not immediately need daemon

Run:

```bash
npx tsx src/cli.ts identity show
```

Meaning:

- The CLI may start daemon warm-up in the background.
- This is normal because `identity show` does not need the daemon result immediately.
- Even if the daemon is still deriving keys, the command itself can finish normally.

Useful follow-up checks:

```bash
npx tsx src/cli.ts vetkey status
tail -n 60 ~/.config/zcloak/run/daemon-vk_98d53928c6fe216e-daemon.log
```

Expected daemon log after the source-mode spawn fix:

```text
Deriving AES-256 key from VetKey ...
Deriving Mail key from VetKey ...
Key derivation complete. Starting JSON-RPC daemon...
Daemon ready. Socket: ...
```

Before the fix, source-mode warm-up could fail with:

```text
Error: Cannot find module '/.../src/cli.js'
```

The fixed background fallback is effectively:

```bash
node --import tsx src/cli.ts vetkey serve --identity=...
```

### Scenario 2: `recv-msg` triggers warm-up, but needs daemon before startup finishes

Run:

```bash
npx tsx src/cli.ts vetkey recv-msg --msg-id=<message_id> --json
```

Meaning:

- `recv-msg` may enter while daemon warm-up is already in progress.
- Unlike normal commands, `recv-msg` needs the daemon immediately for Mail decryption.
- This is the race window we care about.

Expected debug logs when daemon is not ready yet:

```text
recv-msg daemon check: daemon not running
```

If a fresh `starting.lock` exists:

```text
recv-msg daemon check: waiting for daemon ready
```

If the daemon becomes ready in time:

```text
recv-msg daemon check: daemon became ready while waiting
```

If it does not become ready:

```text
recv-msg daemon check: wait timed out
Mail daemon is not running yet. Wait 5~10 seconds for it to start, then try again.
```

If there is no fresh `starting.lock`, `recv-msg` must not start the daemon by itself. It fails immediately after the check.

Expected debug log in that case:

```text
recv-msg daemon check: daemon not running
```

With payload fields similar to:

```json
{
  "principal": "<principal>",
  "hasFreshStartLock": false,
  "lockPath": "~/.config/zcloak/run/<daemon>.starting.lock"
}
```

## Useful Runtime Files

Runtime directory:

```bash
ls -1 ~/.config/zcloak/run
```

Common files:

- `daemon-<sanitized-id>-daemon.log`
- `debug.log`
- `<sanitized-id>.pid`
- `<sanitized-id>.sock`
- `<sanitized-id>.starting.lock`

## Known Notes

- Duplicate-looking daemon logs in both `debug.log` and `daemon-...-daemon.log` are from log double-write, not duplicate daemon processes.
- `vetkey status` must be checked after shutdown completes; a status call made at the same time as `stop` can show transient results.
- The current `recv-msg` behavior is intentionally narrow: it may wait for an already-starting daemon, but it must not initiate daemon startup by itself.
