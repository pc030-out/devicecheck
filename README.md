# Device Lock Backend

Small Node.js service for Render deployment that stores a one-to-one mapping between `ipAddress` and `deviceID`.

## Rules

- One IP address can map to only one device ID
- One device ID can map to only one IP address
- Repeating the same IP/device pair is allowed
- Any mismatch returns `409`

## Endpoints

### `GET /health`
Returns service and database health.

### `GET /api/device-locks?deviceID=...&ipAddress=...`
Looks up an existing mapping.

### `POST /api/device-locks`
Creates or validates a mapping.

Request body:

```json
{
  "deviceID": "abc123",
  "ipAddress": "1.2.3.4"
}
```

`ipAddress` is optional if you want the backend to use the request IP.

### `GET /api/calendly/availability?startTime=ISO_DATE`
Checks if a specific time window is available for the configured Calendly event type.

### `POST /api/calendly/book`
Creates a Calendly booking directly (no Calendly-hosted UI redirect required).

Request body:

```json
{
  "email": "candidate@example.com",
  "name": "Candidate Name",
  "timeslot": "2026-05-12T17:00:00.000Z",
  "timezone": "America/New_York",
  "inviteCode": "abc123...",
  "meetingLink": "https://vizmeet.us/meeting/abc123",
  "note": "Optional note"
}
```

## Local Setup

1. Copy `.env.example` to `.env`
2. Set `DATABASE_URL`
3. Set Calendly variables if booking API is needed:
  - `CALENDLY_API_TOKEN`
  - `CALENDLY_EVENT_TYPE_URI`
  - `CALENDLY_SLOT_MINUTES` (optional, default `30`)
3. Run:

```bash
cd backend
npm install
npm run dev
```

## Generate `CALENDLY_EVENT_TYPE_URI`

Run this from the repo root after setting `CALENDLY_API_TOKEN` in `backend/.env`:

```bash
set +H && set -a && source backend/.env && set +a && node -e "const b=process.env.CALENDLY_API_BASE_URL||'https://api.calendly.com'; const t=process.env.CALENDLY_API_TOKEN; fetch(b+'/users/me',{headers:{Authorization:'Bearer '+t}}).then(r=>r.json()).then(j=>{const u=j.resource.uri; return fetch(b+'/event_types?user='+encodeURIComponent(u),{headers:{Authorization:'Bearer '+t}})}).then(r=>r.json()).then(j=>{(j.collection||[]).forEach(e=>console.log(e.name+' => '+e.uri));}).catch(console.error)"
```

Pick the URI for the event type you want (for example `30 Minute Meeting`) and set it as `CALENDLY_EVENT_TYPE_URI` in `backend/.env`.

## Render Setup

1. Create a PostgreSQL database in Render
2. Create a new Web Service from this repo
3. Set `Root Directory` to `backend`
4. Build command: `npm install`
5. Start command: `npm start`
6. Set env vars:
   - `DATABASE_URL`
   - `CORS_ORIGIN`
   - `TRUST_PROXY=true`
  - `CALENDLY_API_TOKEN`
  - `CALENDLY_EVENT_TYPE_URI`

You can also use `backend/render.yaml` as the blueprint.
