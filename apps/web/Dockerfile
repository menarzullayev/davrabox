# syntax=docker/dockerfile:1
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/design-tokens/package.json packages/design-tokens/
RUN pnpm install --frozen-lockfile --filter @davrabox/web...
COPY packages/design-tokens packages/design-tokens
COPY apps/web apps/web
ARG ANDROID_SHA256_CERT_FINGERPRINT=""
ENV ANDROID_SHA256_CERT_FINGERPRINT=$ANDROID_SHA256_CERT_FINGERPRINT
# Public origin for absolute URLs in index.html (og:image); empty keeps them relative.
ARG VITE_PUBLIC_URL=""
ENV VITE_PUBLIC_URL=$VITE_PUBLIC_URL
RUN pnpm --filter @davrabox/design-tokens build && pnpm --filter @davrabox/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY --chmod=755 apps/web/docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
LABEL org.opencontainers.image.source="https://github.com/menarzullayev/davrabox"
EXPOSE 8080
USER 101
