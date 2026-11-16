const fs = require('node:fs/promises');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { createPool, initializeDatabase, normalizeRecord, readSnapshot } = require('../server');

function encryptionKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error('TNT_BACKUP_KEY must be a base64-encoded 32-byte encryption key.');
  }
  return Buffer.from(value, 'base64');
}

function encryptBackup(backup, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(backup), 'utf8'), cipher.final()]);
  return JSON.stringify({ format: 'tnt-encrypted-backup', version: 1, algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}

function decryptBackup(encrypted, key) {
  const envelope = JSON.parse(encrypted);
  if (envelope.format !== 'tnt-encrypted-backup' || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted backup format.');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
}

function validateBackup(backup) {
  if (backup.format !== 'tnt-tax-tracker' || backup.version !== 1 ||
      !Array.isArray(backup.expenses) || !Array.isArray(backup.sales)) {
    throw new Error('Unsupported backup format.');
  }
  return {
    expenses: backup.expenses.map(item => normalizeRecord(item, 'expense')),
    sales: backup.sales.map(item => normalizeRecord(item, 'sale'))
  };
}

async function restoreBackup(pool, backup) {
  const records = validateBackup(backup);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE expenses, sales IN EXCLUSIVE MODE');
    const existing = await client.query('SELECT (SELECT count(*) FROM expenses) + (SELECT count(*) FROM sales) AS count');
    if (Number(existing.rows[0].count) !== 0) {
      throw new Error('Restore requires an empty target database. Existing records will not be overwritten.');
    }
    for (const table of ['expenses', 'sales']) {
      const fields = table === 'expenses'
        ? ['id','date','amount','category','description','type']
        : ['id','date','amount','description','type'];
      for (const item of records[table]) {
        await client.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i+1}`).join(',')})`, fields.map(field => item[field]));
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (!['export','restore'].includes(command) || !file) throw new Error('Usage: node scripts/database-backup.js export|restore FILE');
  const key = process.env.TNT_BACKUP_KEY;
  encryptionKey(key);
  const pool = createPool();
  try {
    if (command === 'export') {
      const backup = { format:'tnt-tax-tracker', version:1, exportedAt:new Date().toISOString(), ...await readSnapshot(pool) };
      validateBackup(backup);
      const encrypted = encryptBackup(backup, key);
      // Verify the complete authenticated round-trip before saving/uploading an artifact.
      if (JSON.stringify(decryptBackup(encrypted, key)) !== JSON.stringify(backup)) throw new Error('Backup verification failed.');
      await fs.writeFile(file, encrypted, { mode:0o600, flag:'wx' });
      console.log('Encrypted database backup created and verified.');
    } else {
      const contents = await fs.readFile(file, 'utf8');
      const envelope = JSON.parse(contents);
      const backup = envelope.format === 'tnt-encrypted-backup' ? decryptBackup(contents, key) : envelope;
      validateBackup(backup);
      await initializeDatabase(pool);
      await restoreBackup(pool, backup);
      console.log('Backup restored to the empty target database.');
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch(error => {
  console.error('Backup operation failed:', error.code || error.message);
  process.exitCode = 1;
});
module.exports = { encryptBackup, decryptBackup, validateBackup, restoreBackup };
