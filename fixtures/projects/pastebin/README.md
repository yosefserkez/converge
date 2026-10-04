# Pastebin fixture patches

Fixture agents - no model calls.

These patches implement view-limited pastes ("burn after N views") on
SharzyL/pastebin-worker at the commit in `projects/pastebin/project.json`, after
the setup files in `projects/pastebin/setup/`. The manifest format is the same as
`fixtures/deterministic/`. Each patch file is a full replacement.

| Directory | Task | Change |
|---|---|---|
| `storage/` | `task-storage` | `views` upload field (1 to 1000), `maxViews` and `viewsRemaining` in metadata, one view per content read, delete after the last view, `no-store` for limited pastes |
| `api-ui/` | `task-api-ui` | "Max views" upload option, `--views N` in `scripts/pb`, "Remaining views: N" on the display page, docs |
| `delivery/` | `task-delivery` | Strong `ETag` from metadata, `If-None-Match` gets `304` before the content read |
| `repair/` | repair of storage + delivery | Limited pastes get no `ETag` and never `304`; unlimited pastes keep both |

Metadata fields (storage):

- `maxViews`: the limit that the upload set.
- `viewsRemaining`: the content reads that are left. A read returns the value after that read.
- Both fields are absent for a paste without a limit. Old metadata reads as unlimited.

The three feature patches edit different files, so they merge without conflicts.

Expected protected results (see `packages/verification/test/pastebin.test.ts`):

- Baseline, storage, api-ui, and delivery each pass their applicable checks and the project Vitest suite.
- Storage + delivery fails `views.cache-safety`: the limited paste sends an `ETag`, a matching
  `If-None-Match` gets `304` without a view, and the third read still returns the content.
- Storage + api-ui + delivery + repair passes every check.
