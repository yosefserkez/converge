# Execution image for UNTRUSTED candidate code.
#
# - Never receives secrets, repository credentials, or model keys.
# - Storefront dependencies are installed once at build time into
#   /opt/storefront (root-owned, read-only to the runtime user).
# - Trusted helpers in /opt/converge load a verified SourceBundle into
#   /workspace and run only allowlisted tools (typecheck, unit, build).
#
# Build from the repository root:
#   docker build -f containers/execution.Dockerfile -t converge-exec .
FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=1

# tini as PID 1 reaps orphaned processes left by killed tool runs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/storefront
COPY fixtures/storefront/package.json fixtures/storefront/package-lock.json ./
RUN npm ci --no-audit --no-fund \
    && npm cache clean --force \
    && chmod -R a-w /opt/storefront

COPY containers/execution/load-bundle.mjs containers/execution/run-tool.mjs /opt/converge/
RUN chmod 0555 /opt/converge/*.mjs \
    && mkdir -p /workspace \
    && chown node:node /workspace

USER node
WORKDIR /workspace
ENV PORT=8080
EXPOSE 8080

# Stay alive; the controller drives work through exec.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "-e", "setInterval(() => {}, 1 << 30)"]
