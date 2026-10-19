import type { HealthCheck } from "../../../shared/domain/schema";
// Probes run for the lifetime of a workload, on every instance: a choice that
// costs 80ms of CPU is paid ~17,000 times a day at a 5s cadence. These notes
// do not block a deploy; they name the cheap alternative while it is cheap.
const interpreter=/^(node|nodejs|bun|deno|python[0-9.]*|ruby|php|perl|java)$/;
function probeBinary(command:string[]) {
  const base=(v:string)=>v.split('/').at(-1)??v;
  const [first,flag,script]=command;
  if(['sh','bash','ash','dash'].includes(base(first))&&flag==='-c'&&script)return base(script.trim().split(/\s+/)[0]??'');
  return base(first);
}
export function probeAdvisories(w:{kind?:'service'|'worker';healthPath?:string;edgeHealthPath?:string;healthCheck?:HealthCheck}):string[] {
  const notes:string[]=[];
  if(w.kind!=='worker'&&(w.healthPath==='/'||w.edgeHealthPath==='/'))notes.push("A '/' health path is probed by the edge every 5-10s per instance and by readiness checks; a rendered page there costs CPU all day. Point healthPath/edgeHealthPath at a static or cheap route.");
  const h=w.healthCheck;
  if(h) {
    const bin=probeBinary(h.command);
    if(h.intervalSeconds<10)notes.push(`healthCheck runs every ${h.intervalSeconds}s and starts a process each time; 30s is usually enough (startPeriodSeconds covers startup).`);
    if(interpreter.test(bin)&&h.intervalSeconds<30)notes.push(`healthCheck starts a ${bin} runtime every ${h.intervalSeconds}s; prefer the image's own health binary, wget/curl, or intervalSeconds of at least 30.`);
  }
  return notes;
}
