# Render Deployment — Full Setup Guide

This guide walks through deploying the **device-lock backend** on [Render](https://render.com), including a PostgreSQL database and a Node.js web service.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Repository Setup](#2-repository-setup)
3. [Create a PostgreSQL Database](#3-create-a-postgresql-database)
4. [Create a Web Service](#4-create-a-web-service)
5. [Link the Database to the Web Service](#5-link-the-database-to-the-web-service)
6. [Environment Variables](#6-environment-variables)
7. [Deploy and Verify](#7-deploy-and-verify)
8. [Alternative: Blueprint (render.yaml)](#8-alternative-blueprint-renderyaml)
9. [Local Development](#9-local-development)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

- A [Render](https://render.com) account (free tier is sufficient)
- Your code pushed to a **GitHub** or **GitLab** repository
- The backend lives in the `backend/` subfolder of the repo

---

## 2. Repository Setup

Make sure the repo has the following structure under `backend/`:

```
backend/
  src/
    server.js
    db.js
  package.json
  render.yaml        ← optional (used for Blueprint deploy)
  .env.example
```

The `package.json` must have a `start` script:

```json
"scripts": {
  "start": "node src/server.js",
  "dev": "node --watch src/server.js"
}
```

Push all changes to your default branch (e.g. `main`) before continuing.

---

## 3. Create a PostgreSQL Database

### Step-by-step

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New +** → **PostgreSQL**
3. Fill in the form:

   | Field                  | Value                                      |
   | ---------------------- | ------------------------------------------ |
   | **Name**               | `device-lock-db` (or any name you prefer)  |
   | **Database**           | `device_lock`                              |
   | **User**               | leave as auto-generated                    |
   | **Region**             | choose the same region as your web service |
   | **PostgreSQL Version** | `16` (latest stable)                       |
   | **Plan**               | `Free`                                     |

4. Click **Create Database**
5. Wait ~1 minute for provisioning

### After creation — save the connection strings

On the database's dashboard page scroll down to **Connections**. You will see two connection strings:

| Name                      | When to use                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Internal Database URL** | Use this for the web service on Render (same network, faster, no SSL overhead) |
| **External Database URL** | Use this for local development or tools like DBeaver                           |

Copy and save both — you will need them in the steps below.

> **Free tier note:** The free PostgreSQL database **expires after 90 days**. Render will send an email reminder before it is deleted. You must create a new database and update your `DATABASE_URL` env var before that date.

---

## 4. Create a Web Service

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New +** → **Web Service**
3. Connect your GitHub/GitLab account if not already connected
4. Select your repository from the list
5. Fill in the form:

   | Field              | Value                                        |
   | ------------------ | -------------------------------------------- |
   | **Name**           | `princegd-device-lock-backend` (or any name) |
   | **Region**         | Same region as your database                 |
   | **Branch**         | `main`                                       |
   | **Root Directory** | `backend`                                    |
   | **Runtime**        | `Node`                                       |
   | **Build Command**  | `npm install`                                |
   | **Start Command**  | `npm start`                                  |
   | **Plan**           | `Free`                                       |

6. Scroll down to **Advanced** and add environment variables (see [Section 6](#6-environment-variables))
7. Click **Create Web Service**

> **Free tier note:** The free web service **spins down after 15 minutes of inactivity**. The first request after spin-down can take 30–50 seconds. Paid plans stay always-on.

---

## 5. Link the Database to the Web Service

You can connect the database to the web service in two ways:

### Option A — Manually copy Internal Database URL

1. Open your **database** page on Render
2. Copy the **Internal Database URL**
3. Open your **web service** page on Render → **Environment** tab
4. Add env var: `DATABASE_URL` = `<paste Internal Database URL>`

### Option B — Use Render's "Connected Services" feature

1. Open your **web service** → **Environment** tab
2. Click **Link existing database**
3. Select your `device-lock-db` database
4. Render will automatically inject `DATABASE_URL` into the service at runtime

---

## 6. Environment Variables

Set these on the web service under **Environment** → **Environment Variables**:

| Variable       | Value                                 | Notes                                                                                    |
| -------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL` | `<Internal Database URL from Render>` | Required. Auto-set if you link the database.                                             |
| `CORS_ORIGIN`  | `https://yourdomain.com`              | Required. The frontend origin allowed to call this API. Comma-separate multiple origins. |
| `TRUST_PROXY`  | `true`                                | Required on Render. Enables correct IP extraction from `x-forwarded-for`.                |
| `NODE_VERSION` | `20`                                  | Optional. Ensures the right Node version is used.                                        |
| `PORT`         | _(leave blank)_                       | Render sets this automatically. Do not override it.                                      |

### Example `CORS_ORIGIN` values

```
# Single origin
CORS_ORIGIN=https://slothr.us

# Multiple origins (comma-separated)
CORS_ORIGIN=https://slothr.us,https://www.slothr.us
```

---

## 7. Deploy and Verify

### Trigger a deploy

Render auto-deploys when you push to the connected branch. You can also manually trigger one:

1. Open your web service on Render
2. Click **Manual Deploy** → **Deploy latest commit**

### Watch the build logs

Click the **Logs** tab on the web service. A successful startup looks like:

```
==> Starting service with 'npm start'
Server running on port 10000
Database initialized successfully
```

### Verify with the health endpoint

Once deployed, visit (or `curl`) your service URL:

```
https://your-service-name.onrender.com/health
```

Expected response:

```json
{
  "result": true,
  "status": "ok"
}
```

If the database is unreachable you will get:

```json
{
  "result": false,
  "status": "database unavailable"
}
```

### Test the device-lock endpoint

```bash
curl -X POST https://your-service-name.onrender.com/api/device-locks \
  -H "Content-Type: application/json" \
  -d '{"deviceID": "test-device-abc"}'
```

Expected success response:

```json
{
  "result": true,
  "status": "device lock registered"
}
```

---

## 8. Alternative: Blueprint (render.yaml)

`render.yaml` lets you create and configure all Render resources from a single file. The backend already includes one at `backend/render.yaml`:

```yaml
services:
  - type: web
    name: princegd-device-lock-backend
    runtime: node
    rootDir: backend
    plan: starter
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: NODE_VERSION
        value: 20
      - key: DATABASE_URL
        sync: false
      - key: CORS_ORIGIN
        sync: false
      - key: TRUST_PROXY
        value: true
    healthCheckPath: /health
```

### To deploy via Blueprint

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New +** → **Blueprint**
3. Select your repository
4. Render detects `render.yaml` and shows a preview of resources to create
5. Fill in the `sync: false` env vars (`DATABASE_URL`, `CORS_ORIGIN`) when prompted
6. Click **Apply**

> Note: `render.yaml` in this project does **not** include the database definition. Create the database manually (Section 3) first and then paste its Internal URL as `DATABASE_URL` in the Blueprint prompt.

---

## 9. Local Development

1. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env`:

   ```env
   PORT=3001
   DATABASE_URL=postgresql://postgres:password@localhost:5432/device_lock_db
   CORS_ORIGIN=http://localhost:5173
   TRUST_PROXY=true
   ```

3. Start a local PostgreSQL instance (or point `DATABASE_URL` to the Render external URL for quick testing)

4. Install dependencies and run:

   ```bash
   cd backend
   npm install
   npm run dev
   ```

5. The server restarts automatically on file changes (`--watch` flag)

### Connecting DBeaver to Render Postgres

1. Open DBeaver → New Connection → PostgreSQL
2. Switch to the **URL** tab
3. Paste the **External Database URL** from Render
4. Set **SSL** → Mode: `require`
5. Click **Test Connection** → **Finish**

---

## 10. Troubleshooting

### "Application failed to respond"

- Check the **Logs** tab for startup errors
- Make sure `DATABASE_URL` is set correctly
- Confirm `npm start` runs without errors locally

### "database unavailable" from `/health`

- The `DATABASE_URL` is wrong or pointing to the internal URL from outside Render's network (use the external URL locally, internal URL on Render)
- The free Postgres instance may have expired — check its status on the Render dashboard

### IP address always shows as `::1` or `127.0.0.1`

- `TRUST_PROXY` is not set to `true`
- Render routes traffic through a proxy — without `trust proxy`, Express sees only the proxy IP, not the real client IP

### CORS errors in the browser

- Double-check `CORS_ORIGIN` exactly matches your frontend origin (including `https://`, no trailing slash)
- Restart the web service after changing env vars (Render auto-restarts, but you can also trigger a manual deploy)

### Auto-deploy not triggering

- Make sure the connected branch in Render matches the branch you are pushing to
- Check that the GitHub/GitLab integration has access to the repository (Render → Settings → Repository)

### Free tier spin-down (slow first request)

- This is expected on the free plan — the service sleeps after 15 minutes of no traffic
- To keep it warm you can ping `/health` on a schedule (e.g., a free cron job on [cron-job.org](https://cron-job.org))
- Upgrade to a paid plan ($7/month Starter) to eliminate spin-down entirely
