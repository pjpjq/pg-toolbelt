import { describe, test } from "bun:test";
import { POSTGRES_VERSIONS } from "../constants.ts";
import { withDb } from "../utils.ts";
import { roundtripFidelityTest } from "./roundtrip.ts";

/**
 * Security-label integration tests use PostgreSQL's `dummy_seclabel` contrib
 * module, which registers the "dummy" provider. It ships with both the
 * official alpine images and the Supabase PostgreSQL images used in CI.
 */
const DUMMY_PROVIDER_SETUP = `CREATE EXTENSION IF NOT EXISTS dummy_seclabel;`;

for (const pgVersion of POSTGRES_VERSIONS) {
  describe(`security labels on schemas (pg${pgVersion})`, () => {
    test(
      "add label to new schema",
      withDb(pgVersion, async (db) => {
        await roundtripFidelityTest({
          mainSession: db.main,
          branchSession: db.branch,
          initialSetup: DUMMY_PROVIDER_SETUP,
          testSql: `
            CREATE SCHEMA labeled;
            SECURITY LABEL FOR dummy ON SCHEMA labeled IS 'classified';
          `,
        });
      }),
    );

    test(
      "add label to existing schema",
      withDb(pgVersion, async (db) => {
        await roundtripFidelityTest({
          mainSession: db.main,
          branchSession: db.branch,
          initialSetup: `
            ${DUMMY_PROVIDER_SETUP}
            CREATE SCHEMA labeled;
          `,
          testSql: `
            SECURITY LABEL FOR dummy ON SCHEMA labeled IS 'classified';
          `,
        });
      }),
    );

    test(
      "change label value",
      withDb(pgVersion, async (db) => {
        await roundtripFidelityTest({
          mainSession: db.main,
          branchSession: db.branch,
          initialSetup: `
            ${DUMMY_PROVIDER_SETUP}
            CREATE SCHEMA labeled;
            SECURITY LABEL FOR dummy ON SCHEMA labeled IS 'secret';
          `,
          testSql: `
            SECURITY LABEL FOR dummy ON SCHEMA labeled IS 'classified';
          `,
        });
      }),
    );

    test(
      "drop label",
      withDb(pgVersion, async (db) => {
        await roundtripFidelityTest({
          mainSession: db.main,
          branchSession: db.branch,
          initialSetup: `
            ${DUMMY_PROVIDER_SETUP}
            CREATE SCHEMA labeled;
            SECURITY LABEL FOR dummy ON SCHEMA labeled IS 'secret';
          `,
          testSql: `
            SECURITY LABEL FOR dummy ON SCHEMA labeled IS NULL;
          `,
        });
      }),
    );
  });
}
