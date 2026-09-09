/**
 * GamificationOG — Restore & Verify (§101 Disaster Recovery).
 *
 * "Backups are not enough unless restores are regularly tested."
 *
 * Modes:
 *   verify (default) — integrity check + sha256 + row counts vs the
 *                      sidecar manifest. No writes. Use in cron drills.
 *   --confirm         — swap the live database file with the backup (the
 *                      current live file is safety-copied first). Requires
 *                      the application to be STOPPED.
 *   --target <path>   — restore to a specific file instead of the live DB
 *                      (safe for drills and tests against a running server).
 *
 * Usage:
 *   bun scripts/restore.ts backups/gog-backup-<ts>.db
 *   bun scripts/restore.ts backups/gog-backup-<ts>.db --target /tmp/drill.db
 *   bun scripts/restore.ts backups/gog-backup-<ts>.db --confirm
 */
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, statSync, mkdirSync } from 'fs'
import { resolve, dirname, basename } from 'path'

const args = process.argv.slice(2)
const positional = args.find((a) => !a.startsWith('--') && args.indexOf(a) % 2 === 0)
const confirm = args.includes('--confirm')
const targetIdx = args.indexOf('--target')
const targetArg = targetIdx !== -1 && args[targetIdx + 1] ? resolve(args[targetIdx + 1]) : null

if (!positional) {
  console.error('Usage: bun scripts/restore.ts <backup.db> [--confirm | --target <path>]')
  process.exit(1)
}

const backupPath = resolve(positional)
if (!existsSync(backupPath)) {
  console.error(`✖ Backup file not found: ${backupPath}`)
  process.exit(1)
}

function dbPath(): string {
  const raw = process.env.DATABASE_URL
  if (!raw?.startsWith('file:')) {
    console.error('✖ DATABASE_URL must be a file: SQLite URL.')
    process.exit(1)
  }
  return resolve(process.cwd(), raw.slice(5))
}

console.log('── GamificationOG restore (§101) ──')
console.log(`backup      : ${backupPath}`)

// ---- 1. integrity check (a corrupted file may THROW — catch it) ----
let db: Database
try {
  db = new Database(backupPath, { readonly: true })
} catch (err) {
  console.error(`✖ INTEGRITY CHECK FAILED — cannot open backup: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
const counts: Record<string, number> = {}
try {
  const integrity = db.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null
  if (integrity?.integrity_check !== 'ok') {
    console.error(`✖ INTEGRITY CHECK FAILED — this backup is corrupt, do not restore: ${JSON.stringify(integrity)}`)
    db.close()
    process.exit(1)
  }
  for (const t of db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'")
    .all() as Array<{ name: string }>) {
    try {
      counts[t.name] = (db.query(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c
    } catch {
      /* skip */
    }
  }
} catch (err) {
  console.error(`✖ INTEGRITY CHECK FAILED — ${err instanceof Error ? err.message : err}`)
  db.close()
  process.exit(1)
}
db.close()
console.log('integrity   : ok')

// ---- 2. manifest comparison (when a sidecar exists) ----
const manifestPath = `${backupPath}.manifest.json`
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    sha256?: string
    bytes?: number
    tables?: Record<string, number>
  }
  const sha = createHash('sha256').update(readFileSync(backupPath)).digest('hex')
  if (manifest.sha256 && manifest.sha256 !== sha) {
    console.error('✖ SHA256 MISMATCH — the backup file changed since it was taken.')
    process.exit(1)
  }
  console.log('sha256      : matches manifest')
  if (manifest.tables) {
    const mismatches = Object.entries(manifest.tables).filter(([t, c]) => counts[t] !== c)
    if (mismatches.length) {
      console.error(`✖ ROW COUNT MISMATCH vs manifest: ${mismatches.map(([t, c]) => `${t} manifest=${c} actual=${counts[t]}`).join('; ')}`)
      process.exit(1)
    }
    console.log(`row counts  : match manifest (${Object.keys(manifest.tables).length} tables)`)
  }
} else {
  console.log('manifest    : none found (skipped sha/count verification)')
}

// ---- 3. verified restore ----
if (confirm || targetArg) {
  const destination = targetArg ?? dbPath()
  if (!targetArg && confirm) {
    // safety copy of the CURRENT live database before swapping
    const safetyPath = resolve(dirname(destination), `${basename(destination)}.pre-restore-${Date.now()}`)
    copyFileSync(destination, safetyPath)
    console.log(`safety copy : ${safetyPath}`)
  }
  mkdirSync(dirname(destination), { recursive: true })
  // VACUUM INTO produces a pristine copy — copy it into place atomically-ish
  const stagingPath = `${destination}.restore-staging`
  copyFileSync(backupPath, stagingPath)
  renameSync(stagingPath, destination)
  console.log(`restored to : ${destination} (${(statSync(destination).size / 1024).toFixed(1)} KiB)`)
  if (!targetArg) {
    console.log('\nNext steps:')
    console.log('  1. Restart the app (the running process holds the old file handle).')
    console.log('  2. Smoke-test: /api/health → /api/admin/auth/login → a state read.')
    console.log('  3. If projections drifted, run the §102 rebuild: POST /api/admin/recovery/replay')
  }
} else {
  console.log('\n✔ VERIFY-ONLY — backup is healthy. Pass --confirm to swap the live DB')
  console.log('  (app must be stopped), or --target <path> for a drill restore.')
}

console.log(`rows        : ${Object.entries(counts).map(([t, c]) => `${t}=${c}`).join(' · ')}`)
