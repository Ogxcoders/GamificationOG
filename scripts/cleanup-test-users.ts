/** Cleanup: remove orphaned test users from crashed DB test runs. */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const removed = await db.appUser.deleteMany({ where: { externalId: { startsWith: 'db_cascade_' } } })
  // also drop any progression/wallet orphans (defensive — cascades should handle it)
  console.log(`removed ${removed.count} orphaned cascade test users`)
  await db.$disconnect()
}
main()
