const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createApp, createPool, normalizeRecord, backupStatus } = require('../server');
const { encryptBackup, decryptBackup } = require('../scripts/database-backup');

test('missing database configuration refuses startup instead of accepting temporary saves', () => {
  assert.throws(() => createPool(''), /persistent storage/);
  const result = spawnSync(process.execPath, ['server.js'], { cwd:require('node:path').join(__dirname,'..'), env:{...process.env,DATABASE_URL:''},encoding:'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to start/);
});

test('unavailable database returns errors rather than empty data or successful writes', async t => {
  const unavailable = { query:async () => { throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'}); }, connect:async () => { throw new Error('offline'); } };
  const server = createApp(unavailable).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const route of ['/api/health','/api/expenses','/api/sales','/api/summary','/api/backup']) {
    const response = await fetch(base+route);
    assert.equal(response.status,503);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.match((await response.json()).error,/Database unavailable/);
  }
  const response=await fetch(base+'/api/expenses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date:'2026-01-01',amount:10,category:'Rent'})});
  assert.equal(response.status,503);
  assert.equal((await fetch(base+'/server.js')).status,404);
});

test('records validate dates and amounts before saving', () => {
  const valid={date:'2026-01-01',amount:1.23,category:'Rent'};
  assert.equal(normalizeRecord(valid,'expense').amount,1.23);
  for(const changes of [{date:'2026-02-30'},{date:'wrong'},{amount:-1},{amount:0},{amount:Infinity},{amount:1.234},{amount:null},{category:''}]) {
    assert.throws(()=>normalizeRecord({...valid,...changes},'expense'));
  }
});

test('encrypted backups round-trip, hide record details, and reject tampering or wrong keys', () => {
  const key=randomBytes(32).toString('base64');
  const backup={format:'tnt-tax-tracker',version:1,expenses:[{description:'private record'}],sales:[]};
  const encrypted=encryptBackup(backup,key);
  assert.ok(!encrypted.includes('private record'));
  assert.deepEqual(decryptBackup(encrypted,key),backup);
  assert.throws(()=>decryptBackup(encrypted,randomBytes(32).toString('base64')));
  const changed=JSON.parse(encrypted);
  const bytes=Buffer.from(changed.data,'base64'); bytes[0]^=1; changed.data=bytes.toString('base64');
  assert.throws(()=>decryptBackup(JSON.stringify(changed),key));
});

test('backup monitoring warns for missing, overdue, or failed backups', () => {
  const now = Date.parse('2026-11-16T20:00:00Z');
  const recent = { status:'completed', conclusion:'success', updated_at:'2026-11-16T19:00:00Z' };
  assert.equal(backupStatus([recent], now).healthy, true);
  assert.equal(backupStatus([], now).healthy, false);
  assert.equal(backupStatus([{...recent, updated_at:'2026-11-16T10:00:00Z'}], now).healthy, false);
  assert.equal(backupStatus([{status:'completed', conclusion:'failure'}, recent], now).healthy, false);
});
