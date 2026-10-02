import { appSchema,type App } from "../../apps/domain/schema";
import type { Document } from "./document";
export function authoritativeApp(d:Extract<Document,{kind:'App'}>,image:string,runtime?:Record<string,unknown>):App {
 return appSchema.parse({...d.spec,name:d.metadata.name,image,compose:d.spec.compose?{...d.spec.compose,runtime}:undefined});
}
export function assertBindings(old:App|undefined,next:App) {
 if(!old) {if(next.compose)throw new Error('Compose adoption must happen before applying its source file');return;}
 const binding=(a:App)=>a.compose?{project:a.compose.project,services:a.compose.services,containers:a.compose.containers,upstreamFile:a.compose.upstreamFile,upstreamName:a.compose.upstreamName}:null;
 if(JSON.stringify(binding(old))!==JSON.stringify(binding(next)))throw new Error('Cannot replace runtime ownership bindings; migrate/adopt explicitly');
}
