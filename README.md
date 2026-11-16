# TNT Tax Tracker

Finance tracker for TNT Music. All records are stored in PostgreSQL. The app refuses to start without `DATABASE_URL` or a working database; reads and writes return an error if the database is unavailable. There is no in-memory fallback.

## Run locally

Use Node.js 22 or newer and a PostgreSQL database:

```bash
npm ci
# Set DATABASE_URL in your shell to the intended database, without committing credentials.
npm start
```

Open http://localhost:3000. Confirm the green database connection message before entering records. A save is acknowledged only after its SQL write commits. If a connection fails, the form retains the entry; retrying the same new entry uses the same ID to prevent duplicate inserts.

## Railway configuration

Project: **Tax Tracker**, environment: **production**, app service: **TNT-TaxTrack**. The existing **Postgres** service owns the persistent volume.

The app service must reference the database service:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

This is a Railway variable reference, not a literal password. `railway.json` configures `/api/health` as the deployment health check. That endpoint checks the database tables and returns HTTP 503 if unavailable. A successful build alone does not verify persistence.

Before every deployment:

1. Verify and preserve existing records, including a fresh backup.
2. Run the storage tests and real PostgreSQL integration test.
3. Verify database health, then compare records before and after deployment/restart.
4. Confirm a recent backup succeeded. Never assume an attached database is connected to the app.

## Backups

**Automatic encrypted backups:** `.github/workflows/database-backup.yml` runs approximately every six hours and can also be run manually in GitHub Actions. It reads both tables in one consistent snapshot, encrypts in memory with AES-256-GCM, verifies decryption, and uploads only `backup.enc` as an artifact retained for 90 days. Scheduled GitHub jobs can be delayed; check the Actions history for actual completion. The repository is public, so encrypted artifacts may be publicly accessible. Plaintext financial records and encryption keys must never be committed or uploaded as artifacts.

GitHub Actions secrets:

- `TNT_DATABASE_URL`: external database URL for the dedicated read-only `tnt_backup` role.
- `TNT_BACKUP_KEY`: base64-encoded 32-byte encryption key.

The private recovery key copy is `recovery/backup-encryption-key.txt` in this local project folder (ignored by Git). Preserve it separately from GitHub. Losing every copy of this key makes encrypted backups unreadable. GitHub can use a secret but cannot display it back to you.

**Independent download:** On Quarterly Reports, click **Download Full Backup** to save all expense and sales records for every year as a readable JSON file. Keep this private file in your own backed-up storage. It contains financial data.

**Failure notifications:** The first backup run is triggered and verified during setup. GitHub Actions reports subsequent failures to the workflow owner according to that account's notification settings. Review the latest successful backup before relying on a restore.

The app also checks public workflow completion metadata and shows the last successful backup time. It warns when the latest completed run failed, no successful run is available, a backup is more than eight hours old, or status cannot be verified. Financial records and secrets are never included in that status request. GitHub can delay scheduled runs and [disable public-repository schedules after 60 days of repository inactivity](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule); if that happens, re-enable the workflow in GitHub Actions. The warning and manual download remain available in the app.

Railway native volume backup schedules were unavailable on the current workspace plan at setup; no claim is made that Railway-native backups are enabled.

## Recovery

Restore into a separate, empty PostgreSQL database first. The restore command refuses to overwrite any existing financial records, and it rolls back the entire import if any record fails. Do not clear the production database to make a restore run.

1. Download `backup.enc` from a successful **Encrypted database backup** workflow run, or use a manually downloaded JSON backup.
2. Set `DATABASE_URL` to the separate restore database.
3. Set `TNT_BACKUP_KEY` from the private recovery key copy without putting it in shell history or logs.
4. Run:

```bash
node scripts/database-backup.js restore /path/to/backup.enc
```

The same command accepts the plain JSON download. Verify record counts, dates, and amounts before planning a production recovery. Changing the app's connection to a restored database is a separate deployment action.

To create an encrypted export manually with the same environment variables:

```bash
node scripts/database-backup.js export /path/to/new-backup.enc
```

## Verification

```bash
npm test
# Set TEST_DATABASE_URL to PostgreSQL, without committing credentials.
npm run test:integration
```

Integration tests create and remove uniquely named disposable schemas. They verify committed writes through independent SQL queries, reconnect the app, exercise concurrent saves and retry IDs, check date boundaries, and restore an encrypted backup to a separate empty schema. They never use the production tables.
