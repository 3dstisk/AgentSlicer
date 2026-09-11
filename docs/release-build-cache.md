# Release build caches

The Linux release opts into GHCR caching with `ghcr-cache: true` in
`.github/workflows/release-agent-slicer.yml`. It uses Blacksmith 8-vCPU Ubuntu
24.04 runners. No Sticky Disks or additional credentials are required. The build
job grants `packages: write` to its inherited `GITHUB_TOKEN`.

Both caches live in `ghcr.io/<owner>/<repository>-build-cache` and are independent
of the release tag. Other callers of the reusable workflows retain Actions caching.

## Dependencies

`deps-v1-linux-amd64-<hash>` holds `deps/build/OrcaSlicer_dep`, including file modes
and symlinks. The hash covers `deps/**`, `build_linux.sh`, the apt setup action,
the dependency build workflow, the runner label, and the checkout path. wxWidgets
embeds installation paths, so a prefix must be restored at its original path.

A missing image triggers a dependency build and upload. A hit skips that build
and restores the prefix directly into the compilation job. Authentication and
network failures fail the job instead of silently triggering an expensive rebuild.
Bump `deps-v1` in `build_check_cache.yml` when an untracked runner/toolchain change
requires rebuilding dependencies.

## Compiler results

`sccache-v1-linux-amd64` holds a snapshot of sccache's local disk cache. Each native
build restores it, uses the compiler-launcher support in `build_linux.sh`, prints
cache statistics, stops the server, and uploads the updated snapshot after a
successful build. The local cache limit is 5 GB. sccache checks compilation inputs
before reusing an entry; changing source does not require a new snapshot tag.

Concurrent releases can overwrite each other's snapshots. This can reduce cache
coverage but does not change compiled results. Releases are not serialized.

This approach transfers the snapshot on each native build. Measure restore/upload
time alongside cache hits before increasing the size limit. GHCR can retain old,
untagged image versions after tag replacement: the 5-GB limit bounds each local
snapshot, not total registry storage. Review old package versions periodically;
no automatic deletion is configured. Remove the compiler snapshot tag or bump
`sccache-v1` in `build_orca.yml` to start an empty compiler cache.

## Verification on releases

The first release populates missing caches. On a subsequent release with changed
native source but unchanged dependency inputs, check that the dependency lookup
reports `hit=true`, the dependency build is skipped, and compiler statistics show
cache hits. A release with unchanged native inputs can skip compilation entirely
using the existing native-image cache, so it cannot measure sccache performance.

Local checks for the directory-cache script covered misses, registry failures,
required restores, container cleanup on copy failure, and upload ordering.
A real, offline Docker round trip preserved file contents, executable mode,
symlinks, and the installation-prefix layout. GHCR permissions and full Linux
build performance still require verification in CI.
