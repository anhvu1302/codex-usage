# Codex Usage Dashboard

Local dashboard for daily Codex token usage, per-model estimates, per-agent/subagent attribution, and persistent SQLite history.

## Setup (macOS, Linux and Windows)

Use Node.js 24 and pnpm 11. Install dependencies on the target operating system; do not copy `node_modules` between macOS and Windows because SQLite and build tooling use platform-specific binaries.

macOS/Linux:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Windows PowerShell:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm dev
```

In development, open `http://127.0.0.1:8787` (or the `PORT` in `.env`). One Node process hosts Hono API, Vite middleware, and HMR on that port. The first server run inventories the `sessions` directory under `CODEX_HOME` in the background. A watcher imports normal appends quickly, a full metadata inventory repairs missed watcher events every 15 minutes by default, and **Sync now** starts that same fast inventory on demand. **Deep verify** is the explicit, slower option that rereads every JSONL from the beginning without changing source files.

Session titles use the newest matching `thread_name` in `session_index.jsonl` under `CODEX_HOME`, which is the name shown in Codex. A first-user-request summary is only a fallback when no index title exists. The session drawer separately attributes usage to the main agent and each Codex subagent using JSONL metadata such as nickname, role, parent thread, and depth.

## Storage retention

SQLite uses tiered retention while preserving totals, model breakdown and estimated cost:

- Last 30 calendar days: raw usage events and full session/subagent drill-down.
- Days 31–90: hourly rollups by model and main/subagent.
- Older than 90 days: daily rollups by model and main/subagent, retained forever.

Compaction runs once after startup and daily at 03:15 Asia/Ho_Chi_Minh. It is transactional, retains a permanent dedupe ledger, and can also be triggered from the Storage card with **Compact now**. The app only reads the Codex sessions directory; it never deletes, moves or compresses Codex JSONL files.

## Environment

| Variable                            | Default                               | Purpose                                                                                  |
| ----------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`                              | `8787`                                | Local HTTP port. Set this in `.env`, for example `PORT=3000`.                            |
| `CODEX_HOME`                        | Current user's `.codex` directory     | Codex data root; the app reads sessions and the session title index.                     |
| `CODEX_SESSIONS_DIR`                | `<CODEX_HOME>/sessions`               | Optional override for the directory containing Codex JSONL sessions.                     |
| `CODEX_USAGE_DB`                    | Current user's `.codex-usage` DB file | Persistent SQLite file, kept outside this repository.                                    |
| `CODEX_USAGE_SCAN_INTERVAL_MINUTES` | `15`                                  | Full metadata inventory cadence, as an integer from 1–1440; invalid values fall back 15. |

On Windows the defaults resolve through the current user profile, for example `C:\Users\VanAnh\.codex\sessions` and `C:\Users\VanAnh\.codex-usage\codex-usage.db`. When writing paths in `.env`, forward slashes such as `C:/Users/VanAnh/.codex` avoid escaping issues.

The server only binds to `127.0.0.1`; it is not exposed to the local network.

## Commands

```bash
pnpm dev          # one Node process: Hono API + Vite HMR
pnpm build
pnpm start        # runs one production Hono/SQLite/React Node process
pnpm prod         # build then run the one production process
pnpm pm2:start    # build, start/restart the background process, then persist it
pnpm pm2:restart  # rebuild and restart the existing PM2 process
pnpm pm2:status   # inspect the codex-usage process
pnpm pm2:logs     # follow logs (Ctrl+C only exits the log viewer)
pnpm pm2:stop     # stop without removing the PM2 entry
pnpm pm2:delete   # remove the PM2 entry and update the saved process list
pnpm repair       # reclassifies inferable unknown events and backfills configured rate cards
pnpm benchmark:importer -- --files 5000 --changed-percent 1
pnpm verify       # format, lint, typecheck, tests, e2e, Knip and audit
```

## Production

Set the desired local port in `.env`, then run the following from the project root on any supported operating system:

```bash
pnpm prod
```

This builds React into `dist/`, then one Node process serves both the dashboard at `/` and the Hono API at `/api/*`. SQLite, session watching, import, and backfill stay in that same process. It binds only to `127.0.0.1`.

### Run in the background with PM2

```bash
pnpm pm2:start
```

PM2 runs exactly one `codex-usage` process from `build-server/index.js`. It reads `.env` from the project root, including `CODEX_USAGE_SCAN_INTERVAL_MINUTES`, restarts after a crash or after memory exceeds 256 MB, and stores logs in the current user's `.pm2/logs` directory. `pm2 save` persists the process list for resurrection. Scheduled inventories use metadata fast-paths; a full content reread only runs after an explicit **Deep verify** request.

Before the first production restart that applies the source-metadata migration, back up the SQLite database. The migration only adds nullable columns and never touches source JSONL. After rollout, run **Deep verify** once from Data Health to establish a full verification baseline, then watch scan duration, read/skip counts, and process RSS for 24–72 hours. If an inventory fails, the last complete source-size snapshot and imported history remain available; retry with **Sync now** or let the next scheduled inventory run.

On macOS/Linux, restore the saved process automatically after login/reboot by running the one-time `pnpm exec pm2 startup` command and executing the command it prints. Run `pnpm exec pm2 save` again whenever the managed process list changes.

Native Windows is supported by the same app and ecosystem file. PM2 does not provide a native Windows startup generator, so use the Windows installer linked by the official [PM2 startup guide](https://pm2.keymetrics.io/docs/usage/startup/) if the process must survive logout/reboot. The ecosystem enables PM2's message-based graceful shutdown because Unix signals are not available on Windows. Starting, restarting, viewing status and logs still use the same `pnpm pm2:*` commands shown above.
