import type { Config } from "../../../../config/application/config";
import { extensionProject } from "../../../application/stateful";

// Opt-in per-statement statistics (`statementStats: {}`): preload
// pg_stat_statements and create its view in the configured database plus any
// listed one. The library loads only at server start, so turning it on (or
// changing `max`) recreates the container — a short restart for every client.
// Utility statements are not tracked: they are stored unnormalized, so an
// `ALTER ROLE … PASSWORD '…'` would otherwise keep its literal in shared memory.

function statementStatsDatabases(c: Config): string[] {
  const p = c.extensions.postgres!;
  return [...new Set([p.database, ...(p.statementStats?.databases ?? [])])];
}

export function statementStatsArgs(c: Config): string[] {
  const s = c.extensions.postgres!.statementStats;
  if (!s) return [];
  return ["-c", "shared_preload_libraries=pg_stat_statements", "-c", `pg_stat_statements.max=${s.max}`,
    "-c", "pg_stat_statements.track=top", "-c", "pg_stat_statements.track_utility=off"];
}

// Before rollout: a listed database that does not exist would fail `verify`
// after the restart and force a second one for the rollback, so refuse first.
// Skipped while the container is not running (fresh install).
export function statementStatsPreflight(c: Config): string {
  const p = c.extensions.postgres!;
  if (!p.statementStats) return "";
  const container = extensionProject(c, "postgres");
  // Names are schema-validated identifiers.
  return statementStatsDatabases(c).map((db) =>
    `if [ "$(docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null || true)" = true ]; then
  test "$(docker exec --user postgres ${container} psql -X -U two_admin -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '${db}'")" = 1 || { echo 'statementStats database ${db} does not exist' >&2; exit 1; }
fi`).join("\n");
}

// After compose up, inside the rollback trap: the library must be loaded, then
// the view is created (idempotent) and must answer in every listed database.
export function statementStatsVerify(c: Config): string {
  const p = c.extensions.postgres!;
  if (!p.statementStats) return "";
  const container = extensionProject(c, "postgres");
  return statementStatsDatabases(c).map((db) =>
    `docker exec -i --user postgres ${container} psql -X -U two_admin -d ${db} -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
DO $$ BEGIN
  IF NOT 'pg_stat_statements' = ANY (string_to_array(replace(current_setting('shared_preload_libraries'), ' ', ''), ',')) THEN
    RAISE EXCEPTION 'pg_stat_statements is not in shared_preload_libraries';
  END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT count(*) FROM pg_stat_statements;
SQL`).join("\n");
}
