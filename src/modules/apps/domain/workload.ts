import type { Config } from "../../config/application/config";
import type { App } from "./schema";
export type Color = 'blue' | 'green';
export const instanceEnv = (a:App,color:Color) => Object.fromEntries(Object.entries(a.instanceEnv).map(([k,v])=>[k,v.replaceAll('${generation}',color)]));
export const volumeName = (c:Config,a:App,claim:string,color:string) => `two-${c.name}-${a.name}-${claim}-${color}`;
export function containerHealth(a:App) {
 const h=a.healthCheck;
 return h ? {test:['CMD',...h.command],interval:`${h.intervalSeconds}s`,timeout:`${h.timeoutSeconds}s`,start_period:`${h.startPeriodSeconds}s`,retries:h.failureThreshold} : undefined;
}
