# Trusted Git broker image. Build context = repo root:
#   docker build -f containers/git-broker.Dockerfile -t converge-broker .
#
# The server is bundled with esbuild inside the build stage, so the image
# does not depend on a host build step. The build stage installs only the
# two pinned packages the bundle needs (esbuild, zod) with scripts disabled;
# workspace sources are resolved by path. The runtime stage holds node, git
# and one JS file: no npm, no package manager cache, no candidate code.
# `containers/git-broker.Dockerfile.dockerignore` limits the context to the
# broker sources.

ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /build
RUN npm install --no-save --no-audit --no-fund --ignore-scripts esbuild@0.28.2 zod@4.6.5
COPY packages/domain/src packages/domain/src
COPY packages/infrastructure/src/git packages/infrastructure/src/git
COPY containers/git-broker containers/git-broker
RUN node_modules/.bin/esbuild containers/git-broker/server.ts \
      --bundle --platform=node --format=esm --target=node24 \
      --alias:@converge/domain=./packages/domain/src/index.ts \
      --legal-comments=none --outfile=dist/server.mjs

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git --version
ENV NODE_ENV=production \
    PORT=9000
WORKDIR /app
COPY --from=build /build/dist/server.mjs /app/server.mjs
USER node
EXPOSE 9000
CMD ["node", "/app/server.mjs"]
