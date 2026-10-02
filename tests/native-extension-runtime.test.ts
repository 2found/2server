import { expect,test } from 'bun:test';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/modules/config/application/config';
import { renderDeclaration } from '../src/modules/extensions/domain/declaration';
import { catalogDefinition } from '../src/modules/extensions/infrastructure/catalog';
import { run } from '../src/shared/infrastructure/process';
const integration=process.env.DOCKER_TESTS==='1'?test:test.skip;

integration('imgproxy YAML retains private network, health check and signed-image settings',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'two-imgproxy-yaml-'));
  const name=`yaml-${crypto.randomUUID().slice(0,8)}`,network=`two-${name}`,project=`two-${name}-imgproxy`;
  const c=configSchema.parse({version:1,name,ssh:{kind:'ssh',host:'unused.example',user:'ops'},edge:{mode:'managed',network},extensions:{imageProxy:{allowedSources:['https://example.com/'],keyEnv:'TEST_IMG_KEY',saltEnv:'TEST_IMG_SALT'}}});
  const d=catalogDefinition('image-proxy');
  const service=renderDeclaration(d.service,{spec:c.extensions.imageProxy,server:c,edge:c.edge});
  const file=join(dir,'compose.json');
  try{
    expect(service.ports).toBeUndefined();
    expect(service.container_name).toBe(project);
    expect(d.settings.environment.IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES).toBe('false');
    await writeFile(file,JSON.stringify({services:{imgproxy:service},networks:{[network]:{external:true}}}));
    await writeFile(join(dir,'imgproxy.env'),Object.entries({...d.settings.environment,IMGPROXY_KEY:'a'.repeat(64),IMGPROXY_SALT:'b'.repeat(64),IMGPROXY_ALLOWED_SOURCES:'https://example.com/'}).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});
    await run(['docker','network','create',network]);
    await run(['docker','compose','-p',project,'-f',file,'up','-d','--wait','--wait-timeout','40']);
    expect((await run(['docker','inspect','-f','{{.State.Health.Status}}',project])).trim()).toBe('healthy');
  }finally{
    await run(['docker','compose','-p',project,'-f',file,'down','--timeout','1']).catch(()=>{});
    await run(['docker','network','rm',network]).catch(()=>{});
    await rm(dir,{recursive:true,force:true});
  }
},60000);
