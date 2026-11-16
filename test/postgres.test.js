const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { createApp, initializeDatabase, readSnapshot } = require('../server');
const { encryptBackup, decryptBackup, restoreBackup } = require('../scripts/database-backup');

test('real PostgreSQL: commits survive app restarts and encrypted backups restore', { timeout:60000 }, async t => {
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; integration tests never silently skip.');
  const schema=`tnt_test_${randomUUID().replaceAll('-','')}`;
  const restoreSchema=`${schema}_restore`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,connectionTimeoutMillis:10000});
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE SCHEMA ${restoreSchema}`);
  let pool, restorePool, server;
  const stop=async () => {
    if(server) { await new Promise(resolve=>server.close(resolve)); server=null; }
    if(pool) {await pool.end(); pool=null;}
  };
  t.after(async () => {
    await stop();
    if(restorePool)await restorePool.end();
    await admin.query(`DROP SCHEMA ${restoreSchema} CASCADE`);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const start=async () => {
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,connectionTimeoutMillis:10000});
    await initializeDatabase(pool);
    server=createApp(pool).listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base=await start();
  const request=async (path,method='GET',body) => {
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:response.status===204?null:await response.json()};
  };
  const expense={id:randomUUID(),date:'2026-12-31',amount:10.25,category:'Rent',description:'Disposable persistence test'};
  const sale={id:randomUUID(),date:'2026-01-01',amount:20,description:'Disposable persistence test'};
  assert.equal((await request('/api/expenses','POST',expense)).status,201);
  assert.equal((await request('/api/sales','POST',sale)).status,201);
  assert.equal((await request('/api/expenses','POST',expense)).status,200);
  assert.equal((await request('/api/expenses','POST',{...expense,amount:999})).status,409);
  // Independent SQL evidence, not just the response to the write.
  assert.equal((await admin.query(`SELECT amount::float8 AS amount FROM ${schema}.expenses WHERE id=$1`,[expense.id])).rows[0].amount,10.25);
  await stop();
  base=await start();
  const restored=await request('/api/summary');
  assert.equal(restored.body.expenses.length,1);
  assert.equal(restored.body.sales.length,1);
  assert.equal(restored.body.expenses[0].date,'2026-12-31');
  assert.equal(restored.body.sales[0].date,'2026-01-01');
  assert.equal(restored.body.expenses[0].amount,10.25);
  assert.equal((await request('/api/health')).body.storage,'postgresql');
  const backup=(await request('/api/backup')).body;
  const key=randomBytes(32).toString('base64');
  const decrypted=decryptBackup(encryptBackup(backup,key),key);
  restorePool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${restoreSchema}`});
  await initializeDatabase(restorePool);
  await restoreBackup(restorePool,decrypted);
  assert.deepEqual(await readSnapshot(restorePool),restored.body);
  await assert.rejects(restoreBackup(restorePool,decrypted),/empty target/);
  const concurrent=await Promise.all(Array.from({length:8},(_,i)=>request('/api/expenses','POST',{...expense,id:randomUUID(),amount:i+1})));
  assert.ok(concurrent.every(x=>x.status===201));
  assert.equal((await request('/api/expenses')).body.length,9);
  assert.equal((await request(`/api/expenses/${expense.id}`,'DELETE')).status,204);
  await request('/api/sales','POST',{...sale,id:randomUUID()});
  assert.ok(!(await request('/api/expenses')).body.some(x=>x.id===expense.id),'unrelated writes never resurrect deleted records');
  assert.equal((await request(`/api/sales/${sale.id}`,'PUT',{...sale,amount:25})).body.amount,25);
  console.log('Verified real database commits, fresh-process reads, exact dates, concurrent writes, retry safety, deletion isolation, and encrypted restore into an empty schema.');
});
