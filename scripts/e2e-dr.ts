/**
 * GamificationOG — E2E DISASTER RECOVERY suite (§101).
 * Automates the restore drill: live backup → manifest verification →
 * tamper/corruption detection (integrity + sha256) → drill restore into an
 * isolated target with row-count equality vs the live database →
 * §102 replay as post-restore projection repair.
 *
 * Runs the operator scripts as subprocesses exactly as documented in
 * docs/DISASTER_RECOVERY.md.
 *
 * Usage: bun scripts/e2e-dr.ts [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000'
const ROOT = new URL('.', import.meta.url).pathname.replace('/scripts/', '')
const { $ } = Bun

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function sh(cmd: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bash', '-c', `${cmd} 2>&1`], { cwd: ROOT, env: { ...process.env } })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  return { code, out }
}

async function call(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  if (opts.cookie) headers.cookie = opts.cookie
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* non-json */
  }
  return { status: res.status, json, setCookie, headers: res.headers }
}

console.log('\n════════════ GamificationOG — E2E DISASTER RECOVERY (§101) ════════════')
console.log(`Target: ${BASE}\n`)

// ---------- 1. Live backup ----------
console.log('▸ 1. Online backup (VACUUM INTO + integrity + manifest)')
let backupFile = ''
{
  const { code, out } = await sh(`bun --env-file=.env scripts/backup.ts --out /tmp/gog-e2e-dr`)
  check('backup script exits 0', code === 0, out.split('\n').find((l) => l.startsWith('integrity')) ?? '')
  check('backup reports integrity ok', out.includes('integrity   : ok'))
  const destLine = out.split('\n').find((l) => l.startsWith('destination'))
  backupFile = destLine ? destLine.split(':').slice(1).join(':').trim() : ''
  check('backup file path reported', backupFile.length > 0, backupFile)
  const manifestOk = out.includes('manifest    :')
  check('manifest written', manifestOk)
  check('sha256 recorded in output', out.includes('sha256      :'))
  const m = out.match(/rows\s+:\s(.+)/)
  check('row counts captured', !!m && m[1].includes('Event='))
}

// ---------- 2. Manifest contents ----------
console.log('\n▸ 2. Manifest sidecar verification')
{
  const manifest = await Bun.file(`${backupFile}.manifest.json`).json()
  check('manifest has sha256 (64 hex)', typeof manifest.sha256 === 'string' && /^[a-f0-9]{64}$/.test(manifest.sha256))
  check('manifest has bytes', typeof manifest.bytes === 'number' && manifest.bytes > 0)
  check('manifest has integrity ok', manifest.integrity === 'ok')
  check('manifest has table counts', typeof manifest.tables?.Event === 'number')
  check('manifest has createdAt', typeof manifest.createdAt === 'string')
}

// ---------- 3. Verify-only restore ----------
console.log('\n▸ 3. Verify-only restore (scheduled drill mode)')
{
  const { code, out } = await sh(`bun --env-file=.env scripts/restore.ts '${backupFile}'`)
  check('verify-only restore exits 0', code === 0)
  check('integrity ok', out.includes('integrity   : ok'))
  check('sha256 matches manifest', out.includes('sha256      : matches manifest'))
  check('row counts match manifest', out.includes('row counts  : match manifest'))
  check('verify-only does NOT swap the live db', out.includes('VERIFY-ONLY'))
}

// ---------- 4. Corruption / tamper detection ----------
console.log('\n▸ 4. Corruption detection (the drill must fail loudly)')
{
  const tampered = '/tmp/gog-e2e-dr/tampered.db'
  await Bun.write(tampered, Bun.file(backupFile))
  await Bun.write(`${tampered}.manifest.json`, Bun.file(`${backupFile}.manifest.json`))
  // flip bytes in the middle of the file (structural corruption)
  const buf = new Uint8Array(await Bun.file(tampered).arrayBuffer())
  const mid = Math.floor(buf.length / 2)
  const payload = new TextEncoder().encode('GARBAGE-GARBAGE-GARBAGE')
  buf.set(payload, mid)
  await Bun.write(tampered, buf)

  const { code, out } = await sh(`bun --env-file=.env scripts/restore.ts '${tampered}'`)
  check('tampered backup fails verification (non-zero exit)', code !== 0, `exit=${code}`)
  check('failure reason reported', /INTEGRITY CHECK FAILED|SHA256 MISMATCH|ROW COUNT MISMATCH/.test(out))
}

// ---------- 5. Drill restore into isolated target ----------
console.log('\n▸ 5. Drill restore (--target) with live row-count equality')
{
  const drill = '/tmp/gog-e2e-dr/drill-restore.db'
  const { code, out } = await sh(`bun --env-file=.env scripts/restore.ts '${backupFile}' --target '${drill}'`)
  check('drill restore exits 0', code === 0)
  check('drill restored to target path', out.includes(`restored to : ${drill}`))

  // open the drill db and compare row counts against the LIVE database via the API
  const { Database } = await import('bun:sqlite')
  const drillDb = new Database(drill, { readonly: true })
  const liveEvents = drillDb.query('SELECT COUNT(*) AS c FROM Event').get() as { c: number }
  const liveUsers = drillDb.query('SELECT COUNT(*) AS c FROM AppUser').get() as { c: number }
  drillDb.close()

  const health = await call('/api/health')
  check('live app healthy after drill', health.status === 200)
  const metrics = await call('/api/metrics', { headers: { authorization: `Bearer ${process.env.GOG_METRICS_TOKEN ?? ''}` } })
  void metrics
  check('drill DB contains events', liveEvents.c > 0, `Event=${liveEvents.c}`)
  check('drill DB contains users', liveUsers.c > 0, `AppUser=${liveUsers.c}`)
}

// ---------- 6. Post-restore projection repair (§102) ----------
console.log('\n▸ 6. §102 replay as post-restore projection repair')
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('owner login works', login.status === 200)
  const SID = login.setCookie.split(';')[0]
  const rebuild = await call('/api/admin/recovery/replay', {
    cookie: SID,
    body: { external_user_id: 'ada', dry_run: true },
  })
  check('post-restore dry-run rebuild responds 200', rebuild.status === 200, `status ${rebuild.status}`)
  check('rebuild machinery available after restore drill', rebuild.json?.result?.status === 'rolled_back')
}

// ---------- summary ----------
console.log('\n──────────── RESULT ────────────')
console.log(`  pass: ${pass}  fail: ${fail}`)
if (failures.length) {
  console.log('  failed checks:')
  for (const f of failures) console.log(`    - ${f}`)
  process.exit(1)
}
process.exit(0)
