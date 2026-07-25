# Hermes relay (Telegram <-> DME pot) — minimal Node 22 runtime.
#
# Zero npm dependencies (see src/server.mjs) so there is nothing to `npm ci`
# and no third-party supply chain to audit at build time. The image is just
# the Node 22 Alpine base + our ~250-line relay script, run as the
# distro-provided non-root `node` user (uid/gid 1000).
#
# Build:
#   docker build -t <ARTIFACT_REGISTRY_HOST>/mumegaproject/dme/hermes-relay:<TAG> .

FROM node:22-alpine

# Alpine's node image already ships an unprivileged `node` user (1000:1000).
# We don't need `npm install` (no deps), so there's no root-owned node_modules
# step to worry about — copy straight in as that user.
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

# No shell, no package manager invocation at runtime — exec form, PID 1 is node.
ENTRYPOINT ["node", "src/server.mjs"]
