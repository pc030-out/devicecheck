import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_locks (
      id BIGSERIAL PRIMARY KEY,
      ip_address TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Keep one-device-per-IP while allowing the same device across many IPs.
  await pool.query('ALTER TABLE device_locks DROP CONSTRAINT IF EXISTS device_locks_device_id_key');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_device_locks_device_id ON device_locks (device_id)');
}

export async function closeDatabase() {
  await pool.end();
}
