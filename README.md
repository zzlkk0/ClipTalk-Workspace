# ClipTalk Workspace

A self-hosted workspace for your clipboard, conversations and files. Each account has its own data. Sign in with the same account on multiple devices to sync in real time.

Docker is optional. You can run ClipTalk directly with Node.js, use the native installer, or choose Docker Compose.

## Features

- **Account isolation:** clipboard, chat, files, downloads and archives belong to the signed-in account. Other users, including administrators, can access a file only when its owner explicitly shares it.
- **Agent access:** create per-assistant API keys with expiry, revocation and separate clipboard/file permissions in **My account → Agent access**. Use the versioned HTTP API, bundled CLI, or local MCP adapter through HTTPS or an SSH tunnel. Keys survive upgrades; password changes revoke them. Calls are rate-limited and recorded without content or key secrets. See the [Agent setup and API guide](docs/AGENTS_API.md).
- **Device sync:** devices using the same account receive live updates through Socket.IO.
- **Personal drive:** create nested folders, rename or move folders, upload into the current folder, move files individually or in batches, and delete files or whole folders after confirmation. Upload progress and cancellation are available. Folder names support 1–120 characters, with up to 32 levels and 1,000 folders per account; file batches support up to 100 selections.
- **Clear conversations:** clear active conversations after confirmation. Existing conversation archives and drive files remain available.
- **Named conversation archives:** select a start and end date. Create, rename, view, download, restore or delete an archive. Dates include both days and use `Asia/Macau` (UTC+8). Folder organization replaces file archiving.
- **Idle connection control:** the administrator sets the page inactivity interval in system settings (default **1,800 seconds / 30 minutes**, range **5–86,400 seconds**). Idle pages disconnect from realtime sync and show **Resume connection**. Clicking it reconnects and loads current content. Settings take effect on existing connections; each device has its own inactivity timer. Receiving updates from another device does not keep an inactive page connected. This does not sign the account out or add API/upload/download timeouts.
- **Storage quotas:** every account defaults to **1 GB = 1024 MB**. Uploaded file bytes and UTF-8 text in the clipboard, conversations and legacy clipboard archives count toward the limit. Archived files still count; attachments are counted once. Administrators can adjust each account's limit in MB. Lowering a limit preserves existing data and blocks additional storage until usage is reduced.
- **Upload limits:** at most 10 files per request and 500 MB per file, within the account's remaining quota. Concurrent uploads from the same account share a quota.
- **User administration:** registration, approval, disabling accounts and password management. Administrators can create another administrator account, promote an existing active user, or revoke another administrator's access. Revoked accounts become regular users immediately, retaining their ID, password, data, quota and preferences. The initial administrator and your own administrator access cannot be revoked.
- **Languages:** Chinese and English in the workspace and sign-in pages.
- **Custom site name:** administrators can change the name next to the logo in the system settings. It also appears on sign-in, registration, account and sharing pages.
- **Personal account management:** click your username or **My account** in the admin panel to change your username or password. Additional administrators can rename themselves; the initial administrator's username is fixed, but its password and theme can be changed. Account changes sign other devices out. Self deletion requires the username and current password, removes owned workspace data and shares, and preserves at least one active administrator. The initial administrator account cannot be deleted. Previously renamed initial accounts retain their current name and protected identity on update.
- **Admin storage dashboard:** see each user's used space, percentage, remaining capacity and file/text breakdown, including archived content. Refresh usage without losing unsaved quota edits, and adjust individual limits. Administrators see usage metrics without accessing private conversations or files.
- **White and dark themes:** choose your theme in **My account**, or use the sun/moon button. Preferences are saved to your account, follow it across devices, and apply to the workspace, archive reader, sharing and admin pages. Connected workspace devices update together; other accounts keep their own preferences.
- **Archive reader:** archived conversations open in a larger chat-style window with a file sidebar, message search and a full-screen toggle.
- **File sharing:** one header button opens a separate sharing page. Share active or archived files with selected users or create a public link. Owners can change permissions and revoke links. Recipients can download or receive an independent copy into their own space.

## Sharing files

Open **File sharing** in the workspace header, choose a file, and select **Selected users** or **Public**. A selected-user link requires sign-in with an allowed account. A public link allows anyone holding it to download, and signed-in users can also browse public shares in the sharing page. Paste a link from the same website into **Enter a share link** to open it.

The original file continues to count toward its owner's quota. Receiving a file creates a separate copy in the recipient's drive root and counts toward their quota, including simultaneous receives and uploads. Moving files or folders keeps sharing links valid. Revoking a share makes its original link stop working; downloaded or received copies remain. Deleting the original drive file also invalidates its shares. Ordinary private download URLs remain owner-only.

Account deletion removes current account records and owned clipboard, messages, file bodies, archives, quotas and shares. Copies already received by other users remain theirs. Deployment backups are managed separately under the installation directory's private `backups/` folder.

## One-command native deployment — no Docker

Supported installer targets: Ubuntu/Debian and Alibaba Cloud Linux 3 with systemd, on x86_64 or arm64. Modern RHEL-compatible systems with glibc 2.28 or newer also use the RPM installation path. Run as a normal user with sudo privileges, or as root. The installer detects the OS, installs missing build tools through apt-get or dnf/yum, uses Node.js 22/24 or installs a private Node.js 22 runtime, generates a configuration, and starts a systemd service. Older systems such as Alibaba Cloud Linux 2 or CentOS 7 are rejected before package installation because their glibc is too old for the official Node.js 22 binaries.

```bash
curl -fsSL https://raw.githubusercontent.com/zzlkk0/ClipTalk-Workspace/main/deploy.sh | bash
```

Choose a port and installation directory:

```bash
curl -fsSL https://raw.githubusercontent.com/zzlkk0/ClipTalk-Workspace/main/deploy.sh \
  | bash -s -- --mode native --port 18000 --dir "$HOME/cliptalk-workspace"
```

New installations default to HTTP port **8000**. Updates automatically keep the existing port; supply `--port` only when you want to change it. The application listens on the server's interfaces; allow the chosen port in your server/network configuration, or put it behind a reverse proxy. Use HTTPS for encrypted transport.

The native service is `cliptalk-workspace.service`. A new installation defaults to `$HOME/cliptalk-workspace` for a normal user and `/opt/cliptalk-workspace` for root. Subsequent native updates discover the registered service's directory and preserve its service account, including when an installation created by a normal user is later updated as root. A new root installation uses a dedicated unprivileged `cliptalk` service account. An explicit `--dir` selects another directory; an existing native account database there retains its owner as the service account. A managed installation with a missing or empty account database blocks updates instead of silently creating new accounts.

```bash
sudo systemctl status cliptalk-workspace.service
sudo journalctl -u cliptalk-workspace.service -n 30 --no-pager
sudo systemctl restart cliptalk-workspace.service
```

Startup checks connect directly to loopback, bypassing HTTP proxy settings. If a check fails, the installer prints service status and recent logs with initial passwords hidden before rolling back. To check the running service yourself:

```bash
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:8000/api/health
```

Initial username: **admin**. A random initial password is printed only when a new administrator account is created. Read it in the first-start logs, then change it in the admin panel. Existing passwords are preserved during upgrades.

On Alibaba Cloud ECS, allow inbound TCP traffic to the chosen port (8000 by default) in the instance's security group. If an OS firewall is enabled, allow the same port there. After a successful install, open `http://YOUR_PUBLIC_IP:8000/`. The installer does not change your security group or firewall rules.

Preview installer settings without changing the server:

```bash
bash deploy.sh --dry-run --mode native --port 8000 --dir /opt/cliptalk-workspace
```

## Optional Docker deployment

Requires an existing Docker Engine and Docker Compose plugin:

```bash
curl -fsSL https://raw.githubusercontent.com/zzlkk0/ClipTalk-Workspace/main/deploy.sh \
  | bash -s -- --mode docker --port 8000
```

Or clone and run Compose directly:

```bash
git clone https://github.com/zzlkk0/ClipTalk-Workspace.git
cd ClipTalk-Workspace
docker compose up -d --build
docker compose logs app
```

Compose persists data in `./data`. Configuration and the initial administrator are generated on first startup. The container drops root privileges before serving requests.

Optional environment settings:

```bash
CLIPTALK_HTTP_PORT=18000 CLIPTALK_DATA_PATH=/srv/cliptalk-data docker compose up -d --build
```

## Manual Node.js deployment

Use Node.js 22 or 24 and npm. Linux builds may need Python, make and a C++ compiler for `better-sqlite3`.

```bash
git clone https://github.com/zzlkk0/ClipTalk-Workspace.git
cd ClipTalk-Workspace
npm ci --omit=dev
node scripts/init-config.js
npm start
```

Open port 8000. To choose a separate data directory and port:

```bash
CLIPTALK_DATA_DIR=/srv/cliptalk-data CLIPTALK_PORT=18000 node scripts/init-config.js
CLIPTALK_DATA_DIR=/srv/cliptalk-data node server.js
```

`CLIPTALK_HOST` optionally changes the listening interface. `CLIPTALK_CONFIG` optionally names an alternate configuration file. The default is `config.json` inside the data directory.

## Updating and backups

Re-run the installer with the same `--mode`. Native updates discover the existing directory automatically; supply `--dir` only to select a different directory. The existing port is preserved automatically. To switch to port 13131 once, run:

```bash
curl -fsSL https://raw.githubusercontent.com/zzlkk0/ClipTalk-Workspace/main/deploy.sh \
  | bash -s -- --port 13131
```

Later updates can omit `--port`. Native installations retain the port in `data/config.json`, including manual changes. Docker installations retain their saved host port. You can pin a branch, tag or commit with `--ref` (without slashes).

The installer builds the new release before stopping the existing application. It backs up the stopped data, activates the new release, checks `/api/health`, and restores the previous release, native service unit and completed data backup if startup fails. Installer backups are stored in the installation directory's `backups/` folder. Keep these private. Updates reuse the existing account database and show only the current startup's logs; the initial administrator prompt is shown for a new database.

For manual deployments, stop the application before copying the entire data directory. It includes:

```text
data/
  config.json             # session secret and runtime settings
  database/users.db       # accounts, password hashes and admin settings
  database/workspace.db   # per-account content, archives and quotas
  uploads/                # uploaded file bodies
```

SQLite WAL/SHM files may also exist. Copy the complete directory while stopped. A restart currently signs users out because sessions are held in memory; persisted content remains on disk.

### Moving an existing native installation's data

If an earlier installer run started a new empty installation in another directory, your original accounts and files may still be in the original directory. To keep the currently registered native installation and restore an older installation's complete data, run this helper as root:

```bash
curl -fsSL https://raw.githubusercontent.com/zzlkk0/ClipTalk-Workspace/main/scripts/migrate-native-data.py \
  | python3 - --from /path/to/old-installation --to /opt/cliptalk-workspace --port 13131
```

The destination must already be installed and its `cliptalk-workspace.service` must point there. The helper checks the source accounts, stops the destination, refuses to copy data still open by another process, backs up both complete data directories, copies the source with the destination service account's ownership, and checks startup. The original source stays in place. Failed migrations restore the destination's previous data. Backups are saved in the destination's private `backups/` directory.

This replaces the destination's complete data with the source snapshot; it does not merge two sets of accounts. The replaced destination is kept in the backup. Original account IDs, usernames, password hashes, archives, quotas, uploads and settings are retained. Sign in with the original passwords afterwards. `--port` is optional and defaults to the destination's existing port. Later installer updates reuse the registered destination directory and port.

## Migrating the previous shared workspace

Back up the old deployment first. Use its existing data directory, including `database/users.db`, `history.json` and `uploads/`, when starting this version.

On the first startup, the old shared conversations, files and clipboard are saved in an administrator-owned archive named **升级前共享区** (Previous shared workspace). Every account's active workspace starts empty. Other users cannot access this archive. The import is transactional and runs once; the legacy JSON and file bodies are preserved during import. Invalid legacy JSON stops startup so that history is not silently discarded.

## Storage behavior

- On the first drive upgrade, existing active files appear in the drive root; files in previous file archives appear in folders named after those archives. This migration runs once, keeps file bodies and original archive records, and does not change account IDs, passwords, quotas or sharing links.
- Conversation archiving moves messages out of the active workspace and keeps their storage usage. Deleting a conversation archive removes its messages; its files remain in the drive.
- Moving files between folders changes organization only, with no extra storage cost.
- Deleting drive files, including files inside a deleted folder, permanently removes their bodies, attachment links in active and archived conversations, and sharing links. Message text and copies received by other accounts remain. A confirmation explains this before deletion.
- Older clients can still use the legacy file archive/clear API. Clearing files through that API preserves attachments referenced by archived conversations. New clients use drive folders and explicit deletion.
- Quotas measure stored file bodies and text payloads, rather than SQLite database/page overhead. Backups and the original legacy JSON are outside account quotas.
- Administrators can see account usage and change capacity, while content access stays scoped to the owner's session.

## Validation

No production accounts or data are used by tests. Tests create their own temporary databases and HTTP services on random loopback ports.

Installer tests simulate Ubuntu/Debian and Alibaba Cloud Linux 3 with both dnf and yum. They mock host package and service commands while starting real temporary Node.js servers to verify installation, persistent updates, and rollback.
Native migration tests verify account and file preservation, backups, rollback, and refusal to copy active or invalid data. The helper requires Python 3.6 or newer, using only the standard library.

```bash
npm ci
node --test test/workspace-store.test.js

# Additional API, browser and installer tests:
npm install --no-save --package-lock=false socket.io-client playwright
npx playwright install chromium
node --test test/*.test.js
```

Set `CLIPTALK_CHROME` to an existing Chrome/Chromium executable if needed. GitHub Actions runs the storage, account-isolation, multi-device, browser and installer checks.

## Implementation

Node.js, Express, Socket.IO, SQLite (`better-sqlite3`), session authentication and bcrypt password hashing. Uploaded file access always checks the current account, including archived attachments. Production credentials, accounts, uploaded files and deployment-specific configuration are excluded from this repository.
