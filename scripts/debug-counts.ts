/** Debug: event/metric counts + idempotency uniqueness. */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const project = await db.project.findFirst({ include: { environments: true } })
  const env = project!.environments[0]
  const byStatus = await db.event.groupBy({ by: ['status'], where: { projectId: project!.id, environmentId: env.id }, _count: true })
  console.log('events by status:', JSON.stringify(byStatus))
  const bySource = await db.event.groupBy({ by: ['source', 'status'], where: { projectId: project!.id, environmentId: env.id }, _count: true })
  console.log('events by source+status:', JSON.stringify(bySource))
  const metrics = await db.metricDaily.findMany({ where: { projectId: project!.id, environmentId: env.id, metricType: 'events_processed', dimension: '' } })
  console.log('metric rows:', JSON.stringify(metrics.map((m) => ({ d: m.date, v: m.value }))))
  const dupKeys = await db.event.groupBy({
    by: ['idempotencyKey'],
    where: { projectId: project!.id, environmentId: env.id, idempotencyKey: { not: null } },
    _count: { idempotencyKey: true },
    having: { idempotencyKey: { _count: { gt: 1 } } },
  })
  console.log('idempotency keys stored more than once:', JSON.stringify(dupKeys))
  await db.$disconnect()
}
main()
