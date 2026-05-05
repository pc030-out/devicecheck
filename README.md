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

## Local Setup

1. Copy `.env.example` to `.env`
2. Set `DATABASE_URL`
3. Run:

```bash
cd backend
npm install
npm run dev
```

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

You can also use `backend/render.yaml` as the blueprint.
