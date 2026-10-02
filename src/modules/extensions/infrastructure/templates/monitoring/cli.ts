import type { Request } from '../../../../../shared/cli/resource-request';
import { webhookSchema } from '../../../../../shared/domain/schema';
import { quote,remote } from '../../../../../shared/infrastructure/process';
import type { Config } from '../../../../config/application/config';
import { configSchema } from '../../../../config/application/config';
import { deployAll } from '../../../application/deploy';
import { monitoringFiles } from './hooks';
import { testWebhook } from './webhooks';
export async function run(c:Config,command:string,args:string[]) {
 if(command!=='webhooks')throw new Error('Unknown monitoring app command');
 if(!args.length){console.log(JSON.stringify(c.extensions.webhooks.map(({name,provider,enabled})=>({name,provider,enabled})),null,2));return;}
 if(args[0]!=='test'||!args[1]||args.slice(2).some(a=>a!=='--apply')||args.length>3)throw new Error('Use app NAME webhooks [test RECEIVER [--apply]]; configure receivers in the App file');
 const receiver=c.extensions.webhooks.find(w=>w.name===args[1]);
 if(!receiver)throw new Error('Webhook receiver not found');
 if(!args.includes('--apply')){console.log('Webhook test: pass --apply to send');return;}
 console.log(await testWebhook(c,receiver));
}

export const webhookOperations = {
  test: testWebhook,
  apply: async (c: Config) => {
    const selected: Config = { ...c, extensions: { monitoring: c.extensions.monitoring, alertWebhookEnv: c.extensions.alertWebhookEnv, webhooks: c.extensions.webhooks, services: {} } };
    monitoringFiles(selected); // Resolve every enabled secret before SSH.
    await remote(c, `set -euo pipefail
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
test -f /opt/2server/monitoring/compose.json || { echo 'Install monitoring before webhook CRUD; config can be prepared in extensions.webhooks' >&2; exit 1; }`);
    await deployAll(selected); // Existing DNS/auth routes remain in place.
  },
};

export async function legacyWebhookCommand(c:Config,r:Request,state:string,original:string,saveManifest:(file:string,original:string,c:Config)=>Promise<void>) {
 if(!c.extensions.monitoring)throw new Error('Monitoring app is not installed; use app NAME webhooks');
 const {verb,name,options}=r,inspect=['get','describe'].includes(verb);
 const emit=(value:unknown)=>console.log(JSON.stringify(value,null,2));
 const needName=()=>{if(!name)throw new Error('Webhook requires NAME');return name;};
 const spec=async()=>{if(!options.spec)throw new Error('--spec is required');return Bun.file(options.spec).json();};
 const dry=()=>{if(r.apply)return false;console.log(`${verb} webhook ${name??''}: pass --apply to execute`);return true;};

    const current = c.extensions.webhooks.find(w => w.name === name);
    if (inspect) {
      if (name && !current) throw new Error("Webhook not found");
      emit(current ?? c.extensions.webhooks);
      return;
    }
    needName();
    if (!["create", "update", "delete", "test"].includes(verb)) throw new Error(`Unsupported webhook operation: ${verb}`);
    if (verb === "test") {
      if (!current) throw new Error("Webhook not found");
      if (dry()) return;
      emit(await webhookOperations.test(c, current));
      return;
    }
    if (verb === "create" ? !!current : !current)
      throw new Error("Use create for absent webhooks and update/delete for configured webhooks");
    let targets = c.extensions.webhooks.filter(w => w.name !== name);
    if (verb !== "delete") {
      const next = webhookSchema.parse(await spec());
      if (next.name !== name) throw new Error("Spec name must match webhook NAME");
      targets.push(next);
    }
    const updated = configSchema.parse({ ...c, extensions: { ...c.extensions, webhooks: targets } });
    if (!updated.extensions.monitoring) throw new Error("Webhook CRUD requires monitoring enabled; prepare extensions.webhooks in the manifest before first monitoring install");
    if (dry()) return;
    await webhookOperations.apply(updated);
    await saveManifest(r.file, original, updated);
    emit({ webhook: name, operation: verb, applied: true });
    return;

}
