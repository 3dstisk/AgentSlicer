# AgentSlicer MCP API v1

AgentSlicer exposes OrcaSlicer through a Node.js MCP adapter and a native C++
bridge inside the same container:

`MCP client → Streamable HTTP /mcp → Node adapter → Unix socket → Orca GUI thread`

Model bytes use the same authenticated origin through one-time
`PUT /uploads/<upload_id>` requests and are published beneath `/workspace` only
after exact length and SHA-256 verification.
Generated files use that origin and bearer authentication through
`GET /outputs/<filename>`.

The native protocol version reported by `slicer_status` is `1`. MCP tool inputs
and outputs are JSON; renders and desktop captures also return MCP image content.
`GET /livez` checks the adapter process, while `GET /readyz` and `/healthz`
check the native bridge.

## Transport and access control

The default endpoint is `http://127.0.0.1:8765/mcp`. When configured, every MCP
request, upload, and output download must send
`Authorization: Bearer <AGENT_SLICER_TOKEN>`.
Binding outside loopback without a token is rejected at startup.

`AGENT_SLICER_ALLOWED_HOSTS` and `AGENT_SLICER_ALLOWED_ORIGINS` are comma-separated
host allowlists. The `Host` header is always checked; an `Origin` header is
checked when present. Keep the default loopback values for local use. For remote
use, publish only through a trusted TLS proxy and configure exact public hosts.

## Tools

The v1 tool list and order are fixed:

| Tool | Contract |
| --- | --- |
| `slicer_status` | Return readiness, native protocol version, active project/revision, job count, and capabilities. |
| `upload_prepare` | Create a single-use upload ticket for a named `.stl`, `.obj`, `.3mf`, `.step`, or `.stp` with an exact byte count and SHA-256. |
| `project_create` | Reset Orca to one empty active project; return `project_id` and new `revision`. |
| `model_import` | Start import of an `.stl`, `.obj`, `.3mf`, `.step`, or `.stp` from an absolute `/workspace/...` path and return a job. |
| `scene_get` | Return objects, instances, transforms, bounds, plates, and current revision. |
| `object_transform` | Apply an absolute or relative position/rotation/scale and optional `place_on_bed`. |
| `object_auto_orient` | Start native auto-orient for exact object/instance targets, or all printable unlocked instances when targets are omitted. |
| `scene_arrange` | Start native arrangement and return a job. |
| `scene_render` | Render 1–6 unique views: `iso`, `top`, `front`, `rear`, `left`, `right`, `bottom`, or `top_front`; dimensions are 64–2048 pixels. |
| `desktop_capture` | Capture the full Orca desktop for diagnostics, including dialogs. |
| `presets_list` | List exact printer/process/filament names, selection, and compatibility. |
| `presets_select` | Atomically select exact names; filament names are ordered by extruder. |
| `settings_describe` | Discover paginated setting descriptors by scope/query. |
| `settings_get` | Read typed values for exact setting keys. |
| `settings_apply` | Atomically validate/apply typed changes; `dry_run: true` validates without mutation. |
| `slice_start` | Start slicing one zero-based plate and return a job. |
| `job_get` | Poll job state, progress, warnings, result, error, and revision. |
| `gcode_export` | Publish a successful slice as one root-level `.gcode` file under `/outputs`. |
| `project_save` | Publish the active project as one root-level `.3mf` file under `/outputs`. |

Unknown fields are rejected. Opaque IDs and cursors must be copied exactly, not
parsed or constructed by clients.

## Uploads and MCP documentation

Clients can discover the detailed upload workflow through the static MCP
resource `agentslicer://docs/upload` using `resources/list` and
`resources/read`. The `upload_prepare` and `model_import` tool descriptions also
reference that resource for clients that do not load MCP resources automatically.

Call `upload_prepare` with a root-level supported filename, positive byte count,
and lowercase or uppercase SHA-256. It returns:

- a one-time `upload_path` beneath `/uploads`
- the future `/workspace/uploads/...` path to pass to `model_import`
- required method, content type, content length, and expiry metadata

Resolve `upload_path` against the MCP endpoint origin, then send the raw file:

```http
PUT /uploads/00000000-0000-4000-8000-000000000000 HTTP/1.1
Authorization: Bearer <AGENT_SLICER_TOKEN>
Content-Type: application/octet-stream
Content-Length: <exact upload_prepare bytes>

<raw STL, OBJ, 3MF, STEP, or STP bytes>
```

Tickets are consumed by the first authenticated `PUT`, including a failed one,
and expire after 15 minutes by default. The server writes to a private staging
file, rejects length or checksum mismatches, and publishes with a non-replacing
atomic hard link. Failed uploads leave no importable partial file. Configure the
byte limit with `AGENT_SLICER_MAX_UPLOAD_BYTES` and the ticket lifetime with
`AGENT_SLICER_UPLOAD_TTL_MS`. The upload limit defaults to
`AGENT_SLICER_MAX_IMPORT_BYTES` when that variable is set, otherwise 512 MiB.

## Output downloads

Resolve a successful `gcode_export` or `project_save` result path against the MCP
endpoint origin and send the same bearer token used for MCP:

```http
GET /outputs/part.gcode HTTP/1.1
Authorization: Bearer <AGENT_SLICER_TOKEN>
```

`GET /outputs/` returns the sorted paths of downloadable root-level `.gcode`
and `.3mf` files. `GET` and `HEAD` are the only accepted methods. Downloads are
served as attachments with `application/octet-stream`, no content sniffing, and
no caching. Unsupported files, directories, traversal attempts, and symbolic
links are not served.

## Projects, revisions, and jobs

Only one project is active. `project_create` replaces it and invalidates earlier
project IDs. Every mutating request requires both `project_id` and
`expected_revision`; a mismatch returns `revision_conflict`. Reads return the
revision they observed. `presets_list`, `settings_describe`, `settings_get`,
`scene_render`, and `desktop_capture` accept an optional `expected_revision`;
`scene_get` takes only `project_id`.

`desktop_capture` validates the requested project state both before and after
its potentially slow capture. Any project ID or revision drift during capture,
including when `expected_revision` was omitted, discards the captured bytes and
returns `revision_conflict`; a post-capture `project_not_found` caused by a
replacement project is reported the same way.

Project, scene, and configuration mutations advance the revision when they take
effect. Selecting already-selected presets is revision-neutral. A non-dry-run
settings batch is all-or-nothing; `dry_run` does not advance the revision. At
most one mutating asynchronous job is active, otherwise the operation returns
`mutation_in_progress`.

`object_auto_orient`, `scene_arrange`, `slice_start`, and `gcode_export` return
`{job_id, state:"running"}`. `model_import` and `project_save` register the job
before invoking Orca, so they may instead return `{job_id, state:"failed"}` if
native startup fails; retain that `job_id` and poll `job_get` for its stable
failure. Otherwise poll every started job until `succeeded`, `failed`, or
`cancelled`. Every job reports:

- `project_id` and immutable `source_revision`
- `state`, monotonic `progress` from 0 to 1, and current project `revision`
- `warnings[]`, nullable `error`, nullable `result`, and type-specific `metadata`

`model_import` always exposes `metadata: {}` (including immediate startup
failure); native bridge implementations must not serialize that field as `null`.

Each configuration snapshot contains `schema_version: 2`, its source `revision`,
selected `presets`, a safe string map of serialized global `settings`, a stable
`overrides` array, sorted unique `redacted_keys`, the lowercase `sha256` of the
bounded canonical complete configuration, and its canonical byte count. Each
override has `kind` (`object`, `volume`, or `plate`), its stable `identity`, safe
visible `settings`, and an `effective_sha256` covering the complete effective
configuration at that scope. Redacted entries retain provenance as
`global/<key>`, `object_N/<key>`, `object_N/volume_N/<key>`, or `plate_N/<key>`;
the unsafe value itself is never returned. Native snapshot canonical data and
the final controller-produced snapshot envelope (including its revision and
presets) are each bounded to 512 KiB; override arrays are bounded to 4096
entries, and each serialized value is limited to 64 KiB.
Settings and `redacted_keys` have no independent count cap: their total bytes
remain bounded by the snapshot limits. Unsafe values participate only in in-memory hashes. Auto-orient succeeds with
`{oriented:true}`, places its targets on the bed, and advances the project revision.
Arrange succeeds with `{arranged:true}` and advances the project revision. Model import has empty
metadata and succeeds with `{project_id,revision,object_ids}` while advancing
the project revision. Slice metadata adds its
plate to the same snapshot. G-code export inherits the exact snapshot from its
source slice; project saves capture the current configuration. Exports and saves
publish only after their trusted staged file is complete. A failed job carries
the same stable error object shape as a synchronous tool error.

`project_save` completes and bounds configuration preparation before native
serialization starts. A preparation failure returns a registered failed job
with `metadata.output_path` but no snapshot, and does not invoke the native save
callback. Every successfully started save includes the complete v2
`metadata.config_snapshot`.

Agent v1 project saves preserve the model, scalar project metadata, embedded
presets, effective configuration, and plate data. They intentionally omit
regenerating plate preview thumbnails so 3MF serialization can run off the GUI
thread without accessing OpenGL state. Orca's normal interactive Save path is
unchanged and continues to generate its usual thumbnails.

## Settings and units

Use `settings_describe` before reading or changing a setting. A descriptor is
authoritative for:

- `key`, `scope` (`printer`, `process`, or `filament`), label, and description
- native `type`, `nullable`, `read_only`, and `unit`
- numeric `min`, `max`, `max_literal`, and declared `enum_values`

Values are typed JSON: null, boolean, finite number, string, arrays/nested arrays,
or `{value:number, percent:boolean}` for float-or-percent values. Do not infer
units or coerce strings and numbers. Filament settings use a zero-based
`filament_index` (default 0 in requests); non-filament settings must not include
it. A request may contain up to 256 unique settings. Host credentials, host
paths/URLs, plugins, executables/commands, host-side scripts, and post-processing
settings are excluded from discovery and rejected by read/apply operations.
Normal G-code settings remain available because they affect generated printer
instructions rather than executing commands on the AgentSlicer host.

## Files and images

Imports use workspace-rooted file descriptors with no-symlink traversal and are
validated from the same descriptor snapshot used for loading. They must be
regular supported files beneath `/workspace`. The default import limit is
512 MiB and is configurable with `AGENT_SLICER_MAX_IMPORT_BYTES`.

Uploaded models are stored under `/workspace/uploads` with server-generated
UUID filenames and the validated lowercase source extension. Original client
filenames are retained only as ticket metadata and cannot select server paths.

`gcode_export` and `project_save` accept only a single root-level filename, with
the exact lowercase `.gcode` or `.3mf` extension. Absolute, nested, traversal,
symlink, and wrong-extension targets are rejected. `overwrite` defaults to
false. Successful results use absolute `/outputs/<filename>` paths. Output is
written to a private staging file and published atomically.

`scene_render` returns structured image metadata plus one `image/png` MCP content
item per requested view, in request order. It always returns the public
`top_front` vocabulary (never the native `topfront` spelling). `desktop_capture` returns one
diagnostic PNG. Returned paths are internal identifiers, not HTTP URLs; no
`/screenshots` route is published. Image files must be direct children of approved screenshot
roots. The adapter retains the root descriptor, opens the final file with
no-symlink semantics, validates and reads through that same descriptor, verifies
PNG structure/CRC/dimensions and requested render dimensions, and enforces the
`AGENT_SLICER_MAX_IMAGE_BYTES` limit (16 MiB by default). Cleanup is likewise
root-descriptor confined on Linux and is permitted only after a completed,
validated read has pinned the PNG's device/inode and metadata identity. A render
path with invalid native metadata or an invalid PNG is deliberately left
untouched: the adapter never deletes by an unverified pathname, so a file raced
into that name cannot be removed. MCP desktop capture streams ImageMagick's PNG
on stdout with a bounded subprocess buffer, so no shared screenshot pathname is
created, read, or cleaned up. The standalone capture helper writes through a
descriptor for a private runtime staging directory, copies into a descriptor-
pinned publication directory on the screenshot filesystem, and publishes with
a non-replacing hard link.
Oversized-image rejection is covered by adapter unit tests; it does not require
generating a giant GUI render.

## Stable error codes

Tool failures set `isError: true` and return
`{ok:false,error:{code,message,details?}}`. Native v1 error codes are:

`invalid_frame`, `message_too_large`, `invalid_json`, `invalid_request`,
`unknown_method`, `internal_error`, `request_timeout`, `shutting_down`,
`project_not_found`, `job_not_found`, `invalid_job_transition`,
`mutation_in_progress`, `revision_conflict`, `invalid_path`,
`unsupported_format`, `object_not_found`, and `render_failed`.

MCP schema failures are reported by the MCP SDK before native execution. Adapter
or image-validation failures use `mcp_adapter_error`.

`upload_prepare` may return `invalid_filename`, `invalid_size`,
`invalid_checksum`, `upload_too_large`, or `upload_storage_error`. The HTTP
upload endpoint uses status-specific JSON errors including `upload_not_found`,
`invalid_content_type`, `content_length_mismatch`, `checksum_mismatch`,
`upload_too_large`, `upload_conflict`, and `upload_storage_error`.

## Minimal agent loop

1. Call `slicer_status`; wait for `ready: true`.
2. For a local model, call `upload_prepare`, complete its authenticated PUT, and
   retain the returned `workspace_path`.
3. Call `project_create`.
4. Import the workspace model using the returned project revision.
5. Inspect with `scene_get`; transform, auto-orient, or arrange using the latest revision.
6. Select presets, discover settings, and apply typed changes.
7. Start slicing, poll its job, export its G-code, then optionally save the 3MF.

Example mutation and poll:

```json
{"name":"scene_arrange","arguments":{"project_id":"project_…","expected_revision":2}}
{"name":"job_get","arguments":{"job_id":"job_…"}}
```

After arrangement succeeds, use the job's new `revision` (or refresh with
`scene_get`) for the next mutation. Never retry a stale mutation without first
reading current state.
