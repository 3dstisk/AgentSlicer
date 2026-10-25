# Durable editor sessions and native geometry

The Node adapter owns durable editor records and artifacts. Native Orca owns
project contents and effective configuration. A checkpoint is a native project
3MF, restored through `project_restore` with model and configuration loading;
`model_import` is insufficient for recovery. Custom Printing still owns its
commercial projects and handoffs.

Native programmatic restore uses an explicit private restore context.
`LoadStrategy::Silence` alone still opens desktop dialogs, including the warning
for a valid empty checkpoint. Restore permits empty projects and accepted custom
preset configuration without changing global warning preferences. It suppresses
import scaling prompts, preserves oversized geometry within native coordinate
limits, and rejects extreme sizes or configuration substitutions instead of
silently rewriting the checkpoint. Parse errors propagate to the API. Ordinary
desktop import policies remain unchanged. Cross-version restore is not qualified.

## Storage and worker ownership

Node 24 or later provides `node:sqlite`. The session root defaults to
`/config/editor-sessions` (`AGENT_SLICER_SESSION_ROOT`). SQLite uses WAL and FULL
synchronous writes; an exclusive ownership database prevents two adapters from
opening the same store. Private capability keys and records persist across
adapter/container restarts. Mount `/config` on persistent storage.

A dedicated worker hosts one active editor session. Creating records does not
reserve capacity; opening one restores its latest verified checkpoint and
acquires the editing lease. Another session receives `worker_capacity`. Opening
with the current actor reconnects without replacing the native project. A
restore increments session generation and returns fresh process-local native
IDs. Clients must discard cached native IDs and geometry when that changes.

The first claim permanently marks this store as an editor worker.
Legacy MCP/HTTP project commands and unscoped upload/output access are then
rejected; `slicer_status` and capability discovery remain available. Batch work
must use another worker/store. An agent editing an operator session currently
uses the scoped HTTP API and transferred editing capability; raw MCP commands
remain available on batch workers. This avoids exposing another session's presets,
job metadata or temporary native outputs after release. Pool routing and
cross-worker store migration are not implemented: use a dedicated worker, not a
random pool lease, for durable editor sessions.

Acknowledged synchronous mutations have a synced native checkpoint. Asynchronous
mutations are monitored independently of browser connections; their terminal
result is checkpointed before session polling acknowledges clean state. Retain
two checkpoints per session, one geometry artifact and at most 32 user outputs.
The store defaults to 100 records and 2 GiB of retained artifacts
(`AGENT_SLICER_SESSION_MAX_BYTES`); delete completed/abandoned records to reclaim
space. Individual files use the existing upload/file limit. Uploaded inputs and prepared-ticket reservations count toward the quota. Inputs
remain owned until release, expiry, restore or deletion cleans them up; recovery
uses checkpoints rather than those workspace files.

Checkpoint publication copies with bounded buffers and verifies byte count and
SHA-256, syncs the destination, renames it, syncs the directory, then updates
SQLite. A failed save preserves the previous acknowledged checkpoint and leaves
the session dirty. A crash can lose work after that checkpoint. Failed or
interrupted native jobs are not automatically replayed. Browser disconnection
does not cancel jobs or release ownership.

Leases reuse `AGENT_SLICER_POOL_LEASE_TTL_MS` (30 minutes by default). Heartbeats
and commands extend ownership. Explicit transfer checkpoints the project,
rotates the editing capability and records human/agent identity. Release saves
and resets the worker; completion does the same and closes the record;
abandonment discards uncheckpointed work and resets the worker. Completion and
abandonment are idempotent. Expiry cancels tracked jobs, checkpoints, resets and
releases capacity. Observed same-project revision changes remain dirty until the monitor saves a
checkpoint, including adapter-only restarts and geometry exports. Failed output
collection does not prevent other jobs from checkpointing. A native restart is
detected by binding mismatch; reopening
restores the last checkpoint. A store whose worker has an unmanaged legacy
project refuses to overwrite it.

## Authenticated session HTTP routes

All routes retain the outer bearer token and Host/Origin policy. A trusted
application server supplies `owner_id` at creation and `x-agent-slicer-owner`
when listing. These are application identities, not user-entered authentication.
Full native `project_restore` is internal to the checksum-verified checkpoint
service. It is absent from public MCP/HTTP command discovery and cannot be
called through either command transport or scoped session commands. Uploaded
models use geometry-only import; they do not become trusted configuration.

- `POST /api/v1/sessions`: `{owner_id, creation_key, title}`. Creation is
  idempotent per owner/key and returns `{session, token}`.
- `GET /api/v1/sessions`: list the supplied owner's records.
- `GET /api/v1/sessions/<id>`: metadata, never an editing credential.
- `POST .../open`: `{actor:{kind:"human"|"agent",id}}`, returning metadata and
  `lease_token`. `heartbeat` extends it; `transfer` takes a new actor and rotates it.
- `POST .../checkpoint`, `release`, `complete`, `abandon`; `DELETE .../<id>`
  removes only a completed or abandoned record and its private files.
- `POST .../commands/<name>`: validated native parameters, returning
  `{result, session}`. Native project/revision checks still apply. Import paths
  and job IDs must belong to this session; output filenames are server-generated.
- `POST .../uploads`: existing `{filename,bytes,sha256}` preparation. Upload bytes
  with PUT to its returned scoped `upload_path`, preserving Content-Length.
- `GET .../events?job_id=<owned-id>`: bounded one-second `snapshot` SSE. This is
  sampled state with no replay cursor, not a durable event delivery guarantee.

Every per-session route requires `x-agent-slicer-session-token`. Editing,
commands and uploads additionally require `x-agent-slicer-lease-token`. Read and
editing capabilities are independent. Do not expose worker/session/lease secrets
in browser JSON, URLs, logs or geometry. The monorepo Bun server stores them in
private local files and binds its HttpOnly cookie to an owner. This private local
boundary is not production operator SSO.

## Geometry contract

`POST .../geometry` takes `{expected_revision}` and returns artifact ID,
project/revision, byte count and SHA-256. Native code snapshots the model and
metadata on the GUI thread, then serializes off-thread. Mesh arrays never pass
through the bounded JSON bridge. Objects, volumes, instances and plates retain
native IDs. Volume roles include printable parts and modifiers such as negative
parts; the renderer must deliberately style/filter roles rather than merging
them into printable geometry.

The `.scene.bin` container starts with eight ASCII bytes `ASGEOM01`, followed by
little-endian uint32 padded JSON length and a reserved zero uint32. Padded UTF-8
JSON follows, then contiguous little-endian float32 XYZ positions and uint32
triangle indices. Manifest buffer offsets are relative to that binary section.
The manifest is bounded by the native bridge JSON limit; the container is bounded
by the native archive-entry limit and adapter file/storage limits.

The manifest declares schema version 1, millimeters, Z up, a right-handed frame,
column-major affine 4x4 matrices and counter-clockwise local triangle winding.
World positions are `instance.transform * volume.transform * position`.
Mirrors remain in the full matrices; instance `mirrored` flags indicate negative
determinants. Preserve indices and use the determinant when rendering reflected
winding. No axis conversion, recentering or reinterpretation of original uploads
is needed. Plate metadata uses native origins, sizes and assignments.

Native plate lookup uses registration and a cached outside-state set. Refresh
every instance of an affected object after programmatic import, transformation or restore,
before acknowledging the mutation or checkpointing it. Otherwise a newly
oversized instance can falsely report a printable plate until restore rebuilds
the cache. The scoped geometry-only registration policy prevents interactive
vase prompts and implicit vase-setting changes. A `plate_index` of `-1` means no
fully containing printable plate. Overlapping multi-plate ownership remains
outside the qualified fixture corpus; native 3MF loading reconstructs membership.

`GET .../artifacts/<artifact-id>/manifest` adds authorized session, project,
revision and artifact identity. `/binary` streams only the buffer section; the
plain artifact route downloads the entire container. Stale geometry returns 409,
and unknown or foreign-session artifacts return 404 after session authorization.
The browser decoder validates identity, lengths, finite vertices, triangle
indices, references and matrix shape before constructing renderer buffers.
Geometry is a revision-scoped snapshot, not a persistence format for recovery.

## Toolpath contract

`POST .../toolpaths` takes `{expected_revision, slice_job_id}` for a succeeded
`slice_start` job of the session and returns `{artifact_id, bytes}`; the same
slice at the same revision reuses its artifact. Native copies the plate's
G-code move columns on the GUI thread and encodes them off-thread with
`toolpath_export`. The adapter keeps at most eight toolpath artifacts, all of
the current revision; older or stale ones are removed, and stale ones return
409 from the artifact route.

The `.toolpath.bin` container starts with `ASTP0001`, a little-endian uint32
padded JSON length and a reserved zero uint32, then padded UTF-8 JSON and the
binary section. The manifest lists `plate_index`, the vertex `count`, the top Z
of each layer, Orca's line-type `roles` (native ExtrusionRole id, key, label,
color), the native `move_types` ids, the option rows' colors and the 4-byte
aligned `buffers`: float32 XYZ positions, float32 widths and heights, uint32
layers and uint8 move types, line types and extruders, one entry per move
vertex. A segment runs from the previous vertex to its own position, like
Orca's G-code viewer. Download it through the plain artifact route.
