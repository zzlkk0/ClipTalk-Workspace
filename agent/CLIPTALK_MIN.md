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

## 2. Key and transport rules

- Create the key in **My account → Agent access** with an actor (for example `SERVER`) and the scopes `project:read`, `project:write` and, for uploads, `project:circuits`.
- Store the key in a file readable only by you (`chmod 600`) and point `CLIPTALK_TOKEN_FILE` at it. The client never prints the key. Do not put it in Git, logs, messages or memory.
- Only HTTPS, or plain HTTP to `127.0.0.1`/`localhost`/`::1` (SSH tunnel), is accepted. Redirects are refused. Proxy environment variables are not used.
- For a private certificate authority set `CLIPTALK_CA_FILE=/path/to/ca.pem`.
- On `429 Too Many Requests` the client waits for `Retry-After` once and retries.

## 3. Commands

```bash
python3 cliptalk_min.py me
python3 cliptalk_min.py project state fyp
python3 cliptalk_min.py project events fyp --cursor-file ~/.cliptalk/fyp.cursor --wait 25
python3 cliptalk_min.py project messages fyp --to SERVER --since msg-12
python3 cliptalk_min.py project set-status fyp --json '{"plan":"T0","in_progress":["T0"],"blocked":[]}'
python3 cliptalk_min.py project update-task fyp T0 --status in_progress --notes "queue limit suspected"
python3 cliptalk_min.py project send fyp --to PC --type question --task I3 --body "Offset binary?"
python3 cliptalk_min.py project send fyp --to PC --type answer --thread msg-12 --file reply.md
python3 cliptalk_min.py project handoff fyp --file handoff.json
python3 cliptalk_min.py project ask fyp --task T2 --question "Ask the admin about Genus?" --option "A: contact admin" --option "B: Yosys" --recommend A --blocking
python3 cliptalk_min.py project memory-put fyp --file memory_SERVER.md
python3 cliptalk_min.py project doc-put fyp WORKFLOW_SERVER --file WORKFLOW_SERVER.md
python3 cliptalk_min.py project topology-push fyp ble_rx_chain --file topology.json
python3 cliptalk_min.py project results-push fyp ble_rx_chain --file m1_metrics.csv --candidate R60F --task M1 --evidence L2
python3 cliptalk_min.py project results-get fyp ble_rx_chain --task M1 --metric gain_dB
python3 cliptalk_min.py --help
```

Output is JSON on stdout. Errors are JSON on stderr (`error`, `status`, `detail`) with exit code 1. A `409 version_conflict` includes the current version and content in `detail`; read it, merge, and write again. When `--version` is omitted the client reads the current version first.

`events` returns changes after the cursor and waits up to `--wait` seconds (at most 25) when there are none. With `--cursor-file` it reads and saves the cursor automatically. If the reply says `"reset": true`, re-read the state and continue from the returned cursor.

## 4. Result files

`results-push` accepts CSV, JSON Lines or a JSON array. CSV columns:

| Column | Meaning |
| --- | --- |
| `candidate`, `task_id`, `case_id`, `node`, `metric`, `unit`, `status`, `evidence_level`, `supersedes` | Copied as text |
| `value` | Number; leave empty for `NATIVE_FAILED` / `BLOCKED` |
| `limit_op`, `limit_value`, `limit_ref` | Become `limit` (`>=`, `<=`, `>`, `<`, `==`) |
| `corner`, `temp_C`, `vdd_V`, `rf_Hz`, `lo_Hz`, `if_Hz`, `fs_Hz`, `gain_state`, `cond.<name>` | Become `conditions` |
| `run.<name>` | Become `run` (e.g. `run.tool`, `run.netlist_sha256`, `run.run_dir`) |

`--candidate`, `--task` and `--evidence` fill missing fields. Records are sent in batches of 500 with an `Idempotency-Key` derived from the file contents, so running the same upload again returns the first result instead of duplicating records. The Node CLI derives the same keys, so either client can retry the other's upload.

The server refuses text that looks like model cards, Liberty/LEF structures or PDK paths (`422 sensitive_content_blocked`). That check is a second line of defence: sanitize topologies and never upload PDK, model or library content (see `08_WEB_SYNC_PROTOCOL.md`, section 7).
