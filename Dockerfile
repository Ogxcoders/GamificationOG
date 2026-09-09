# syntax=docker/dockerfile:1
# GamificationOG — production image (Next.js standalone, runs under Bun)
# Build:  docker build -t gamificationog .
# Run:    docker run -p 3000:3000 -v gog-db:/app/db gamificationog
# First boot auto-creates the SQLite schema and seeds the reference project
# (disable with GOG_AUTOSEED=false).

# ---------- 1. deps ----------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------- 2. build ----------
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL is only needed at build time for prisma generate/db typing
ENV DATABASE_URL=file:/app/db/custom.db
RUN bunx prisma generate \
 && bun run build \
 && cp -r .next/static .next/standalone/.next/ \
 && cp -r public .next/standalone/

# ---------- 3. runtime ----------
FROM oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/app/db/custom.db \
    GOG_AUTOSEED=true
RUN mkdir -p /app/db

# standalone server + traced node_modules (includes @prisma/client + sharp)
COPY --from=builder /app/.next/standalone ./

# first-boot provisioning tools (prisma CLI + engines, schema, seed)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts/seed.ts ./scripts/seed.ts
COPY --from=builder /app/scripts/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
VOLUME /app/db
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
