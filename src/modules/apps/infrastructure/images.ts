import { remote } from '../../../shared/infrastructure/process';
import type { Config } from '../../config/application/config';
import { imageReference } from '../domain/image';
export const imageOperations={remote};
export function imageRepository(ref:string) {
 const name=ref.split('@')[0]; const last=name.slice(name.lastIndexOf('/')+1);
 return last.includes(':') ? name.slice(0,name.lastIndexOf(':')) : name;
}
// Resolve on the target platform. A failed registry read never falls back to cache.
export async function resolveImage(c:Config,ref:string):Promise<string> {
 imageReference.parse(ref);
 if(ref.includes('@sha256:')) return ref;
 let output:string;
 try { output=await imageOperations.remote(c,`set -euo pipefail
python3 - <<'PY'
import subprocess,re
r=subprocess.run(['docker','pull',${JSON.stringify(ref)}],capture_output=True,text=True)
if r.returncode: raise RuntimeError('Registry pull failed; no cached fallback')
digests=re.findall(r'^Digest: (sha256:[a-f0-9]{64})$',r.stdout,re.M)
if len(set(digests))!=1: raise RuntimeError('Registry did not return one immutable digest')
print(digests[0])
PY`); } catch {throw new Error('Registry resolution failed; no cached image fallback. Check VM registry credentials and connectivity.');}
 const digest=output.trim();
 if(!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid registry digest');
 return `${imageRepository(ref)}@${digest}`;
}
