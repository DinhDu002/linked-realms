# Two images:
# - the default target: hub-api, the relay and the Map server, with `lr-node`, the Land's Node, which
#   the Map server runs (packages/map-server/src/node.ts). Its default command is a self-hosted Map
#   server (docs/self-hosting.md); compose.yaml names the command for the other services.
# - `shell` (docker build --target shell): the Shell's static pages behind Caddy with its headers.
#   The Hub's URL is fixed when it is built: --build-arg VITE_HUB_URL=https://hub.example.org, and
#   so are the Map server image its "Your Land" command runs (--build-arg VITE_LAND_IMAGE=<image>),
#   the Public node's RPC (VITE_NODE_URL=https://rpc.example.org) and its network (VITE_NETWORK).
# `lr-node` is LR's release image, ghcr.io/dinhdu002/lr-node (DinhDu002/lr), copied in as a binary.
# @dinhdu002/lr-core comes from GitHub Packages, which needs a token with read:packages even though
# the package is public, so every build passes it as a BuildKit secret (it never lands in a layer):
#   export NODE_AUTH_TOKEN=$(gh auth token)
#   docker build --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
# Node 26 runs the services' TypeScript directly; the two web pages are built on the build machine's
# platform.

# LR's Node, built by DinhDu002/lr for amd64 and arm64 on musl, like the images below.
FROM ghcr.io/dinhdu002/lr-node:0.1.0 AS lr-node

# The Land UI (packages/client) and the Shell.
FROM --platform=$BUILDPLATFORM node:26.12.1-alpine3.24 AS build
RUN npm install -g pnpm@11.3.0
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=node_auth_token,env=NODE_AUTH_TOKEN pnpm install --frozen-lockfile
ARG VITE_HUB_URL=http://localhost:8787
ARG VITE_LAND_IMAGE
ARG VITE_NODE_URL=http://localhost:9445
ARG VITE_NETWORK=test
RUN pnpm --filter @linked-realms/client build \
 && pnpm --filter @linked-realms/shell build \
 && node packages/shell/scripts/caddy-headers.ts > packages/shell/headers.caddy

FROM caddy:2.11.7-alpine AS shell
COPY packages/shell/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/packages/shell/headers.caddy /etc/caddy/headers.caddy
COPY --from=build /app/packages/shell/dist /srv

FROM node:26.12.1-alpine3.24
RUN npm install -g pnpm@11.3.0
# The Land's Node (LR's release), built for musl like this image. The Map server spawns it (NODE_BIN).
COPY --from=lr-node /usr/local/bin/lr-node /usr/local/bin/lr-node
WORKDIR /app
# /data: the Map server key and its Node's chain (/data/lr-node), one volume per Map server,
# writable by the unprivileged user.
RUN mkdir -p /data && chown -R node:node /app /data
USER node
COPY --chown=node:node . .
RUN --mount=type=secret,id=node_auth_token,env=NODE_AUTH_TOKEN,uid=1000 \
    pnpm install --frozen-lockfile --prod \
    --filter @linked-realms/hub-api... \
    --filter @linked-realms/relay... \
    --filter @linked-realms/map-server... \
    --filter @linked-realms/dashboard...
COPY --from=build --chown=node:node /app/packages/client/dist packages/client/dist

ENV NODE_ENV=production
# The Map server key lives in the /data volume, so it survives updates of the image.
ENV MAP_SERVER_KEY_FILE=/data/map-server-key
CMD ["node", "packages/map-server/src/main.ts"]
