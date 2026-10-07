import type { Request } from '../../../../../shared/cli/resource-request';
import { remote } from '../../../../../shared/infrastructure/process';
import type { Config } from '../../../../config/application/config';
import { saveManifest } from '../../../../config/infrastructure/save';
import { extensionDiagnostics } from '../../../application/contributions';
import { legacyWebhookCommand } from './cli';

export async function legacyMonitoringResource(r: Request, c: Config, state: string, original: string) {
  if (r.resource === 'webhook') {
    await legacyWebhookCommand(c,r,state,original,saveManifest);
    return true;
  }
  if (r.resource !== 'monitor' || !['get','describe'].includes(r.verb)) return false;
  console.log(await remote(c, `set -euo pipefail
printf 'HOST\\n'; uptime; free -m; df -h -x tmpfs -x devtmpfs
printf '\\nCONTAINERS\\n'; docker stats --no-stream --format '{{json .}}'
printf '\\nRUNTIME HEALTH (first 200 lines)\\n'; head -n 200 /opt/2server/metrics/runtime.prom 2>/dev/null || true
${extensionDiagnostics(c)}`));
  return true;
}
