let secrets:Record<string,Record<string,string>>|undefined;
export function setVmSecrets(value?:Record<string,Record<string,string>>) {secrets=value;}
export function vmSecret(app:string,key:string):string|undefined {
 if(!secrets) throw new Error('VM secrets require a connected session');
 return secrets[app]?.[key];
}
