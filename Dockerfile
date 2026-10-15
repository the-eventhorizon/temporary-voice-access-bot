FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

ENV APP_ENV=prod \
    DATABASE_PATH=/app/data/access-bot.sqlite \
    WEB_ADMIN_HOST=0.0.0.0 \
    WEB_ADMIN_PORT=8787

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /app/data && chown node:node /app/data

VOLUME ["/app/data"]
EXPOSE 8787

USER node

CMD ["node", "dist/index.js"]
