# One image for all three services. Each Cloud Run job picks its entry point
# with --command/--args (see infra/deploy.sh).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY config.js ./
COPY lib ./lib
COPY services ./services

USER node
