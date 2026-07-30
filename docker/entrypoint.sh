#!/bin/sh
set -e

# Apply pending migrations before the app accepts traffic. `migrate deploy`
# only replays committed migrations — it never generates or resets — so it is
# safe to run on every container start, including on multiple replicas
# (Prisma takes an advisory lock).
#
# Set RUN_MIGRATIONS_ON_START=false when migrations are run as a separate
# deploy step, e.g. a Kubernetes init container or job.
#
# NOTE: this is why `prisma` is a runtime dependency of @hub/db rather than a
# devDependency — the image is built with `pnpm install --prod`, which would
# otherwise strip the CLI and break container start.
#
# The CLI is invoked through its own bin symlink rather than `pnpm --filter
# @hub/db exec`, because pnpm is not in the runtime image. The `runtime` stage is
# a fresh `FROM base`, so it inherits `corepack enable` — a shim — but none of
# the pnpm the build stages downloaded. Calling `pnpm` here therefore made
# corepack fetch pnpm from registry.npmjs.org on *every container start*: a
# network dependency at boot, in the one place the app has no reason to need
# one, and a hang rather than an error when that fetch cannot complete. It is
# also invisible until it bites — the container just sits in `starting` and then
# reports unhealthy, with a single "Corepack is about to download" line as the
# only clue.
if [ "${RUN_MIGRATIONS_ON_START:-true}" = "true" ]; then
  echo "==> Applying database migrations"
  # Subshell: the app must still start from WORKDIR, not from packages/db.
  (cd packages/db && ./node_modules/.bin/prisma migrate deploy)
fi

exec "$@"
