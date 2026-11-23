# syntax=docker/dockerfile:1
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @davrabox/api...
COPY apps/api apps/api
RUN pnpm --filter @davrabox/api build \
 && pnpm --filter @davrabox/api deploy --prod --legacy /out

FROM gcr.io/distroless/nodejs22-debian12:nonroot
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
