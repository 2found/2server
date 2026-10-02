import {test, expect} from 'bun:test';
import {mkdtemp, mkdir, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema} from '../src/config';
import {runtimeHealthFiles} from '../src/extensions/monitoring/runtime-health';
import {monitoringCompose} from '../src/extensions/monitoring/hooks';

test('extension discovers actual Compose containers and installation changes without a core inventory', async()=>{
 const root=await mkdtemp(join(tmpdir(),'monitoring-discovery-'));
 const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'unused',user:'operator'},edge:{mode:'managed'},extensions:{monitoring:{zone:'example.com'}}});
 const config=join(root,'control/current/server.json'),metrics=join(root,'metrics/runtime.prom');
 const desired={version:1,name:c.name,extensionApps:{} as Record<string,unknown>,extensions:{monitoring:true}};
 try {
  for(const dir of ['bin','control/current','monitoring'])await mkdir(join(root,dir),{recursive:true});
  await Bun.write(join(root,'bin/docker'),`#!/bin/bash
case "$*" in *missing*) exit 1;; esac
echo '{"state":{"Running":true},"restarts":0,"owner":null,"networks":{}}'
`);await chmod(join(root,'bin/docker'),0o755);
  await Bun.write(join(root,'monitoring/compose.json'),JSON.stringify(monitoringCompose(c)));
  const script=runtimeHealthFiles(c)['runtime-metrics.sh'].replaceAll('/opt/2server',root);
  const collect=async()=>{
   await Bun.write(config,JSON.stringify(desired));
   const p=Bun.spawn(['bash','-se'],{env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`},stdin:new Blob([script]),stdout:'pipe',stderr:'pipe'});
   await new Response(p.stderr).text();return p.exited;
  };
  expect(await collect()).toBe(0);
  let text=await Bun.file(metrics).text();
  expect(text).toContain('container="two-test-prometheus"} 1');
  expect(text).toContain('container="two-test-node-exporter"} 1');
  expect(text).not.toContain('alertmanager');

  // New/custom templates need no collector regeneration and no registry change.
  desired.extensionApps.images={template:'image-proxy'};
  desired.extensionApps.custom={template:'future-template'};
  for(const app of ['images','custom'])await mkdir(join(root,`extensions/${app}`),{recursive:true});
  await Bun.write(join(root,'extensions/images/compose.json'),JSON.stringify({services:{image:{container_name:'two-test-images-imgproxy',environment:{SECRET:'do-not-export'}}}}));
  await Bun.write(join(root,'extensions/custom/compose.json'),JSON.stringify({services:{main:{container_name:'missing-main'},sidecar:{container_name:'custom-sidecar'}}}));
  expect(await collect()).toBe(0);
  text=await Bun.file(metrics).text();
  expect(text).toContain('two_container_healthy{container="two-test-images-imgproxy"} 1');
  expect(text).toContain('two_container_healthy{container="missing-main"} 0');
  expect(text).toContain('two_container_healthy{container="custom-sidecar"} 1');
  expect(text).not.toContain('do-not-export');

  // Removal must ignore retained Compose/data directories.
  delete desired.extensionApps.images;
  expect(await collect()).toBe(0);
  expect(await Bun.file(metrics).text()).not.toContain('two-test-images-imgproxy');
  await rm(join(root,'extensions/custom/compose.json'));
  expect(await collect()).toBe(0);
  expect(await Bun.file(metrics).text()).toContain('two_extension_config_healthy{app="custom"} 0');

  // Added receiver appears through the actual bundle, without a phantom target
  // when disabled. No receiver credentials are read by discovery.
  c.extensions.webhooks=[{name:'operator',provider:'discord',urlEnv:'DISCORD_URL',enabled:true,sendResolved:true}];
  await Bun.write(join(root,'monitoring/compose.json'),JSON.stringify(monitoringCompose(c)));
  expect(await collect()).toBe(0);
  expect(await Bun.file(metrics).text()).toContain('container="two-test-alertmanager"} 1');
  const last=await Bun.file(metrics).text();
  desired.name='wrong-server';
  expect(await collect()).not.toBe(0);
  expect(await Bun.file(metrics).text()).toBe(last);
 } finally {await rm(root,{recursive:true,force:true});}
});
