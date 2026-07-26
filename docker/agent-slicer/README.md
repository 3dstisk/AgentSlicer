# AgentSlicer container

Tagged commits build the existing OrcaSlicer Linux AppImage for x86_64, publish
it on the GitHub release, and package that exact AppImage into
`ghcr.io/3dstisk/agentslicer`.

Run a published image:

```bash
./scripts/agent-slicer-up
./scripts/agent-slicer-capture first.png
./scripts/agent-slicer-down
```

The GUI is available at <http://localhost:3000>. Files shared with OrcaSlicer
belong in `runtime/workspace`; screenshots are written to
`runtime/screenshots`.

To build the image locally, first place an x86_64 AppImage at
`docker/agent-slicer/dist/OrcaSlicer.AppImage`, then run:

```bash
docker compose -f compose.yaml -f compose.build.yaml build
docker compose -f compose.yaml -f compose.build.yaml up -d
```

The image intentionally uses X11 (`PIXELFLUX_WAYLAND=false`). This makes the
virtual display capturable with deterministic X11 tools and gives a future MCP
server a stable control surface.
