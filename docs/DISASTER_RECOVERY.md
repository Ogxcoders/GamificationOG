# GamificationOG — Disaster Recovery (§101)

> "Backups are not enough unless restores are regularly tested."

This document defines the recovery objectives, the backup/restore tooling, and the operator runbooks for the reference stack (Next.js app + SQLite database). The same *model* applies when scaling out: swap the storage layer (PostgreSQL with PITR, Redis, object storage) and keep the runbooks.

## 1. Objectives

| Objective | Target (this reference stack) | How it is met |
|---|---|---|
| **RPO** (max data loss window) | ≤ 24h with daily snapshots; ≤ 5min with WAL-mode + 5-minute snapshot cron | `bun scripts/backup.ts` (safe online `VACUUM INTO`) on a schedule |
| **RTO** (max time to restore service) | ≤ 10 minutes | verified restore + app restart + smoke checks |
| **Backup frequency** | daily (reference), hourly in production, plus offsite copy | cron: `0 3 * * * cd /app && bun --env-file=.env scripts/backup.ts` |
| **Restore verification** | every backup is integrity-checked at write time; restores are *verified* (sha256 + row counts vs manifest) and drilled with `--target` | `bun scripts/restore.ts` |
| **Projection rebuild** | any time, without side effects | §102 replay: `POST /api/admin/recovery/replay` |
| **Corruption recovery** | detect → restore last good backup → rebuild projections | runbook §5 |

## 2. Backup tooling

```bash
# snapshot the live DB (safe while the app runs; VACUUM INTO is consistent)
bun --env-file=.env scripts/backup.ts            # → backups/gog-backup-<ts>.db
bun --env-file=.env scripts/backup.ts --out /mnt/offsite
```

Every backup writes a sidecar manifest (`*.manifest.json`) containing:

- `sha256` of the database file,
- byte size,
- row counts for every table,
- creation timestamp and source path.

Backups are **verified at creation** (`PRAGMA integrity_check` on the copy); a failed check aborts with exit code 1 and the file is *not* considered restorable. Retention prunes to the newest 14 snapshots automatically.

## 3. Restore tooling

```bash
# VERIFY-ONLY (default, safe, read-only) — use in scheduled restore drills
bun --env-file=.env scripts/restore.ts backups/gog-backup-<ts>.db

# DRILL RESTORE — restore into an isolated file, live DB untouched
bun --env-file=.env scripts/restore.ts backups/gog-backup-<ts>.db --target /tmp/drill.db

# LIVE RESTORE — swap the live database (app MUST be stopped)
bun --env-file=.env scripts/restore.ts backups/gog-backup-<ts>.db --confirm
```

The verifier re-runs `PRAGMA integrity_check`, re-hashes the file against the manifest sha256, and compares row counts table-by-table. Any mismatch or malformed image → clean failure, exit code 1. `--confirm` always safety-copies the current live file (`.pre-restore-<ts>`) before swapping.

## 4. Restore runbook (data loss / accidental deletion)

1. **Stop the app** (`systemctl stop gog` / kill the Next.js process).
2. Pick the newest healthy backup: `bun --env-file=.env scripts/restore.ts backups/<latest>.db` (verify-only) — must print `integrity: ok`, `sha256: matches manifest`, `row counts: match manifest`.
3. Restore: add `--confirm`.
4. **Start the app**, then smoke-test in order:
   - `GET /api/health` → `{"status":"ok"}`
   - admin login → `POST /api/admin/auth/login`
   - a state read → `GET /api/v1/users/<some-user>/state`
   - metrics → `GET /api/metrics` (domain counters reflect restored row counts)
5. If any user state looks wrong (drift between events and projections), run the §102 rebuild:
   - dry-run first: `POST /api/admin/recovery/replay {"dry_run": true}` → inspect the drift report,
   - then apply: `POST /api/admin/recovery/replay {"dry_run": false}`.
6. File the incident: note timestamps, backup used, drift verdict, duration (this measures your real RTO).

## 5. Corruption recovery runbook

Symptoms: `database disk image is malformed`, app 500s on DB access, integrity check failures.

1. Do NOT write more traffic — stop the app (freeze the corrupted file for forensics).
2. `cp db/custom.db /tmp/forensics-$(date +%s).db`
3. Run the restore verifier against the newest backups (newest → older) until one passes.
4. Restore with `--confirm`, start the app.
5. Rebuild projections from the event log (§102) — the event store is the source of truth; projections are always rebuildable.
6. If the event store itself lost events between the backup and the failure, accept the RPO gap and re-seed from upstream client queues (SDK offline queue, §79) where possible.

## 6. Failover model (multi-instance / region)

- The reference stack is single-instance; its in-process realtime hub (§78) and rate limiter are per-instance by design. Multi-instance deployments should bridge the hub via Redis pub/sub and move the limiter to Redis before scaling horizontally (documented in the hub source).
- Regions (§ Phase 5) pin project data to a logical region; regional failover = restore the region's backups into the standby region + repoint DNS. The §64 promotion flow (export → import) moves *configuration* between environments; backups move *state*.
- Event replay recovery (§102) is the shared primitive: after ANY restore, projections can be recomputed from the stored event stream without re-triggering webhooks or other external side effects.

## 7. Scheduled restore drills

```bash
# weekly drill: verify every backup + restore the newest into a scratch file
0 4 * * 1  cd /app && for f in $(ls -t backups/gog-backup-*.db | head -1); do \
             bun --env-file=.env scripts/restore.ts "$f" --target /tmp/drill.db; done
```

A drill is **green** when the verifier prints all three checks (`integrity`, `sha256`, `row counts`) and exits 0. Anything else pages the operator. The E2E suite `scripts/e2e-dr.ts` automates the same assertions (backup → manifest → tamper-detection → drill restore) so drills also run in CI.
