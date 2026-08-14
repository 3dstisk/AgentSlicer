# AgentSlicer fixed worker pool

One OrcaSlicer process has one active project and one mutable preset/configuration
state. Multiple agents therefore must not share a container. The AgentSlicer pool
gateway grants each lease exclusive access to one of three fixed worker
containers. The workers are ordinary Compose/Swarm services and are already
running before the gateway accepts work; the gateway never creates containers
through the Docker Engine API.

The fixed workers are reused after release. Their OrcaSlicer project and preset
state is therefore not automatically reset between leases. Use this deployment
only for agents in the same trust boundary, and have every job import its full
project and apply the required presets/settings. Restart the three worker
services when a clean application state is required.

## Start a local pool

The worker image must already exist on the Docker host. Generate a strong pool
management token, then start the gateway:

```bash
export AGENT_SLICER_POOL_TOKEN="$(openssl rand -hex 32)"
export AGENT_SLICER_POOL_WORKER_TOKEN="$(openssl rand -hex 32)"
export AGENT_SLICER_POOL_ID=local
export AGENT_SLICER_IMAGE=ghcr.io/3dstisk/agentslicer:latest
docker compose -f compose.pool.yaml up --build -d
```

Compose starts `agent-slicer-worker-1`, `agent-slicer-worker-2`, and
`agent-slicer-worker-3` on the private `agent-slicer-pool` network. The gateway
has no Docker socket mount. It registers the configured worker URLs, waits for
their `/readyz` endpoints, and rewrites proxied requests to the shared internal
worker token. It also probes a worker immediately before assigning it. An
unhealthy worker remains out of circulation and is retried until its service is
healthy again.

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
  "heartbeat_path": "/leases/6e6ce07a-24d5-46e6-bb09-ecfca7bc64a0",
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
30 minutes. For a long slice, continue polling `job_get` or explicitly renew the
lease before its deadline:

```http
PATCH /leases/6e6ce07a-24d5-46e6-bb09-ecfca7bc64a0 HTTP/1.1
Authorization: Bearer <single-lease bearer token>
```

The heartbeat returns the new `expires_at`. Heartbeats and polling use the same
lease token, so a client can reconnect after an MCP transport interruption and
resume `job_get` with the previously returned job ID. A transport disconnect
does not release the lease or cancel an already-started slice. A missing,
expired, or released lease token receives `401` and can never reach a worker.

Release the lease when the agent is finished:

```http
DELETE /leases/6e6ce07a-24d5-46e6-bb09-ecfca7bc64a0 HTTP/1.1
Authorization: Bearer <single-lease bearer token>
```

The gateway immediately revokes routing and rechecks the fixed worker before
returning it to the ready set. If every worker is leased, acquisition requests
wait in a bounded FIFO queue. A full
queue returns `429`; an acquisition timeout returns `503`. Both include a
`Retry-After` header and a typed retryable response:

```json
{
  "error": {
    "code": "capacity_unavailable",
    "message": "No healthy AgentSlicer worker became available before the lease wait expired"
  },
  "retryable": true,
  "retryAfterMs": 5000,
  "pool": {
    "target": 3,
    "ready": 0,
    "leased": 3,
    "starting": 0,
    "unhealthy": 0,
    "queued": 0
  }
}
```

Queue saturation uses the stable code `lease_queue_full`. MCP worker responses
are proxied without rewriting their bodies, including a failed `job_get`
snapshot's structured `{code,message,details}` error.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_SLICER_POOL_TOKEN` | required | Management bearer token used only by `POST /leases`. |
| `AGENT_SLICER_POOL_ID` | `default` | Stable identifier included in gateway logs. |
| `AGENT_SLICER_POOL_WORKERS` | three Compose worker origins | Comma-delimited fixed worker HTTP origins; the entry count is the pool size. |
| `AGENT_SLICER_POOL_WORKER_TOKEN` | required | Internal bearer token configured identically on every fixed worker. |
| `AGENT_SLICER_POOL_MAX_QUEUE` | `100` | Maximum waiting lease requests. |
| `AGENT_SLICER_POOL_ACQUIRE_WAIT_MS` | `60000` | Maximum server-side FIFO wait. |
| `AGENT_SLICER_POOL_LEASE_TTL_MS` | `1800000` | Idle lease lifetime, refreshed by proxied traffic. |
| `AGENT_SLICER_POOL_RETRY_DELAY_MS` | `5000` | Unhealthy-worker retry delay and capacity-error `retryAfterMs`. |

`GET /livez` checks the gateway process. `GET /readyz` and `/healthz` report
ready, leased, starting, unhealthy, and queued counts. Readiness stays healthy
while existing leases can still be proxied, and `accepting_leases` reports
whether a warm worker is immediately available.

`GET /capacity` is a read-only, identifier-free capacity snapshot with the same
safe counts, `acceptingLeases`, and `retryAfterMs`. `GET /metrics` exposes
Prometheus metrics for lease wait duration, allocation failures, worker startup
failures, worker reclamation reasons, and current worker states. Pool logs use
structured JSON events for `lease_allocation_failed`, `worker_startup_failed`,
and `worker_reclaimed`, allowing a capacity timeout to be correlated with its
provisioning or readiness cause without exposing lease tokens.

To change capacity, add or remove explicit worker services and update
`AGENT_SLICER_POOL_WORKERS` to match. The pool intentionally does not proxy the
browser desktop. Interactive desktop access should remain an operator-only
endpoint on a specifically selected worker, not a tenant routing surface.
