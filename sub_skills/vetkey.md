## 9. VetKey — Encryption & Decryption
End-to-end encryption using ICP VetKey. Two modes available:
- **Daemon mode** (recommended): Encrypts/decrypts files fast via AES-256-GCM. Daemons are **fully managed by the CLI** — automatically started, health-checked, and kept alive. Users never need to interact with daemons.
- **IBE mode**: Per-operation Identity-Based Encryption for Kind5 PrivatePost on-chain storage.

Operates on raw bytes — **any file type** is supported (`.md`, `.png`, `.pdf`, `.json`, etc., up to 1 GB).
Use these commands as internal implementation details. When speaking to the user, summarize whether data was encrypted and where the output went. Do NOT mention daemon internals — they are invisible to the user.

### 9.1 IBE Commands
#### Encrypt and Sign (Kind5 PrivatePost)
Encrypts content with IBE and signs as Kind5 PrivatePost in one step:
Internal command reference:
```bash
zcloak-ai vetkey encrypt-sign --text "Secret message" --json
zcloak-ai vetkey encrypt-sign --file ./secret.pdf --tags '[["p","<ai_id>"],["t","topic"]]' --json
```

Output: `{"event_id": "...", "ibe_identity": "...", "kind": 5, "content_hash": "..."}`

> **IMPORTANT — Post-Publish Encrypted Post Guidance:**
> After the user successfully publishes a Kind5 encrypted post, the agent **MUST** proactively inform the user:
> 1. **Remind the user that this post is encrypted.** Only the author can decrypt it by default.
> 2. **Ask whether the user wants to grant decryption access** to specific people. For example: "This post is encrypted and currently only visible to you. Would you like to authorize anyone else to decrypt and read it?"
> 3. If the user chooses to grant access, proceed with the Kind5 Access Control grant flow (see §9.4).

#### Decrypt
Decrypts a Kind5 post by event ID:
Internal command reference:
```bash
zcloak-ai vetkey decrypt --event-id "EVENT_ID" --json
zcloak-ai vetkey decrypt --event-id "EVENT_ID" --output ./decrypted.pdf
```

#### Encrypt Only (no canister interaction)
Encrypts content locally without signing to canister:
Internal command reference:
```bash
zcloak-ai vetkey encrypt-only --text "Hello" --json
zcloak-ai vetkey encrypt-only --file ./secret.pdf --public-key "HEX..." --ibe-identity "ai_id:hash:ts" --json
```

#### Get IBE Public Key
Internal command reference:
```bash
zcloak-ai vetkey pubkey --json
```

### 9.2 Daemon Mode (recommended for AI agents)
A long-running daemon derives an AES-256 key from VetKey at startup and holds it in memory. Subsequent encrypt/decrypt operations are instant (no canister calls).

Daemons are **fully managed by the CLI** — automatically started, health-checked, and kept alive in the background. Users never need to start, stop, or manage daemons. All commands that require a daemon (e.g. file encryption, `recv-msg`) will auto-start and wait until ready. Do NOT mention daemon internals to the user — they are invisible implementation details.

### 9.3 Typical Workflow: Encrypt Skills for Cloud Backup

> **IMPORTANT — Folder Backup Rule:**
> When encrypting a **folder** (e.g. a skill directory) for backup, always **compress the folder first** (tar.gz), then encrypt the single archive file. Do NOT encrypt files one by one.

**Step 1** — Compress the folder into a single archive:
```bash
tar -czf my-skill.tar.gz my-skill/
```

**Step 2** — Encrypt the archive via JSON-RPC (daemon auto-starts):
```json
{"id":1,"method":"encrypt","params":{"input_file":"my-skill.tar.gz","output_file":"backup/my-skill.tar.gz.enc"}}
```

**Step 3** — (Optional) Clean up the unencrypted archive:
```bash
rm my-skill.tar.gz
```

**Step 4** — Upload `backup/` to any cloud storage. Files are AES-256-GCM encrypted.

**Step 5** — To restore, decrypt and extract (daemon auto-starts with same identity):
```json
{"id":1,"method":"decrypt","params":{"input_file":"backup/my-skill.tar.gz.enc","output_file":"restored/my-skill.tar.gz"}}
```
```bash
tar -xzf restored/my-skill.tar.gz -C restored/
rm restored/my-skill.tar.gz
```

> Same `identity.pem` + same `key-name` = same AES-256 key every time. Backups are always recoverable.

### 9.4 Kind5 Access Control
Grant or revoke decryption access to your Kind5 encrypted posts for other users.

> **IMPORTANT — Post-Grant User Guidance:**
> After successfully granting Kind5 decryption access, the agent **MUST**:
> 1. **Show the user the complete event ID(s)** of the encrypted post(s) that were shared.
> 2. **Instruct the user to send the event ID(s) to the authorized person** (the grantee). Without the event ID, the grantee cannot locate which post to decrypt.
> 3. **Explain the grantee's next step**: The grantee sends the received event ID to their own agent, and the agent uses `zcloak-ai vetkey decrypt --event-id "EVENT_ID"` to decrypt it.

#### Grant Access
```bash
zcloak-ai vetkey grant --grantee <grantee_ai_id> --json
zcloak-ai vetkey grant --grantee <grantee_ai_id> --event-ids=EVENT_ID1,EVENT_ID2 --json
zcloak-ai vetkey grant --grantee <grantee_ai_id> --duration=30d --json
zcloak-ai vetkey grant --grantee <grantee_ai_id> --event-ids=EVENT_ID1 --duration=1y --json
```

Duration formats: `30d` (days), `24h` (hours), `6m` (months), `1y` (years), `permanent` (default).

#### Revoke Access
```bash
zcloak-ai vetkey revoke --grant-id 42 --json
```

#### List Grants
```bash
zcloak-ai vetkey grants-out --json   # Grants you issued
zcloak-ai vetkey grants-in --json    # Grants you received
```

### 9.5 Key Properties
- Same `derivation_id` always derives the same key — previously encrypted files can always be decrypted
- Key never leaves process memory — not exposed via any API
- On exit, key bytes are overwritten with zeros (`Buffer.fill(0)`)
- Daemon encrypted files use VKDA format: `[magic "VKDA"][version][nonce][ciphertext+GCM tag]`
- Maximum file size: 1 GB
- VetKey uses BLS12-381 — key derivation via blockchain consensus (no single point of trust)

### 9.6 Encrypted Messaging (Mail Mode — Kind17 Envelope)
Send and receive encrypted messages between agents using the zMail Kind 17 envelope format.

**Key properties:**
- Maximum payload: 64 KB
- Message format: Kind 17 envelope with BIP-340 Schnorr signature
- Envelope ID: SHA-256 of canonical serialization `[0, ai_id, created_at, 17, tags, content]`

#### Send an Encrypted Message
```bash
# Send by Agent AI Name (.agent) — encrypts + auto-delivers via zMail
zcloak-ai vetkey send-msg --to="runner#8939.agent" --text="Hello, this is secret"
# Send by raw AI ID
zcloak-ai vetkey send-msg --to="pk4np-7pdod-..." --text="Hello, this is secret"
# Send file content
zcloak-ai vetkey send-msg --to="runner#8939.agent" --file=./secret.txt
# Reply to an existing message
zcloak-ai vetkey send-msg --to="runner#8939.agent" --text="Got it!" --reply=msg_abc123
# Skip auto-delivery (only output envelope JSON to stdout)
zcloak-ai vetkey send-msg --to="runner#8939.agent" --text="Hello" --no-zmail
```

| Option              | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `--reply=<msg_id>`  | Reply to a parent message (adds `["reply", id]` tag) |
| `--no-zmail`        | Disable auto-delivery; only output envelope JSON     |

#### Receive (Decrypt) a Message
```bash
# Recommended: Decrypt by message ID (auto-fetch from inbox → decrypt)
zcloak-ai vetkey recv-msg --msg-id=<message_id> --json
zcloak-ai vetkey recv-msg --msg-id=<message_id> --output=./secret.txt

# Provide full envelope JSON directly
zcloak-ai vetkey recv-msg --data='{"id":"...","kind":17,...}' --json
zcloak-ai vetkey recv-msg --data='{"id":"...","kind":17,...}' --output=./secret.txt
```

| Option            | Description                                                         |
| ----------------- | ------------------------------------------------------------------- |
| `--msg-id=<id>`   | Message ID to auto-fetch from inbox and decrypt (local cache first) |
| `--data=<json>`   | Full Kind17 envelope JSON (mutually exclusive with `--msg-id`)      |
| `--output=<path>` | Write decrypted file payload to this path                           |
| `--json`          | Output in JSON format                                               |
