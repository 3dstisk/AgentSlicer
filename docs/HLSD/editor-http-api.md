# Editor HTTP API

AgentSlicer's Node adapter serves human editor clients and MCP agents over one
validated command registry in `src/agent-mcp/src/tool-contract.ts`. Both paths
use the same upload preparation, native parameter conversion, typed result
validation, render-image handling and stable native errors. Native Orca remains
the source of truth for the active project and revision.
Both transports publish the same public allowlist. Full native checkpoint
restore stays internal to verified session reopening, outside command discovery
and execution; uploaded models import geometry without loading configuration.

## Routes

All editor routes use the existing Host/Origin allowlists and bearer token.
Pool access uses an active worker lease, not the management token. The pool
explicitly proxies the `/api/v1/` namespace to that lease's worker. A dedicated
local worker can be addressed directly through a trusted application server.

- `GET /api/v1/capabilities`: API version, adapter checkout revision from
  `AGENT_SLICER_BUILD_REVISION`, input JSON schemas for available commands,
  snapshot event mode and single-active-project session model. The adapter
  revision does not identify the native binary; record the container image ID
  and inspect `slicer_status` for native protocol and capability evidence.
- `POST /api/v1/commands/<name>`: JSON parameters exactly as in the MCP tool.
  Responses preserve the MCP result envelope (`structuredContent`, content
  blocks and `isError`). Rendering content blocks include PNGs.
- `GET /api/v1/events?job_id=<optional-id>`: a bounded SSE subscription. Each
  `snapshot` contains current `status` and optionally `job`, using validated
  command results. `backend_error` carries failed snapshots. Reads do not
  overlap within a subscription; slow clients are disconnected instead of
  accumulating buffered snapshots. Reconnect begins with a fresh snapshot.

Existing authenticated `/uploads/<id>` and `/outputs/<filename>` routes remain
the file transport. A browser-facing server should expose only named uploads
and authorized artifacts, never the worker's complete output index or pool
management. The monorepo's `apps/agent-slicer-ui` provides that credential
boundary for private local development.

HTTP errors use 400 for invalid JSON/parameters, 413 for oversized command
requests, 415 for unsupported request types, 409 for native revision/project
conflicts, 404 for unknown routes, 422 for other native command rejections, and
502 for adapter/result validation failures. Transport authorization retains its
existing 401/403 behavior. Native mutation preconditions are unchanged.

## State and lifetime

One worker owns one mutable project. These unscoped command routes do not provide
durable editor-session storage or cross-customer artifact isolation. Use the
[scoped session API](editor-sessions-and-geometry.md) for durable editing.
Snapshots sample the existing bridge once per second while subscribed. There
are no native push notifications, exactly-once event guarantees or historical
event cursors. An SSE disconnect does not cancel a native job or release a
lease. Pool leases still require their normal heartbeat/lifetime handling;
an open stream alone must not be treated as permanent ownership.

Session authorization, checkpoints, recovery and native geometry export live in
the scoped API. Higher-level Custom Printing handoff remains separate. A
browser must refresh on stale revision and must not automatically retry an
uncertain mutation.
