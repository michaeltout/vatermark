# Compile the CPU worker for Linux; never copy the local macOS binary.
FROM rust:1.90.0-bookworm AS worker-build
WORKDIR /engine
COPY engine/Cargo.toml engine/Cargo.lock ./
COPY engine/src ./src
RUN cargo build --release --locked --bin vatermark-worker

FROM node:22-bookworm-slim AS web-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Includes tsx, which starts the TypeScript server, and build/test dependencies.
# The lockfile pins the official Verus SDK GitHub revisions.
RUN corepack pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts vitest.config.ts playwright.config.ts index.html ./
COPY src ./src
COPY server ./server
# Gift protocol tests exercise the local operator helpers during the build.
COPY scripts ./scripts
COPY tests ./tests
COPY engine/tests/fixtures ./engine/tests/fixtures
COPY --from=worker-build /engine/target/release/vatermark-worker ./bin/vatermark-worker
# Exercise the real Linux worker and native SDK dependencies before publishing.
RUN corepack pnpm test && corepack pnpm build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/tmp/vatermark
COPY --from=web-build --chown=node:node /app/package.json ./package.json
COPY --from=web-build --chown=node:node /app/node_modules ./node_modules
COPY --from=web-build --chown=node:node /app/server ./server
COPY --from=web-build --chown=node:node /app/dist ./dist
COPY --from=worker-build --chown=node:node /engine/target/release/vatermark-worker ./bin/vatermark-worker
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "server/index.ts"]
