import { chmod,mkdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { operatorState } from '../../../shared/infrastructure/operator-state';
import { readConfig } from '../../config/infrastructure/file';
import { extensionSpec } from '../../extensions/application/bindings';
import { extensionFor } from '../../extensions/application/registry';

const common:Record<string,string>={get:'get',deploy:'deploy',logs:'logs',restart:'reload',delete:'delete',rollback:'rollback',scale:'scale'};
export const appHelp='app [NAME] [get|deploy|logs|restart|delete|rollback|scale|help]';
export async function appCommand(args:string[],execute:(args:string[])=>Promise<void>):Promise<boolean> {
 if(args[0]==='app') {
  if(args[1]==='--help'){console.log(appHelp);return true;}
  if(Object.hasOwn(common,args[1])&&(!args[2]||args[2].startsWith('-')))return false; // Legacy noun-first list commands.
  if(!args[1]||args[1].startsWith('-')) {await execute(['get','app',...args.slice(1)]);return true;}
  const name=args[1],hasOperation=!!args[2]&&!args[2].startsWith('-'),op=hasOperation?args[2]:'get';
  const tail=args.slice(hasOperation?3:2);
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(name)||op.startsWith('-'))throw new Error(`Use ${appHelp}`);
  await execute(Object.hasOwn(common,op)?[common[op],'app',name,...tail]:['app-action',name,op,...tail]);
  return true;
 }
 if(args[0]!=='app-action'||!args.includes('-f'))return false;
 const at=args.indexOf('-f'),file=args[at+1];
 if(!file)throw new Error('Missing server manifest');
 const c=await readConfig(file),name=args[1],op=args[2];
 const ext=extensionFor(c,name),installed=!!(ext&&extensionSpec(c,ext));
 if(!installed&&!c.apps.some(a=>a.name===name))throw new Error(`App ${name} is not installed`);
 const rest=args.slice(3);rest.splice(rest.indexOf('-f'),2);
 if(op==='help') {
  if(rest.length)throw new Error('App help takes only connection options');
  console.log(`App ${name}${installed?` (template ${c.extensionApps[name]?.template??ext!.cliName??ext!.name})`:''}\n  get, deploy, logs, restart, delete${installed?'':', rollback, scale'}`);
  for(const [command,detail]of Object.entries(installed?ext!.commands??{}:{}))console.log(`  app ${name} ${command}${detail.usage?' '+detail.usage:''} — ${detail.description}`);
  return true;
 }
 const command=installed&&Object.hasOwn(ext!.commands??{},op)?ext!.commands![op]:undefined;
 if(!command)throw new Error(`Command ${op} is not installed for App ${name}; use app ${name} help`);
 const context=ext!.context?.(c)??c;
 // Only shipped extension modules can extend the CLI. No paths/code from VM state.
 const template=c.extensionApps[name]?.template??ext!.cliName??ext!.name;
 const {runExtensionCommand}=await import('../../extensions/cli/command');
 if(!rest.includes('--apply')||command.readOnly)await runExtensionCommand(template,context,op,rest);
 else {
  const state=operatorState(c.name),lock=join(state,'lock');
  await mkdir(state,{recursive:true,mode:0o700});await chmod(state,0o700);
  try {await mkdir(lock);}catch{throw new Error(`Another operation holds ${lock}`);}
  try {await runExtensionCommand(template,context,op,rest);}finally{await rm(lock,{recursive:true,force:true});}
 }
 return true;
}
