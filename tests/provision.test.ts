import { expect,test } from "bun:test";
import { mkdir,mkdtemp,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionRoot } from "../src/modules/server/infrastructure/provision";

test("stranded legacy state prevents duplicate resource creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "two-legacy-state-"));
  try {
    await Bun.write(join(dir, "terraform.tfstate"), JSON.stringify({
      resources: [{ type: "google_storage_bucket", name: "backup" }],
    }));
    await expect(provisionRoot(dir, join(dir, "vars.json"), join(dir, "state"), true))
      .rejects.toThrow("Legacy Terraform state");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const integration = process.env.TERRAFORM_TESTS === "1" ? test : test.skip;
test("input preparation failure releases the Terraform operation lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "two-tf-input-"));
  const state = join(dir, "state");
  const failure = new Error("Cannot write generated input");
  try {
    await expect(provisionRoot(dir, join(dir, "vars.json"), state, false, false, async () => {
      expect((await stat(join(state, "operation.lock"))).isDirectory()).toBe(true);
      throw failure;
    })).rejects.toBe(failure);
    await expect(stat(join(state, "operation.lock"))).rejects.toMatchObject({code: "ENOENT"});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

integration("saved plan persists isolated state across create, update and destroy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "two-tf-state-"));
  const root = join(dir, "root"), state = join(dir, "state"), vars = join(dir, "vars.json");
  try {
    await mkdir(root);
    // Terraform's built-in provider: no cloud account or external resource.
    await Bun.write(join(root, "main.tf"), `
      variable "value" { type = string }
      resource "terraform_data" "probe" { input = var.value }
    `);
    await Bun.write(vars, JSON.stringify({ value: "initial" }));
    await provisionRoot(root, vars, state, true);
    const before = await Bun.file(join(state, "terraform.tfstate")).json();
    const id = before.resources[0].instances[0].attributes.id;
    expect(id).toBeTruthy();
    expect(await Bun.file(join(root, "terraform.tfstate")).exists()).toBe(false);
    await provisionRoot(root, vars, state, true);
    expect((await Bun.file(join(state, "terraform.tfstate")).json()).serial).toBe(before.serial);
    await Bun.write(vars, JSON.stringify({ value: "updated" }));
    await provisionRoot(root, vars, state, true);
    const after = await Bun.file(join(state, "terraform.tfstate")).json();
    expect(after.resources[0].instances[0].attributes.id).toBe(id);
    expect(after.resources[0].instances[0].attributes.input.value).toBe("updated");
    await provisionRoot(root, vars, state, true, true);
    expect((await Bun.file(join(state, "terraform.tfstate")).json()).resources).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);

test('Terraform outputs become a complete bootstrap manifest for GCP and AWS', async () => {
  const {provisionManifest}=await import('../src/modules/server/infrastructure/provision');
  const shared={name:{value:'dx-server'},origin_ip:{value:'203.0.113.10'}};
  const gcp=provisionManifest('gcp',{...shared,ssh:{value:{kind:'gcp',project:'example-project',zone:'asia-southeast1-a',instance:'dx-server',iap:true}}});
  expect(gcp.ssh.kind).toBe('gcp');expect(gcp.apps).toEqual([]);expect(gcp.domains).toEqual([]);
  const aws={...shared,ssh_host:{value:'203.0.113.10'},vm:{value:{kind:'aws' as const,region:'ap-southeast-1',instanceId:'i-0123456789abcdef0'}}};
  expect(()=>provisionManifest('aws',aws)).toThrow();
  expect(provisionManifest('aws',aws,'ubuntu').vm).toEqual(aws.vm.value);
});

test('provision dry run never applies or exports; apply exports privately and refuses overwrite', async () => {
  const {provision,provisionOperations}=await import('../src/modules/server/infrastructure/provision');
  const {createHash}=await import('node:crypto');
  const {homedir}=await import('node:os');
  const {stat}=await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'two-provision-dx-'));
  const file=join(dir,'server.tfvars'),output=join(dir,'server.local.json');
  const state=join(homedir(),'.local/state/2server/terraform/gcp',createHash('sha256').update(file).digest('hex').slice(0,16));
  const original=provisionOperations.run,calls:string[][]=[];
  provisionOperations.run=async(args)=>{
    calls.push(args);
    return args.includes('output')?JSON.stringify({name:{value:'dx-server'},origin_ip:{value:'203.0.113.10'},ssh:{value:{kind:'gcp',project:'example-project',zone:'asia-southeast1-a',instance:'dx-server',iap:true}}}):'';
  };
  try {
    await Bun.write(file,'project = "example-project"');
    await provision('gcp',file,false,false,{output});
    expect(calls.some(a=>a.includes('apply')||a.includes('output'))).toBe(false);
    expect(await Bun.file(output).exists()).toBe(false);
    await provision('gcp',file,true,false,{output});
    expect(calls.some(a=>a.includes('apply'))).toBe(true);
    expect((await Bun.file(output).json()).name).toBe('dx-server');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const count=calls.length;
    await expect(provision('gcp',file,true,false,{output})).rejects.toThrow('overwrite');
    expect(calls).toHaveLength(count);
    await expect(provision('aws',file,true,false,{output:join(dir,'aws.json')})).rejects.toThrow('--ssh-user');
    expect(calls).toHaveLength(count);
  } finally {provisionOperations.run=original;await rm(dir,{recursive:true,force:true});await rm(state,{recursive:true,force:true});}
});
