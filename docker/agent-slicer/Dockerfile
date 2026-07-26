ARG ORCASLICER_RUNTIME_IMAGE=lscr.io/linuxserver/orcaslicer:latest

FROM ubuntu:24.04 AS extract

ARG TARGETARCH
COPY dist/OrcaSlicer.AppImage /tmp/OrcaSlicer.AppImage

RUN test "${TARGETARCH}" = "amd64" \
    && chmod 0755 /tmp/OrcaSlicer.AppImage \
    && cd /tmp \
    && ./OrcaSlicer.AppImage --appimage-extract \
    && test -x /tmp/squashfs-root/bin/orca-slicer

FROM ${ORCASLICER_RUNTIME_IMAGE}

ARG TARGETARCH
ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown

LABEL org.opencontainers.image.title="AgentSlicer" \
      org.opencontainers.image.description="OrcaSlicer x86_64 with a browser-accessible desktop and screenshot capture" \
      org.opencontainers.image.source="https://github.com/3dstisk/AgentSlicer" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}"

RUN test "${TARGETARCH}" = "amd64" \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        imagemagick \
        x11-utils \
        xdotool \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /opt/orcaslicer \
    && mkdir -p /opt/orcaslicer /screenshots /workspace

COPY --from=extract /tmp/squashfs-root/ /opt/orcaslicer/
COPY capture-orca /usr/local/bin/capture-orca

RUN chmod 0755 \
        /opt/orcaslicer/AppRun \
        /opt/orcaslicer/bin/orca-slicer \
        /usr/local/bin/capture-orca
