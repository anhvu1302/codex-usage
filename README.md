# Codex Usage Dashboard

Local dashboard for daily Codex token usage, per-model estimates, per-agent/subagent attribution, and persistent SQLite history.

## Setup

```bash
pnpm install
cp .env.example .env
pnpm dev
```

In development, open `http://127.0.0.1:8787` (or the `PORT` in `.env`). One Node process hosts Hono API, Vite middleware, and HMR on that port. The first server run imports `~/.codex/sessions` in the background; the **Sync now** button can rescan at any time.

Session titles use the newest matching `thread_name` in `~/.codex/session_index.jsonl`, which is the name shown in Codex. A first-user-request summary is only a fallback when no index title exists. The session drawer separately attributes usage to the main agent and each Codex subagent using JSONL metadata such as nickname, role, parent thread, and depth.

## Environment

| Variable             | Default                         | Purpose                                                       |
| -------------------- | ------------------------------- | ------------------------------------------------------------- |
| `PORT`               | `8787`                          | Local HTTP port. Set this in `.env`, for example `PORT=3000`. |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions`             | Source directory containing Codex JSONL sessions.             |
| `CODEX_USAGE_DB`     | `~/.codex-usage/codex-usage.db` | Persistent SQLite file, kept outside this repository.         |

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
pnpm verify       # format, lint, typecheck, tests, e2e, Knip and audit
```

## Production

Set the desired local port in `.env`, then run the following from the project root:

```bash
PORT=3000 pnpm prod
```

This builds React into `dist/`, then one Node process serves both the dashboard at `/` and the Hono API at `/api/*`. SQLite, session watching, import, and backfill stay in that same process. It binds only to `127.0.0.1`.

### Run in the background with PM2

```bash
pnpm pm2:start
```

PM2 runs exactly one `codex-usage` process from `build-server/index.js`. It reads `.env` from the project root, restarts after a crash or after memory exceeds 256 MB, and stores logs under `~/.pm2/logs`. `pm2 save` persists the process list for resurrection.

To also restore the saved process automatically after macOS login/reboot, run the one-time `pm2 startup` command and execute the command it prints. Run `pm2 save` again whenever the managed process list changes. See the official [PM2 startup guide](https://pm2.keymetrics.io/docs/usage/startup/).
