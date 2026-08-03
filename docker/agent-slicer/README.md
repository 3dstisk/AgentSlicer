# AgentSlicer container

The x86_64 image runs OrcaSlicer, its browser desktop, and the authenticated MCP
server in one container. Main-branch pushes, manual runs, and tagged commits
build a fresh AppImage, package it into the image, run the Linux x86_64 native
unit tests (including the agent bridge), and run the complete Docker E2E.
Successful main-branch pushes publish `latest` and an immutable SHA tag. Tagged
commits publish the version tag and update `latest`; manual runs only verify the
image.

The authoritative v1 tool and security contract is in
[the MCP API documentation](../../docs/mcp-api.md).

Run it locally with a private bearer token:

```bash
export AGENT_SLICER_TOKEN='replace-with-a-long-random-secret'
export PUID="$(id -u)"
export PGID="$(id -g)"
./scripts/agent-slicer-up
./scripts/agent-slicer-capture first.png
./scripts/agent-slicer-down
```

Matching `PUID` and `PGID` to the host user keeps the bind-mounted workspace,
outputs, and screenshots writable without recursively changing their ownership.

The GUI is at <http://localhost:3000>; MCP is at
`http://127.0.0.1:8765/mcp`. Both are bound to localhost by default. MCP and
`PUT /uploads/<upload_id>` requests must send
`Authorization: Bearer $AGENT_SLICER_TOKEN`.

Example HTTP MCP client entry:

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": {
    "Authorization": "Bearer replace-with-the-same-secret"
  }
}
```

Mount layout:

- `runtime/workspace` → models imported from `/workspace`
- `runtime/outputs` → exported `.gcode` and saved `.3mf`
- `runtime/screenshots` → diagnostic and scene screenshots
- `runtime/config` → persistent OrcaSlicer configuration

Imports are limited to 512 MiB by default; set
`AGENT_SLICER_MAX_IMPORT_BYTES` to a positive byte count to tighten that limit.
Uploads use the same limit by default. Set `AGENT_SLICER_MAX_UPLOAD_BYTES` to a
lower positive byte count when needed, and set `AGENT_SLICER_UPLOAD_TTL_MS` to
change the 15-minute one-time ticket lifetime. Uploads are streamed, verified
against the prepared SHA-256 and byte count, and published atomically under
`runtime/workspace/uploads`.
Exports and saves use private staging files and are published atomically beneath
`runtime/outputs`.

To build the image locally, first place an x86_64 AppImage at
`docker/agent-slicer/dist/OrcaSlicer.AppImage`, then run:

```bash
docker compose -f compose.yaml -f compose.build.yaml build
docker compose -f compose.yaml -f compose.build.yaml up -d
```

`GET /livez` checks the MCP process. `GET /readyz` and `GET /healthz` require
the native Orca bridge to be ready. Compose waits on `/readyz`. Override
`AGENT_SLICER_ALLOWED_HOSTS` or `AGENT_SLICER_ALLOWED_ORIGINS` only when placing
the localhost service behind a trusted proxy.

On a fresh AgentSlicer configuration, Orca enables every bundled Bambu Lab
printer/nozzle preset and every selectable Bambu-compatible Generic filament
profile automatically. Bambu Lab H2S 0.4 mm, its 0.20 mm Standard process, and
Generic PLA are selected initially. Existing user configurations are left
unchanged, and the native bridge stays unavailable if bootstrap fails.

The image uses X11 with Mesa llvmpipe so screenshots remain available without a
GPU. The Selkies desktop disables file transfer, command execution, nested
Docker, and terminal-oriented desktop features.

For a remote deployment, keep the container ports private, terminate TLS at a
trusted reverse proxy, use a high-entropy token, and set exact Host and Origin
allowlists. Protect the browser desktop with the LinuxServer `CUSTOM_USER` and
`PASSWORD` settings if it is exposed.

The runtime base is the verified LinuxServer OrcaSlicer `v2.4.2-ls31` amd64
manifest (`sha256:3d5adaa318c6451f1b67f5efb0135a3e39ffebeefe8c013af1766c9f0335aba5`).
If startup times out, inspect `docker compose logs orcaslicer`; `/livez` isolates
the MCP process, while a failing `/readyz` usually means Orca is still starting,
the GUI is blocked by a dialog, or the native Unix socket is unavailable.
