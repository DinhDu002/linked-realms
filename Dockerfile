# One image for hub-api, relay and the Map servers; compose.yaml picks the command.
# Node 26 runs the TypeScript sources directly, so there is no build step.
FROM node:26.12.1-alpine3.24

RUN npm install -g pnpm@11.3.0

WORKDIR /app
# /data/map-N: one volume per Map server (Mining key), writable by the unprivileged user.
RUN mkdir -p /data/map-1 /data/map-2 /data/map-3 \
 && chown -R node:node /app /data
USER node

COPY --chown=node:node . .
# Only what the three services and the seed script need: no contracts (they need git for forge-std),
# no client (Phaser, Vite), no indexer (Ponder).
RUN pnpm install --frozen-lockfile --prod \
    --filter @linked-realms/hub-api... \
    --filter @linked-realms/relay... \
    --filter @linked-realms/map-server...

ENV NODE_ENV=production
