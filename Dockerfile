# syntax=docker/dockerfile:1

# Single multi-arch image serving both the API and the built SPA
# (TECHNICAL_DESIGN.md §9). Build with:
#   docker buildx build --platform linux/amd64,linux/arm64 -t inventory-hub:latest .

ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------------------
# deps — install the full workspace (dev included) from the lockfile
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
COPY packages/db/package.json        packages/db/
COPY packages/connector-sdk/package.json        packages/connector-sdk/
COPY packages/connector-shopify/package.json    packages/connector-shopify/
COPY packages/connector-tcgplayer/package.json  packages/connector-tcgplayer/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — generate the Prisma client, compile packages, API and SPA
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo
COPY . .

RUN pnpm --filter @hub/db generate \
 && pnpm --filter "./packages/**" build \
 && pnpm --filter @hub/api build \
 && pnpm --filter @hub/web build

# ---------------------------------------------------------------------------
# prod-deps — the same lockfile, production dependencies only
# ---------------------------------------------------------------------------
FROM deps AS prod-deps
WORKDIR /repo
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Prisma's query engine links against OpenSSL; the slim image omits it.
# tini gives us correct signal forwarding so SIGTERM reaches Node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

WORKDIR /repo

COPY --from=prod-deps /repo/node_modules                      ./node_modules
COPY --from=prod-deps /repo/apps/api/node_modules             ./apps/api/node_modules
COPY --from=prod-deps /repo/packages/db/node_modules          ./packages/db/node_modules

COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json     ./apps/api/
COPY packages/db/package.json  ./packages/db/

COPY --from=build /repo/apps/api/dist          ./apps/api/dist
COPY --from=build /repo/apps/web/dist          ./apps/web/dist
COPY --from=build /repo/packages/db/dist       ./packages/db/dist
COPY --from=build /repo/packages/db/generated  ./packages/db/generated
COPY --from=build /repo/packages/db/prisma     ./packages/db/prisma
COPY --from=build /repo/packages/connector-sdk/dist        ./packages/connector-sdk/dist
COPY --from=build /repo/packages/connector-shopify/dist    ./packages/connector-shopify/dist
COPY --from=build /repo/packages/connector-tcgplayer/dist  ./packages/connector-tcgplayer/dist

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# `node` (uid 1000) ships with the base image. SQLite deployments write their
# database under /data, so it must be owned by the runtime user.
RUN mkdir -p /data && chown -R node:node /data /repo
USER node

ENV PORT=3000
ENV WEB_ROOT=/repo/apps/web/dist
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
