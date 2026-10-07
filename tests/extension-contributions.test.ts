import { expect,test } from 'bun:test';
import { mkdir,mkdtemp,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { configSchema } from '../src/modules/config/application/config';
import { portableStatePolicy } from '../src/modules/control/application/state-policy';
import { validateSnapshot } from '../src/modules/control/application/snapshot';
import { captureState } from '../src/modules/control/infrastructure/portable-state';
import { backupObjectAdminRequired,extensionAlertRules,extensionDiagnostics,extensionSummaries } from '../src/modules/extensions/application/contributions';
import { extensionRegistry } from '../src/modules/extensions/application/registry';
import type { Extension } from '../src/modules/extensions/domain/types';
import { monitoringFiles } from '../src/modules/extensions/infrastructure/templates/monitoring/hooks';

const base = {version:1,name:'audit',ssh:{kind:'ssh',host:'host.example',user:'operator'},edge:{mode:'managed'}};
test('native contributions use bound instance config; dump backups do not request object-admin and alerts are not duplicated', () => {
  const c = configSchema.parse({...base,extensionApps:{
    metrics: {template:'monitoring',spec:{zone:'example.com',hostname:'metrics.example.com'}},
    other: {template:'monitoring',spec:{zone:'example.com',hostname:'other.example.com',passwordEnv:'METRICS_PASSWORD'}},
    orders: {template:'postgres',spec:{passwordEnv:'PG_PASS',backup:{engine:'dump',destination:'gs://example-bucket/orders'}}},
    ledger: {template:'postgres',spec:{passwordEnv:'PG_PASS',backup:{engine:'pgbackrest',destination:'gs://example-bucket/ledger'}}},
  }});
  const summaries = extensionSummaries(c,'/private/state');
  expect(summaries).toHaveLength(2);
  expect(summaries[0]).toContain('Monitoring (metrics): https://metrics.example.com');
  expect(summaries[0]).toContain('/private/state/monitoring/metrics/credentials.json');
  expect(summaries[1]).toContain('environment variable METRICS_PASSWORD');
  const diagnostics = extensionDiagnostics(c);
  expect(diagnostics).toContain('/opt/2server/backups/orders/postgres-last-success');
  expect(diagnostics).toContain('two-audit-ledger-backup.service');
  expect(diagnostics).not.toContain('two-audit-postgres-backup.service');
  expect(backupObjectAdminRequired(c)).toBe(true);
  delete c.extensionApps.ledger;
  expect(backupObjectAdminRequired(c)).toBe(false);
  expect(extensionAlertRules().match(/name: postgres/g)).toHaveLength(1);
  const legacy = configSchema.parse({...base,extensions:{postgres:{passwordEnv:'PG_PASS',backup:{engine:'pgbackrest',destination:'gs://example-bucket/legacy'}}}});
  expect(backupObjectAdminRequired(legacy)).toBe(true);
  expect(extensionDiagnostics(legacy)).toContain('two-audit-postgres-backup.service');
});

test('a template contributes alerts and portable state without importing its implementation into the consumer', () => {
  const ext: Extension = {name:'audit-provider',schema:z.object({}),
    alertRules:'\n  - name: audit-provider\n    rules:\n      - alert: AuditUnavailable\n        expr: audit_up == 0\n',
    controlState:{roots:['audit-provider'],schema:z.string().regex(/^audit-provider\/saved\.json$/)},
  };
  const policy = portableStatePolicy([ext]);
  expect(policy.schema.safeParse('audit-provider/saved.json').success).toBe(true);
  expect(policy.schema.safeParse('audit-provider/other.json').success).toBe(false);
  expect(policy.schema.safeParse('other/saved.json').success).toBe(false);
  extensionRegistry.push(ext);
  try {
    const c = configSchema.parse({...base,extensions:{monitoring:{zone:'example.com'}}});
    const alerts = Bun.YAML.parse(monitoringFiles(c)['alerts.yml']) as {groups:Array<{name:string}>};
    expect(alerts.groups.map(g => g.name)).toEqual(['host','postgres','audit-provider','runtime']);
  } finally { extensionRegistry.pop(); }
});

test('portable state preserves legacy and named monitoring credentials; undeclared files and traversal fail closed', async () => {
  const c = configSchema.parse(base);
  const snapshot = {version:1,revision:crypto.randomUUID(),config:c,env:{},state:{
    'monitoring-credentials.json':'legacy-private',
    'monitoring/retired-metrics/credentials.json':'retained-private',
    'compose/api/template.json':'compose-private',
  }};
  expect(validateSnapshot(JSON.stringify(snapshot)).state).toEqual(snapshot.state);
  for (const path of ['monitoring/../credentials.json','monitoring/other/config.json','monitoring/other/credentials.json.next','/etc/passwd','lock/token'])
    expect(() => validateSnapshot(JSON.stringify({...snapshot,state:{[path]:'hidden'}}))).toThrow('Invalid server control snapshot');
  const dir = await mkdtemp(join(tmpdir(),'extension-state-'));
  try {
    await mkdir(join(dir,'monitoring/retired-metrics'),{recursive:true});
    await mkdir(join(dir,'compose/api'),{recursive:true});
    for (const [path,value] of Object.entries(snapshot.state)) await Bun.write(join(dir,path),value);
    await Bun.write(join(dir,'monitoring/retired-metrics/credentials.json.next'),'uncommitted');
    await Bun.write(join(dir,'unrelated-secret.json'),'not-portable');
    expect(await captureState(dir)).toEqual(snapshot.state);
    await symlink(join(dir,'unrelated-secret.json'),join(dir,'monitoring/retired-metrics/link.json'));
    await expect(captureState(dir)).rejects.toThrow('Symlinks');
  } finally { await rm(dir,{recursive:true,force:true}); }
  const loose: Extension = {name:'test',schema:z.object({}),controlState:{roots:['test'],schema:z.string()}};
  expect(portableStatePolicy([loose]).schema.safeParse('test/../escape.json').success).toBe(false);
  expect(portableStatePolicy([loose]).schema.safeParse('undeclared.json').success).toBe(false);
  expect(() => portableStatePolicy([{...loose,controlState:{roots:['../outside'],schema:z.string()}}])).toThrow();
});
