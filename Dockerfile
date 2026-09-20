FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx --yes npm@11 ci
COPY tsconfig*.json ./
COPY src ./src
COPY client ./client
COPY scripts ./scripts
RUN npm run build
RUN mkdir -p /app/data && chown -R node:node /app

# 用于数据库迁移和离线管理，保留 Prisma CLI。
FROM build AS tools
USER node
CMD ["npm", "run", "db:migrate"]

FROM build AS production-dependencies
RUN npx --yes npm@11 prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
