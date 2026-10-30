# The SFTP relay's image (packages/sftp-relay), built from the repository root:
#
#   docker build -f packages/sftp-relay/Dockerfile -t alcove-sftp-relay .
#
# Base pinned to node:26-alpine's multi-arch index digest in both stages, the
# digest the default image pins (Dockerfile); the docker ecosystem entry for
# /packages/sftp-relay in .github/dependabot.yml raises a bump of this copy.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS builder

WORKDIR /build

# The lockfile-exact install of the workspaces the bundle reads: core, built
# for its `websocket-relay` entry, and the relay with its build tools. The
# root .npmrc puts the install-script policy in force here as in CI.
COPY .npmrc package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/peerjs-broker/package.json packages/peerjs-broker/
COPY packages/websocket-relay/package.json packages/websocket-relay/
COPY packages/sftp-relay/package.json packages/sftp-relay/
COPY lib lib
RUN --mount=type=cache,target=/root/.npm \
  npm ci -w packages/core -w packages/sftp-relay

COPY tsconfig.base.json tsconfig.json ./
COPY packages/core/*.ts packages/core/tsconfig.json packages/core/tsconfig.rollup.json packages/core/
COPY packages/core/src packages/core/src/
COPY packages/peerjs-broker/src packages/peerjs-broker/src/
COPY packages/websocket-relay/src packages/websocket-relay/src/
COPY packages/sftp-relay/rollup.config.mjs packages/sftp-relay/
COPY packages/sftp-relay/src packages/sftp-relay/src/
RUN npm run build -w packages/core \
  && npm run build -w packages/sftp-relay

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

LABEL org.opencontainers.image.source="https://github.com/georgetown-mdi/alcove" \
      org.opencontainers.image.description="Alcove SFTP relay: forwards each WebSocket from an allowed browser origin to one SFTP server" \
      org.opencontainers.image.licenses="Apache-2.0"

# The relay runs node alone, so the package managers the base bundles are
# taken out, as the default image takes them out (Dockerfile).
RUN rm -rf \
  /usr/local/lib/node_modules/npm \
  /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm \
  /usr/local/bin/npx \
  /usr/local/bin/corepack \
  /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg \
  /opt/yarn-v*

# One file, every module it runs bundled in (rollup.config.mjs), root-owned so
# the account below cannot rewrite it.
WORKDIR /app
COPY --from=builder /build/packages/sftp-relay/dist/sftp-relay.mjs /app/sftp-relay.mjs

USER node

# It binds every interface inside the container; which host interfaces reach
# it is the `-p` publish binding's choice (docs/DEPLOYMENT.md). The operator
# adds `--target` and `--allowed-origin` to the run.
EXPOSE 8080
ENTRYPOINT ["node", "/app/sftp-relay.mjs", "--host", "0.0.0.0", "--port", "8080"]
