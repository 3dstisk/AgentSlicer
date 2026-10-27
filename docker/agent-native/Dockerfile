# linuxserver/orcaslicer:v2.4.2-ls31, pinned to its verified linux/amd64 manifest.
ARG ORCASLICER_RUNTIME_IMAGE=lscr.io/linuxserver/orcaslicer@sha256:3d5adaa318c6451f1b67f5efb0135a3e39ffebeefe8c013af1766c9f0335aba5

FROM ubuntu:24.04 AS extract

ARG TARGETARCH
COPY docker/agent-native/dist/OrcaSlicer.AppImage /tmp/OrcaSlicer.AppImage

RUN test "${TARGETARCH}" = "amd64" \
    && chmod 0755 /tmp/OrcaSlicer.AppImage \
    && cd /tmp \
    && ./OrcaSlicer.AppImage --appimage-extract \
    && test -x /tmp/squashfs-root/bin/orca-slicer

FROM ${ORCASLICER_RUNTIME_IMAGE}

ARG TARGETARCH

RUN test "${TARGETARCH}" = "amd64" \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        imagemagick \
        curl \
        x11-utils \
        xdotool \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /opt/orcaslicer \
    && mkdir -p /opt/orcaslicer /screenshots /workspace

COPY --from=extract /tmp/squashfs-root/ /opt/orcaslicer/

# Extraction can leave owner-only directories; the runtime launches as abc.
RUN chmod -R a+rX /opt/orcaslicer \
    && chmod 0755 \
        /opt/orcaslicer/AppRun \
        /opt/orcaslicer/bin/orca-slicer \
    && test -x /opt/orcaslicer/AppRun \
    && test -x /opt/orcaslicer/bin/orca-slicer \
    && smoke_home="$(mktemp -d)" \
    && chown abc:abc "${smoke_home}" \
    && (cd "${smoke_home}" \
        && timeout -k 5s 60s s6-setuidgid abc \
            env HOME="${smoke_home}" \
                XDG_CACHE_HOME="${smoke_home}/.cache" \
                XDG_CONFIG_HOME="${smoke_home}/.config" \
                XDG_DATA_HOME="${smoke_home}/.local/share" \
            /opt/orcaslicer/AppRun --help >/dev/null) \
    && rm -rf "${smoke_home}"
