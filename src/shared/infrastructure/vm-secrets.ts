let secrets:Record<string,Record<string,string>>|undefined;
export function setVmSecrets(value?:Record<string,Record<string,string>>) {secrets=value;}
export function vmSecret(app:string,key:string):string|undefined {
 if(!secrets) throw new Error('VM secrets require a connected session');
 return secrets[app]?.[key];
}
// Drop an app's whole secret namespace from the connected session; the session
// commit then removes it from the current control revision. Returns key names.
export function deleteVmSecrets(app:string):string[]|undefined {
 if(!secrets) return undefined;
 const keys=Object.keys(secrets[app]??{}).sort();
 delete secrets[app];
 return keys;
}
