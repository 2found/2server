import {extensionRoot,extensionProject} from '../../stateful';
import {instanceName,backupRoot} from '../instance';
import type { Config } from "../../config";

export function postgresHealthFiles(c: Config): Record<string, string> {
  const p = c.extensions.postgres!;
  return {
    "metrics.sh": `#!/bin/bash
set -euo pipefail
mkdir -p /opt/2server/metrics
chmod 755 /opt/2server/metrics
tmp=$(mktemp /opt/2server/metrics/.postgres.XXXXXX)
trap 'rm -f "$tmp"' EXIT
stamp() { value=$(cat "${backupRoot(c)}/$1" 2>/dev/null || true); if [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s' "$value"; else printf 0; fi; }
{
  printf 'two_postgres_metrics_timestamp_seconds %s\\n' "$(date +%s)"
  printf 'two_postgres_backup_required ${p.backup ? 1 : 0}\\n'
  printf 'two_postgres_backup_max_age_seconds ${(p.backup?.maxAgeHours ?? 26) * 3600}\\n'
  printf 'two_postgres_backup_last_success_seconds %s\\n' "$(stamp postgres-last-success-epoch)"
  printf 'two_postgres_backup_failed %s\\n' "$(stamp postgres-backup-failed)"
  printf 'two_postgres_restore_check_failed %s\\n' "$(stamp postgres-restore-check-failed)"
  printf 'two_postgres_restore_check_required ${p.backup?.engine === "pgbackrest" ? 1 : 0}\\n'
  printf 'two_postgres_restore_check_max_age_seconds ${(p.backup?.restoreCheckMaxAgeHours ?? 192) * 3600}\\n'
  printf 'two_postgres_restore_check_last_success_seconds %s\\n' "$(stamp postgres-last-restore-check-epoch)"
  printf 'two_postgres_archive_required ${p.backup?.engine === "pgbackrest" ? 1 : 0}\\n'
  if result=$(docker exec -i --user postgres -e PGOPTIONS=-cstatement_timeout=3000 ${extensionProject(c,"postgres")} psql -X -U two_admin -d ${p.database} -v ON_ERROR_STOP=1 -At 2>/dev/null <<'SQL'
SELECT 'two_postgres_connections ' || count(*) FROM pg_stat_activity;
SELECT 'two_postgres_max_connections ' || current_setting('max_connections');
SELECT 'two_postgres_blocked_connections ' || count(*) FROM pg_stat_activity WHERE wait_event_type='Lock';
SELECT 'two_postgres_oldest_transaction_seconds ' || coalesce(max(extract(epoch FROM now()-xact_start)),0) FROM pg_stat_activity WHERE pid <> pg_backend_pid();
SELECT 'two_postgres_archive_failures_total ' || failed_count FROM pg_stat_archiver;
SELECT 'two_postgres_last_archived_seconds ' || coalesce(extract(epoch FROM last_archived_time),0) FROM pg_stat_archiver;
SELECT 'two_postgres_last_archive_failed_seconds ' || coalesce(extract(epoch FROM last_failed_time),0) FROM pg_stat_archiver;
SELECT 'two_postgres_pending_wal_files ' || count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready';
SELECT 'two_postgres_wal_bytes ' || coalesce(sum(size),0) FROM pg_ls_waldir();
SQL
  ); then
    printf 'two_postgres_up 1\\n%s\\n' "$result"
  else
    printf 'two_postgres_up 0\\n'
  fi
} ${c.instance ? `| sed 's/^\\([^ ]*\\) /\\1{app="${c.instance.name}"} /'` : ''} > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" /opt/2server/metrics/${instanceName(c,"postgres")}.prom
`,
    "metrics.service": `[Unit]\nDescription=2server PostgreSQL metrics\nAfter=docker.service\n[Service]\nType=oneshot\nExecStart=/bin/bash ${extensionRoot("postgres",c)}/current/metrics.sh\nTimeoutStartSec=30s\n`,
    "metrics.timer": `[Unit]\nDescription=2server PostgreSQL metric collection\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nUnit=${extensionProject(c,"postgres")}-metrics.service\n[Install]\nWantedBy=timers.target\n`,
  };
}
export function postgresHealthInstall(c: Config) {
  const unit = `${extensionProject(c,"postgres")}-metrics`;
  return `install -m 644 ${extensionRoot("postgres",c)}/current/metrics.service /etc/systemd/system/${unit}.service
install -m 644 ${extensionRoot("postgres",c)}/current/metrics.timer /etc/systemd/system/${unit}.timer
systemctl daemon-reload
systemctl enable --now ${unit}.timer
systemctl start ${unit}.service`;
}
export const postgresAlertRules = `
  - name: postgres
    rules:
      - alert: PostgreSQLDown
        expr: two_postgres_up == 0
        for: 2m
      - alert: PostgreSQLMetricsStale
        expr: time() - two_postgres_metrics_timestamp_seconds > 180
        for: 2m
      - alert: PostgreSQLBackupOverdue
        expr: (time() - two_postgres_backup_last_success_seconds > two_postgres_backup_max_age_seconds) and (two_postgres_backup_required == 1)
        for: 5m
      - alert: PostgreSQLBackupFailed
        expr: (two_postgres_backup_failed == 1) and (two_postgres_backup_required == 1)
        for: 2m
      - alert: PostgreSQLRestoreCheckFailed
        expr: (two_postgres_restore_check_failed == 1) and (two_postgres_restore_check_required == 1)
        for: 2m
      - alert: PostgreSQLRestoreCheckOverdue
        expr: (time() - two_postgres_restore_check_last_success_seconds > two_postgres_restore_check_max_age_seconds) and (two_postgres_restore_check_required == 1)
        for: 5m
      - alert: PostgreSQLWALArchiveFailure
        expr: (((rate(two_postgres_archive_failures_total[5m]) > 0) and (two_postgres_last_archive_failed_seconds > two_postgres_last_archived_seconds)) or ((two_postgres_pending_wal_files > 0) and (time() - two_postgres_last_archived_seconds > 600))) and (two_postgres_archive_required == 1)
        for: 2m
      - alert: PostgreSQLConnectionsHigh
        expr: two_postgres_connections / two_postgres_max_connections > 0.8
        for: 5m
      - alert: PostgreSQLBlockedQueries
        expr: two_postgres_blocked_connections > 0
        for: 5m
      - alert: PostgreSQLLongTransaction
        expr: two_postgres_oldest_transaction_seconds > 300
        for: 5m
`;
