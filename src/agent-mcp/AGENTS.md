# Agent adapter

Read the root agent guide and the relevant design in `docs/HLSD/` before changing
the native/MCP/HTTP boundary. Commands share validation and execution in
`tool-contract.ts`; session lifecycle owns worker access rather than duplicating
native project state. For editor session or geometry changes, read the
[session contract](../../../docs/HLSD/editor-sessions-and-geometry.md).

- Session checkpoint copying uses `copySessionFile`, which owns its source
  handle, bounds reads and writes, verifies bytes/checksums, syncs the destination
  and its directory before metadata publication, and closes all handles.
  Do not await `FileHandle.close()` on a finished writable stream created with
  `autoClose:false`: the stream can retain the handle indefinitely after finish.
- Session read capabilities and editing lease capabilities have separate scope.
  Never return lease credentials from a read operation or include credentials
  in URLs, structured logs, geometry manifests, or general output listings.
  After authenticating an editing capability, verify that its session is the
  active worker owner. A failed release metadata save can leave a stale binding
  and capability after ownership has already been cleared or reassigned.
- Full configuration restore uses verified checkpoints or the scoped
  `restore-upload` lifecycle route described in the session contract. Keep
  `project_restore` out of public MCP/HTTP command discovery and dispatch.
- Native IDs belong to one process/project incarnation. Persist native 3MF
  checkpoints and validate the active binding after restore; never reconstruct
  an editor project by importing geometry and guessing its configuration.
- Every observed native revision advance must persist `dirty=true` before
  updating the binding, including geometry reads and adapter-only recovery.
  Monitor jobs independently and retry dirty checkpoints even if another
  artifact fails. Dedicated editor stores own replacement projects across reset
  crash windows; unmanaged-project rejection still applies before first claim.
- Retain native output sources until artifact metadata commits. Reclaim
  unpublished copies on recovery and count owned input uploads in retention.
  Never regenerate a missing capability key for a store with existing records.
- New native operations require controller/facade tests and real-worker
  acceptance on an identified native image. Adapter schemas do not prove native
  implementation availability.
- Public tool changes also update the strict ordered discovery expectation in
  `e2e/docker-e2e.mjs`; run it against the built worker before release.
