import { remote } from '../../../../../shared/infrastructure/process';
import type { Config } from '../../../../config/application/config';
import { extensionProject } from '../../../application/stateful';
import { restoreScript,runBackup } from './backups';
import { physicalRestoreScript,removeRecoveryScript } from './pgbackrest';
export const postgresCliOperations={remote,runBackup};
export async function run(c:Config,command:string,args:string[]) {
 const allowed:Record<string,string[]>={backup:[],backups:[],restore:['--id','--database','--recovery','--target-time'],'check-backup':[],recoveries:[],'remove-recovery':['--recovery']};
 const readOnly=['backups','recoveries'].includes(command),options:Record<string,string>={};let apply=false;
 if(!Object.hasOwn(allowed,command))throw new Error('Unknown postgres app command');
 for(let i=0;i<args.length;i++) {
  const flag=args[i];
  if(flag==='--apply'&&!apply&&!readOnly){apply=true;continue;}
  if(!allowed[command].includes(flag)||flag in options||!args[i+1]||args[i+1].startsWith('-'))throw new Error('Unknown, duplicate or missing database command option');
  options[flag]=args[++i];
 }
 let script:string|undefined;
 if(command==='backup'&&!c.extensions.postgres?.backup)throw new Error('PostgreSQL backup is not configured for this app');
 if(command==='backups') {
  if(c.extensions.postgres?.backup?.engine!=='pgbackrest')throw new Error('Backup inventory requires pgBackRest');
  script=`docker exec --user postgres ${extensionProject(c,'postgres')} pgbackrest --stanza=main --output=json info`;
 }
 if(command==='check-backup')script=physicalRestoreScript(c,{name:'drill',check:true});
 if(command==='restore') {
  if(options['--database']&&(options['--recovery']||options['--target-time']))throw new Error('Choose logical --database or physical --recovery, not both');
  script=options['--database']?restoreScript(c,options['--id']??'',options['--database']):physicalRestoreScript(c,{name:options['--recovery']??'',id:options['--id'],targetTime:options['--target-time']});
 }
 if(command==='remove-recovery')script=removeRecoveryScript(c,options['--recovery']??'');
 if(command==='recoveries')script=`docker ps -a --filter label=io.2server.owner=${c.name} --filter label=io.2server.recovery=true --filter name=^/${extensionProject(c,'recovery')}- --format '{{json .}}'`;
 if(!readOnly&&!apply){console.log(`${command} ${c.instance?.name??'postgres'}: pass --apply to execute`);return;}
 console.log(command==='backup'?await postgresCliOperations.runBackup(c):await postgresCliOperations.remote(c,script!));
}
