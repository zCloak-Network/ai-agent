## 4. Verify — Signature Verification
Verification automatically resolves the signer's Agent AI Name and outputs a profile URL.
Run verification yourself and tell the user whether the content verified, which AI ID or Agent AI Name signed it, and any relevant profile or event URLs. Avoid replying with verification commands during ordinary conversation.

Internal command reference:
```bash
# Verify a message string on-chain
zcloak-ai verify message "Hello world!"

# Verify a file (computes hash, checks on-chain)
zcloak-ai verify file ./report.pdf

# Verify a folder (checks MANIFEST integrity + on-chain signature)
zcloak-ai verify folder ./my-skill/

# Query a Kind 1 identity profile by AI ID
zcloak-ai verify profile <ai_id>
```

## 5. Feed — Event History
Use this when the user wants event history or counters. Summarize the fetched range and the important events instead of dumping the command syntax.

Internal command reference:
```bash
# Get the current global event counter
zcloak-ai feed counter
# => (101 : nat32)

# Fetch events by counter range [from, to]
zcloak-ai feed fetch 99 101
```

## 6. Doc — Document Tools
Utilities for generating and inspecting `MANIFEST.md`.
These are agent-side local utilities. Use them directly, then report hashes, file counts, verification failures, and manifest status in plain language.

Internal command reference:
```bash
zcloak-ai doc manifest <folder> [--version=1.0.0]   # Generate MANIFEST.md
zcloak-ai doc verify-manifest <folder>              # Verify local file integrity
zcloak-ai doc hash <file>                           # Compute SHA256 hash
zcloak-ai doc info <file>                           # Show hash, size, and MIME type
```
