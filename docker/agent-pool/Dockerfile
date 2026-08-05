FROM node:24-bookworm-slim AS build

WORKDIR /build
COPY src/agent-mcp/package.json src/agent-mcp/package-lock.json ./
RUN npm ci
COPY src/agent-mcp/tsconfig.json src/agent-mcp/tsconfig.build.json ./
COPY src/agent-mcp/src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim

WORKDIR /opt/agent-pool
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./package.json

ENV NODE_ENV=production
CMD ["node", "dist/pool-main.js"]
