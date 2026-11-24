# syntax=docker/dockerfile:1
# Node >= 22.23.4 is required (CVE-2026-111497, Brotli decoder out-of-bounds write). The distroless nodejs22 image still shipped
# 22.22.0 on 2026-11-24, so the runtime binary comes from the patched official image (same Debian 12 / glibc as distroless).
FROM node:22.23.5-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @davrabox/api...
COPY apps/api apps/api
RUN pnpm --filter @davrabox/api build \
 && pnpm --filter @davrabox/api deploy --prod --legacy /out

FROM gcr.io/distroless/nodejs22-debian12:nonroot
COPY --from=node:22.23.5-slim /usr/local/bin/node /nodejs/bin/node
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/migrations ./migrations
COPY --from=build /repo/apps/api/package.json ./package.json
ENV NODE_ENV=production API_PORT=3000
LABEL org.opencontainers.image.source="https://github.com/menarzullayev/davrabox"
EXPOSE 3000
USER 65532:65532
CMD ["dist/main.js"]
