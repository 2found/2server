import { expect,test } from 'bun:test';
import { chmod,mkdir,mkdtemp,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appLock,drainInBackground,httpProbe,pullUnlessPresent } from '../src/modules/apps/infrastructure/rollout';
import { run } from '../src/shared/infrastructure/process';
import { originProbeScript } from '../src/modules/domains/infrastructure/edge';
import { configSchema } from '../src/modules/config/application/config';

// A PATH of stub binaries that log their argv and answer like Docker/curl.
async function stubs(dir:string,{ip='172.18.0.9',internal='false',curl=true}:{ip?:string;internal?:string;curl?:boolean}={}) {
  const bin=join(dir,'bin');await mkdir(bin,{recursive:true});
  const write=async(name:string,body:string)=>{await Bun.write(join(bin,name),`#!/bin/bash\necho "${name} $*" >> '${dir}/calls'\n${body}\n`);await chmod(join(bin,name),0o755);};
  await write('docker',`case "$1 $2" in
 'inspect -f') echo '${ip}';;
 'network inspect') echo '${internal}';;
 'image inspect') [ -f '${dir}/present' ];;
 run*) echo 200;;
 pull*) :;;
esac`);
  if(curl){await write('curl','echo 200');return {...process.env,PATH:`${bin}:${process.env.PATH}`};}
  // Hide the host's curl: only the stubs, bash and timeout stay reachable. A
  // system directory is no use here: on a merged-/usr host /bin holds curl.
  for(const tool of ['bash','timeout']){const path=Bun.which(tool);if(path)await symlink(path,join(bin,tool));}
  return {...process.env,PATH:bin};
}
async function probe(dir:string,env:Record<string,string|undefined>,target:{name:string}|{variable:string}={name:'prod-api-green'}) {
  const script=`set -euo pipefail\nremaining=5\nnew=prod-api-green\nif ${httpProbe('edge',target,8080,'/healthz',2,true)}; then echo ready; fi\n`;
  const p=Bun.spawn([Bun.which('bash')!,'-s'],{env,stdin:new Blob([script]),stdout:'pipe',stderr:'pipe'});
  const [out]=await Promise.all([new Response(p.stdout).text(),p.exited]);
  return {out,calls:await Bun.file(join(dir,'calls')).text()};
}

test('readiness probes from the host at the container address instead of starting a curl container',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'two-probe-host-'));
  try{
    for(const target of [{name:'prod-api-green'},{variable:'new'}]) {
      await rm(join(dir,'calls'),{force:true});
      const {out,calls}=await probe(dir,await stubs(dir),target);
      expect(out).toContain('ready');
      expect(calls).toContain('curl -s --connect-timeout 2 --max-time 2 -o /dev/null -w %{http_code} http://172.18.0.9:8080/healthz');
      expect(calls).not.toContain('docker run');
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('an internal network, a missing host curl or no IPv4 address keeps the containerized probe',async()=>{
  for(const variant of [{internal:'true'},{curl:false},{ip:''},{ip:'not-an-address'}]) {
    const dir=await mkdtemp(join(tmpdir(),'two-probe-fallback-'));
    try{
      const {out,calls}=await probe(dir,await stubs(dir,variant));
      expect(out).toContain('ready');
      expect(calls).toContain("docker run --rm --network edge curlimages/curl:8.12.1 -s --connect-timeout 2 --max-time 2 -o /dev/null -w %{http_code} http://prod-api-green:8080/healthz");
      expect(calls).not.toMatch(/^curl /m);
    }finally{await rm(dir,{recursive:true,force:true});}
  }
});

test('a failing host probe is a failed probe, not a reason to probe twice',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'two-probe-fail-'));
  try{
    const env=await stubs(dir);
    await Bun.write(join(dir,'bin/curl'),`#!/bin/bash\necho "curl $*" >> '${dir}/calls'\necho 503\n`);
    const {out,calls}=await probe(dir,env);
    expect(out).not.toContain('ready');
    expect(calls).not.toContain('docker run');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a digest the VM already holds is not pulled again; an absent one and a tag still pull',async()=>{
  const digest=`example/api@sha256:${'a'.repeat(64)}`;
  expect(pullUnlessPresent('example/api:latest','docker pull x')).toBe('docker pull x');
  const dir=await mkdtemp(join(tmpdir(),'two-pull-'));
  try{
    const env=await stubs(dir);
    const script=`set -euo pipefail\n${pullUnlessPresent(digest,`docker pull '${digest}'`)}\n`;
    for(const present of [true,false]) {
      await rm(join(dir,'calls'),{force:true});
      if(present)await Bun.write(join(dir,'present'),'');else await rm(join(dir,'present'),{force:true});
      const p=Bun.spawn(['bash','-s'],{env,stdin:new Blob([script]),stdout:'ignore',stderr:'ignore'});
      expect(await p.exited).toBe(0);
      expect((await Bun.file(join(dir,'calls')).text()).includes('docker pull')).toBe(!present);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('the app lock waits long enough to cover a previous rollout\'s drain and stop',()=>{
  expect(appLock({name:'api',drainSeconds:70,stopTimeoutSeconds:60})).toBe('exec 8>/var/lock/2server-app-api.lock\nflock -w 250 8');
});

const flockTest=Bun.which('flock')?test:test.skip;
flockTest('a background drain keeps the app lock until its stop finishes, after the script has returned',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'two-drain-'));
  try{
    const lock=join(dir,'app.lock'),stopped=join(dir,'stopped');
    const script=`set -Eeuo pipefail
exec 8>${lock}
flock -w 5 8
exec 9>${join(dir,'edge.lock')}
flock -w 5 9
flock -u 9
${drainInBackground('api',1,`touch ${stopped}`)}
echo committed
`;
    const started=performance.now();
    const out=await run(['bash','-s'],script);
    expect(out.trim()).toBe('committed');
    expect(performance.now()-started).toBeLessThan(900);
    // The edge lock was released before the drain; the app lock was not.
    await run(['flock','-n',join(dir,'edge.lock'),'true']);
    await expect(run(['flock','-n',lock,'true'])).rejects.toThrow();
    await run(['flock','-w','5',lock,'true']);
    expect(await Bun.file(stopped).exists()).toBe(true);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('the edge origin check also curls from the host, with the credential on stdin and the containerized fallback kept',async()=>{
  const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'unused',user:'operator'},edge:{mode:'managed'}});
  const authorization='Basic c2VjcmV0LXZhbHVl';
  for(const variant of [{},{internal:'true'}]) {
    const dir=await mkdtemp(join(tmpdir(),'two-origin-'));
    try{
      const env=await stubs(dir,variant);
      // The stub curl and docker log stdin too, to prove where the header travels.
      await Bun.write(join(dir,'bin/curl'),`#!/bin/bash\necho "curl $*" >> '${dir}/calls'\ncat >> '${dir}/stdin'\necho 200\n`);
      const p=Bun.spawn(['bash','-s'],{env,stdin:new Blob([originProbeScript(c,'monitor.example.com','/-/ready','200',authorization)]),stdout:'ignore',stderr:'ignore'});
      expect(await p.exited).toBe(0);
      const calls=await Bun.file(join(dir,'calls')).text();
      expect(calls).not.toContain(authorization);
      if(variant.internal){
        expect(calls).toMatch(/docker run --rm -i --network \S+ curlimages\/curl:8.12.1 .*--connect-to monitor.example.com:443:\S+:443 https:\/\/monitor.example.com\/-\/ready/);
      }else{
        expect(calls).toContain('curl -sk --connect-timeout 5 --max-time 20 --config - -o /dev/null -w %{http_code} --connect-to monitor.example.com:443:172.18.0.9:443 https://monitor.example.com/-/ready');
        expect(calls).not.toContain('docker run');
        expect(await Bun.file(join(dir,'stdin')).text()).toContain(authorization);
      }
    }finally{await rm(dir,{recursive:true,force:true});}
  }
});
