FROM node:20-slim AS base

RUN corepack enable && corepack prepare yarn@4.13.0 --activate

WORKDIR /app

# Copy dependency manifests
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY packages/types/package.json packages/types/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/polymarket-client/package.json packages/polymarket-client/package.json
COPY packages/exchange-clients/package.json packages/exchange-clients/package.json
COPY packages/llm-clients/package.json packages/llm-clients/package.json
COPY packages/testing/package.json packages/testing/package.json
COPY apps/api-gateway/package.json apps/api-gateway/package.json
COPY apps/market-discovery-service/package.json apps/market-discovery-service/package.json
COPY apps/price-feed-service/package.json apps/price-feed-service/package.json
COPY apps/orderbook-service/package.json apps/orderbook-service/package.json
COPY apps/feature-engine-service/package.json apps/feature-engine-service/package.json
COPY apps/agent-gateway-service/package.json apps/agent-gateway-service/package.json
COPY apps/risk-service/package.json apps/risk-service/package.json
COPY apps/execution-service/package.json apps/execution-service/package.json
COPY apps/config-service/package.json apps/config-service/package.json
COPY apps/replay-service/package.json apps/replay-service/package.json
COPY apps/whale-tracker-service/package.json apps/whale-tracker-service/package.json
COPY apps/post-trade-analyzer-service/package.json apps/post-trade-analyzer-service/package.json
COPY apps/strategy-optimizer-service/package.json apps/strategy-optimizer-service/package.json
COPY apps/derivatives-feed-service/package.json apps/derivatives-feed-service/package.json
COPY apps/pipeline-orchestrator/package.json apps/pipeline-orchestrator/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json

RUN yarn install

# Copy source
COPY tsconfig.json ./
COPY packages packages
COPY apps apps
COPY scripts scripts

# ─── Dev target: tsx watch with hot-reload ──────────────────────────────────
FROM base AS dev
ENV NODE_ENV=development
# Entrypoint set via docker-compose command

# ─── Prod target: compiled JS ───────────────────────────────────────────────
FROM base AS build
RUN yarn workspaces foreach -A run build

FROM node:20-slim AS prod
RUN corepack enable && corepack prepare yarn@4.13.0 --activate
WORKDIR /app
COPY --from=build /app .
ENV NODE_ENV=production
