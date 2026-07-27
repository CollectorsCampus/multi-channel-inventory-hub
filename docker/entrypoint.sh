#!/bin/sh
set -e

# Apply pending migrations before the app accepts traffic. `migrate deploy`
# only replays committed migrations — it never generates or resets — so it is
# safe to run on every container start, including on multiple replicas
# (Prisma takes an advisory lock).
#
# Set RUN_MIGRATIONS_ON_START=false when migrations are run as a separate
# deploy step, e.g. a Kubernetes init container or job.
if [ "${RUN_MIGRATIONS_ON_START:-true}" = "true" ]; then
  echo "==> Applying database migrations"
  pnpm --filter @hub/db exec prisma migrate deploy
fi

exec "$@"
