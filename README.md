# ClipTalk Workspace

A self-hosted workspace for your clipboard, conversations and files. Each account has its own data. Sign in with the same account on multiple devices to sync in real time.

Docker is optional. You can run ClipTalk directly with Node.js, use the native installer, or choose Docker Compose.

## Features

- **Account isolation:** clipboard, chat, files, downloads and archives belong to the signed-in account. Other users, including administrators, cannot read that account's content through the application.
- **Device sync:** devices using the same account receive live updates through Socket.IO.
- **Clear active content:** clear conversations or files after confirmation. Existing archives remain available.
- **Named date archives:** select a start date, end date and content type. Create, rename, view, download, restore or delete an archive. Dates include both days and use `Asia/Macau` (UTC+8).
- **Storage quotas:** every account defaults to **1 GB = 1024 MB**. Uploaded file bytes and UTF-8 text in the clipboard, conversations and legacy clipboard archives count toward the limit. Archived files still count; attachments are counted once. Administrators can adjust each account's limit in MB. Lowering a limit preserves existing data and blocks additional storage until usage is reduced.
- **Upload limits:** at most 10 files per request and 500 MB per file, within the account's remaining quota. Concurrent uploads from the same account share a quota.
- **User administration:** registration, approval, disabling accounts and password management.
- **Languages:** Chinese and English in the workspace and sign-in pages.

## One-command native deployment — no Docker

Supported installer targets: Ubuntu/Debian with systemd, on x86_64 or arm64. Run as a normal user with sudo privileges, or as root. The installer downloads source, installs missing build tools, uses Node.js 22/24 or installs a private Node.js 22 runtime, generates a configuration, and starts a systemd service.

```bash
curl -fsSL https://raw.githubusercontent.com/zzlkk0/ClipTalk-Workspace/main/deploy.sh | bash
```

Choose a port and installation directory:

```bash
curl -fsSL https://raw.githubusercontent.com/zzlkk0/ClipTalk-Workspace/main/deploy.sh \
  | bash -s -- --mode native --port 18000 --dir "$HOME/cliptalk-workspace"
```

The default HTTP port is **8000**. The application listens on the server's interfaces; allow the chosen port in your server/network configuration, or put it behind a reverse proxy. Use HTTPS for encrypted transport.

The native service is `cliptalk-workspace.service`. The default directory is `$HOME/cliptalk-workspace` for a normal user and `/opt/cliptalk-workspace` for root. Root installation uses a dedicated unprivileged `cliptalk` service account.

```bash
sudo systemctl status cliptalk-workspace.service
sudo journalctl -u cliptalk-workspace.service -n 30 --no-pager
sudo systemctl restart cliptalk-workspace.service
```

Initial username: **admin**. A random initial password is printed only when a new administrator account is created. Read it in the first-start logs, then change it in the admin panel. Existing passwords are preserved during upgrades.

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

Re-run the installer with the same `--mode`, `--dir` and `--port`. You can pin a branch, tag or commit with `--ref` (without slashes).

The installer builds the new release before stopping the existing application. It backs up the stopped data, activates the new release, checks `/api/health`, and restores the previous release and completed data backup if startup fails. Installer backups are stored in the installation directory's `backups/` folder. Keep these private.

For manual deployments, stop the application before copying the entire data directory. It includes:

```text
data/
  config.json             # session secret and runtime settings
  database/users.db       # accounts, password hashes and admin settings
  database/workspace.db   # per-account content, archives and quotas
  uploads/                # uploaded file bodies
```

SQLite WAL/SHM files may also exist. Copy the complete directory while stopped. A restart currently signs users out because sessions are held in memory; persisted content remains on disk.

## Migrating the previous shared workspace

Back up the old deployment first. Use its existing data directory, including `database/users.db`, `history.json` and `uploads/`, when starting this version.

On the first startup, the old shared conversations, files and clipboard are saved in an administrator-owned archive named **升级前共享区** (Previous shared workspace). Every account's active workspace starts empty. Other users cannot access this archive. The import is transactional and runs once; the legacy JSON and file bodies are preserved during import. Invalid legacy JSON stops startup so that history is not silently discarded.

## Storage behavior

- Archiving moves records out of the active workspace and keeps their storage usage.
- Clearing files removes active file entries and their active chat attachment links. Attachments referenced by archived conversations remain available and still count toward storage.
- Deleting an archive removes its records. File bodies are removed when no active or archived record still references them.
- Quotas measure stored file bodies and text payloads, rather than SQLite database/page overhead. Backups and the original legacy JSON are outside account quotas.
- Administrators can see account usage and change capacity, while content access stays scoped to the owner's session.

## Validation

No production accounts or data are used by tests. Tests create their own temporary databases and HTTP services on random loopback ports.

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
