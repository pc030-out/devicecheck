import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { closeDatabase, initializeDatabase, pool } from './db.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const trustProxy = process.env.TRUST_PROXY === 'true';
const DEVICE_LOCK_ENDPOINT = '/kO17zP1jS9sKyN4pXvL5gL5mG5xR3nW6bY0D8uF3iK99kT2wB8ftVaV26r7qZ0M3xJmQ4cH1e2-device-lock';
const DEVICE_LOCK_ROUTE_PATHS = ['/api/device-locks', DEVICE_LOCK_ENDPOINT];

if (trustProxy) {
  app.set('trust proxy', true);
}

app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean) || true,
}));
app.use(express.json());

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
  const ipAddress = normalizeIpAddress(typeof req.query.ipAddress === 'string' ? req.query.ipAddress : getClientIp(req));

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
      return res.status(404).json({ result: false, status: 'mapping not found' });
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
    return res.status(500).json({ result: false, status: 'failed to fetch mapping' });
  }
});

app.post(DEVICE_LOCK_ROUTE_PATHS, async (req, res) => {
  const deviceID = normalizeDeviceId(req.body?.deviceID);
  const ipAddress = normalizeIpAddress(req.body?.ipAddress || getClientIp(req));

  if (!deviceID) {
    return res.status(400).json({ result: false, status: 'deviceID is required' });
  }

  if (!ipAddress) {
    return res.status(400).json({ result: false, status: 'ipAddress could not be determined' });
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
    return res.status(500).json({ result: false, status: 'failed to save mapping' });
  } finally {
    client.release();
  }
});

async function startServer() {
  await initializeDatabase();

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
