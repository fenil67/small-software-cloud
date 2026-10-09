# ─── Stage 1: build ───────────────────────────────────────────────────────────
# Uses npm (not pnpm) to avoid pnpm workspace/virtual-store issues in Docker.
# pnpm is only needed for the local monorepo; npm works fine for isolated builds.
FROM node:20-alpine AS builder

WORKDIR /app

# Install ALL deps (including devDependencies for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY . .
RUN npm run build

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine

# git: needed by cloneRepo in deployRunner
# curl: required by fly.io/install.sh (node:20-alpine ships BusyBox wget only;
#       the install script calls curl internally to download the flyctl binary)
RUN apk add --no-cache git curl

# Install flyctl into /usr/local/bin (FLYCTL_INSTALL/bin resolves to /usr/local/bin)
RUN curl -fsSL https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sh
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /app

# Production deps only — no devDependencies, no TypeScript tooling
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations

ENV NODE_ENV=production
# PORT is injected by Railway at runtime; EXPOSE is documentation only
EXPOSE 4000

CMD ["node", "dist/index.js"]
