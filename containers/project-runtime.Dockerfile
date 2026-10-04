# Generic runtime for UNTRUSTED code of registry projects (project mode).
#
# - Never receives secrets, repository credentials, or model keys.
# - Dependencies are NOT in the image. A trusted prep run installs them from the
#   project's frozen lockfile (with Internet, no secrets) and the platform
#   snapshots that container. Candidate runs start from the snapshot offline.
# - Trusted helpers in /opt/converge load verified source into /workspace
#   (keeping node_modules) and run commands that come from the project registry.
#
# Build from the repository root:
#   docker build -f containers/project-runtime.Dockerfile -t converge-project .
FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    WRANGLER_SEND_METRICS=false \
    CI=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10.24.0 \
    && npm cache clean --force
# A pinned global pnpm, not corepack: corepack would download a newer pnpm at
# run time, which needs the network and can disagree with the lockfile.

COPY containers/project/load-source.mjs containers/project/run-cmd.mjs /opt/converge/
RUN chmod 0555 /opt/converge/*.mjs && mkdir -p /workspace && chown node:node /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--", "node", "-e", "setInterval(() => {}, 1 << 30)"]
