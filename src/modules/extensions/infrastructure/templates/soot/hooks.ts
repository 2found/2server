import type { ExtensionHooks } from '../../../domain/types';
import { identity,operatorToken,restart,retire } from './deploy';
import { sootSourceDeployment } from './source';

export const sootHooks={
  sourceDeployment:sootSourceDeployment,
  deploy:restart,
  remove:retire,
  validate(c,ctx){
    if(!c.extensions.soot)return;
    if(!c.instance) {
      ctx.addIssue({code:'custom',message:'Soot requires a named App instance'});
    } else {
      try{identity(c);}catch{ctx.addIssue({code:'custom',message:'Soot must use its isolated instance data root'});}
    }
  },
  summary(c){operatorToken(c);return [`Soot API: ${identity(c).container}:7788; readiness and C3 acknowledgment required`];},
} satisfies ExtensionHooks;
