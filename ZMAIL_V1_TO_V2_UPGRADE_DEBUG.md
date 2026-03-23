# zMail V1 -> V2 Upgrade Debug Record

This note is for validating the existing `vetkey send-msg/recv-msg` flow before switching fully to Kind17 v2.

Current conclusion:

- no special mailbox migration is needed for the Kind17 v2 upgrade
- mailbox cache files are raw message cache, not a normalized content store
- `inbox.json` and `sent.json` may legitimately contain mixed historical formats
- compatibility responsibility is in `recv-msg`, not in mailbox reset or rewrite logic

## Goal

1. Verify legacy `v1` send/receive still works end-to-end.
2. Verify new `v2` send/receive works end-to-end.
3. Record envelope shape, inbox/sync behavior, and decryption behavior side by side.

## Identities

- Receiver identity PEM: `~/.config/zcloak/ai-id.pem`
- Sender identity PEM: `~/.config/zcloak/ai-id-sender.pem`

Receiver is the inbox owner. Sender is only used to post test messages to the receiver.

## Mailbox Isolation

No extra top-level sender workspace is required for this test.

The current CLI stores mailbox cache by principal under:

```bash
~/.config/zcloak/mailboxes/<principal>/
```

That means:

- receiver cache stays under the receiver principal directory
- sender cache stays under the sender principal directory
- inbox/sent state does not mix as long as the two PEM files produce different principals

## Preconditions

1. Build the CLI once from the current workspace:

```bash
npm run build
```

2. Confirm both PEM files exist:

```bash
npx tsx src/cli.ts identity show --identity=~/.config/zcloak/ai-id.pem
npx tsx src/cli.ts identity show --identity=~/.config/zcloak/ai-id-sender.pem
```

3. Register both identities with zMail:

```bash
npx tsx src/cli.ts zmail register --identity=~/.config/zcloak/ai-id.pem
npx tsx src/cli.ts zmail register --identity=~/.config/zcloak/ai-id-sender.pem
```

4. Capture the two principal IDs from step 2:

- `RECEIVER_AI_ID=<receiver principal>`
- `SENDER_AI_ID=<sender principal>`

## Quick Cleanup Before Each Round

Use these before a fresh round if inbox state is noisy:

```bash
npx tsx src/cli.ts zmail sync --identity=~/.config/zcloak/ai-id.pem --full
npx tsx src/cli.ts zmail inbox --identity=~/.config/zcloak/ai-id.pem --limit=10 --json
```

For the Kind17 v2 upgrade, no special mailbox migration is required.

Historical inbox cache may still contain older message formats after a re-sync,
because the server continues to return those historical messages. Compatibility
is handled by `recv-msg`, not by resetting mailbox cache.

The same applies to `sent.json`: it is also just cached server data, so older
records may remain in legacy `content` string form while newer records use
structured object content.

## Phase 1: Legacy V1 Baseline

### 1. Send a v1 message

```bash
npx tsx src/cli.ts vetkey send-msg \
  --identity=~/.config/zcloak/ai-id-sender.pem \
  --to="$RECEIVER_AI_ID" \
  --text="v1 smoke $(date +%s)" \
  --kind17-version=v1
```

Expected:

- command prints a Kind17 envelope JSON to stdout
- envelope `content` is a JSON string
- `content.v == 1`
- tags include `payload_type` and `ibe_id`

### 2. Sync receiver inbox

```bash
npx tsx src/cli.ts zmail sync --identity=~/.config/zcloak/ai-id.pem
npx tsx src/cli.ts zmail inbox --identity=~/.config/zcloak/ai-id.pem --limit=5 --json
```

Record:

- latest `msg_id`
- whether inbox shows unread count correctly
- whether local cache was updated

### 3. Decrypt the v1 message

```bash
npx tsx src/cli.ts vetkey recv-msg \
  --identity=~/.config/zcloak/ai-id.pem \
  --msg-id="<v1 msg_id>" \
  --json
```

Expected:

- decryption succeeds
- output contains `payload_type: "text"`
- output contains the original plaintext
- output contains `verified_sender`

## Phase 2: New V2 Flow

### 1. Send a v2 message

`v2` is now the default, so no version flag is required.

```bash
npx tsx src/cli.ts vetkey send-msg \
  --identity=~/.config/zcloak/ai-id-sender.pem \
  --to="$RECEIVER_AI_ID" \
  --text="v2 smoke $(date +%s)"
```

Expected:

- command prints a Kind17 envelope JSON to stdout
- envelope `content` is an object
- `content.v == 2`
- `content.alg == "aes-256-gcm"`
- `content.key_alg == "vetkey-ibe"`
- `content.keys` contains both sender and receiver entries
- tags no longer require `payload_type` / `ibe_id`

### 2. Sync receiver inbox

```bash
npx tsx src/cli.ts zmail sync --identity=~/.config/zcloak/ai-id.pem
npx tsx src/cli.ts zmail inbox --identity=~/.config/zcloak/ai-id.pem --limit=5 --json
```

Record:

- latest `msg_id`
- whether the message is cached normally
- whether inbox payload shape differs from v1

### 3. Decrypt the v2 message

```bash
npx tsx src/cli.ts vetkey recv-msg \
  --identity=~/.config/zcloak/ai-id.pem \
  --msg-id="<v2 msg_id>" \
  --json
```

Expected:

- decryption succeeds
- body key is first unwrapped through daemon `ibe-decrypt`
- plaintext matches the original v2 text

## Side-by-Side Checks

Check these carefully after both phases:

- `send-msg` output shape:
  - v1: `content` string with `v/type/ct`
  - v2: `content` object with `v/type/alg/key_alg/iv/ciphertext/keys`
- receiver inbox sync behavior:
  - does either format fail to cache?
  - does either format affect unread counting?
- `recv-msg --msg-id` behavior:
  - v1 still works
  - v2 works through the new decrypt path
- sender verification:
  - compare `verified_sender` between v1 and v2

## Record Template

### Identity Snapshot

- Receiver PEM:
- Receiver principal:
- Sender PEM:
- Sender principal:
- zMail URL:
- Test date:

### V1 Result

- send status:
- envelope shape:
- sync status:
- inbox msg_id:
- recv status:
- plaintext match:
- verified_sender:
- notes:

### V2 Result

- send status:
- envelope shape:
- sync status:
- inbox msg_id:
- recv status:
- plaintext match:
- verified_sender:
- notes:

### Diff Summary

- v1 only behavior:
- v2 only behavior:
- compatibility issues:
- blockers before switching default permanently:

## Current Run: 2026-03-23

### Identity Snapshot

- Receiver PEM: `/Users/wanghui/.config/zcloak/ai-id.pem`
- Receiver principal: `rtbpf-jz3v4-w5nhm-4pgp2-2mgqk-ce5gz-aw4wr-7tlte-ohefu-5mxb5-2ae`
- Sender PEM: `/Users/wanghui/.config/zcloak/ai-id-sender.pem`
- Sender principal: `3tkog-tcj6z-i5fjg-wv7oa-bbly2-grhyw-5qxhn-fsaz2-dg73w-cymzm-dae`
- V2 backend: `https://zmail-api-v2-822734913522.asia-southeast1.run.app`
- V1 backend: `https://zmail-api-822734913522.asia-southeast1.run.app`

### Registration

- Receiver register on V2: already registered
- Sender register on V2: success on 2026-03-23
- Receiver register on V1: already registered
- Sender register on V1: already registered

### V1 Result

- Local v1 envelope generation: success
- V1 envelope sent to V2 backend: failed with `unsupported_content_version`
- V1 envelope sent to V1 backend: failed with `unknown_sender`
- New v1 end-to-end send test: blocked by old backend sender recognition issue
- Existing historical v1 inbox message decrypt: success
- Verified historical v1 msg_id: `1eed654dbd3c17fdda590e58e33f760caaeacc979a283157fbf04c952e04909d`
- Historical v1 plaintext: `hi nice to meet u`

### V2 Result

- V2 send: success
- Delivered msg_id: `bfa2ee4abbf6f06674ba3bf7ea717f4fd6a17697db51cb7cba19516ed58cfcae`
- Receiver sync result: `1 new inbox, 0 new sent`
- Receiver inbox cache contains the delivered v2 message: yes
- Receiver decrypt via `recv-msg --msg-id`: success
- V2 plaintext: `v2 smoke 2026-03-23T17:01+08:00`

### Compatibility Notes

- `recv-msg` now handles both:
  - legacy v1 content as JSON string with `v/type/ct`
  - new v2 content as object with `v/type/alg/key_alg/iv/ciphertext/keys`
- Existing cached v1 inbox messages still decrypt correctly
- New v2 messages send, sync, cache, and decrypt correctly on the V2 backend
- Mailbox cache does not need schema migration:
  - `inbox.json` can contain mixed v1/v2 historical messages
  - `sent.json` can also contain mixed historical message formats
  - cache files are expected to mirror server history, not convert everything to v2

### Mailbox Cache Observations

- Receiver `inbox.json` after re-sync still contained mixed historical formats:
  - `1` v2 object record
  - `9` v1 JSON-string records
  - `11` older raw-string records
- Comparing the current receiver `inbox.json` with the last backup copy showed:
  - same message count
  - same message IDs
  - same ordering
  - same content-type distribution
- Comparing the sender `sent.json` with the last backup copy at the time of inspection also showed:
  - same message count
  - same message IDs
  - same ordering
  - same content-type distribution
- Conclusion: forced mailbox reset/full-sync did not produce a meaningful cache-format upgrade and is not needed

### Preferences / Policy API Verification

- Initial receiver preferences:
  - `message_policy_mode = all`
  - `allow_list = []`
  - `block_list = []`
- `policy set --mode=allow_list`: success
- `allow add --ai-id=3tkog-tcj6z-i5fjg-wv7oa-bbly2-grhyw-5qxhn-fsaz2-dg73w-cymzm-dae`: success
- With `message_policy_mode=allow_list` and sender in `allow_list`:
  - sender delivery succeeded
  - delivered test msg_id: `aa7188e7e229f2ecfe3422711040d5f0a510d20ab80e5418dc58463ca7bd90ec`
  - zMail response summary: `delivered_to=1`, `blocked_count=0`
- `block add --ai-id=3tkog-tcj6z-i5fjg-wv7oa-bbly2-grhyw-5qxhn-fsaz2-dg73w-cymzm-dae`: success
- Mutual exclusion behavior verified:
  - after `block add`, the same AI-ID was removed from `allow_list`
- With `message_policy_mode=allow_list` and sender in `block_list`:
  - sender delivery failed
  - blocked test msg_id: `ec963f7501017e4c8abbf4e37af5cf596c44a0212550263b4d7d8c9e08f570aa`
  - zMail error: `all_recipients_blocked`
- With `message_policy_mode=all` and sender in `block_list`:
  - sender delivery still failed
  - blocked test msg_id: `4eab8154825324f0bb1834f47c515fd961b2120f06a9887c322aeea145d834c1`
  - zMail error: `all_recipients_blocked`
- Conclusion:
  - `allow_list` mode works
  - `block_list` works
  - `block_list` takes precedence over `allow_list`
  - `block_list` is still enforced even when `message_policy_mode=all`
  - these commands should be used serially, not concurrently, because each update is read-modify-write
- Final receiver preferences were restored to:
  - `message_policy_mode = all`
  - `allow_list = []`
  - `block_list = []`

### Current Blockers

- Legacy v1 send path is intentionally not a release blocker:
  - V2 backend rejects v1 content by design with `unsupported_content_version`
  - the product direction is to standardize on the V2 endpoint
  - v1 send is retained only for compatibility/debug comparison and will be phased out
- `node dist/cli.js ...` currently fails at runtime because `@dfinity/vetkeys` is imported as named ESM exports from a CommonJS package in the built output; test execution had to use `npx tsx src/cli.ts ...`

### Migration Helper

- No special helper is needed
- Keep the existing mailbox cache in place
- Run normal `zmail sync` when you actually want to refresh local cache
