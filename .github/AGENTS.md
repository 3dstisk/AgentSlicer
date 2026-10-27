# CI guidance

For external slicer regression failures, compare the pinned fixtures and baseline
with upstream's reviewed changes before updating expected output. Preserve hard
failure checks when updating a test harness. The two multicolor corrections in
`scripts/ci-slicer-baseline.json` come from orca-test-repo commit
`65ba1daf0e11be4c18c715315d48f4f3d55aa041`; the other entries match the pinned
runner's fixtures. Keep baseline provenance with the workflow that applies it.
