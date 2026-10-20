#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

mode=native
port=8000
port_explicit=0
dir_explicit=0
repo=zzlkk0/ClipTalk-Workspace
ref=main
dry_run=0
if [[ $(id -u) == 0 ]]; then install_dir=/opt/cliptalk-workspace; else install_dir="${HOME}/cliptalk-workspace"; fi
usage() {
  cat <<'HELP'
Usage: bash deploy.sh [--mode native|docker] [--port 8000] [--dir PATH] [--ref main] [--dry-run]

Default: native Node.js + systemd, without Docker, on Ubuntu/Debian or Alibaba Cloud Linux 3.
New installations use port 8000. Updates keep the existing port unless --port is supplied.
Native updates reuse the installed systemd service's directory and service account.
Native mode installs a private Node.js 22 runtime if Node.js 22/24 is unavailable.
Docker mode requires an existing Docker Engine and Compose plugin.
Re-run the same command to update. Existing account data and passwords are kept.
A stopped-data backup and startup check run before an update is accepted.
HELP
}
while (($#)); do
  case "$1" in
    --mode|--port|--dir|--ref)
      if (($#<2)); then printf 'Missing value for %s\n' "$1" >&2; exit 2; fi
      case "$1" in --mode) mode=$2;; --port) port=$2; port_explicit=1;; --dir) install_dir=$2; dir_explicit=1;; --ref) ref=$2;; esac
      shift 2;;
    --dry-run) dry_run=1; shift;;
    --help|-h) usage; exit 0;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2;;
  esac
done
[[ "$mode" == native || "$mode" == docker ]] || { printf 'Mode must be native or docker.\n' >&2; exit 2; }
[[ "$ref" =~ ^[a-zA-Z0-9._-]+$ ]] || { printf 'Use a branch, tag or commit without slashes.\n' >&2; exit 2; }
service=cliptalk-workspace.service
unit_path="/etc/systemd/system/$service"
installed_dir=''
installed_user=''
if [[ "$mode" == native && -f "$unit_path" ]]; then
  installed_cwd=''
  installed_data=''
  while IFS= read -r line; do
    case "$line" in
      WorkingDirectory=*) installed_cwd=${line#WorkingDirectory=};;
      Environment=CLIPTALK_DATA_DIR=*) installed_data=${line#Environment=CLIPTALK_DATA_DIR=};;
      User=*) installed_user=${line#User=};;
    esac
  done < "$unit_path"
  if [[ "$installed_cwd" == /*/current && "$installed_data" == "${installed_cwd%/current}/data" ]]; then
    installed_dir=${installed_cwd%/current}
    if ((!dir_explicit)); then install_dir=$installed_dir; fi
  elif ((!dir_explicit)); then
    printf 'The existing native service uses custom paths. Supply --dir for its intended installation; no files were changed.\n' >&2; exit 1
  fi
fi
[[ "$install_dir" == /* && "$install_dir" != / && "$install_dir" != *[$'\n\r\t %"\\']* ]] || { printf 'Choose an absolute installation path without whitespace or special characters.\n' >&2; exit 2; }
accounts_preexisting=0
if [[ -s "$install_dir/data/database/users.db" ]]; then accounts_preexisting=1; fi
if [[ "$mode" == docker && -f "$install_dir/.deployment-mode" ]]; then
  # A Docker bind mount may belong to the container UID, rather than this user.
  accounts_preexisting=1
fi
if [[ "$mode" == native && -f "$install_dir/.deployment-mode" ]] && ((!accounts_preexisting)); then
  printf 'The existing account database is missing or empty: %s/data/database/users.db. Update stopped without creating new accounts; restore the existing data first.\n' "$install_dir" >&2; exit 1
fi
if ((!port_explicit)); then
  saved_port=''
  # Native config is authoritative, including ports changed by hand. Docker's
  # config contains the container port, so reuse its saved host port instead.
  if [[ "$mode" == native && -f "$install_dir/data/config.json" ]]; then
    command -v python3 >/dev/null || { printf 'Reading the existing native port requires Python 3. Install it or supply --port explicitly.\n' >&2; exit 1; }
    if ! saved_port=$(python3 - "$install_dir/data/config.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as source:
        config = json.load(source)
    port = config.get('port')
    if port is not None:
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('Invalid configured port')
        print(port)
except (OSError, ValueError, AttributeError):
    print('Cannot read the existing port from data/config.json; configuration was not changed.', file=sys.stderr)
    sys.exit(1)
PY
    ); then exit 1; fi
  fi
  if [[ -z "$saved_port" && -f "$install_dir/.port" ]]; then saved_port=$(cat "$install_dir/.port"); fi
  if [[ -n "$saved_port" ]]; then port=$saved_port; fi
fi
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port>=1 && 10#$port<=65535)) || { printf 'Invalid port.\n' >&2; exit 2; }
port=$((10#$port))
if ((dry_run)); then
  printf 'Plan only: mode=%s port=%s directory=%s ref=%s\n' "$mode" "$port" "$install_dir" "$ref"
  printf 'No files, packages, containers or services were changed.\n'
  exit 0
fi
[[ $(uname -s) == Linux ]] || { printf 'The installer supports Linux servers.\n' >&2; exit 1; }
privilege=()
if [[ $(id -u) != 0 ]]; then
  command -v sudo >/dev/null || { printf 'sudo is required for server setup.\n' >&2; exit 1; }
  privilege=(sudo)
fi
if [[ -f "$install_dir/.deployment-mode" && $(cat "$install_dir/.deployment-mode") != "$mode" ]]; then
  printf 'This installation uses another mode. Choose a different --dir to deploy another instance.\n' >&2; exit 1
fi
printf 'Using installation directory: %s\n' "$install_dir"
if [[ "$mode" == native ]]; then
  [[ -f /etc/os-release && -d /run/systemd/system ]] || { printf 'Native installation requires Linux with systemd and /etc/os-release.\n' >&2; exit 1; }
  # Alibaba Cloud Linux uses the RHEL package family, rather than apt.
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *' debian '*|*' ubuntu '*) package_family=debian; package_manager=apt-get;;
    *' alinux '*|*' anolis '*|*' rhel '*|*' fedora '*|*' centos '*|*' rocky '*|*' almalinux '*)
      package_family=rpm
      if command -v dnf >/dev/null; then package_manager=dnf; else package_manager=yum; fi;;
    *) printf 'Unsupported native system: %s. Supported: Ubuntu/Debian and modern RHEL-compatible systems, including Alibaba Cloud Linux 3.\n' "${PRETTY_NAME:-${ID:-unknown}}" >&2; exit 1;;
  esac
  command -v "$package_manager" >/dev/null || { printf 'Required package manager is unavailable: %s\n' "$package_manager" >&2; exit 1; }
  glibc_version=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
  glibc_version=${glibc_version##* }
  if [[ ! "$glibc_version" =~ ^([0-9]+)\.([0-9]+)$ ]] || ((BASH_REMATCH[1]<2 || (BASH_REMATCH[1]==2 && BASH_REMATCH[2]<28))); then
    printf 'Native Node.js 22 requires glibc 2.28 or newer. This system reports %s. Use Alibaba Cloud Linux 3 or a newer supported OS.\n' "${glibc_version:-unknown}" >&2; exit 1
  fi
  printf 'Detected %s; package manager: %s.\n' "${PRETTY_NAME:-${ID:-Linux}}" "$package_manager"
  printf 'Checking native dependencies (curl, xz, Python and C++ build tools)...\n'
  missing=0
  for executable in curl xz python3 make g++ tar sha256sum; do command -v "$executable" >/dev/null || missing=1; done
  if [[ $(id -u) == 0 ]]; then
    for executable in useradd runuser nologin; do command -v "$executable" >/dev/null || missing=1; done
  fi
  if ((missing)); then
    if [[ "$package_family" == debian ]]; then
      "${privilege[@]}" "$package_manager" update
      "${privilege[@]}" "$package_manager" install -y curl ca-certificates xz-utils python3 make g++ tar coreutils util-linux passwd
    else
      "${privilege[@]}" "$package_manager" install -y curl ca-certificates xz python3 make gcc-c++ tar coreutils util-linux shadow-utils
    fi
  fi
else
  command -v curl >/dev/null || { printf 'Install curl first.\n' >&2; exit 1; }
  command -v docker >/dev/null || { printf 'Docker is optional. Install Docker and Compose, or use --mode native.\n' >&2; exit 1; }
  docker_cmd=(docker)
  if ! docker info >/dev/null 2>&1; then docker_cmd=("${privilege[@]}" docker); fi
  "${docker_cmd[@]}" info >/dev/null
  "${docker_cmd[@]}" compose version >/dev/null
fi
if [[ "$mode" == native && $(id -u) == 0 ]]; then
  account=cliptalk
  previous_account=''
  if [[ "$install_dir" == "$installed_dir" && -n "$installed_user" ]]; then
    previous_account=$installed_user
  elif ((accounts_preexisting)); then
    # An explicit --dir can recover another existing installation. Its database
    # owner must retain access through private parent directories under /home.
    previous_account=$(stat -c %U "$install_dir/data/database/users.db")
  fi
  if [[ -n "$previous_account" ]]; then
    id "$previous_account" >/dev/null 2>&1 || { printf 'The existing service account is unavailable: %s. No application files were changed.\n' "$previous_account" >&2; exit 1; }
    if [[ $(id -u "$previous_account") != 0 ]]; then account=$previous_account; fi
  fi
  id "$account" >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/cliptalk --shell "$(command -v nologin)" "$account"
else account=$(id -un); fi
if [[ "$mode" == native ]]; then printf 'Native service account: %s\n' "$account"; fi
mkdir -p "$install_dir/releases" "$install_dir/backups"
work_dir=$(mktemp -d)
previous_unit=0
if [[ "$mode" == native && -f "$unit_path" ]]; then
  cp "$unit_path" "$work_dir/previous-unit"
  previous_unit=1
fi
release_dir="$install_dir/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$release_dir"
old_release=''
if [[ -L "$install_dir/current" ]]; then old_release=$(readlink -f "$install_dir/current"); fi
activated=0
backup_dir=''
export CLIPTALK_HTTP_PORT="$port" CLIPTALK_DATA_PATH="$install_dir/data"
compose() { "${docker_cmd[@]}" compose --project-name cliptalk-workspace --file "$1/compose.yaml" "${@:2}"; }
stop_app() {
  if [[ "$mode" == native ]]; then "${privilege[@]}" systemctl stop "$service"; else compose "$1" stop app; fi
}
startup_diagnostics() {
  # Capture the failed release's logs before rollback restarts the old release.
  printf 'Service status and recent logs (passwords redacted):\n' >&2
  {
    if [[ "$mode" == native ]]; then
      "${privilege[@]}" systemctl status "$service" --no-pager -l || true
      "${privilege[@]}" journalctl -u "$service" --since "$startup_since_native" -n 80 --no-pager || true
    else
      compose "$release_dir" logs --since "$startup_since_docker" --no-color --tail 80 app || true
    fi
  } 2>&1 | sed -E 's/(密码:[[:space:]]*).*/\1[redacted]/; s/([Pp]assword:[[:space:]]*).*/\1[redacted]/' >&2 || true
}
rollback() {
  local status=$?
  set +e
  if ((status!=0 && activated)); then
    printf 'Startup failed; rolling back the application and stopped-data backup.\n' >&2
    stop_app "$release_dir" || true
    if [[ -n "$backup_dir" && -f "$backup_dir/data.tar.gz" ]]; then
      mv "$install_dir/data" "$backup_dir/failed-data" || true
      tar -xzf "$backup_dir/data.tar.gz" -C "$install_dir"
    fi
    if [[ -n "$old_release" ]]; then
      ln -sfn "$old_release" "$install_dir/current"
    fi
    if [[ "$mode" == native ]]; then
      if ((previous_unit)); then
        "${privilege[@]}" install -D -m 0644 "$work_dir/previous-unit" "$unit_path" || true
        "${privilege[@]}" systemctl daemon-reload || true
      fi
      if [[ -n "$old_release" ]] || ((previous_unit)); then "${privilege[@]}" systemctl restart "$service" || true; fi
    elif [[ -n "$old_release" ]]; then
      compose "$old_release" up -d --no-build || true
    fi
  fi
  rm -rf "$work_dir"
  exit "$status"
}
trap rollback EXIT
printf 'Downloading %s (%s)...\n' "$repo" "$ref"
curl -fL --retry 3 "https://api.github.com/repos/$repo/tarball/$ref" -o "$work_dir/source.tar.gz"
if tar -tzf "$work_dir/source.tar.gz" | awk '/^\// || /(^|\/)\.\.($|\/)/ {bad=1} END {exit !bad}'; then
  printf 'Unsafe archive paths.\n' >&2; exit 1
fi
tar -xzf "$work_dir/source.tar.gz" --strip-components=1 -C "$release_dir"
for required in server.js workspace-store.js sharing-store.js quota-storage.js drive-store.js connection-policy.js package-lock.json; do [[ -f "$release_dir/$required" ]] || { printf 'Incomplete release.\n' >&2; exit 1; }; done

if [[ "$mode" == native ]]; then
  node_bin=''
  if command -v node >/dev/null && command -v npm >/dev/null; then
    major=$(node -p 'process.versions.node.split(".")[0]')
    if [[ "$major" == 22 || "$major" == 24 ]]; then
      candidate_node=$(command -v node)
      if [[ $(id -u) != 0 ]] || runuser -u "$account" -- "$candidate_node" -v >/dev/null 2>&1; then
        node_bin=$(dirname "$candidate_node")
      fi
    fi
  fi
  if [[ -z "$node_bin" ]]; then
    runtime_dir="$install_dir/.runtime/node22"
    if [[ ! -x "$runtime_dir/bin/node" ]]; then
      case $(uname -m) in x86_64) architecture=x64;; aarch64|arm64) architecture=arm64;; *) printf 'Supported architectures: x86_64 and arm64.\n' >&2; exit 1;; esac
      curl -fsSL --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$work_dir/SHASUMS256.txt"
      node_archive=$(awk -v suffix="-linux-$architecture.tar.xz" '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-/ && substr($2,length($2)-length(suffix)+1)==suffix {print $2;exit}' "$work_dir/SHASUMS256.txt")
      [[ -n "$node_archive" ]] || { printf 'Node.js release was not found.\n' >&2; exit 1; }
      curl -fL --retry 3 "https://nodejs.org/dist/latest-v22.x/$node_archive" -o "$work_dir/$node_archive"
      awk -v name="$node_archive" '$2==name' "$work_dir/SHASUMS256.txt" > "$work_dir/node.sha256"
      (cd "$work_dir" && sha256sum -c node.sha256)
      mkdir -p "$runtime_dir"
      tar -xJf "$work_dir/$node_archive" --strip-components=1 -C "$runtime_dir"
    fi
    node_bin="$runtime_dir/bin"
  fi
  [[ -x "$node_bin/node" && -x "$node_bin/npm" ]] || { printf 'Node.js and npm must use the same installation.\n' >&2; exit 1; }
  if [[ $(id -u) == 0 ]]; then chown -R "$account:$(id -gn "$account")" "$install_dir"; fi
  run_app() { if [[ $(id -u) == 0 ]]; then runuser -u "$account" -- "$@"; else "$@"; fi; }
  (cd "$release_dir" && run_app env PATH="$node_bin:$PATH" "$node_bin/npm" ci --omit=dev --no-audit --no-fund)
  "$node_bin/node" --check "$release_dir/server.js"
else
  compose "$release_dir" build
fi

# Build completes before the existing application is stopped.
if [[ -n "$old_release" ]]; then
  stop_app "$old_release"
  activated=1
  backup_dir="$install_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$backup_dir"
  if [[ -d "$install_dir/data" ]]; then tar -czf "$backup_dir/data.tar.gz.tmp" -C "$install_dir" data && mv "$backup_dir/data.tar.gz.tmp" "$backup_dir/data.tar.gz"; fi
fi
mkdir -p "$install_dir/data"
if [[ "$mode" == native ]]; then
  if [[ $(id -u) == 0 ]]; then chown -R "$account:$(id -gn "$account")" "$install_dir/data"; fi
  run_app env CLIPTALK_DATA_DIR="$install_dir/data" CLIPTALK_PORT="$port" "$node_bin/node" "$release_dir/scripts/init-config.js"
  cat > "$work_dir/$service" <<UNIT
[Unit]
Description=ClipTalk personal workspace
After=network.target
[Service]
Type=simple
User=$account
WorkingDirectory=$install_dir/current
Environment=CLIPTALK_DATA_DIR=$install_dir/data
ExecStart=$node_bin/node $install_dir/current/server.js
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$install_dir/data
[Install]
WantedBy=multi-user.target
UNIT
  # Replacing the global service changes the running installation even when
  # this explicitly selected directory has no previous release of its own.
  activated=1
  "${privilege[@]}" install -D -m 0644 "$work_dir/$service" "$unit_path"
  "${privilege[@]}" systemctl daemon-reload
fi
ln -sfn "$release_dir" "$install_dir/current"
activated=1
startup_since_native=$(date '+%Y-%m-%d %H:%M:%S')
startup_since_docker=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
if [[ "$mode" == native ]]; then
  "${privilege[@]}" systemctl enable "$service"
  "${privilege[@]}" systemctl restart "$service"
else compose "$release_dir" up -d --no-build; fi
healthy=0
for attempt in $(seq 1 30); do
  # A loopback check must not go through HTTP_PROXY/ALL_PROXY.
  if curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$port/api/health" 2>"$work_dir/health-error" | tr -d '[:space:]' | grep -q '"ok":true'; then healthy=1; break; fi
  sleep 1
done
if ((!healthy)); then
  printf 'Startup health check failed for http://127.0.0.1:%s/api/health.\n' "$port" >&2
  if [[ -s "$work_dir/health-error" ]]; then cat "$work_dir/health-error" >&2; fi
  startup_diagnostics
  exit 1
fi
printf '%s\n' "$mode" > "$install_dir/.deployment-mode"
printf '%s\n' "$port" > "$install_dir/.port"
activated=0
printf '\nClipTalk is ready on port %s. Open http://YOUR_SERVER:%s/\n' "$port" "$port"
if ((accounts_preexisting)); then
  printf 'Existing account database reused. Stored accounts and passwords are kept.\n'
else
  printf 'New account database initialized. Initial username: admin; its random password is in this startup log.\n'
fi
if [[ "$mode" == native ]]; then
  printf 'Service: %s\n' "$service"
  "${privilege[@]}" journalctl -u "$service" --since "$startup_since_native" -n 18 --no-pager
else compose "$release_dir" logs --since "$startup_since_docker" --tail 18 app; fi
printf 'Data directory: %s/data\n' "$install_dir"
if [[ -n "$backup_dir" ]]; then printf 'Previous data backup: %s\n' "$backup_dir"; fi
