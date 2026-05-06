---
"@supabase/pg-delta": minor
---

perf(extractDepends): split monolithic DEPENDS_SQL via OID-map (-77% steady-state extract)

`extractDepends` previously executed a single 1370-line `DEPENDS_SQL`
that materialised the catalog-dependency graph entirely server-side: a
30-branch `objects` CTE formatted stable-ids for every `pg_depend` OID,
then a `base` CTE joined `pg_depend × objects` on both sides to produce
edge tuples. The intermediate `base` was scanned 6+ times by the
downstream synthesised CTEs (comments, view-rewrite rels/cols, FK
constraints, ownership, publications, FDW, etc.), and its size grew with
the square of distinct (classid, objid) pairs.

The refactor moves stable-id construction from SQL to TS:

- `RAW_DEPENDS_SQL` returns raw `pg_depend` tuples
  (classid/objid/objsubid + ref triple + deptype) for `deptype IN
  ('n','a')`.
- `OID_IDENTITY_SQL` returns a `(classid, objid, objsubid) → (schema,
  stable_id)` table, derived from the previous `objects` CTE without
  the cross-join against `pg_depend`.
- The trimmed `DEPENDS_SQL` keeps only the synthesised per-class CTEs
  whose (dependent, referenced, deptype) tuples are *not* already in
  `pg_depend` (or that need a different join shape than the base
  translator).
- A new TS `translateRawDepends` joins the raw tuples to identity rows
  via a `Map`, replacing the SQL `base` CTE with O(N) JS lookups.

`extractCatalog` runs all four queries in `Promise.all` (raw depends,
identity, synth depends, privilege/membership) and concatenates the
results without a cross-source dedup — see the comment block in
`extractDepends` for why the four sources' (dependent, referenced,
deptype) tuples are disjoint by construction.

### Bench

`bench:e2e` + `bench:quick-extract`, pg17 supabase image,
N=400-table synthetic schema, p50 of 5 iterations.

Steady-state (post-`ANALYZE`, the realistic case for any
already-warm production database):

| | before (`ba7d67c`) | after | |
|---|---|---|---|
| `extractCatalog` wall | 755.67 ms | **171.29 ms** | **−77%** |
| `extractDepends` (prod) | 702.06 ms | 93.61 ms | −87% |
| `DEPENDS_SQL` only | 644.80 ms | 71.24 ms | −89% |

Cold-start (freshly-loaded schema, planner statistics still stale —
typical immediately after a bulk-import migration):

| | before (`ba7d67c`) | after | |
|---|---|---|---|
| `extractCatalog` wall | ~6700 ms | 6415.06 ms | ~−5% |

Both cold-start runs spend ~98% of wall time inside the synthesised
`DEPENDS_SQL` (which still does heavy `pg_depend × pg_class × …`
joins). Running `ANALYZE` against the target database before extracting
collapses cold-start back to the steady-state row above; pg-delta does
not run `ANALYZE` itself because mutating server state inside a
read-only extractor is a footgun.

### Behaviour

No observable change to `catalog.depends` for any tested scenario
(integration suite, declarative export, supabase-base-init, dbdev
roundtrip). The OID-split is a pure refactor that moves work from SQL
to JS without changing the (dependent_stable_id, referenced_stable_id,
deptype) tuple set the extractor returns.

Refs #250.
