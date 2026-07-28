# syntax=docker/dockerfile:1

# Single multi-arch image serving both the API and the built SPA
# (TECHNICAL_DESIGN.md §9). Build with:
#   docker buildx build --platform linux/amd64,linux/arm64 -t inventory-hub:latest .

ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------------------
# base — shared by every stage
#
# openssl must be present in the BUILD stages, not just at runtime. Prisma
# detects its query-engine target from the OpenSSL version it finds; without
# the package installed it falls back to debian-openssl-1.1.x, and the client
# generated in `build` then refuses to load in a runtime that has 3.0.x.
# Keeping one base means detection agrees everywhere, and stays correct per
# architecture under buildx rather than being pinned via `binaryTargets`.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Manifests only — this layer is what the dependency cache keys on.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
COPY packages/db/package.json        packages/db/
COPY packages/connector-sdk/package.json        packages/connector-sdk/
COPY packages/connector-shopify/package.json    packages/connector-shopify/
COPY packages/connector-tcgplayer/package.json  packages/connector-tcgplayer/
COPY packages/catalog-scryfall/package.json     packages/catalog-scryfall/

# ---------------------------------------------------------------------------
# deps — full workspace install, dev dependencies included
# ---------------------------------------------------------------------------
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — generate the Prisma client, compile packages, API and SPA
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @hub/db generate \
 && pnpm --filter "./packages/**" build \
 && pnpm --filter @hub/api build \
 && pnpm --filter @hub/web build

# ---------------------------------------------------------------------------
# prod-deps — the same lockfile, production dependencies only
#
# Installed from scratch rather than pruned out of `deps`, so the pnpm virtual
# store never contains dev packages in the first place. Pruning would leave the
# stripped versions behind in the layer below, which the runtime image carries.
# ---------------------------------------------------------------------------
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# tini forwards signals correctly so SIGTERM reaches Node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Ownership is set during COPY. A `chown -R` afterwards would rewrite every
# file into a second layer, roughly doubling the image.
#
# The whole prod-deps tree is taken at once — every package.json plus every
# node_modules. pnpm's isolated layout links workspace packages and their
# dependencies with relative symlinks, so cherry-picking individual
# node_modules directories leaves dangling links the moment one workspace
# package imports another.
COPY --from=prod-deps --chown=node:node /repo ./

COPY --from=build --chown=node:node /repo/apps/api/dist          ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/web/dist          ./apps/web/dist
COPY --from=build --chown=node:node /repo/packages/db/dist       ./packages/db/dist
COPY --from=build --chown=node:node /repo/packages/db/generated  ./packages/db/generated
COPY --from=build --chown=node:node /repo/packages/db/prisma     ./packages/db/prisma
COPY --from=build --chown=node:node /repo/packages/connector-sdk/dist        ./packages/connector-sdk/dist
COPY --from=build --chown=node:node /repo/packages/connector-shopify/dist    ./packages/connector-shopify/dist
COPY --from=build --chown=node:node /repo/packages/connector-tcgplayer/dist  ./packages/connector-tcgplayer/dist
COPY --from=build --chown=node:node /repo/packages/catalog-scryfall/dist     ./packages/catalog-scryfall/dist

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# `node` (uid 1000) ships with the base image. SQLite deployments write their
# database under /data, so it must be owned by the runtime user.
RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=3000
ENV WEB_ROOT=/repo/apps/web/dist
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
