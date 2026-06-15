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
  "meetingLink": "https://staffspot.us/meeting/abc123",
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
curl --request GET \
  --url https://api.calendly.com/users/me \
  --header "authorization: Bearer your_api_token"

curl --request GET \
  --url "https://api.calendly.com/event_types?user=$USER_URI" \
  --header "authorization: Bearer $CALENDLY_API_TOKEN"
```

Example output:

```
solo  | 30 Minute Meeting                  | https://api.calendly.com/event_types/ce6b83d6-...
group | Introductory Call - Parallel Studios | https://api.calendly.com/event_types/9f1388ec-...
```

- `solo` = One-on-One event (single booking per slot)
- `group` = Group event (multiple people can book the same slot — no per-slot limit)

Copy the URI for the event type you want and set it as `CALENDLY_EVENT_TYPE_URI` in `backend/.env` and in the Render environment variables.

## Telegram Bot Setup

The `/api/phone-verification/notify` endpoint sends phone verification codes via Telegram. Follow these steps to configure your Telegram bot.

### Step 1: Create a Telegram Bot with BotFather

1. Open Telegram and search for **@BotFather** (official Telegram bot management bot)
2. Start a chat and send the command `/newbot`
3. BotFather will ask for a bot name (display name) and username
4. Example:
   - Bot name: `Phone Verification Code`
   - Username: `pvc2fa_bot` (must be unique and end with `_bot`)
5. BotFather will respond with your **Bot Token** (looks like: `123456789:ABCDEfghIjklmnoPQRstuvWXYZ...`)
6. **Save the bot token** — you'll need this for `TELEGRAM_BOT_TOKEN` environment variable

### Step 2: Get Your Chat ID

You need to pair the bot with your Telegram account and retrieve your Chat ID.

#### Method A: Using getUpdates API (Recommended)

1. Open Telegram and find your newly created bot (search for `@pvc2fa_bot` or your bot username)
2. Send any message to the bot (e.g., "hello")
3. Run this command from the repo root (replace `YOUR_BOT_TOKEN` with your actual token):

```bash
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates"
```

Example:

```bash
curl "https://api.telegram.org/bot123456789:ABCDEfghIjklmnoPQRstuvWXYZ/getUpdates"
```

4. Look for the response JSON. Find your message in the results:

```json
{
  "ok": true,
  "result": [
    {
      "update_id": 133043870,
      "message": {
        "message_id": 1,
        "chat": {
          "id": 8709207593,
          ...
        },
        "text": "hello"
      }
    }
  ]
}
```

5. Extract the **Chat ID** from `result[0].message.chat.id` (in this example: `8709207593`)
6. **Save the chat ID** — you'll need this for `TELEGRAM_CHAT_ID` environment variable

### Group Chat Mode (Notify Multiple Users)

If several users need to receive the same notification, use a Telegram group or supergroup.

1. Create a group in Telegram and add the bot
2. Send at least one message in that group
3. Call getUpdates again:

```bash
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates"
```

4. Find group updates in the response and extract the final chat ID

Example pattern for migrated groups:

```json
{
  "message": {
    "chat": { "id": -5298395497, "type": "group" },
    "migrate_to_chat_id": -1003946187399
  }
}
```

```json
{
  "message": {
    "chat": { "id": -1003946187399, "type": "supergroup" }
  }
}
```

Use the **supergroup ID** (`-100...`) as `TELEGRAM_CHAT_ID`. Do not use the old temporary group ID after migration.

Example:

```env
TELEGRAM_CHAT_ID=-1003946187399
```

Notes:

- Group/supergroup IDs are negative numbers
- If the group is upgraded, always switch to the new `migrate_to_chat_id`
- Everyone in that group can see the bot notification

#### Method B: Using Telegram Bot API Tester (Web)

1. Visit the Telegram Bot API documentation: https://core.telegram.org/bots/api-sdk
2. Alternatively, use any REST client (Postman, Insomnia) and call the getUpdates endpoint with your bot token
3. Follow the same steps as Method A to extract the chat ID

### Step 3: Configure Environment Variables

Set these two environment variables in your `backend/.env` file:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCDEfghIjklmnoPQRstuvWXYZ...
TELEGRAM_CHAT_ID=8709207593
# or group mode:
# TELEGRAM_CHAT_ID=-1003946187399
```

### Step 4: Test the Integration

Once deployed to Render, you can verify the Telegram integration is working by:

1. Triggering the phone verification flow on your frontend
2. Enter a 6-digit code in the phone verification modal
3. Check your Telegram chat with the bot for the message: `{Company} Verification Code: {code}`

Example message: `Parallel Studios Verification Code: 123456`

### Security Notes

- Keep your `TELEGRAM_BOT_TOKEN` secret — never commit it to git
- Use environment variables for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in production
- If your bot token is ever exposed, rotate it immediately by running `/revoke` command with BotFather
- The bot sends messages directly to your private Telegram chat (only reachable by you)

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
   - `TELEGRAM_BOT_TOKEN` (from BotFather)

- `TELEGRAM_CHAT_ID` (private chat ID or supergroup ID from getUpdates API)

You can also use `backend/render.yaml` as the blueprint.
