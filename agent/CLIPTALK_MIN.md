# cliptalk_min.py — project client for machines without Node.js 22

`agent/cliptalk_min.py` uses only the Python standard library and runs on Python 3.6 or newer, so it works on older RHEL/CentOS EDA servers. Its commands and options are the same as `node scripts/cliptalk.js project ...`. Copy the single file to the server; nothing needs to be installed.

## 1. Test the connection first

Copy `scripts/check-connectivity.py` as well and run it once:

```bash
export CLIPTALK_URL=https://your-site.example        # or http://127.0.0.1:18131 through an SSH tunnel
export CLIPTALK_TOKEN_FILE="$HOME/.config/cliptalk/token"
python3 check-connectivity.py --project fyp            # add --write-test to post one test message
```

It checks DNS, TCP, TLS, `/api/health`, the key and project access, one step per line. It only reports: it never tries proxies, tunnels or other ways around network restrictions. If a step fails on a school network, ask the network administrators whether access is allowed; do not work around it.

## 2. Key, name and transport rules

- Create the key in **My account → Agent access** with `project:read` and `project:write`. One key can serve several agents: each agent sets its own name with `--as NAME` or `CLIPTALK_AGENT_NAME` (sent as `X-Agent-Name`).
- Store the key in a file readable only by you (`chmod 600`) and point `CLIPTALK_TOKEN_FILE` at it. The client never prints the key.
- Only HTTPS, or plain HTTP to `127.0.0.1`/`localhost`/`::1` (SSH tunnel), is accepted. Redirects are refused. Proxy environment variables are not used.
- For a private certificate authority (e.g. a server installed with `deploy.sh --https-ip`) copy its `data/tls/ca.pem` and set `CLIPTALK_CA_FILE=/path/to/ca.pem`.
- If the client refuses a connection, stop and report it. Do not send the key with curl or your own code to a remote `http://` address, and do not disable certificate checks.
- On `429 Too Many Requests` the client waits for `Retry-After` once and retries.

## 3. Commands

```bash
export CLIPTALK_AGENT_NAME=server1
python3 cliptalk_min.py project state demo
python3 cliptalk_min.py project file-get demo RULES.md
python3 cliptalk_min.py project file-get demo GUIDE.md
python3 cliptalk_min.py project events demo --cursor-file ~/.cliptalk/demo.cursor --wait 25
python3 cliptalk_min.py project messages demo --to server1
python3 cliptalk_min.py project send demo --to PC1 --type question --body "Which corners?"
python3 cliptalk_min.py project set-status demo --json '{"plan":"T1","in_progress":["T1"],"blocked":[]}'
python3 cliptalk_min.py project summary demo --text "Corner sweep half done"
python3 cliptalk_min.py project file-put demo agents/server1.md --file intro.md
python3 cliptalk_min.py project upload demo deliverables/T1 ./gain.csv ./plot.png
python3 cliptalk_min.py project task-add demo T4 --title "Noise sweep" --owner server1
python3 cliptalk_min.py project ask demo --question "Delete old runs?" --option yes --option no --blocking
python3 cliptalk_min.py project records-push demo rx --file metrics.csv --candidate R1 --task T1
python3 cliptalk_min.py --help
```

Output is JSON on stdout. Errors are JSON on stderr (`error`, `status`, `detail`) with exit code 1. A `409 version_conflict` includes the current version in `detail`. When `--version` is omitted the client reads the current version first. `events` waits up to `--wait` seconds (at most 25); with `--cursor-file` it saves the cursor; `"reset": true` means re-read the state.

## 4. Result files

`records-push` accepts CSV, JSON Lines or a JSON array. CSV columns:

| Column | Meaning |
| --- | --- |
| `candidate`, `task_id`, `case_id`, `node`, `metric`, `unit`, `status`, `evidence_level`, `supersedes` | Copied as text |
| `value` | Number; leave empty for `NATIVE_FAILED` / `BLOCKED` |
| `limit_op`, `limit_value`, `limit_ref` | Become `limit` (`>=`, `<=`, `>`, `<`, `==`) |
| `corner`, `temp_C`, `vdd_V`, `rf_Hz`, `lo_Hz`, `if_Hz`, `fs_Hz`, `gain_state`, `cond.<name>` | Become `conditions` |
| `run.<name>` | Become `run` (e.g. `run.tool`, `run.netlist_sha256`, `run.run_dir`) |

`--candidate`, `--task` and `--evidence` fill missing fields. Records are sent in batches of 500 with an `Idempotency-Key` derived from the file contents, so running the same upload again returns the first result instead of duplicating records. The Node CLI derives the same keys, so either client can retry the other's upload.

The server refuses text that looks like model cards, Liberty/LEF structures or PDK paths (`422 sensitive_content_blocked`). That check is a second line of defence: sanitize topologies and never upload PDK, model or library content (see `08_WEB_SYNC_PROTOCOL.md`, section 7).
