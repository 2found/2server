import { afterEach,expect,spyOn,test } from 'bun:test';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAdvisories } from '../src/modules/apps/domain/probe-cost';
import { fileCommand } from '../src/modules/source/cli/command';

const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const check=(intervalSeconds:number,...command:string[])=>({command,intervalSeconds,timeoutSeconds:5,startPeriodSeconds:60,failureThreshold:3});

test('a rendered home page as the edge probe target is named; a dedicated route and a worker are not',()=>{
  expect(probeAdvisories({kind:'service',healthPath:'/'})[0]).toContain("healthPath '/'");
  expect(probeAdvisories({kind:'service',healthPath:'/healthz'})).toEqual([]);
  expect(probeAdvisories({kind:'worker',healthPath:'/'})).toEqual([]);
});

test('frequent probes and interpreter probes are named; a 30s binary probe is quiet',()=>{
  expect(probeAdvisories({healthCheck:check(5,'wget','-q','--spider','http://localhost:8080/healthz')})).toEqual([expect.stringContaining('every 5s')]);
  expect(probeAdvisories({healthCheck:check(15,'/usr/local/bin/node','-e','fetch("http://localhost:3000/")')})).toEqual([expect.stringContaining('starts a node runtime every 15s')]);
  expect(probeAdvisories({healthCheck:check(10,'sh','-c','python3 -c "import urllib"')})).toEqual([expect.stringContaining('python3 runtime')]);
  expect(probeAdvisories({healthCheck:check(30,'node','-e','fetch("/")')})).toEqual([]);
  expect(probeAdvisories({healthCheck:check(30,'wget','--spider','-q','http://localhost/healthz')})).toEqual([]);
});

test('validate prints the advisory on stderr and still succeeds',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'two-probe-cost-'));dirs.push(dir);
  const file=join(dir,'app.yaml');
  await writeFile(file,`apiVersion: 2server.app/v1
kind: App
metadata: {name: web}
spec:
  image: ghcr.io/example/web:latest
  port: 3000
  healthPath: /
  memoryMb: 256
  cpus: 0.5
  healthCheck: {command: [node, -e, 'fetch("http://localhost:3000/")'], intervalSeconds: 10}
`);
  const warn=spyOn(console,'warn').mockImplementation(()=>{});
  const log=spyOn(console,'log').mockImplementation(()=>{});
  try {
    expect(await fileCommand(['validate','-f',file])).toBe(true);
    const notes=warn.mock.calls.map(c=>String(c[0]));
    expect(notes).toHaveLength(2);
    expect(notes.every(n=>n.startsWith('Advisory: '))).toBe(true);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('Valid App: web');
  } finally {warn.mockRestore();log.mockRestore();}
});
