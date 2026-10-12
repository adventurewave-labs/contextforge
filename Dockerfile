FROM node:24-alpine

WORKDIR /app

# Zero npm dependencies — no install step.
COPY package.json ./
COPY server ./server
COPY web ./web

ENV NODE_ENV=production
EXPOSE 3000

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

CMD ["node", "server/index.js"]
