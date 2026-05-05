/**
 * Per-extractor breakdown of `extractCatalog` against a live Supabase Postgres
 * container (Docker).
 *
 * Run: `cd packages/pg-delta && bun run bench:extract-breakdown`
 *
 * Mirrors `bench:e2e`'s container/base-init/synthetic-schema setup, but
 * replaces the single `extractCatalog` timing with a per-extractor breakdown
 * so we can see which of the ~28 parallel queries dominate.
 *
 * Two passes per scenario:
 *   - "serial":   extractors run one-at-a-time; clean per-query cost (no
 *                  pool-queue contention with neighbours).
 *   - "parallel": extractors run via `Promise.all` exactly as `extractCatalog`
 *                  does in production; per-extractor duration here includes
 *                  pool-queue wait when N > pool size.
 *
 * Pool size: the production pool defaults to `PGDELTA_POOL_MAX=5`; the
 * "parallel" wall therefore reflects ≈5-way concurrency, not 28-way.
 */

import type { Pool } from "pg";
import { extractCurrentUser, extractVersion } from "../src/core/context.ts";
import { extractDepends } from "../src/core/depend.ts";
import { extractAggregates } from "../src/core/objects/aggregate/aggregate.model.ts";
import { extractCollations } from "../src/core/objects/collation/collation.model.ts";
import { extractDomains } from "../src/core/objects/domain/domain.model.ts";
import { extractEventTriggers } from "../src/core/objects/event-trigger/event-trigger.model.ts";
import { extractExtensions } from "../src/core/objects/extension/extension.model.ts";
import { extractForeignDataWrappers } from "../src/core/objects/foreign-data-wrapper/foreign-data-wrapper/foreign-data-wrapper.model.ts";
import { extractForeignTables } from "../src/core/objects/foreign-data-wrapper/foreign-table/foreign-table.model.ts";
import { extractServers } from "../src/core/objects/foreign-data-wrapper/server/server.model.ts";
import { extractUserMappings } from "../src/core/objects/foreign-data-wrapper/user-mapping/user-mapping.model.ts";
import { extractIndexes } from "../src/core/objects/index/index.model.ts";
import { extractMaterializedViews } from "../src/core/objects/materialized-view/materialized-view.model.ts";
import { extractProcedures } from "../src/core/objects/procedure/procedure.model.ts";
import { extractPublications } from "../src/core/objects/publication/publication.model.ts";
import { extractRlsPolicies } from "../src/core/objects/rls-policy/rls-policy.model.ts";
import { extractRoles } from "../src/core/objects/role/role.model.ts";
import { extractRules } from "../src/core/objects/rule/rule.model.ts";
import { extractSchemas } from "../src/core/objects/schema/schema.model.ts";
import { extractSequences } from "../src/core/objects/sequence/sequence.model.ts";
import { extractSubscriptions } from "../src/core/objects/subscription/subscription.model.ts";
import { extractTables } from "../src/core/objects/table/table.model.ts";
import { extractTriggers } from "../src/core/objects/trigger/trigger.model.ts";
import { extractCompositeTypes } from "../src/core/objects/type/composite-type/composite-type.model.ts";
import { extractEnums } from "../src/core/objects/type/enum/enum.model.ts";
import { extractRanges } from "../src/core/objects/type/range/range.model.ts";
import { extractViews } from "../src/core/objects/view/view.model.ts";
import { createPool } from "../src/core/postgres-config.ts";
import {
  POSTGRES_VERSION_TO_SUPABASE_POSTGRES_TAG,
  type SupabasePostgresVersion,
} from "../tests/constants.ts";
import { SupabasePostgreSqlContainer } from "../tests/supabase-postgres.ts";
import { applySupabaseBaseInit, waitForPool } from "../tests/utils.ts";
import { generateLargeSchemaSql } from "./large-schema-generator.ts";
import { formatMarkdownTable, nsToMs } from "./utils.ts";

const WARMUP = 2;
const ITERS = 5;

const E2E_TABLE_COUNT = Number(
  process.env.BENCH_E2E_TABLE_COUNT ?? process.env.BENCH_TABLE_COUNT ?? "400",
);
if (
  !Number.isInteger(E2E_TABLE_COUNT) ||
  E2E_TABLE_COUNT < 1 ||
  E2E_TABLE_COUNT > 50_000
) {
  console.error(
    `[bench:extract-breakdown] BENCH_E2E_TABLE_COUNT / BENCH_TABLE_COUNT must be integer 1..50000, got ${String(process.env.BENCH_E2E_TABLE_COUNT ?? process.env.BENCH_TABLE_COUNT ?? "400")}`,
  );
  process.exit(1);
}

// Disable retries so transient `pg_get_*def() = NULL` cases do not double-count
// query cost. The DBs we bench are static during measurement.
const RETRY_OPTIONS = { retries: 0, backoffMs: 0 };

type ExtractorEntry = {
  label: string;
  run: (pool: Pool) => Promise<unknown>;
  /** Returned count of rows for this extractor (for size context). */
  count?: (result: unknown) => number;
};

const lenOf = (result: unknown) =>
  Array.isArray(result) ? result.length : Number.NaN;

const EXTRACTORS: ExtractorEntry[] = [
  { label: "aggregates", run: (p) => extractAggregates(p), count: lenOf },
  { label: "collations", run: (p) => extractCollations(p), count: lenOf },
  {
    label: "compositeTypes",
    run: (p) => extractCompositeTypes(p),
    count: lenOf,
  },
  { label: "domains", run: (p) => extractDomains(p), count: lenOf },
  { label: "enums", run: (p) => extractEnums(p), count: lenOf },
  { label: "extensions", run: (p) => extractExtensions(p), count: lenOf },
  {
    label: "indexes",
    run: (p) => extractIndexes(p, RETRY_OPTIONS),
    count: lenOf,
  },
  {
    label: "materializedViews",
    run: (p) => extractMaterializedViews(p, RETRY_OPTIONS),
    count: lenOf,
  },
  { label: "subscriptions", run: (p) => extractSubscriptions(p), count: lenOf },
  { label: "publications", run: (p) => extractPublications(p), count: lenOf },
  {
    label: "procedures",
    run: (p) => extractProcedures(p, RETRY_OPTIONS),
    count: lenOf,
  },
  { label: "rlsPolicies", run: (p) => extractRlsPolicies(p), count: lenOf },
  { label: "roles", run: (p) => extractRoles(p), count: lenOf },
  { label: "schemas", run: (p) => extractSchemas(p), count: lenOf },
  { label: "sequences", run: (p) => extractSequences(p), count: lenOf },
  {
    label: "tables",
    run: (p) => extractTables(p, RETRY_OPTIONS),
    count: lenOf,
  },
  {
    label: "triggers",
    run: (p) => extractTriggers(p, RETRY_OPTIONS),
    count: lenOf,
  },
  { label: "eventTriggers", run: (p) => extractEventTriggers(p), count: lenOf },
  {
    label: "rules",
    run: (p) => extractRules(p, RETRY_OPTIONS),
    count: lenOf,
  },
  { label: "ranges", run: (p) => extractRanges(p), count: lenOf },
  {
    label: "views",
    run: (p) => extractViews(p, RETRY_OPTIONS),
    count: lenOf,
  },
  {
    label: "foreignDataWrappers",
    run: (p) => extractForeignDataWrappers(p),
    count: lenOf,
  },
  { label: "servers", run: (p) => extractServers(p), count: lenOf },
  { label: "userMappings", run: (p) => extractUserMappings(p), count: lenOf },
  { label: "foreignTables", run: (p) => extractForeignTables(p), count: lenOf },
  { label: "depends", run: (p) => extractDepends(p), count: lenOf },
  { label: "version", run: (p) => extractVersion(p) },
  { label: "currentUser", run: (p) => extractCurrentUser(p) },
];

function median(nums: readonly number[]): number {
  if (nums.length === 0) return Number.NaN;
  const s = [...nums].sort((a, b) => a - b);
  const v = s[Math.floor(s.length / 2)];
  return v === undefined ? Number.NaN : v;
}

interface PerExtractorStats {
  serialP50Ns: number;
  parallelP50Ns: number;
  count: number;
}

interface ScenarioResult {
  perExtractor: Map<string, PerExtractorStats>;
  serialSumP50Ns: number;
  parallelWallP50Ns: number;
}

async function runScenario(
  pool: Pool,
  scenario: string,
): Promise<ScenarioResult> {
  // Per-iteration samples: extractor -> [ns, ns, ...]
  const serialSamples = new Map<string, number[]>();
  const parallelSamples = new Map<string, number[]>();
  const counts = new Map<string, number>();
  const serialSumSamples: number[] = [];
  const parallelWallSamples: number[] = [];

  for (const e of EXTRACTORS) {
    serialSamples.set(e.label, []);
    parallelSamples.set(e.label, []);
  }

  for (let i = 0; i < WARMUP + ITERS; i++) {
    // ── Serial pass ──
    let serialSum = 0;
    for (const e of EXTRACTORS) {
      const t0 = Bun.nanoseconds();
      const result = await e.run(pool);
      const dt = Bun.nanoseconds() - t0;
      serialSum += dt;
      if (i >= WARMUP) {
        serialSamples.get(e.label)?.push(dt);
        if (e.count) counts.set(e.label, e.count(result));
      }
    }
    if (i >= WARMUP) serialSumSamples.push(serialSum);

    // ── Parallel pass (matches production `extractCatalog`) ──
    const wallStart = Bun.nanoseconds();
    const perExtractorDurations = await Promise.all(
      EXTRACTORS.map(async (e) => {
        const t0 = Bun.nanoseconds();
        await e.run(pool);
        return [e.label, Bun.nanoseconds() - t0] as const;
      }),
    );
    const wall = Bun.nanoseconds() - wallStart;
    if (i >= WARMUP) {
      parallelWallSamples.push(wall);
      for (const [label, dt] of perExtractorDurations) {
        parallelSamples.get(label)?.push(dt);
      }
    }
  }

  const perExtractor = new Map<string, PerExtractorStats>();
  for (const e of EXTRACTORS) {
    perExtractor.set(e.label, {
      serialP50Ns: median(serialSamples.get(e.label) ?? []),
      parallelP50Ns: median(parallelSamples.get(e.label) ?? []),
      count: counts.get(e.label) ?? Number.NaN,
    });
  }

  console.error(
    `[bench:extract-breakdown] scenario=${scenario} done (${ITERS} iters, ${WARMUP} warmup)`,
  );

  return {
    perExtractor,
    serialSumP50Ns: median(serialSumSamples),
    parallelWallP50Ns: median(parallelWallSamples),
  };
}

function printScenario(
  pgVersion: SupabasePostgresVersion,
  scenario: string,
  result: ScenarioResult,
) {
  const totalSerial = result.serialSumP50Ns;
  const rows = [...result.perExtractor.entries()]
    .sort((a, b) => b[1].serialP50Ns - a[1].serialP50Ns)
    .map(([label, s]) => {
      const pct = totalSerial > 0 ? (100 * s.serialP50Ns) / totalSerial : 0;
      return [
        label,
        Number.isFinite(s.count) ? String(s.count) : "—",
        nsToMs(s.serialP50Ns),
        `${pct.toFixed(1)}%`,
        nsToMs(s.parallelP50Ns),
      ];
    });

  console.log(`\n### pg${pgVersion} — ${scenario}\n`);
  console.log(
    `serialSum p50: **${nsToMs(result.serialSumP50Ns)} ms**, ` +
      `parallel wall p50: **${nsToMs(result.parallelWallP50Ns)} ms** ` +
      `(speedup ≈ ${(result.serialSumP50Ns / Math.max(1, result.parallelWallP50Ns)).toFixed(2)}×)\n`,
  );
  console.log(
    formatMarkdownTable(
      ["extractor", "rows", "serial p50 ms", "% serial", "parallel p50 ms"],
      rows,
    ),
  );
}

const versionsRaw = process.env.PGDELTA_TEST_POSTGRES_VERSIONS?.split(",") ?? [
  "17",
];
const versions = versionsRaw
  .map((v) => Number(v) as SupabasePostgresVersion)
  .filter((v) => v in POSTGRES_VERSION_TO_SUPABASE_POSTGRES_TAG);

if (versions.length === 0) {
  console.log(
    "No valid Supabase postgres versions in PGDELTA_TEST_POSTGRES_VERSIONS",
  );
  process.exit(0);
}

console.error(
  `[bench:extract-breakdown] N=${E2E_TABLE_COUNT} tables; pool max=${process.env.PGDELTA_POOL_MAX ?? 5}; warmup=${WARMUP} iters=${ITERS}`,
);

type StartedSupabase = Awaited<
  ReturnType<InstanceType<typeof SupabasePostgreSqlContainer>["start"]>
>;

for (const pgVersion of versions) {
  const image = `supabase/postgres:${POSTGRES_VERSION_TO_SUPABASE_POSTGRES_TAG[pgVersion]}`;
  let pool: Pool | undefined;
  let container: StartedSupabase | undefined;
  try {
    container = await new SupabasePostgreSqlContainer(image).start();
    pool = createPool(container.getConnectionUri(), {
      connectionTimeoutMillis: 30_000,
    });
    await waitForPool(pool);
    await applySupabaseBaseInit(pool, pgVersion);

    const baseInit = await runScenario(pool, "base-init only");
    printScenario(pgVersion, "base-init only", baseInit);

    const largeSql = generateLargeSchemaSql({
      tableCount: E2E_TABLE_COUNT,
      includeSecurityLabels: process.env.BENCH_SECURITY_LABELS === "1",
      fdwLoopback: {
        host: "127.0.0.1",
        port: 5432,
        dbname: container.getDatabase(),
        user: container.getUsername(),
        password: container.getPassword(),
      },
    });
    await pool.query(largeSql);
    const synthetic = await runScenario(
      pool,
      `+ synthetic schema (N=${E2E_TABLE_COUNT})`,
    );
    printScenario(
      pgVersion,
      `+ synthetic schema (N=${E2E_TABLE_COUNT})`,
      synthetic,
    );
  } catch (e) {
    console.error(`[bench:extract-breakdown] pg${pgVersion} failed:`, e);
    console.error(
      "Ensure Docker is running and the Supabase image can be pulled.",
    );
    process.exitCode = 1;
    break;
  } finally {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  }
}
