# linuxserver/orcaslicer:v2.4.2-ls31, pinned to its verified linux/amd64 manifest.
ARG ORCASLICER_RUNTIME_IMAGE=lscr.io/linuxserver/orcaslicer@sha256:3d5adaa318c6451f1b67f5efb0135a3e39ffebeefe8c013af1766c9f0335aba5

FROM ubuntu:24.04 AS extract

ARG TARGETARCH
COPY docker/agent-slicer/dist/OrcaSlicer.AppImage /tmp/OrcaSlicer.AppImage

RUN test "${TARGETARCH}" = "amd64" \
    && chmod 0755 /tmp/OrcaSlicer.AppImage \
    && cd /tmp \
    && ./OrcaSlicer.AppImage --appimage-extract \
    && test -x /tmp/squashfs-root/bin/orca-slicer

FROM node:24-bookworm-slim AS mcp

WORKDIR /build
COPY src/agent-mcp/package.json src/agent-mcp/package-lock.json ./
RUN npm ci
COPY src/agent-mcp/tsconfig.json src/agent-mcp/tsconfig.build.json ./
COPY src/agent-mcp/src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM ${ORCASLICER_RUNTIME_IMAGE}

ARG TARGETARCH
ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown

LABEL org.opencontainers.image.title="AgentSlicer" \
      org.opencontainers.image.description="OrcaSlicer x86_64 with a browser desktop and authenticated MCP control" \
      org.opencontainers.image.source="https://github.com/3dstisk/AgentSlicer" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}"

RUN test "${TARGETARCH}" = "amd64" \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        imagemagick \
        curl \
        x11-utils \
        xdotool \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /opt/orcaslicer \
    && mkdir -p /opt/orcaslicer /opt/agent-mcp /screenshots /workspace

COPY --from=extract /tmp/squashfs-root/ /opt/orcaslicer/
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
