FROM node:24-alpine

# OCI labels for registry/tooling discoverability
LABEL org.opencontainers.image.title="ContextForge" \
      org.opencontainers.image.description="Prompt compression with faithfulness verification" \
      org.opencontainers.image.source="https://github.com/adventurewave-labs/contextforge" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="docker.io/library/node:24-alpine"

WORKDIR /app

# Zero npm dependencies — no install step. package.json alone for metadata;
# server/ and web/ change most, so they layer last for cache efficiency.
COPY package.json ./
COPY server ./server
COPY web ./web

ENV NODE_ENV=production
EXPOSE 3000

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

# Node handles SIGTERM directly (see graceful-shutdown drain in server/index.js);
# no child processes exist, so no init wrapper is needed. Never pass --init to
# node itself — it's a docker-run flag, and node rejects it (crash loop).
CMD ["node", "server/index.js"]
