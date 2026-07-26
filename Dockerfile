# The single image both ECS services run: `MODE` picks server, worker, or the
# one-off migrator. One image means the manifest, engine, and store adapters are provably
# identical across the request path and the execution path.
#
# docker build -t atp:dev.
# docker run --rm -e MODE=server -e DATABASE_URL=… -p 3000:3000 atp:dev
#
# The app runs from TypeScript sources under `tsx`, not a `tsc` bundle. That is deliberate:
# the workspace's `@atp/*` packages resolve to their `src/index.ts` through the `exports`
# field (CLAUDE.md / ), so there is no build step anywhere in the repo — and it means
# `packages/store/src/db/migrations/*.sql` is simply present at runtime rather than needing a
# copy step a `tsc` emit would have required.

# ---- deps: install the full workspace once, cached on the lockfile --------------------------
FROM node:22-alpine AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json ./packages/schema/
COPY packages/engine/package.json ./packages/engine/
COPY packages/reporting/package.json ./packages/reporting/
COPY packages/store/package.json ./packages/store/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY packages/cli/package.json ./packages/cli/
COPY tools/compile/package.json ./tools/compile/
COPY infra/package.json ./infra/
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---- build: compile the corpus to the normalized manifest the server loads ------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY tools ./tools
COPY tests ./tests
#: the server loads the manifest, not the source files. Baking it in makes container
# start-up a file read instead of a corpus compile, and makes the image self-describing.
RUN pnpm compile && test -s dist/manifest.json

# ---- runtime --------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
# tini is PID 1: it forwards SIGTERM to the app (so the graceful-shutdown handlers in
# main.ts / main-worker.ts actually run and in-flight work is parked / leases released) and
# reaps orphans. ECS sends SIGTERM then waits `stopTimeout` before SIGKILL.
RUN apk add --no-cache tini && corepack enable
WORKDIR /app

# `--chown` matters: the default ARTIFACT_STORE=local writes under /app/.atp/artifacts, and
# a root-owned tree would make the first run fail with EACCES under `USER node`. ECS itself
# uses S3, but bare `docker run` / compose / k8s deployments hit the local path.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/tools ./tools
COPY --from=build --chown=node:node /app/tests ./tests
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json /app/tsconfig.json ./
COPY docker-entrypoint.sh /usr/local/bin/
RUN mkdir -p /app/.atp/artifacts && chown -R node:node /app/.atp

ENV MODE=server
ENV MANIFEST_PATH=/app/dist/manifest.json
ENV TESTS_ROOT=/app
EXPOSE 3000

USER node
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]

# Only server mode serves HTTP; a worker/migrate container has no port to probe, so an
# unconditional probe would mark a perfectly healthy worker `unhealthy`. ECS ignores image
# HEALTHCHECKs (the ALB target group checks the server), but `docker run`/compose honour it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD sh -c '[ "$MODE" != server ] || node -e "fetch(\"http://127.0.0.1:\"+(process.env.PORT||3000)+\"/healthz\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'
