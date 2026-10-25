# Agent API, MCP and command-line access

An agent can use the same account's web clipboard and personal drive without opening or controlling a browser. All three clients use the same scoped API keys and account quotas. The web clipboard is the site's synchronized text area; this API does not access the operating system clipboard.

## 1. Connect securely, including servers without a domain

The included CLI and MCP adapter accept HTTPS, or HTTP on `127.0.0.1`, `localhost` and `::1`. They reject remote plaintext HTTP and do not follow redirects with a credential.

For a server without a domain, open an SSH tunnel **on the computer running the agent**. Replace the SSH user, server address and final port with your deployment:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:18131:127.0.0.1:13131 USER@SERVER
```

Keep that terminal open. Open `http://127.0.0.1:18131/` in your browser, sign in, and create the API key through this encrypted tunnel. The final `13131` is the website's port **on the SSH server**; use your actual port. The first `18131` is a free local port on the agent's computer. Neither an extra public port nor a domain is needed. Use a restricted SSH account with forwarding access where available. Keep host-key verification enabled.

For agents running on the website server itself, use its loopback URL directly. For an existing HTTPS reverse proxy, use its HTTPS origin. An agent running in another container needs a tunnel or HTTPS endpoint reachable from that container; its `localhost` refers to the container.

## 2. Create a key

Open **My account → Agent access**, enter an assistant name and validity (1–365 days; default 30), select permissions, and confirm your current password. The default selections are read-only. Each account can hold at most 20 active keys. The page shows all active keys plus recent expired/revoked keys (up to 100 rows).

| Permission | Allowed operations |
| --- | --- |
| `clipboard:read` | Read the web clipboard |
| `clipboard:write` | Replace or empty the web clipboard |
| `files:read` | List folders/files, download, inspect storage usage |
| `files:upload` | Upload into the drive root or an existing owned folder |
| `files:manage` | Create/rename/move folders and move files |
| `files:delete` | Permanently delete files and folders, including nested contents |

The full key is shown once. The server stores its SHA-256 digest, not its secret. Create a separate key for each assistant. Keys never grant administration, password changes, key management, or access to another account. Supplying a user ID does not change ownership. A browser session cookie is not a substitute for the Bearer key on `/api/v1`.

Store the key in a private file **outside the directory you allow the agent to transfer**. For example, on Linux/macOS:

```bash
mkdir -p ~/.config/cliptalk
chmod 700 ~/.config/cliptalk
umask 077
read -rsp 'Paste API key: ' CLIPTALK_NEW_KEY
printf '\n'
printf '%s\n' "$CLIPTALK_NEW_KEY" > ~/.config/cliptalk/token
unset CLIPTALK_NEW_KEY
```

Do not put keys in Git, URLs, screenshots, or agent prompts. Revocation and expiry reject new requests immediately. Uploads recheck the key immediately before committing. Changing an account password revokes all its keys; changing its username keeps the same owner identity. Disabled/deleted accounts cannot use keys. API keys survive service restarts and normal upgrades.

## 3. Install the client tools

On the agent's computer, install Node.js 22 or 24, then:

```bash
git clone https://github.com/zzlkk0/ClipTalk-Workspace.git
cd ClipTalk-Workspace
npm ci --omit=dev
```

The website does not need to run on this computer. The repository contains `scripts/cliptalk.js` (CLI) and `scripts/cliptalk-mcp.js` (MCP adapter). To update this checkout, use `git pull --ff-only` and run `npm ci --omit=dev` again. Optional `npm link` registers `cliptalk` and `cliptalk-mcp` as commands; it is also fine to invoke them with `node` directly.

## 4. Use MCP

Add this **stdio** server configuration to an MCP-compatible agent. Replace every example path with an absolute local path. The node executable must be reachable by the agent; use its absolute path if necessary.

```json
{
  "mcpServers": {
    "cliptalk": {
      "command": "node",
      "args": ["/path/to/ClipTalk-Workspace/scripts/cliptalk-mcp.js"],
      "env": {
        "CLIPTALK_URL": "http://127.0.0.1:18131",
        "CLIPTALK_TOKEN_FILE": "/path/to/private/cliptalk-token",
        "CLIPTALK_LOCAL_DIR": "/path/to/agent-files"
      }
    }
  }
}
```

Create `CLIPTALK_LOCAL_DIR` before starting the adapter. It confines MCP uploads/downloads to that directory, including symlink checks; downloads create new files and refuse overwrites. If it is omitted, remote clipboard/folder/list operations work but local file transfers are unavailable. Files are transferred as streams rather than embedding large binary bodies in model messages. Local paths refer to the adapter's machine.

The adapter exposes only tools permitted by the key at startup:

`connection_info`, `read_clipboard`, `write_clipboard`, `storage_usage`, `list_files`, `list_folders`, `create_folder`, `update_folder`, `move_files`, `upload_file`, `download_file`, `delete_files`, `delete_folder`.

Deletion tools require `confirm: true`. Their descriptions and destructive-operation annotations allow the agent host to apply its approval policy; the server still enforces scopes and account ownership. Retrieved clipboard/file metadata is user content, not instructions to bypass those permissions. An adapter is not an HTTP `/mcp` endpoint: it runs locally and calls the remote HTTPS/tunneled API. Authentication failure at startup is reported on stderr without printing the key.

Example request to your assistant: “Upload the generated report to my Research folder and put a short summary in my web clipboard.” Grant `files:read`, `files:upload` and `clipboard:write`; add `files:manage` if it should create the folder itself.

## 5. Use the CLI

In a terminal on the agent's computer:

```bash
export CLIPTALK_URL=http://127.0.0.1:18131
export CLIPTALK_TOKEN_FILE="$HOME/.config/cliptalk/token"
node scripts/cliptalk.js me
node scripts/cliptalk.js clipboard get
node scripts/cliptalk.js clipboard set --text 'The report is ready.'
node scripts/cliptalk.js list
node scripts/cliptalk.js mkdir Research
node scripts/cliptalk.js upload ./report.pdf --folder FOLDER_ID
node scripts/cliptalk.js download FILE_ID ./received-report.pdf
node scripts/cliptalk.js move FILE_ID --folder FOLDER_ID
node scripts/cliptalk.js delete FILE_ID --confirm
node scripts/cliptalk.js --help
```

`FILE_ID` is the `name` field returned by upload/list, not the display filename (`originalName`). Folder IDs are returned by create/list. Omit `--folder` when uploading/moving to root. Clipboard writes also accept `--file filename` or `--stdin` instead of `--text`. CLI output is JSON, errors go to stderr and exit nonzero. A download never overwrites an existing local file. `CLIPTALK_TOKEN` is supported for secret managers that inject environment variables; `CLIPTALK_TOKEN_FILE` takes precedence.

The CLI uses the caller's local filesystem permissions. The narrower `CLIPTALK_LOCAL_DIR` boundary is enforced for MCP transfers, where file paths may be model-selected.

## 6. Call HTTP directly

Use `Authorization: Bearer <key>`. JSON writes require `Content-Type: application/json`. Base path: `/api/v1`. Examples below use the SSH tunnel:

```bash
printf 'Authorization: Bearer %s\n' "$(cat "$CLIPTALK_TOKEN_FILE")" | \
  curl --fail-with-body -H @- "$CLIPTALK_URL/api/v1/clipboard"

printf 'Authorization: Bearer %s\n' "$(cat "$CLIPTALK_TOKEN_FILE")" | \
  curl --fail-with-body -X PUT -H @- \
    -H 'Content-Type: application/json' -d '{"text":"Report ready"}' \
    "$CLIPTALK_URL/api/v1/clipboard"
```

These examples pass the credential through stdin instead of curl's command arguments. For automated use, the provided clients or your language's HTTP library are also suitable. Never log the Authorization header.

| Method and path | Scope | Input / result |
| --- | --- | --- |
| `GET /me` | Any valid key | Username, key name, scopes, expiry, request limit |
| `GET /clipboard` | `clipboard:read` | `{ "text": "…" }` |
| `PUT /clipboard` | `clipboard:write` | `{ "text": "…" }`; empty string clears it |
| `GET /storage` | `files:read` | File/text bytes, total usage and quota |
| `GET /drive?folderId=ID` | `files:read` | Current folder, breadcrumbs, child folders, files; omit folderId for root |
| `GET /folders` | `files:read` | All owned folders and parent IDs |
| `POST /folders` | `files:manage` | `{ "name": "Research", "parentId": null }`; returns ID |
| `PATCH /folders/:id` | `files:manage` | `name` and/or `parentId`; null parent moves to root |
| `DELETE /folders/:id` | `files:delete` | `{ "confirm": true }`; recursively deletes contents |
| `POST /files?folderId=ID` | `files:upload` | Multipart field `files`, up to 10 files; omit folderId for root |
| `GET /files/:name` | `files:read` | File download; URL-encode the returned file ID |
| `PATCH /files` | `files:manage` | `{ "names": ["FILE_ID"], "folderId": null }` |
| `DELETE /files` | `files:delete` | `{ "names": ["FILE_ID"], "confirm": true }` |

File limits match the website: 500 MB per file, at most 100 IDs in a move/delete batch, and the account's remaining quota. Clipboard strings are limited to 500,000 JavaScript string units, with actual UTF-8 bytes charged to quota. Folder organization and sharing follow the same rules as the website. Deleting a drive file also removes its attachment/share links; copies already received by other accounts remain.

Keys have a fixed limit of **60 requests/minute each**, persisted across restarts. There is also an API IP limit of 240 requests/minute. A `429` includes `Retry-After`; wait rather than retrying in a tight loop. Reads return `200`, folder creation `201`, and uploads `200`. Writes/deletes normally return `{ "ok": true }`. Errors return `{ "error": "code" }`: `401 invalid_agent_key`, `403 insufficient_scope`, `404 not_found`, `409 folder_exists`, `413 quota_exceeded`, or `429 too_many_requests`, among others. Browser idle disconnection does not affect these API calls.

The **Agent access** page shows the latest 1,000 authenticated API attempts per account, with key name, time, action, optional file/folder name and result. Hover over an action/result for the API route and HTTP status; durations are available in the log API. It includes denied scoped operations and failures, but never clipboard text, file bodies, passwords or key secrets. Account deletion removes its keys and logs. Keys and logs reside in `database/users.db` and are included in existing private deployment backups. Revoked/expired key metadata remains available for attribution; old private backups may contain older authorization state, so revoke keys again if restoring an old backup.
