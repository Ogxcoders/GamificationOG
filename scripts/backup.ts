/**
 * GamificationOG — Backup (§101 Disaster Recovery).
 *
 * Creates a safe, consistent online snapshot of the SQLite database via
 * `VACUUM INTO` (takes a write lock only briefly; safe while the app runs),
 * verifies integrity of the resulting file, and writes a sidecar manifest
 * with sha256 + table row counts so restores can be verified later.
 *
 * Usage:
 *   bun scripts/backup.ts                    → backups/gog-backup-<ts>.db
 *   bun scripts/backup.ts --out /path/dir    → custom output directory
 *
 * Schedule (per docs/DISASTER_RECOVERY.md):
 *   production: continuous WAL archiving or hourly snapshot, daily offsite
 *   this reference stack: daily snapshot via cron is sufficient.
 */
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { mkdirSync, statSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs'
import { resolve, basename } from 'path'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const outDir = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : resolve('backups')

// resolve DATABASE_URL (file:./db/custom.db style)
function dbPath(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) {
    console.error('✖ DATABASE_URL is not set — load .env first (bun --env-file or source).')
    process.exit(1)
  }
  if (!raw.startsWith('file:')) {
    console.error(`✖ Only file: SQLite URLs are supported by this backup script (got "${raw}").`)
    process.exit(1)
  }
  const p = raw.slice(5)
  return resolve(process.cwd(), p)
}

const source = dbPath()
if (!existsSync(source)) {
  console.error(`✖ Database file not found: ${source}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const now = new Date()
const stamp = `${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`
const backupPath = resolve(outDir, `gog-backup-${stamp}.db`)

console.log('── GamificationOG backup (§101) ──')
console.log(`source      : ${source}`)
console.log(`destination : ${backupPath}`)

// 1. consistent online snapshot
const db = new Database(source, { readonly: true })
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
db.close()

// 2. integrity check on the COPY (never trust an unverified backup)
const verify = new Database(backupPath, { readonly: true })
let integrityResult: { integrity_check?: string } | null = null
try {
  integrityResult = verify.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null
} catch (err) {
  verify.close()
  console.error(`✖ Backup integrity check FAILED: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
const counts = collectCounts(verify)
verify.close()
const integrity = integrityResult

if (integrity?.integrity_check !== 'ok') {
  console.error(`✖ Backup integrity check FAILED: ${JSON.stringify(integrity)} — file kept for inspection, do NOT restore it.`)
  process.exit(1)
}

// 3. sha256 + manifest
const size = statSync(backupPath).size
const sha = hashFile(backupPath)
const manifest = {
  file: basename(backupPath),
  path: backupPath,
  bytes: size,
  sha256: sha,
  integrity: 'ok',
  source,
  createdAt: new Date().toISOString(),
  tables: counts,
}
writeFileSync(`${backupPath}.manifest.json`, JSON.stringify(manifest, null, 2))

// 4. rolling retention: keep the newest 14 backups + manifests
pruneOldBackups(outDir, 14)

console.log(`integrity   : ok`)
console.log(`size        : ${(size / 1024).toFixed(1)} KiB`)
console.log(`sha256      : ${sha}`)
console.log(`rows        : ${Object.entries(counts).map(([t, c]) => `${t}=${c}`).join(' · ')}`)
console.log(`manifest    : ${backupPath}.manifest.json`)
console.log('✔ backup complete — restores are verified with: bun scripts/restore.ts <file>')

function collectCounts(db: Database): Record<string, number> {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'")
    .all() as Array<{ name: string }>
  const counts: Record<string, number> = {}
  for (const t of tables) {
    try {
      counts[t.name] = (db.query(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c
    } catch {
      /* skip weird tables */
    }
  }
  return counts
}

function hashFile(path: string): string {
  const h = createHash('sha256')
  h.update(readFileSync(path))
  return h.digest('hex')
}

function pruneOldBackups(dir: string, keep: number): void {
  const files = Array.from(new Bun.Glob('gog-backup-*.db').scan({ cwd: dir })).sort()
  const excess = files.slice(0, Math.max(0, files.length - keep))
  for (const f of excess) {
    try {
      unlinkSync(resolve(dir, f))
      if (existsSync(resolve(dir, `${f}.manifest.json`))) {
        unlinkSync(resolve(dir, `${f}.manifest.json`))
      }
    } catch {
      /* best effort */
    }
  }
  if (excess.length) console.log(`retention    : pruned ${excess.length} old backup(s) (keeping ${keep})`)
}
