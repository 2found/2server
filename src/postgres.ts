import type { Config } from "./config";

export const postgresAdmin = "two_admin";
export const postgresMigration = "two_migrator";
export function postgresInit(c: Config) {
  const p = c.extensions.postgres!;
  // Names are schema-validated identifiers. Passwords are read by the local
  // bootstrap administrator, never interpolated into shell arguments or logs.
  return `#!/bin/bash
set -euo pipefail
psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
CREATE ROLE two_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', '${p.username}', pg_read_file('/run/2server/app-password')) \\gexec
SELECT format('CREATE ROLE two_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', pg_read_file('/run/2server/migration-password')) \\gexec
GRANT two_owner TO two_migrator;
ALTER DATABASE "${p.database}" OWNER TO two_owner;
REVOKE ALL ON DATABASE "${p.database}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${p.database}" TO "${p.username}", two_migrator;
ALTER ROLE two_migrator IN DATABASE "${p.database}" SET role TO 'two_owner';
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO two_owner;
GRANT USAGE ON SCHEMA public TO "${p.username}";
ALTER DEFAULT PRIVILEGES FOR ROLE two_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${p.username}";
ALTER DEFAULT PRIVILEGES FOR ROLE two_owner GRANT USAGE, SELECT ON SEQUENCES TO "${p.username}";
ALTER DEFAULT PRIVILEGES FOR ROLE two_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SQL
touch "$PGDATA/.2server-roles-v1"
`;
}

export const postgresEntrypoint = `#!/bin/bash
set -euo pipefail
if [ -s "$PGDATA/PG_VERSION" ] && [ ! -f "$PGDATA/.2server-roles-v1" ]; then
  echo 'Unrecognized PostgreSQL role layout; refusing to modify existing data.' >&2
  exit 1
fi
install -d -o postgres -g postgres -m 700 /run/2server
for kind in admin app migration; do
  install -o postgres -g postgres -m 600 "/run/2server-input/$kind-password" "/run/2server/$kind-password"
done
install -m 755 /run/2server-input/init.sh /docker-entrypoint-initdb.d/10-2server.sh
mkdir -p /var/log/pgbackrest /var/spool/pgbackrest
chown postgres:postgres /var/log/pgbackrest /var/spool/pgbackrest
exec /usr/local/bin/docker-entrypoint.sh "$@"
`;
