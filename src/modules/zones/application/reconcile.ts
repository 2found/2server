import type { Config } from '../../config/application/config';
import type { Zone } from '../domain/schema';
import { cloudflareClient } from '../../domains/application/reconcile';
import { inspectZone,applyZone } from '../infrastructure/cloudflare';
export const zoneOperations={inspectZone,applyZone,cloudflareClient};
export async function reconcileZone(c:Config,zone:Zone,apply=false){
 const cf=zoneOperations.cloudflareClient(c);
 const plan=await zoneOperations.inspectZone(cf,c.name,zone);
 console.log(JSON.stringify({zonePolicy:plan},null,2));
 if(!apply){console.log('Plan only; pass --apply to update Cloudflare. No image pull or app rollout.');return;}
 await zoneOperations.applyZone(cf,c.name,zone);
 console.log('Cloudflare zone policy applied. App runtimes unchanged.');
}
