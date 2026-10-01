# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install dependencies first (cached layer)
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile

# Copy source and compile
COPY . .
RUN pnpm run build

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

# Install git (needed for git clone in deployRunner)
RUN apk add --no-cache git

# Install flyctl
RUN wget -q -O - https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sh
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /app

# Install production deps only
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/index.js"]
