# Deployment Guide

This document covers the current KiCAD Prism deployment model for Docker hosting and local development.

## Runtime Overview

KiCAD Prism runs as two services:

- `backend`: FastAPI API server on port `8000`
- `frontend`: production Vite bundle served by Nginx on port `8080`

In Docker, the frontend proxies `/api/*` requests to the backend over the Compose network.

Default local endpoints:
- UI: [http://127.0.0.1:8080](http://127.0.0.1:8080)
- API: [http://127.0.0.1:8000](http://127.0.0.1:8000)

## Docker Hosting

### Prerequisites

- Docker Engine or Docker Desktop
- Docker Compose support
- enough disk space for imported repositories and generated outputs

### 1. Clone the repository

```bash
git clone https://github.com/krishna-swaroop/KiCAD-Prism.git
cd KiCAD-Prism
```

### 2. Create the root `.env`

Docker Compose reads the repository root `.env` automatically.

```bash
cp .env.example .env
```

Baseline authenticated configuration:

```env
WORKSPACE_NAME=KiCAD Prism
AUTH_ENABLED=true
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
SESSION_SECRET=replace-with-a-long-random-secret
SESSION_TTL_HOURS=12
SESSION_COOKIE_SECURE=false
ALLOWED_USERS_STR=
ALLOWED_DOMAINS_STR=
BOOTSTRAP_ADMIN_USERS_STR=admin@example.com
DEFAULT_VIEWER_DOMAINS_STR=pixxel.co.in,spacepixxel.co.in
GITHUB_TOKEN=
DEV_MODE=false
```

Generate a session secret with:

```bash
python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
```

Important:
- `SESSION_SECRET` is required whenever auth is effectively enabled.
- `SESSION_COOKIE_SECURE=true` should be used only behind HTTPS.
- `DEV_MODE` should stay `false` in Docker hosting.

### 3. Start the stack

```bash
docker compose up --build -d
```

Open the UI at [http://127.0.0.1:8080](http://127.0.0.1:8080).

### 4. Stop the stack

```bash
docker compose down
```

## Docker Volumes and Persistence

Current Compose mounts:

- `./data/projects` -> `/app/projects`
- `./data/ssh` -> `/root/.ssh`

Persisted data includes:
- imported repositories
- `.project_registry.json`
- `.rbac_roles.json`
- `.folders.json`
- exported comments JSON inside repos when generated
- SSH keys and `known_hosts`

## Authentication Modes

### Guest Mode

```env
AUTH_ENABLED=false
GOOGLE_CLIENT_ID=
SESSION_SECRET=
DEV_MODE=false
```

Behavior:
- login wall is disabled
- backend serves a guest admin session
- all visitors have full admin/designer/viewer access while auth is disabled

### Google Login + Session Auth

```env
AUTH_ENABLED=true
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
SESSION_SECRET=your-random-secret
DEFAULT_VIEWER_DOMAINS_STR=pixxel.co.in,spacepixxel.co.in
DEV_MODE=false
```

Behavior:
- frontend shows the Google sign-in screen
- backend exchanges the Google authorization code for user info
- backend issues an `HttpOnly` signed session cookie
- RBAC role resolution uses stored assignments plus bootstrap admins
- users from `DEFAULT_VIEWER_DOMAINS_STR` get implicit `viewer` access when no explicit role is stored
- on first successful login, those implicit viewers are written into `.rbac_roles.json` so admins can promote them later

### Local Dev Bypass

```env
AUTH_ENABLED=true
GOOGLE_CLIENT_ID=
SESSION_SECRET=
DEV_MODE=true
```

Behavior:
- auth is effectively disabled because the backend only enables auth when `AUTH_ENABLED=true`, `GOOGLE_CLIENT_ID` is set, and `DEV_MODE=false`
- this is convenient for local backend/frontend development

## Google OAuth Setup

Create a Google OAuth client of type "Web application" and add the frontend origins and redirect URIs you actually use.

Typical origins:
- local frontend dev: `http://127.0.0.1:5173`
- local Docker frontend: `http://127.0.0.1:8080`
- production: `https://your-domain.example`

Typical redirect URIs:
- local frontend dev: `http://127.0.0.1:5173/auth/callback`
- local Docker frontend: `http://127.0.0.1:8080/auth/callback`
- production: `https://your-domain.example/auth/callback`

Use the client ID value in `GOOGLE_CLIENT_ID` and the client secret in `GOOGLE_CLIENT_SECRET`.

If your production deployment is HTTPS, also set:

```env
SESSION_COOKIE_SECURE=true
```

## Private Repository Access

KiCAD Prism supports two normal approaches.

### SSH

Recommended for long-lived hosted deployments.

- SSH material persists under `./data/ssh`
- backend startup ensures `~/.ssh` exists and scans common Git hosts into `known_hosts`
- add the generated or mounted public key to your Git host account

### GitHub Personal Access Token

If you use HTTPS cloning for private GitHub repositories, set:

```env
GITHUB_TOKEN=your_token_here
```

The backend configures Git URL rewriting at startup so GitHub HTTPS operations can use the token.

## Local Development Hosting

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Notes:
- backend settings also support a backend-local `.env`
- if nothing is configured, local dev defaults generally keep auth off because `DEV_MODE=true`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend dev URL:
- [http://127.0.0.1:5173](http://127.0.0.1:5173)

## Operational Notes

### Rebuild after env or frontend changes

```bash
docker compose up --build -d
```

### Inspect logs

```bash
docker compose logs --tail=100 frontend
docker compose logs --tail=100 backend
```

### Session behavior

- changing `SESSION_SECRET` invalidates all existing sessions
- secure cookies require HTTPS and will not work correctly on plain HTTP if `SESSION_COOKIE_SECURE=true`

## Troubleshooting

### Blank page with frontend bundle errors

If the browser shows a blank page, open DevTools and check the first JavaScript error.

A previously observed production issue came from unsafe manual chunk splitting. If a bundle regression returns, rebuild and verify that:
- `/assets/index-*.js` loads successfully
- `/api/auth/config` returns `200`
- the first console error is captured before reloading again

### `SESSION_SECRET is not configured`

Cause:
- auth is enabled but `SESSION_SECRET` is empty

Fix:
- set `SESSION_SECRET` in the root `.env`
- rebuild/restart the stack

### Google sign-in not appearing

Check:
- `AUTH_ENABLED=true`
- `GOOGLE_CLIENT_ID` is set
- `DEV_MODE=false`
- browser origin is listed in the Google OAuth configuration

### Login works but API requests fail after deploy

Check:
- `SESSION_COOKIE_SECURE` matches your transport mode
- HTTPS termination is configured correctly if using secure cookies
- browser is not blocking cookies for the deployed origin

### Imported repositories disappear after restart

Check that `./data/projects` is mounted and writable on the host.

## Related Docs

- [../README.md](../README.md)
- [./KICAD-PRJ-REPO-STRUCTURE.md](./KICAD-PRJ-REPO-STRUCTURE.md)
- [./PATH-MAPPING.md](./PATH-MAPPING.md)
