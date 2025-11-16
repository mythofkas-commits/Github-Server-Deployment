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
| `MAX_QUEUE_SIZE` | Maximum queued deployments waiting for workers (default `50`) |
| `GITHUB_TOKEN`, `GITHUB_USERNAME` | Used for GitHub operations |
| `ADMIN_USERNAME` | Login username for the dashboard/API (default `admin`) |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of the admin password (generate via `node -e "console.log(require('bcryptjs').hashSync('super-secret', 12))"`) |
| `SESSION_SECRET` | Secret used to sign the JWT session cookie |
| `ALLOWED_ORIGIN` | Browser origin allowed to call the API (e.g. `http://localhost:5173`) |
| `USERS_FILE` | Path to the JSON file that stores regular user accounts (`./data/users.json` by default) |

Run locally:

```bash
cd api
npm install
PORT=3002 node server.js
```

Systemd/PM2 service should run `PORT=3002 node server.js` and nginx must proxy `/deployer/api` to it.

### Security & Auth

- Every dashboard/API call (except `/api/health`) now requires a single-admin login. The backend compares the username/password sent to `/api/auth/login` against `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` (bcryptjs).
- Successful logins receive a signed JWT baked into a `httpOnly` cookie; the frontend always sends it via `credentials: "include"`.
- `SESSION_SECRET` must be a long random string. Rotate it to invalidate existing sessions.
- `ALLOWED_ORIGIN` pins CORS to the React dashboard origin. Browsers from any other origin receive `403` and cannot attach cookies.
- Always serve the dashboard/API over HTTPS (the auth cookie is `secure` in production) and remember that deploy/test scripts still execute with full system privileges—only trusted admins should get credentials.
- Project build/deploy paths are normalized so user input cannot escape the checked-out repo or configured nginx root.

#### Admin credential wizard

- Run `cd api && npm run setup:admin` the first time you deploy (or anytime you need to rotate admin secrets).
- The wizard prompts for the admin username, password (stored as a bcrypt hash), and session secret, then safely writes them into `api/.env`.
- Existing values are detected; you can choose to keep or regenerate them, so there's no need to manually edit `.env` for these keys anymore.

### Users & authentication

- Admin remains env-based—you are the only platform admin and still use `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` for privileged access (diagnostics, full project visibility, etc.).
- Regular users can self-serve by signing up through the dashboard (or calling `POST /api/users/signup`). Accounts are stored in `USERS_FILE` with bcryptjs hashes.
- Each project record now tracks an `ownerId`. The API enforces ACLs across **all** project/deploy/log routes so users can only see and operate on their own projects, while admins retain full visibility.
- Signups/login share the same JWT cookie/session infrastructure so the frontend can seamlessly switch between admin and user roles.

### Command templates

- Regular users pick from predefined command templates (see `api/lib/commandTemplates.js`) instead of entering arbitrary shell commands.
- Templates such as **Node App (npm)** (`npm ci`, `npm run build`, `npm start`) or **Static SPA (npm)** (`npm ci`, `npm run build`) map cleanly onto the deploy pipeline.
- Admins can still configure fully custom install/build/test/start commands, or optionally assign a template and then override commands as needed.
- The deploy engine enforces templates for user-owned projects, ensuring untrusted users cannot run arbitrary host commands.

### Rate limiting & abuse controls

- The API applies a general rate limit of ~200 requests per 5 minutes per IP plus a stricter deploy/rollback limit (10 requests per 5 minutes). Bursts return `429` with a JSON error.
- Deploy queueing is bounded by `MAX_QUEUE_SIZE`. When the in-memory queue plus active jobs reaches this threshold, new deployments are rejected so one rogue project cannot exhaust memory.
- Login and signup endpoints are separately rate-limited to slow down brute-force attempts.

### Security notes

- Build/install/test/start commands run with the full privileges of the deploy user—treat every project as trusted code or isolate the server network-wise. There is no container/VM sandbox in this phase.
- Deploy paths and build outputs are normalized + constrained to the repo/`NGINX_ROOT`, but they still write to the host filesystem. Always review project configuration before granting access.
- Multi-user support is designed for small groups/teams; harden with HTTPS, firewalls, and monitoring before exposing to untrusted networks.

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

### Testing

- Start the backend (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `ALLOWED_ORIGIN`) and frontend, then confirm the login screen appears. Invalid credentials must produce a 401, valid credentials should unlock the dashboard and cookie session.
- Hit any protected endpoint (e.g. `GET /api/projects`) without cookies and verify it returns 401; repeat from an unapproved origin and confirm CORS blocks it.
- Attempt to configure a project with a malicious `../` build output or deploy path outside `NGINX_ROOT` and ensure the API refuses to save/deploy it.
- Hammer `/api/projects/:id/deploy` more than 10x in five minutes or enqueue more deployments than `MAX_QUEUE_SIZE` to confirm the API returns 429 and the queue stays bounded.
- Run the diagnostics (`npm run doctor:secrets`, `npm run doctor:backend`) to ensure they still pass after the auth changes.
