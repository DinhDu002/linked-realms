# Three images:
# - the default target: hub-api, the relay and the Map server, with `lr-node`, the Land's Node, which
#   the Map server runs (packages/map-server/src/node.ts). Its default command is a self-hosted Map
#   server (docs/self-hosting.md); compose.yaml names the command for the other services.
# - `shell` (docker build --target shell): the Shell's static pages behind Caddy with its headers.
#   The Hub's URL is fixed when it is built: --build-arg VITE_HUB_URL=https://hub.example.org, and
#   so are the Map server image its "Your Land" command runs (--build-arg VITE_LAND_IMAGE=<image>),
#   the Public node's RPC (VITE_NODE_URL=https://rpc.example.org) and its network (VITE_NETWORK).
# - `lr-node` (docker build --target lr-node): a Node of LR alone, for the company's seed, Public
#   node, archive and Checkpoint signer (deploy/compose.chain.yaml, deploy/compose.signer.yaml).
# Node 26 runs the services' TypeScript directly; the WebAssembly core and the two web pages are
# built on the build machine's platform. `lr-node` is built for the image's own platform, so
# image.yml builds each platform on a runner of that architecture rather than under emulation.

# wasm-bindgen-cli, the version in crates/core/Cargo.toml, for the build machine's architecture.
FROM scratch AS wasm-bindgen-amd64
ADD --checksum=sha256:82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e \
    https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/wasm-bindgen-0.2.129-x86_64-unknown-linux-musl.tar.gz \
    /wasm-bindgen.tar.gz
FROM scratch AS wasm-bindgen-arm64
ADD --checksum=sha256:1797c349a0f45d30946e8986b184135e12839ab576c9a04203e85febfc5dcb35 \
    https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/wasm-bindgen-0.2.129-aarch64-unknown-linux-gnu.tar.gz \
    /wasm-bindgen.tar.gz
FROM wasm-bindgen-${BUILDARCH} AS wasm-bindgen

# packages/core/pkg: the WebAssembly build of crates/core (ADR 0009), as packages/core's `build`.
FROM --platform=$BUILDPLATFORM rust:1.99.1-slim-trixie AS wasm
COPY --from=wasm-bindgen /wasm-bindgen.tar.gz /tmp/
RUN tar -xzf /tmp/wasm-bindgen.tar.gz --strip-components=1 -C /usr/local/bin --wildcards '*/wasm-bindgen'
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
RUN cargo build --locked -p linked-realms-core --features wasm --target wasm32-unknown-unknown --profile wasm \
 && wasm-bindgen --target web --out-dir /pkg target/wasm32-unknown-unknown/wasm/linked_realms_core.wasm

# The chain on musl: crates/randomx's vectors, which prove the RandomX it links builds and hashes
# right on musl, then lr-node. CMake and the C++ compiler come from the image's Alpine release, at
# these versions; without linux-headers (asm/hwcap.h) RandomX quietly hashes with software AES on
# ARM.
FROM rust:1.99.1-alpine3.24 AS chain
RUN apk add --no-cache cmake~4.2 g++~15.2 make~4.4 linux-headers~7.0
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
RUN cargo test --locked -p linked-realms-randomx \
 && cargo build --locked --release -p linked-realms-node --bin lr-node

# Only the binary: no key is in this image. A Checkpoint signer's words are a secret file on its
# own machine (deploy/compose.signer.yaml). The chain lives in the /data volume, writable by the
# unprivileged user.
FROM alpine:3.24.3 AS lr-node
RUN install -d -o 10001 -g 10001 /data
COPY --from=chain /src/target/release/lr-node /usr/local/bin/lr-node
USER 10001:10001
ENTRYPOINT ["lr-node"]
CMD ["--data", "/data"]

# The Land UI (packages/client) and the Shell.
FROM --platform=$BUILDPLATFORM node:26.12.1-alpine3.24 AS build
RUN npm install -g pnpm@11.3.0
WORKDIR /app
COPY . .
COPY --from=wasm /pkg packages/core/pkg
RUN pnpm install --frozen-lockfile
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
# The Land's Node, built for musl like this image. The Map server spawns it (NODE_BIN).
COPY --from=chain /src/target/release/lr-node /usr/local/bin/lr-node
WORKDIR /app
# /data: the Map server key and its Node's chain (/data/lr-node), one volume per Map server,
# writable by the unprivileged user.
RUN mkdir -p /data && chown -R node:node /app /data
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile --prod \
    --filter @linked-realms/hub-api... \
    --filter @linked-realms/relay... \
    --filter @linked-realms/map-server... \
    --filter @linked-realms/dashboard...
COPY --from=wasm --chown=node:node /pkg packages/core/pkg
COPY --from=build --chown=node:node /app/packages/client/dist packages/client/dist

ENV NODE_ENV=production
# The Map server key lives in the /data volume, so it survives updates of the image.
ENV MAP_SERVER_KEY_FILE=/data/map-server-key
CMD ["node", "packages/map-server/src/main.ts"]
