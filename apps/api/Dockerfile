# ─── Stage 1: build ───────────────────────────────────────────────────────────
# Uses npm (not pnpm) to avoid pnpm workspace/virtual-store issues in Docker.
# pnpm is only needed for the local monorepo; npm works fine for isolated builds.
#
# Image digest from: docker buildx imagetools inspect node:20-alpine
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# Install ALL deps (including devDependencies for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY . .
RUN npm run build

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# git: needed by cloneRepo in deployRunner
RUN apk add --no-cache git

# Install flyctl 0.5.1 — exact pinned version, SHA-256 verified, no install script.
# Binary lands in /usr/local/bin (root-owned) so the unprivileged app user cannot
# write to it, which also prevents flyctl from self-updating.
#
# Checksum source: https://github.com/superfly/flyctl/releases/download/v0.5.1/flyctl_0.5.1_checksums.txt
RUN set -eux; \
    wget -q -O /tmp/flyctl.tar.gz \
      "https://github.com/superfly/flyctl/releases/download/v0.5.1/flyctl_0.5.1_Linux_x86_64.tar.gz"; \
    echo "47803bc5dc3eb7c7a45626ff76f0082e8c5b5fb8b805efbe00469d04757e1b1b  /tmp/flyctl.tar.gz" \
      | sha256sum -c -; \
    tar -xzf /tmp/flyctl.tar.gz -C /usr/local/bin flyctl; \
    rm /tmp/flyctl.tar.gz; \
    chmod 755 /usr/local/bin/flyctl

ENV PATH="/usr/local/bin:${PATH}"

# Create unprivileged app user with home directory.
# flyctl writes ~/.fly for config; using /home/app keeps that writable by the app user.
# /tmp (the OS temp dir used by deploys) is world-writable by default in Alpine.
RUN addgroup -S app && adduser -S -G app -h /home/app app

WORKDIR /app

# Production deps only — no devDependencies, no TypeScript tooling
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations

# App files owned by root; app user gets read+execute but cannot write.
RUN chown -R root:root /app && chmod -R a+rX /app

ENV NODE_ENV=production
# PORT is injected by Railway at runtime; EXPOSE is documentation only
EXPOSE 4000

# Run as the unprivileged app user.
# Both the start command (node dist/index.js) and the Railway pre-deploy command
# (node dist/db/migrate.js) run as this user — node is world-executable and
# /app/dist is world-readable.
USER app

CMD ["node", "dist/index.js"]
