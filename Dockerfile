FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js db.js workspace-store.js sharing-store.js quota-storage.js docker-entrypoint.js ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
COPY --chown=node:node i18n ./i18n
ENV CLIPTALK_DATA_DIR=/data CLIPTALK_PORT=8000
EXPOSE 8000
CMD ["node", "docker-entrypoint.js"]
