import { describe, expect, test } from "bun:test";
import dedent from "dedent";
import { diffCatalogs } from "../../src/core/catalog.diff.ts";
import { extractCatalog } from "../../src/core/catalog.model.ts";
import { applyDeclarativeSchema } from "../../src/core/declarative-apply/index.ts";
import { exportDeclarativeSchema } from "../../src/core/export/index.ts";
import { createPlan } from "../../src/core/plan/create.ts";
import { sortChanges } from "../../src/core/sort/sort-changes.ts";
import { POSTGRES_VERSIONS, type PostgresVersion } from "../constants.ts";
import { withDb } from "../utils.ts";

const INITIAL_SETUP_SQL = dedent`
  CREATE SCHEMA my_schema;

  CREATE TABLE my_schema.tournaments (
    id integer PRIMARY KEY,
    visitors_total_count integer,
    start_date date,
    background_images text[],
    priority_override_score integer,
    priority_score integer
  );

  CREATE FUNCTION my_schema.update_priority_scores()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    NEW.priority_score = coalesce(NEW.priority_override_score, 0);
    RETURN NEW;
  END;
  $$;
`;

const TRIGGER_SQL = dedent`
  CREATE TRIGGER trg_update_priority_scores
  BEFORE INSERT OR UPDATE OF visitors_total_count, start_date, background_images, priority_override_score ON my_schema.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION my_schema.update_priority_scores();
`;

for (const pgVersion of POSTGRES_VERSIONS as PostgresVersion[]) {
  describe(`trigger UPDATE OF declarative roundtrip (pg${pgVersion})`, () => {
    test(
      "exported schema reapplies without recreating an unchanged trigger",
      withDb(pgVersion, async ({ main, branch }) => {
        await main.query(INITIAL_SETUP_SQL);
        await branch.query(INITIAL_SETUP_SQL);
        await branch.query(TRIGGER_SQL);

        const planResult = await createPlan(main, branch);
        if (!planResult) {
          throw new Error("createPlan returned null -- expected trigger changes");
        }

        const output = exportDeclarativeSchema(planResult);
        const applyResult = await applyDeclarativeSchema({
          content: output.files.map((file) => ({
            filePath: file.path,
            sql: file.sql,
          })),
          pool: main,
          disableCheckFunctionBodies: true,
          validateFunctionBodies: false,
        });

        if (applyResult.apply.status !== "success") {
          throw new Error(
            `Declarative apply failed (${applyResult.apply.status})`,
            { cause: applyResult },
          );
        }

        const mainCatalog = await extractCatalog(main);
        const branchCatalog = await extractCatalog(branch);
        const remainingChanges = diffCatalogs(mainCatalog, branchCatalog);

        if (remainingChanges.length > 0) {
          const sorted = sortChanges({ mainCatalog, branchCatalog }, remainingChanges);
          const remainingSql = sorted.map((change) => change.serialize()).join(";\n");
          console.error(
            `[trigger-update-of-declarative-roundtrip] ${remainingChanges.length} remaining change(s) after roundtrip:\n${remainingSql}`,
          );
        }

        expect(remainingChanges).toHaveLength(0);
      }),
      60 * 1000,
    );
  });
}
