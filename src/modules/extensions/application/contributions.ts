import type { Config } from '../../config/application/config';
import { enabledExtensions, extensionRegistry } from './registry';

export function extensionSummaries(c: Config, state: string) {
  return enabledExtensions(c).flatMap(ext => ext.summary?.(c,state) ?? []);
}
export function extensionDiagnostics(c: Config) {
  return enabledExtensions(c).map(ext => ext.diagnostics?.(c) ?? '').filter(Boolean).join('\n');
}
export function backupObjectAdminRequired(c: Config) {
  return enabledExtensions(c).some(ext => ext.backupStoragePermissions?.(c).objectAdmin);
}
export function extensionAlertRules() {
  // One metric rule set per registered template, regardless of instance count.
  return extensionRegistry.map(ext => ext.alertRules ?? '').join('\n');
}
