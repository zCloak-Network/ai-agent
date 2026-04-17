## 8. Delete — File Deletion with 2FA Verification
Delete files with mandatory **2FA (WebAuthn passkey)** authorization. The agent must obtain passkey confirmation from an authorized owner before deleting any file.
This is also a mixed agent/human flow. The agent prepares and verifies the request; the user only completes the browser-based passkey authorization.

### 8.1 Prepare 2FA Request
Generate a 2FA challenge for the file deletion and get an authentication URL.
Internal command reference:
```bash
zcloak-ai delete prepare <file_path>
# => Outputs:
#    === 2FA Challenge ===
#    <challenge_string>
#
#    === 2FA Authentication URL ===
#    https://id.zcloak.ai/agent/2fa?challenge=...
```
The command:
1. Gathers file information (name, size, timestamp)
2. Calls `prepare_2fa_info` on the registry canister to get a WebAuthn challenge
3. Outputs the challenge string (save this for step 8.3)
4. Outputs an authentication URL for the user to open

### 8.2 User Completes Passkey Authentication
Ask the user to open the authentication URL in their browser. The identity portal will:
- Prompt the user to authorize the file deletion via their passkey
- Complete the 2FA verification on-chain

### 8.3 Check 2FA Status (Optional)
Check whether the 2FA has been confirmed without deleting the file.
Internal command reference:
```bash
zcloak-ai delete check <challenge>
# => Status: confirmed / pending
```

### 8.4 Confirm and Delete
After the user completes passkey authentication, confirm 2FA and delete the file.
Internal command reference:
```bash
zcloak-ai delete confirm <challenge> <file_path>
# => File "example.pdf" deleted successfully.
```

The command will:
- Query the 2FA result on-chain
- Verify `confirm_timestamp` exists (meaning the owner has authorized)
- Delete the file only after successful verification

### Internal Flow Reference
```bash
# Step 1: Prepare 2FA for file deletion
zcloak-ai delete prepare ./report.pdf

# Step 2: User opens the URL in browser and completes passkey auth

# Step 3: Confirm and delete
zcloak-ai delete confirm "<challenge>" ./report.pdf
```
