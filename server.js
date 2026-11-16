const express = require('express');
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');

const COLUMNS = {
  expenses: "id, to_char(date, 'YYYY-MM-DD') AS date, amount::float8 AS amount, category, description, type",
  sales: "id, to_char(date, 'YYYY-MM-DD') AS date, amount::float8 AS amount, description, type"
};

function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required. Refusing to start without persistent storage.');
  }
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  pool.on('error', error => console.error('Database connection error:', error.code || 'unavailable'));
  return pool;
}

async function initializeDatabase(pool) {
  // Startup must fail if either table cannot be created/read. There is no temporary store.
  await pool.query(`CREATE TABLE IF NOT EXISTS expenses (
    id VARCHAR(36) PRIMARY KEY,
    date DATE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    category VARCHAR(255),
    description TEXT,
    type VARCHAR(20)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sales (
    id VARCHAR(36) PRIMARY KEY,
    date DATE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    description TEXT,
    type VARCHAR(20)
  )`);
  await pool.query('SELECT id FROM expenses LIMIT 0');
  await pool.query('SELECT id FROM sales LIMIT 0');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizeRecord(record, type) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw httpError(400, 'A record is required.');
  }
  const id = record.id === undefined ? randomUUID() : record.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 36) {
    throw httpError(400, 'Invalid record ID.');
  }
  const date = record.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw httpError(400, 'Enter a valid date.');
  }
  const amount = Number(record.amount);
  if (!['number', 'string'].includes(typeof record.amount) || !Number.isFinite(amount) ||
      amount <= 0 || amount > 99999999.99 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
    throw httpError(400, 'Enter a positive amount with no more than two decimal places.');
  }
  const description = record.description ?? '';
  if (typeof description !== 'string' || description.length > 10000) {
    throw httpError(400, 'Description must be text of at most 10,000 characters.');
  }
  const item = { id, date, amount, description, type };
  if (type === 'expense') {
    if (typeof record.category !== 'string' || !record.category.trim() || record.category.length > 255) {
      throw httpError(400, 'Select an expense category.');
    }
    item.category = record.category;
  }
  return item;
}

async function readSnapshot(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const expenses = await client.query(`SELECT ${COLUMNS.expenses} FROM expenses ORDER BY date DESC, id`);
    const sales = await client.query(`SELECT ${COLUMNS.sales} FROM sales ORDER BY date DESC, id`);
    await client.query('COMMIT');
    return { expenses: expenses.rows, sales: sales.rows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function backupStatus(runs, now = Date.now()) {
  const success = runs.find(run => run.conclusion === 'success' && Number.isFinite(Date.parse(run.updated_at)));
  const completed = runs.find(run => run.status === 'completed');
  const lastSuccessfulBackup = success?.updated_at || null;
  const latestRunFailed = Boolean(completed && completed.conclusion !== 'success');
  return {
    healthy: Boolean(lastSuccessfulBackup && now - Date.parse(lastSuccessfulBackup) < 8 * 60 * 60 * 1000 && !latestRunFailed),
    lastSuccessfulBackup,
    latestRunFailed,
    url: 'https://github.com/dragongirl322/TNT-TaxTrack/actions/workflows/database-backup.yml'
  };
}

function createApp(pool) {
  if (!pool) throw new Error('A PostgreSQL pool is required.');
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json());
  const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  let backupCache;
  app.get('/api/backup-status', async (_req, res) => {
    try {
      if (!backupCache || Date.now() - backupCache.checkedAt > 5 * 60 * 1000) {
        // Public workflow metadata only. No database records or secrets are sent to this API.
        const response = await fetch('https://api.github.com/repos/dragongirl322/TNT-TaxTrack/actions/workflows/database-backup.yml/runs?per_page=20', {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TNT-Tax-Tracker' },
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error('Backup status unavailable');
        const data = await response.json();
        if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid backup status');
        backupCache = { checkedAt: Date.now(), runs: data.workflow_runs };
      }
      res.json(backupStatus(backupCache.runs));
    } catch {
      res.status(502).json({ error: 'Automatic backup status could not be checked.' });
    }
  });

  app.get('/api/health', route(async (_req, res) => {
    await pool.query('SELECT id FROM expenses LIMIT 0');
    await pool.query('SELECT id FROM sales LIMIT 0');
    res.json({ ok: true, storage: 'postgresql' });
  }));

  for (const [table, type] of [['expenses', 'expense'], ['sales', 'sale']]) {
    const columns = COLUMNS[table];
    app.get(`/api/${table}`, route(async (_req, res) => {
      const result = await pool.query(`SELECT ${columns} FROM ${table} ORDER BY date DESC, id`);
      res.json(result.rows);
    }));

    app.post(`/api/${table}`, route(async (req, res) => {
      const item = normalizeRecord(req.body, type);
      const fields = table === 'expenses'
        ? ['id', 'date', 'amount', 'category', 'description', 'type']
        : ['id', 'date', 'amount', 'description', 'type'];
      const result = await pool.query(
        `INSERT INTO ${table} (${fields.join(', ')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (id) DO NOTHING RETURNING ${columns}`,
        fields.map(field => item[field])
      );
      if (result.rowCount) return res.status(201).json(result.rows[0]);
      // Retrying the same save is safe, but reusing an ID must never overwrite other data.
      const existing = await pool.query(`SELECT ${columns} FROM ${table} WHERE id = $1`, [item.id]);
      if (existing.rowCount && fields.every(field => existing.rows[0][field] === item[field])) {
        return res.json(existing.rows[0]);
      }
      throw httpError(409, 'This record ID already exists with different details. Reload before saving again.');
    }));

    app.put(`/api/${table}/:id`, route(async (req, res) => {
      const item = normalizeRecord({ ...req.body, id: req.params.id }, type);
      const fields = table === 'expenses'
        ? ['date', 'amount', 'category', 'description', 'type']
        : ['date', 'amount', 'description', 'type'];
      const result = await pool.query(
        `UPDATE ${table} SET ${fields.map((field, i) => `${field} = $${i + 1}`).join(', ')}
         WHERE id = $${fields.length + 1} RETURNING ${columns}`,
        [...fields.map(field => item[field]), item.id]
      );
      if (!result.rowCount) throw httpError(404, 'Record not found.');
      res.json(result.rows[0]);
    }));

    app.delete(`/api/${table}/:id`, route(async (req, res) => {
      const result = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
      if (!result.rowCount) throw httpError(404, 'Record not found.');
      res.status(204).end();
    }));
  }

  app.get('/api/summary', route(async (_req, res) => res.json(await readSnapshot(pool))));
  app.get('/api/backup', route(async (_req, res) => {
    const snapshot = await readSnapshot(pool);
    const exportedAt = new Date().toISOString();
    res.attachment(`tnt-tax-tracker-${exportedAt.slice(0, 10)}.json`);
    res.json({ format: 'tnt-tax-tracker', version: 1, exportedAt, ...snapshot });
  }));

  // Only serve the app; database exports and operational files must never be public files.
  app.get(['/', '/index.html'], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root: __dirname });
  });
  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, _next) => {
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 503;
    console.error(`${req.method} ${req.path}:`, error.code || (status < 500 ? error.message : 'database unavailable'));
    res.status(status).json({ error: status < 500 ? error.message :
      'Database unavailable. Your request could not be confirmed. Keep your entry and retry when the connection is restored.' });
  });
  return app;
}

async function start() {
  let pool;
  try {
    pool = createPool();
    await initializeDatabase(pool);
    const server = createApp(pool).listen(process.env.PORT || 3000, () => {
      console.log('TNT Tax Tracker is using PostgreSQL persistent storage.');
    });
    const shutdown = () => {
      server.close(async () => { await pool.end(); process.exit(0); });
      setTimeout(() => process.exit(1), 15000).unref();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    return server;
  } catch (error) {
    console.error('Startup failed:', pool ? error.code || 'database unavailable' : error.message);
    if (pool) await pool.end();
    process.exitCode = 1;
  }
}

if (require.main === module) start();
module.exports = { createApp, createPool, initializeDatabase, normalizeRecord, readSnapshot, backupStatus };
