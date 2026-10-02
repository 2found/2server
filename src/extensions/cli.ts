import type {Config} from '../config';
import {extensionForCliName} from './index';
// Only definitions shipped with the CLI may load a module; never a VM-supplied path.
export async function runExtensionCommand(template:string,c:Config,command:string,args:string[]) {
 const ext=extensionForCliName(template);
 if(!ext||!Object.hasOwn(ext.commands??{},command))throw new Error('Extension command is not registered');
 const module=await import(`./${template}/cli.ts`);
 await module.run(c,command,args);
}
