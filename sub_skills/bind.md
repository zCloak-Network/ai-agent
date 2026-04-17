## 7. Bind — Agent-Owner Binding
Link the agent to a human owner via **WebAuthn passkey**.
This is a mixed agent/human flow. The agent runs the CLI steps; the user only opens the URL and completes passkey authentication.
Treat this as part of onboarding, not as an advanced optional feature hidden behind user discovery.

### Input formats accepted by bind commands

Both `bind prepare` and `bind check-passkey` accept **either**:
- A raw AI ID (e.g. `57odc-ymip7-...`)
- An Owner AI Name (`.ai`), such as `alice.ai` or `alice#1234.ai`

> **⚠️ Agent AI Names (`.agent`) are NOT accepted as the owner.**
> If the user provides a `.agent` ID (e.g. `runner#8939.agent`), reject it immediately with a clear error:
> "Agent AI Names (`.agent`) cannot be used as an owner for binding. Please provide an Owner AI Name (`.ai`) or a raw AI ID."
> Do NOT attempt to resolve or look up the AI ID behind a `.agent` name for binding purposes.

When an Owner AI Name (`.ai`) is provided, the CLI **automatically resolves it to an AI ID** via `user_profile_get_by_id` on the registry canister. **Never ask the user to manually copy or look up an AI ID when they have already given an Owner AI Name.**

### Owner-binding guidance
- If the agent has no owner bound yet, proactively raise this with the user.
- Explain briefly that owner binding is used for passkey-backed authorization, including sensitive actions such as secure delete and future protected flows.
- If the user provides a raw AI ID, use it directly.
- If the user provides an Owner AI Name (`.ai`), use it directly. The CLI resolves it automatically.
- Only ask the user for an identifier if they have provided neither an AI ID nor an Owner AI Name (`.ai`).
- Do not ask the user to open `https://id.zcloak.ai/setting` to copy an AI ID if an Owner AI Name is already known.
- Do not ask the user to invent or guess a binding command. The agent should orchestrate the flow.

### Pre-check: Passkey Verification
Before binding, verify the target owner has a registered passkey. Owners created via OAuth may not have a passkey yet.
Internal command reference:
```bash
# Check by raw AI ID
zcloak-ai bind check-passkey <user_ai_id>

# Check by Owner AI Name (.ai), auto-resolved to AI ID internally
zcloak-ai bind check-passkey alice.ai
# => Passkey registered: yes / no
```

### Binding Flow
The `prepare` command automatically performs the passkey pre-check before proceeding.
When guiding the user, present this as:
- The agent prepares the bind request and returns an authentication URL.
- The user opens the URL and completes passkey authentication.
- The agent verifies the final binding result.

Internal command reference:
```bash
# Step 1 (Agent): Initiate the bind and print the URL (includes passkey pre-check)
# Accepts AI ID or Owner AI Name (.ai) directly
zcloak-ai bind prepare alice.ai
# or:
zcloak-ai bind prepare <user_ai_id>
# => Prints: https://id.zcloak.ai/agent/bind?challenge=...

# Step 2 (Human): Open the URL in a browser and complete passkey authentication.

# Step 3: Verify the binding
zcloak-ai register get-owner <agent_ai_id>
# => connection_list shows the bound owner AI ID(s)
```
