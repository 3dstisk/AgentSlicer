ARG ORCASLICER_NATIVE_IMAGE=agent-slicer-native:dev

FROM node:24-bookworm-slim AS mcp

WORKDIR /build
COPY src/agent-mcp/package.json src/agent-mcp/package-lock.json ./
RUN npm ci
COPY src/agent-mcp/tsconfig.json src/agent-mcp/tsconfig.build.json ./
COPY src/agent-mcp/src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM ${ORCASLICER_NATIVE_IMAGE}

ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown

LABEL org.opencontainers.image.title="AgentSlicer" \
      org.opencontainers.image.description="OrcaSlicer x86_64 with a browser desktop and authenticated MCP control" \
      org.opencontainers.image.source="https://github.com/3dstisk/AgentSlicer" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}"

RUN mkdir -p /opt/agent-mcp

COPY --from=mcp /usr/local/bin/node /usr/local/bin/node
COPY --from=mcp /build/dist /opt/agent-mcp/dist
COPY --from=mcp /build/node_modules /opt/agent-mcp/node_modules
COPY --from=mcp /build/package.json /opt/agent-mcp/package.json
COPY docker/agent-slicer/capture-orca /usr/local/bin/capture-orca
COPY docker/agent-slicer/init-agent-slicer /custom-cont-init.d/99-agent-slicer
COPY docker/agent-slicer/service-agent-slicer-mcp /custom-services.d/agent-slicer-mcp

RUN chmod 0755 \
        /opt/orcaslicer/AppRun \
        /opt/orcaslicer/bin/orca-slicer \
        /usr/local/bin/capture-orca \
        /custom-cont-init.d/99-agent-slicer \
        /custom-services.d/agent-slicer-mcp

HEALTHCHECK --interval=10s --timeout=7s --start-period=120s --retries=12 \
    CMD curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8765/readyz >/dev/null || exit 1
