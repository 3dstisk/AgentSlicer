# AgentSlicer warm container pool

One OrcaSlicer process has one active project and one mutable preset/configuration
state. Multiple agents therefore must not share a container. The AgentSlicer pool
gateway keeps disposable containers warm, grants each lease exclusive access to
one container, and destroys that container on release or idle expiry. A released
container is never assigned to another agent.

## Start a local pool

The worker image must already exist on the Docker host. Generate a strong pool
management token, then start the gateway:

```bash
export AGENT_SLICER_POOL_TOKEN="$(openssl rand -hex 32)"
export AGENT_SLICER_POOL_SIZE=2
export AGENT_SLICER_POOL_ID=local
export AGENT_SLICER_IMAGE=ghcr.io/3dstisk/agentslicer:latest
docker compose -f compose.pool.yaml up --build -d
```

The gateway uses the Docker Engine socket to create and destroy workers on the
private `agent-slicer-pool` network. Workers have anonymous writable state only:
no workspace, output, screenshot, or Orca configuration volume is shared. The
gateway rewrites each proxied request to the worker's private bearer token.
Immediately before assigning an idle worker, the pool checks that worker's
`/readyz` endpoint. An unhealthy or unreachable worker is destroyed and the
request continues waiting for a clean replacement instead of receiving a dead
MCP endpoint.

Each gateway owns workers through its stable `AGENT_SLICER_POOL_ID`. Before it
warms the pool at startup, it force-removes containers carrying both its managed
label and that pool ID. This reclaims workers orphaned by a gateway crash without
touching workers owned by another pool. Every concurrently running gateway on a
Docker host must use a unique pool ID; reuse the same ID when restarting that
gateway so recovery can find its earlier workers.

Mounting `/var/run/docker.sock` grants Docker-host control. Run the pool gateway
only as a trusted infrastructure component, never as tenant-supplied code.

## Acquire and use a lease

Acquire a worker with the pool management token:

```http
POST /leases HTTP/1.1
Authorization: Bearer <AGENT_SLICER_POOL_TOKEN>
Content-Type: application/json

{"wait_ms":60000}
```

The response contains a lease-specific token and relative routes:

```json
{
  "lease_id": "6e6ce07a-24d5-46e6-bb09-ecfca7bc64a0",
  "token": "<single-lease bearer token>",
  "expires_at": "2026-08-05T14:30:00.000Z",
  "mcp_path": "/mcp",
  "release_path": "/leases/6e6ce07a-24d5-46e6-bb09-ecfca7bc64a0",
  "required_headers": {
    "authorization": "Bearer <single-lease bearer token>"
  }
}
```

Use the lease token—not the management token—for MCP, uploads, and outputs on
the gateway origin:

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": {
    "Authorization": "Bearer <single-lease bearer token>"
  }
}
```

Every proxied request refreshes the idle lease deadline. The default idle TTL is
30 minutes. Continue polling long-running jobs so an active agent keeps its
lease. A missing, expired, or released lease token receives `401` and can never
reach a worker.

Release the lease when the agent is finished:

```http
DELETE /leases/6e6ce07a-24d5-46e6-bb09-ecfca7bc64a0 HTTP/1.1
Authorization: Bearer <single-lease bearer token>
```

The gateway immediately revokes routing, force-removes the worker and its
anonymous volumes, and starts a clean replacement in the background. If every
worker is leased, acquisition requests wait in a bounded FIFO queue. A full
queue returns `429`; an acquisition timeout returns `503`. Both include
`Retry-After: 5`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_SLICER_POOL_TOKEN` | required | Management bearer token used only by `POST /leases`. |
| `AGENT_SLICER_POOL_ID` | `default` | Stable worker owner ID; unique per concurrently running gateway. |
| `AGENT_SLICER_POOL_SIZE` | `2` | Total warm plus leased workers. |
| `AGENT_SLICER_POOL_MAX_QUEUE` | `100` | Maximum waiting lease requests. |
| `AGENT_SLICER_POOL_ACQUIRE_WAIT_MS` | `60000` | Maximum server-side FIFO wait. |
| `AGENT_SLICER_POOL_LEASE_TTL_MS` | `1800000` | Idle lease lifetime, refreshed by proxied traffic. |
| `AGENT_SLICER_POOL_WORKER_IMAGE` | `ghcr.io/3dstisk/agentslicer:latest` | Disposable worker image. |
| `AGENT_SLICER_POOL_NETWORK` | `agent-slicer-pool` | Private Docker network shared with workers. |
| `AGENT_SLICER_POOL_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker Engine Unix socket. |
| `AGENT_SLICER_POOL_DOCKER_API_VERSION` | negotiated (up to `1.44`) | Optional fixed Docker Engine API version; setting it disables negotiation. |
| `AGENT_SLICER_POOL_WORKER_READY_TIMEOUT_MS` | `180000` | Worker `/readyz` startup deadline. |
| `AGENT_SLICER_POOL_WORKER_SHM_BYTES` | `1073741824` | Per-worker `/dev/shm` size. |
| `AGENT_SLICER_POOL_WORKER_ENV` | empty | Newline-delimited extra `NAME=value` worker settings. |

`GET /livez` checks the gateway process. `GET /readyz` and `/healthz` report
warm, leased, warming, and queued counts. Readiness stays healthy while existing
leases can still be proxied, and `accepting_leases` reports whether a warm worker
is immediately available.

The pool intentionally does not proxy the browser desktop. Interactive desktop
access should remain an operator-only endpoint on a specifically selected
worker, not a tenant routing surface.
