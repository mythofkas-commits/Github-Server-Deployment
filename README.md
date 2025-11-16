## Deployment Dashboard

Self-hosted deployment platform that lets you import GitHub repositories, run structured deploy pipelines, manage releases, and inspect logs from a single dashboard. The backend exposes a JSON API under `/deployer/api` and the React frontend lives at `/deployer`.

### Features

- GitHub import with validation, optional runtime/command overrides, and per-project configuration stored on disk.
- Deployment engine with steps for git sync, install, test, build, release, nginx reload, and PM2 restarts.
- Release management (`current`/`previous` symlinks) so rollback is a single API call.
- API endpoints for triggering deploys, listing deployment history, pulling logs, and rolling back.
- Frontend dashboard that shows live deployment status, history, log viewer modal, and rollback button.

### Backend

The API lives under `api/` (Node 20). Environment variables (`api/.env`):

| Variable | Description |
| --- | --- |
| `PORT` | Port to listen on (default `3001`) |
| `PROJECTS_DIR` | Root for per-project data (`/var/deploy/projects`) |
| `LOGS_DIR` | Deployment logs root (`/var/deploy/logs`) |
| `BUILD_DIR` | Temporary build scratch dir |
| `NGINX_ROOT` | Base directory allowed for deploy paths (`/var/www`) |
| `NGINX_SITES_AVAILABLE` / `NGINX_SITES_ENABLED` | nginx config directories |
| `PM2_BIN` | pm2 executable (default `pm2`) |
| `MAX_CONCURRENT_DEPLOYS` | Number of concurrent deploys (default `1`) |
| `GITHUB_TOKEN`, `GITHUB_USERNAME` | Used for GitHub operations |

Run locally:

```bash
cd api
npm install
PORT=3002 node server.js
```

Systemd/PM2 service should run `PORT=3002 node server.js` and nginx must proxy `/deployer/api` to it.

### Frontend

The React app sits in `frontend/`. Key env var:

- `REACT_APP_API_BASE` – API base (e.g. `http://localhost:3002/api`). Defaults to `/deployer/api` in production and `http://localhost:3002/api` when served from `localhost`.

Build/run:

```bash
cd frontend
npm install
npm start # dev
npm run build # production bundle
```

### Workflow

1. Use “Import Project” in the UI to register a GitHub repo. Advanced options let you specify install/test/start commands, runtime (static vs node), domain, port, build directory, and environment variables (KEY=VALUE per line).
2. Click “Deploy” to trigger `POST /api/projects/:id/deploy`. The backend queues the job, streams logs to `/var/deploy/logs/<project>/<deployment>.log`, and exposes progress via `GET /api/deployments/:deploymentId`.
3. View deployment history + logs from the project detail screen. Logs open in a modal that pulls `GET /api/deployments/:id/log`.
4. Roll back using “Rollback” which calls `POST /api/projects/:id/rollback` to flip symlinks, reload nginx, and restart PM2 for node runtimes.

### Rollback & Releases

- Releases live under `/var/deploy/projects/<id>/releases/<timestamp-commit>` with `current` and `previous` symlinks.
- The backend symlinks `deployPath` (default `/var/www/<id>`) to the `current` release.
- Rollbacks simply point `current` back at the `previous` symlink and reload nginx / pm2.

### Deployment APIs

- `POST /api/projects/:projectId/deploy` → `{ deploymentId, status }`
- `GET /api/deployments/:deploymentId` → metadata (steps, timestamps, commit)
- `GET /api/deployments/:deploymentId/log` → log text
- `GET /api/projects/:projectId/deployments?limit=10`
- `POST /api/projects/:projectId/rollback`

Use these endpoints if you want to integrate other tooling or automate deployments without the UI.

### Project Configuration API

- `GET /api/projects/:projectId` – returns the stored configuration for the project (repo, branch, commands, runtime, env, etc.).
- `PATCH /api/projects/:projectId` – partial updates for editable fields:
  - `name`, `description`
  - `repoUrl`, `branch`
  - `buildCommand`, `buildOutput`, `installCommand`, `testCommand`, `startCommand`
  - `deployPath`, `target`, `runtime`, `domain`, `port`
  - `env` (object keyed by env var names)
- The frontend Settings tabs call these endpoints so any changes you save in the UI are persisted and used for future deployments.

### Env Vars & Secrets

- Every project can define env vars from the Advanced tab.
- Toggle “Secret” to mark an env var as sensitive:
  - Values are encrypted with `SECRETS_MASTER_KEY` (AES-256-GCM) and never stored or logged in plaintext.
  - After saving, secrets appear as “set” but their values are hidden; entering a new value rotates the secret.
  - Secrets cannot be converted back to plain env vars—delete and recreate them if needed.
- Non-secret env vars remain editable/visible, stored in plaintext like before.
- During deploys and pm2 restarts, all env vars (including decrypted secrets) are injected into the process environment without touching disk.

### Diagnostics & Safety

- **SECRETS_MASTER_KEY** must be set (and should be a strong random string) before using secrets in production. The API refuses to start in production if it’s missing.
- Run `npm run doctor:secrets` inside `api/` to scan all stored projects. It verifies that each secret env var is encrypted and decryptable (without printing the value).
- Run `npm run inspect:runtime-env -- <project-id>` (or `node api/scripts/inspectRuntimeEnv.js <project-id>`) to list the runtime env keys that will be injected for a project—useful sanity check before deployments.
- Run `npm run doctor:backend` to perform a full platform health check. It validates registry data, filesystem/git state, nginx configs, pm2 processes, and deployment history/log presence for every project, summarizing OK/WARN/ERROR statuses without touching secrets.
- Diagnostics never output plaintext secrets; they only report structural issues so you can fix them before exposing the dashboard to real workloads.
