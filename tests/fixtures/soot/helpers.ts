import { cp,mkdtemp,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../../../src/modules/config/application/config';
import { extensionFor } from '../../../src/modules/extensions/application/registry';
import { parseDocument } from '../../../src/modules/source/application/documents';
import { setVmSecrets } from '../../../src/shared/infrastructure/vm-secrets';
import type { DeployState } from '../../../src/modules/extensions/infrastructure/templates/soot/protocol';
import { runtimeIdentity } from '../../../src/modules/extensions/infrastructure/templates/soot/deploy';

export async function fixture(name='helper') {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'2server-soot-')));
  await cp(join(import.meta.dir,'../../../examples/soot'),dir,{recursive:true});
  const path=join(dir,'app.yaml');
  const raw=Bun.YAML.parse(await Bun.file(path).text()) as any;raw.metadata.name=name;raw.domains=[];
  await Bun.write(path,Bun.YAML.stringify(raw));
  const doc=parseDocument(raw);if(doc.kind!=='Extension')throw new Error('fixture template');
  const config=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'test.invalid',user:'operator'},edge:{mode:'managed'},
    extensionApps:{[name]:{template:'soot',spec:doc.spec,secrets:doc.secrets,webhooks:[]}}});
  const bound=extensionFor(config,name)!.context!(config);
  setVmSecrets({[name]:{SOOT_OPERATOR_TOKEN:'test-operator-token-only-0000000000000000'}});
  return {dir,input:{path,document:doc,config:bound},config,bound,doc};
}
export function runtimeState(c:ReturnType<typeof configSchema.parse>):DeployState {
  return {runtime_identity:runtimeIdentity(c),persisted_revision:'saved-1',active_revision:'active-1',fingerprints:'a'.repeat(64),persisted_digest:'b'.repeat(64),
    baseline:null,deploy_drift:true,compatibility_pin:'soot/api1-store1',runtime_package_pins:['35c9af6ab29b4ffea7374a1233b677afef1a79188b8188eba1d0642451f24f23'],
    prior_revision:'',prior_package_digest:'',source_changed:false};
}
