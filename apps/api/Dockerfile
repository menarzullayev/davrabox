# syntax=docker/dockerfile:1
# Node 26.13.1 or newer is required (CVE-2026-111497, Brotli decoder out-of-bounds write); the distroless image ships the same patched build on Debian 13.
FROM node:26.13.1-slim AS build
RUN npm install -g pnpm@12.23.0 --no-fund --no-audit
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @davrabox/api...
COPY apps/api apps/api
RUN pnpm --filter @davrabox/api build \
 && pnpm --filter @davrabox/api deploy --prod --legacy /out

FROM gcr.io/distroless/nodejs26-debian13:nonroot
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
