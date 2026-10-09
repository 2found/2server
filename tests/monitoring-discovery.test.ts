import { expect,test } from 'bun:test';
import { chmod,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/modules/config/application/config';
import { monitoringCompose } from '../src/modules/extensions/infrastructure/templates/monitoring/hooks';
import { runtimeHealthFiles } from '../src/modules/extensions/infrastructure/templates/monitoring/runtime-health';
import { extensionFor } from '../src/modules/extensions/application/registry';

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
  await Bun.write(join(root,'extensions/custom/retired'),'');
  expect(await collect()).toBe(0);
  expect(await Bun.file(metrics).text()).not.toContain('app="custom"');

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

test('explicit observers follow the live legacy spec without regenerating the collector', async()=>{
 const root=await mkdtemp(join(tmpdir(),'monitoring-observers-'));
 const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'unused',user:'operator'},edge:{mode:'managed'},extensions:{monitoring:{zone:'example.com',containers:['missing-old']}}});
 const upstream=join(root,'legacy.caddy');
 const desired={version:1,name:c.name,extensions:{monitoring:{containers:['missing-new'],upstreams:[{name:'legacy',file:upstream}]}}};
 try {
  for(const dir of ['bin','control/current','monitoring'])await mkdir(join(root,dir),{recursive:true});
  await Bun.write(join(root,'monitoring/compose.json'),JSON.stringify(monitoringCompose(c)));
  await Bun.write(join(root,'bin/docker'),`#!/bin/bash
case "$*" in *missing*) exit 1;; esac
echo '{"state":{"Running":true},"restarts":0,"owner":null,"networks":{}}'
`);await chmod(join(root,'bin/docker'),0o755);
  const script=runtimeHealthFiles(c)['runtime-metrics.sh'].replaceAll('/opt/2server',root);
  const collect=async()=>{
   await Bun.write(join(root,'control/current/server.json'),JSON.stringify(desired));
   const p=Bun.spawn(['bash','-se'],{env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`},stdin:new Blob([script]),stdout:'pipe',stderr:'pipe'});
   await new Response(p.stderr).text();return p.exited;
  };
  expect(await collect()).toBe(0);
  let text=await Bun.file(join(root,'metrics/runtime.prom')).text();
  expect(text).toContain('container="missing-new"} 0');
  expect(text).toContain('container="missing-upstream-legacy"} 0');
  expect(text).not.toContain('missing-old');
  desired.extensions.monitoring.containers=[];
  desired.extensions.monitoring.upstreams=[];
  expect(await collect()).toBe(0);
  text=await Bun.file(join(root,'metrics/runtime.prom')).text();
  expect(text).not.toContain('missing-new');
  expect(text).not.toContain('missing-upstream-legacy');
  // Invalid fields preserve the last complete file, including in named pipelines.
  const last=text;
  desired.extensions.monitoring.containers=['unsafe"label'];
  expect(await collect()).not.toBe(0);
  expect(await Bun.file(join(root,'metrics/runtime.prom')).text()).toBe(last);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('named observers respect instance identity and managed retirement while missing live targets still alert', async()=>{
 const root=await mkdtemp(join(tmpdir(),'monitoring-retired-'));
 const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'unused',user:'operator'},edge:{mode:'managed'},extensionApps:{
  metrics:{template:'monitoring',spec:{zone:'example.com',containers:['baked-old']}},
 }});
 const retiredRoute=join(root,'retired.caddy'),liveRoute=join(root,'live.caddy');
 const desired={version:1,name:c.name,extensionApps:{
  metrics:{template:'monitoring',spec:{containers:['retired-blue','retired-broker','missing-live'],upstreams:[{name:'retired',file:retiredRoute},{name:'live',file:liveRoute}]}},
  second:{template:'monitoring',spec:{containers:['other-instance-only']}},
  broker:{template:'nats',spec:{}},
 },extensions:{monitoring:{containers:['legacy-only']}}};
 try {
  for(const dir of ['bin','control/current','monitoring','apps/retired','extensions/broker/current','extensions/metrics','extensions/second'])await mkdir(join(root,dir),{recursive:true});
  for(const path of ['monitoring/compose.json','extensions/metrics/compose.json','extensions/second/compose.json'])await Bun.write(join(root,path),JSON.stringify({services:{main:{container_name:'monitoring-fixture'}}}));
  await Bun.write(join(root,'apps/retired/blue.json'),JSON.stringify({compose:{containers:{blue:'retired-blue',green:'retired-green'},upstreamFile:retiredRoute}}));
  await Bun.write(join(root,'extensions/broker/current/compose.json'),JSON.stringify({services:{main:{container_name:'retired-broker'}}}));
  await Bun.write(join(root,'extensions/broker/retired'),'');
  await Bun.write(join(root,'bin/docker'),'#!/bin/bash\nexit 1\n');await chmod(join(root,'bin/docker'),0o755);
  const script=runtimeHealthFiles(extensionFor(c,'metrics')!.context!(c))['runtime-metrics.sh'].replaceAll('/opt/2server',root);
  const metrics=join(root,'metrics/metrics-runtime.prom');
  const collect=async()=>{
   await Bun.write(join(root,'control/current/server.json'),JSON.stringify(desired));
   const p=Bun.spawn(['bash','-se'],{env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`},stdin:new Blob([script]),stdout:'pipe',stderr:'pipe'});
   const err=await new Response(p.stderr).text();return {code:await p.exited,err};
  };
  let result=await collect();expect(result.code,result.err).toBe(0);
  let text=await Bun.file(metrics).text();
  expect(text).toContain('collector="metrics",container="missing-live"} 0');
  expect(text).toContain('collector="metrics",container="missing-upstream-live"} 0');
  for(const target of ['retired-blue','retired-broker','missing-upstream-retired','baked-old','other-instance-only','legacy-only'])expect(text).not.toContain(target);
  // Same contract, active lifecycle: absence is a real outage again.
  await Bun.write(join(root,'apps/retired/current'),'blue');
  await rm(join(root,'extensions/broker/retired'));
  result=await collect();expect(result.code,result.err).toBe(0);
  text=await Bun.file(metrics).text();
  expect(text).toContain('collector="metrics",container="retired-blue"} 0');
  expect(text).toContain('collector="metrics",container="retired-broker"} 0');
  expect(text).toContain('collector="metrics",container="missing-upstream-retired"} 0');
  // Reject a changed template rather than reading another instance's spec.
  const last=text;desired.extensionApps.metrics.template='nats';
  expect((await collect()).code).not.toBe(0);
  expect(await Bun.file(metrics).text()).toBe(last);
 } finally {await rm(root,{recursive:true,force:true});}
});
