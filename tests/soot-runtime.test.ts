import { expect,test } from 'bun:test';
import { cp,mkdir,readFile,rm,writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { run } from '../src/shared/infrastructure/process';
import { canonical,checkBundle,framedDigest,stageFiles,type BundleFile } from '../src/modules/extensions/infrastructure/templates/soot/bundle';
import { makePlan,RuntimeError,sha256,stateSchema,receiptSchema } from '../src/modules/extensions/infrastructure/templates/soot/protocol';
import { runtimeIdentity } from '../src/modules/extensions/infrastructure/templates/soot/deploy';
import { fixture } from './fixtures/soot/helpers';
import { setVmSecrets } from '../src/shared/infrastructure/vm-secrets';

// A supplied local runtime image is never fetched or published by this fixture.
// It must contain the exact afb1e0d binary verified by the mounted T2 receipt.
const enabled=process.env.DOCKER_TESTS==='1';
test.skipIf(!enabled)('isolated Linux T2 C3: auth/TLS, config-only apply, drift races, restart and guarded restore retain stores',async()=>{
  const image=process.env.SOOT_RUNTIME_IMAGE;if(!image)throw new Error('Set SOOT_RUNTIME_IMAGE to the verified local afb1e0d image');
  const f=await fixture(),container='2server-soot-fixture-'+crypto.randomUUID(),base=join(f.dir,'vm');
  const token='isolated-fixture-token-'+crypto.randomUUID();const dirs=['config','transactions','state','credentials','release'];
  const secondContainer=container+'-beta',secondBase=join(f.dir,'vm-beta'),secondToken='isolated-beta-token-'+crypto.randomUUID();
  let secondURL='';
  const deploymentReceipts:string[]=[];
  let tlsServer:ReturnType<typeof createServer>|undefined;
  for(const name of dirs)await mkdir(join(base,name),{recursive:true,mode:0o700});
  await mkdir(join(base,'config/packs.d'),{mode:0o700});
  await cp(join(f.dir,'runtime-receipt.json'),join(base,'release/receipt.json'));
  await writeFile(join(base,'credentials/operator.env'),'SOOT_OPERATOR_TOKEN='+token+'\n',{mode:0o600});
  await mkdir(join(base,'config/bootstrap'),{mode:0o700});
  await writeFile(join(base,'config/bootstrap/soot.json'),JSON.stringify({id:'management',soul:'SOUL.md',mission:'mission.md'}));
  await writeFile(join(base,'config/bootstrap/SOUL.md'),'Management only');await writeFile(join(base,'config/bootstrap/mission.md'),'Wait for reviewed source');
  await writeFile(join(base,'config/deployment.json'),JSON.stringify({listen:'0.0.0.0:7788',data_dir:'/state',credentials_dir:'/credentials',token_env:'SOOT_OPERATOR_TOKEN',model:{},soots:['bootstrap/soot.json'],workers:1,packs_dir:'packs.d'}));
  const serveArgs=['serve','--config','/config/deployment.json','--instance-id','helper','--transaction-root','/transactions','--config-root','/config','--state-root','/state','--credential-root','/credentials','--runtime-receipt','/release/receipt.json'];
  const dockerArgs=['docker','run','-d','--name',container,'--platform','linux/amd64','--restart=no','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m',
    '--env-file',join(base,'credentials/operator.env'),'-e','SOOT_HOME=/credentials/home','-p','127.0.0.1::7788',
    ...dirs.flatMap(name=>['--mount',`type=bind,src=${join(base,name)},dst=/${name}${name==='release'?',readonly':''}`]),image];
  let url='';
  const call=async(path:string,body?:unknown,bearer=token)=>{
    const response=await fetch(url+path,{headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},method:body===undefined?'GET':'POST',
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
    const data=await response.json() as any;
    if(!response.ok)throw new RuntimeError(data.code??data.error,data.reason_code??'request_rejected');return data;
  };
  const state=async()=>stateSchema.parse(await call('/v1/settings/deploy/state'));
  const start=async(initial=false)=>{
    await run([...dockerArgs,...serveArgs,...(initial?['--initialize-instance']:[])]);
    const mapping=(await run(['docker','port',container,'7788/tcp'])).trim();url='http://'+mapping;
    for(let n=0;n<100;n++){try{const r=await fetch(url+'/readyz');if(r.ok)return;}catch{}await Bun.sleep(100);}
    throw new Error('Pinned isolated runtime failed bootstrap readiness');
  };
  const startSecond=async()=>{
    for(const name of dirs)await mkdir(join(secondBase,name),{recursive:true,mode:0o700});
    await cp(join(base,'config'),join(secondBase,'config'),{recursive:true});
    await cp(join(base,'release/receipt.json'),join(secondBase,'release/receipt.json'));
    await writeFile(join(secondBase,'credentials/operator.env'),'SOOT_OPERATOR_TOKEN='+secondToken+'\n',{mode:0o600});
    await run(['docker','run','-d','--name',secondContainer,'--platform','linux/amd64','--restart=no','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m',
      '--env-file',join(secondBase,'credentials/operator.env'),'-e','SOOT_HOME=/credentials/home','-p','127.0.0.1::7788',
      ...dirs.flatMap(name=>['--mount',`type=bind,src=${join(secondBase,name)},dst=/${name}${name==='release'?',readonly':''}`]),image,
      ...serveArgs.map((v,i)=>serveArgs[i-1]==='--instance-id'?'beta':v),'--initialize-instance']);
    secondURL='http://'+(await run(['docker','port',secondContainer,'7788/tcp'])).trim();
    for(let n=0;n<100;n++){try{if((await fetch(secondURL+'/readyz')).ok)return;}catch{}await Bun.sleep(100);}
    throw new Error('Second isolated instance failed readiness');
  };
  const stop=async()=>{
    await run(['docker','kill','--signal=TERM',container]);
    const p=Bun.spawn(['docker','wait',container],{stdout:'pipe',stderr:'pipe'});
    const timeout=AbortSignal.timeout(90000);
    const result=await Promise.race([new Response(p.stdout).text(),new Promise<never>((_,reject)=>timeout.addEventListener('abort',()=>reject(new Error('stop/join timed out')),{once:true}))]);
    expect(result.trim()).toBe('0');await p.exited;await run(['docker','rm',container]);
  };
  const refresh=async(mission:string)=>{
    await writeFile(join(f.dir,'bundle/soot/soots/helper/mission.md'),mission);
    // The scripted provider is an explicit fixture choice, never a template default.
    await writeFile(join(f.dir,'bundle/soot/ai.json'),JSON.stringify({model:{provider:'demo',name:'scripted'},credentials_dir:'/credentials'}));
    const m=await Bun.file(join(f.dir,'bundle/soot.bundle.json')).json();delete m.source_digest.value;
    const names=['soot/ai.json','soot/deployment.json','soot/soots/helper/SOUL.md','soot/soots/helper/mission.md','soot/soots/helper/soot.json'];
    const files:BundleFile[]=await Promise.all(names.map(async name=>({name,mode:0o600,bytes:await readFile(join(f.dir,'bundle',name))})));
    m.source_digest.value=framedDigest('soot.bundle.source.v1',canonical(m),files);
    await writeFile(join(f.dir,'bundle/soot.bundle.json'),JSON.stringify(m));return checkBundle(f.input);
  };
  const stage=async(bundle:Awaited<ReturnType<typeof checkBundle>>,plan:ReturnType<typeof makePlan>)=>{
    const root=join(base,'transactions/inbox',plan.bindings.staging_id);await mkdir(root,{recursive:true,mode:0o700});
    for(const d of bundle.directories)await mkdir(join(root,d),{recursive:true,mode:0o700});
    for(const file of stageFiles(bundle,'/transactions/inbox/'+plan.bindings.staging_id)){
      await mkdir(join(root,file.name,'..'),{recursive:true,mode:0o700});await writeFile(join(root,file.name),file.bytes,{mode:file.mode});
    }
    const metadata=JSON.stringify({source_digest:plan.bindings.source_digest,package_digest:plan.bindings.package_digest,compatibility_pin:plan.bindings.compatibility_pin});
    expect(sha256(metadata)).toBe(plan.bindings.staging_digest);await writeFile(root+'.json',metadata,{mode:0o600});
  };
  const deploy=async(bundle:Awaited<ReturnType<typeof checkBundle>>,review:boolean)=>{
    const before=await state(),plan=makePlan(before,bundle.manifest.source_digest.value,bundle.receipt.oci_manifest_digest.slice(7));
    if(review)plan.reviewed_replacement={kind:before.baseline?'reviewed_replacement':'initial_source_review',bindings:{...plan.bindings}};
    await stage(bundle,plan);const lease=await call('/v1/settings/deploy/prepare',plan);
    let receipt=receiptSchema.parse(await call('/v1/settings/deploy/commit',lease));
    for(let n=0;n<100&&receipt.state==='pending';n++){await Bun.sleep(50);try{receipt=receiptSchema.parse(await call('/v1/settings/transactions/'+plan.request_id));}catch(e){if(e instanceof RuntimeError)throw e;}}
    expect(receipt.state).toBe('applied');deploymentReceipts.push(plan.request_id);return state();
  };
  try {
    await start(true);await startSecond();
    const bootstrap=await state();expect(bootstrap.runtime_identity).toBe(runtimeIdentity(f.bound));expect(bootstrap.baseline).toBeNull();
    const betaState=stateSchema.parse(await (await fetch(secondURL+'/v1/settings/deploy/state',{headers:{Authorization:'Bearer '+secondToken}})).json());
    expect(betaState.runtime_identity).not.toBe(bootstrap.runtime_identity);
    expect((await fetch(secondURL+'/v1/settings/deploy/state',{headers:{Authorization:'Bearer '+token}})).status).toBe(401);
    expect((await fetch(url+'/v1/settings/deploy/state',{headers:{Authorization:'Bearer '+secondToken}})).status).toBe(401);
    const denied=await fetch(url+'/v1/settings/deploy/state');expect(denied.status).toBe(401);
    const wrong=await fetch(url+'/v1/settings/deploy/state',{headers:{Authorization:'Bearer wrong-fixture-token'}});expect(wrong.status).toBe(401);
    const first=await refresh('First explicit fixture mission');
    const noReview=makePlan(bootstrap,first.manifest.source_digest.value,first.receipt.oci_manifest_digest.slice(7));await stage(first,noReview);
    await expect(call('/v1/settings/deploy/prepare',noReview)).rejects.toThrow('deploy_drift');
    const deployed=await deploy(first,true);expect(deployed.deploy_drift).toBe(false);
    const created=await call('/v1/conversations',{id:crypto.randomUUID(),soot:'helper',expected_active_revision:deployed.active_revision});
    const conversationId=created.id??created.conversation?.id;expect(typeof conversationId).toBe('string');
    const requestId=crypto.randomUUID();
    const accepted=await call('/v1/conversations/'+conversationId+'/messages',{id:requestId,text:'Explicit scripted fixture request',expected_active_revision:deployed.active_revision});
    const runId=accepted.run.id;expect(typeof runId).toBe('string');
    let runRecord=await call('/v1/conversations/'+conversationId+'/runs/'+runId);
    for(let n=0;n<100&&!['completed','failed','stopped','done'].includes(runRecord.state);n++){await Bun.sleep(50);runRecord=await call('/v1/conversations/'+conversationId+'/runs/'+runId);}
    expect(runRecord.request_id).toBe(requestId);expect(runRecord.config_revision).toBe(deployed.active_revision);
    const retainedMessages=await call('/v1/conversations/'+conversationId+'/messages');
    await writeFile(join(base,'credentials/fixture-vault-sentinel'),'retained rotated credential marker',{mode:0o600});
    await mkdir(join(base,'state/monitoring'),{mode:0o700});await writeFile(join(base,'state/monitoring/fixture-sentinel'),'retained monitoring marker',{mode:0o600});
    // Authenticated settings save changes P while A remains acknowledged.
    await call('/v1/settings/action',{action:'soot.save',request_id:crypto.randomUUID(),revision:deployed.persisted_revision,soot:{id:'helper',name:'Helper',soul:'Be clear',mission:'operator mission',packs:[],use:[]}});
    const edited=await state();expect(edited.deploy_drift).toBe(true);expect(edited.active_revision).toBe(deployed.active_revision);
    const second=await refresh('Second fixture source mission');
    const refreshed=makePlan(edited,second.manifest.source_digest.value,second.receipt.oci_manifest_digest.slice(7));await stage(second,refreshed);
    await expect(call('/v1/settings/deploy/prepare',refreshed)).rejects.toThrow('deploy_drift');
    const activationId=crypto.randomUUID();
    let activated=receiptSchema.parse((await call('/v1/settings/action',{action:'config.activate',request_id:activationId,revision:edited.persisted_revision,expected_active_revision:edited.active_revision})).receipt);
    for(let n=0;n<100&&activated.state==='pending';n++){await Bun.sleep(50);try{activated=receiptSchema.parse(await call('/v1/settings/transactions/'+activationId));}catch(e){if(e instanceof RuntimeError)throw e;}}
    expect(activated.state).toBe('applied');const activeEdit=await state();expect(activeEdit.active_revision).not.toBe(deployed.active_revision);
    await stop();await start();expect((await state()).active_revision).toBe(activeEdit.active_revision);
    expect((await call('/v1/settings')).soots.find((s:any)=>s.id==='helper').mission).toBe('operator mission');
    const afterActiveEdit=makePlan(await state(),second.manifest.source_digest.value,second.receipt.oci_manifest_digest.slice(7));await stage(second,afterActiveEdit);
    await expect(call('/v1/settings/deploy/prepare',afterActiveEdit)).rejects.toThrow('deploy_drift');
    const replaced=await deploy(second,true);expect(replaced.runtime_package_pins).toEqual(deployed.runtime_package_pins);
    await stop();await start();expect((await state()).active_revision).toBe(replaced.active_revision);
    expect((await call('/v1/conversations/'+conversationId)).id).toBe(conversationId);
    expect(await call('/v1/conversations/'+conversationId+'/runs/'+runId)).toEqual(runRecord);
    expect(await Bun.file(join(base,'credentials/fixture-vault-sentinel')).text()).toBe('retained rotated credential marker');
    const raceBundle=await refresh('Prepared but externally changed');const beforeRace=await state();
    const racePlan=makePlan(beforeRace,raceBundle.manifest.source_digest.value,raceBundle.receipt.oci_manifest_digest.slice(7));await stage(raceBundle,racePlan);
    const lease=await call('/v1/settings/deploy/prepare',racePlan);
    await expect(call('/v1/settings/action',{action:'soot.save',request_id:crypto.randomUUID(),revision:beforeRace.persisted_revision,soot:{id:'helper',name:'Helper',soul:'Be clear',mission:'competing writer',packs:[],use:[]}})).rejects.toThrow('config_busy');
    const mission=join(base,'config/soots/helper/mission.md'),oldMission=await readFile(mission);await writeFile(mission,'external edit after prepare');
    await expect(call('/v1/settings/deploy/commit',lease)).rejects.toThrow('source_changed');
    await writeFile(mission,oldMission);await call('/v1/settings/deploy/abort',lease);
    // A fully admitted source with missing provider credentials fails runtime
    // activation and retains the acknowledged prior generation/readiness.
    await refresh('Candidate requiring absent provider credentials');
    await writeFile(join(f.dir,'bundle/soot/ai.json'),JSON.stringify({model:{provider:'openai',name:'fixture-model',key_env:'MISSING_FIXTURE_PROVIDER_KEY'},credentials_dir:'/credentials'}));
    const badManifest=await Bun.file(join(f.dir,'bundle/soot.bundle.json')).json();delete badManifest.source_digest.value;
    const badNames=['soot/ai.json','soot/deployment.json','soot/soots/helper/SOUL.md','soot/soots/helper/mission.md','soot/soots/helper/soot.json'];
    badManifest.source_digest.value=framedDigest('soot.bundle.source.v1',canonical(badManifest),await Promise.all(badNames.map(async name=>({name,mode:0o600,bytes:await readFile(join(f.dir,'bundle',name))}))));
    await writeFile(join(f.dir,'bundle/soot.bundle.json'),JSON.stringify(badManifest));
    const badBundle=await checkBundle(f.input),goodBefore=await state(),badPlan=makePlan(goodBefore,badBundle.manifest.source_digest.value,badBundle.receipt.oci_manifest_digest.slice(7));
    await stage(badBundle,badPlan);const badLease=await call('/v1/settings/deploy/prepare',badPlan);
    await expect(call('/v1/settings/deploy/commit',badLease)).rejects.toThrow('validation_failed');
    expect((await state()).active_revision).toBe(goodBefore.active_revision);expect((await fetch(url+'/readyz')).status).toBe(200);
    const beforeRestore=await state();const rollback={request_id:crypto.randomUUID(),persisted_revision:beforeRestore.persisted_revision,active_revision:beforeRestore.active_revision,
      prior_revision:beforeRestore.prior_revision,package_digest:beforeRestore.prior_package_digest,compatibility_pin:beforeRestore.compatibility_pin,fingerprints:beforeRestore.fingerprints};
    let restored=receiptSchema.parse(await call('/v1/settings/deploy/rollback',rollback));
    for(let n=0;n<100&&restored.state==='pending';n++){await Bun.sleep(50);try{restored=receiptSchema.parse(await call('/v1/settings/transactions/'+rollback.request_id));}catch(e){if(e instanceof RuntimeError)throw e;}}
    expect(restored.state).toBe('applied');
    expect((await state()).baseline?.source_digest).toBe(first.manifest.source_digest.value);
    expect((await call('/v1/conversations/'+conversationId)).id).toBe(conversationId);
    expect(await call('/v1/conversations/'+conversationId+'/runs/'+runId)).toEqual(runRecord);
    expect(await call('/v1/conversations/'+conversationId+'/messages')).toEqual(retainedMessages);
    for(const request of deploymentReceipts)expect(receiptSchema.parse(await call('/v1/settings/transactions/'+request)).state).toBe('applied');
    expect(await Bun.file(join(base,'credentials/fixture-vault-sentinel')).text()).toBe('retained rotated credential marker');
    expect(await Bun.file(join(base,'state/monitoring/fixture-sentinel')).text()).toBe('retained monitoring marker');
    // Local TLS with an explicitly trusted fixture CA; no public DNS claim.
    await run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(base,'tls.key'),'-out',join(base,'tls.crt'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
    const ca=await readFile(join(base,'tls.crt'),'utf8');
    tlsServer=createServer({key:await readFile(join(base,'tls.key')),cert:ca},(req,res)=>{
      const upstream=httpRequest(url+(req.url??'/'),{method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode??502,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
    });
    await new Promise<void>(resolve=>tlsServer!.listen(0,'127.0.0.1',resolve));const port=(tlsServer.address() as {port:number}).port;
    expect((await fetch(`https://127.0.0.1:${port}/readyz`,{tls:{ca}})).status).toBe(200);
    expect((await fetch(`https://127.0.0.1:${port}/v1/settings/deploy/state`,{tls:{ca}})).status).toBe(401);
    const tlsState=await fetch(`https://127.0.0.1:${port}/v1/settings/deploy/state`,{tls:{ca},headers:{Authorization:'Bearer '+token}});
    expect(stateSchema.parse(await tlsState.json()).runtime_identity).toBe(bootstrap.runtime_identity);
    await stop();
    expect((await fetch(secondURL+'/readyz')).status).toBe(200);
  } finally {
    tlsServer?.close();
    await run(['docker','rm','-f',container]).catch(()=>{});await run(['docker','rm','-f',secondContainer]).catch(()=>{});await rm(f.dir,{recursive:true,force:true});setVmSecrets();
  }
},180000);
