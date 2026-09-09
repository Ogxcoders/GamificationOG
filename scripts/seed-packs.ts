/**
 * GamificationOG — Pack catalog seeder (§57).
 * Idempotent: upserts the built-in packs by slug. Safe to run anytime.
 */
import { db } from '../src/lib/db'
import { BUILT_IN_PACKS } from '../src/server/packs/catalog'

async function main() {
  for (const pack of BUILT_IN_PACKS) {
    await db.pack.upsert({
      where: { slug: pack.slug },
      create: {
        slug: pack.slug,
        name: pack.name,
        description: pack.description,
        category: pack.category,
        version: pack.version,
        status: 'published',
        definitionJson: JSON.stringify(pack.definition),
      },
      update: {
        name: pack.name,
        description: pack.description,
        category: pack.category,
        version: pack.version,
        definitionJson: JSON.stringify(pack.definition),
      },
    })
    console.log(`  ✓ ${pack.slug} (${pack.category})`)
  }
  console.log(`\n✓ ${BUILT_IN_PACKS.length} packs in catalog`)
}

main()
  .catch((e) => {
    console.error('Pack seed failed:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
