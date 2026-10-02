import { createHash } from "node:crypto";
import { chmod,lstat,mkdir,rm,writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath } from 'node:url';
import { run } from "../../../shared/infrastructure/process";
import { configSchema } from '../../config/application/config';
export const provisionOperations = {run};
type ProvisionOptions = {output?: string; sshUser?: string; prepareInput?: () => Promise<void>};
export function provisionManifest(provider: string, outputs: Record<string, {value: unknown}>, sshUser?: string) {
  return configSchema.parse({version:1, name:outputs.name?.value,
    ssh:provider==='gcp'?outputs.ssh?.value:{kind:'ssh',host:outputs.ssh_host?.value,user:sshUser},
    originIp:outputs.origin_ip?.value, vm:outputs.vm?.value,
    disks:Object.values((outputs.data_disks?.value ?? {}) as object),edge:{mode:'managed'}});
}
export function assertDestroyPlan(plan: {
  resource_changes?: {
    type: string;
    change: { actions: string[]; before?: Record<string, unknown> };
  }[];
}) {
  for (const resource of plan.resource_changes ?? []) {
    if (!resource.change.actions.includes("delete")) continue;
    const before = resource.change.before;
    if (
      (resource.type === "google_compute_instance" &&
        before?.deletion_protection !== false) ||
      (resource.type === "aws_instance" &&
        before?.disable_api_termination !== false)
    ) {
      throw new Error(
        "VM deletion protection is enabled. Apply a reviewed allow_destroy=true update in the original Terraform state before requesting destruction. No part of the destroy plan was applied.",
      );
    }
  }
}
export async function provision(
  provider: string,
  file: string,
  apply: boolean,
  destroy = false,
  options: ProvisionOptions = {},
) {
  if (!["gcp", "aws", "gcs-backup"].includes(provider))
    throw new Error("Terraform target must be gcp, aws or gcs-backup");
  if (options.sshUser && provider !== 'aws') throw new Error('--ssh-user is only valid for AWS manifest export');
  const dir = fileURLToPath(new URL(`../../../../terraform/${provider}/`, import.meta.url));
  const identity = createHash("sha256")
    .update(resolve(file))
    .digest("hex")
    .slice(0, 16);
  const state = join(
    homedir(),
    ".local",
    "state",
    "2server",
    "terraform",
    provider,
    identity,
  );
  if (options.output) {
    if (destroy || provider === 'gcs-backup' || !options.output.endsWith('.json')) throw new Error('--output requires a VM target and a .json path');
    if (provider === 'aws' && !options.sshUser) throw new Error('AWS --output requires --ssh-user matching your AMI');
    // Validate user input before creating paid resources.
    provisionManifest(provider, {name:{value:'validation'},ssh:{value:{kind:'gcp',project:'example-project',zone:'us-central1-a',instance:'validation'}},ssh_host:{value:'203.0.113.10'}}, options.sshUser);
    try { await lstat(options.output); throw new Error('Refusing to overwrite --output; choose a new private manifest path'); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  } else if (options.sshUser) throw new Error('--ssh-user requires --output');
  console.log(`Terraform state: ${join(state,'terraform.tfstate')}`);
  await provisionRoot(dir, file, state, apply, destroy, options.prepareInput, async () => {
    if (!options.output) return;
    try {
      const outputs = JSON.parse(await provisionOperations.run(['terraform',`-chdir=${dir}`,'output',`-state=${join(state,'terraform.tfstate')}`,'-json']));
      const c = provisionManifest(provider, outputs, options.sshUser);
      await mkdir(dirname(resolve(options.output)), {recursive:true,mode:0o700});
      await writeFile(options.output, JSON.stringify(c,null,2)+'\n',{flag:'wx',mode:0o600});
    } catch {
      throw new Error(`Terraform applied, but bootstrap manifest export failed. Inspect outputs using the state at ${join(state,'terraform.tfstate')}; do not create a new Terraform state.`);
    }
    console.log('Bootstrap manifest saved. Verify/trust the SSH host key, then run server bootstrap -f FILE --env-file PRIVATE_FILE --apply.');
  });
  if (options.output && !apply) console.log(`Apply will export a private bootstrap manifest to ${options.output}; no file written during plan.`);
}

// Shared runner: the reviewed plan and apply must read/write the same state.
export async function provisionRoot(
  dir: string,
  file: string,
  state: string,
  apply: boolean,
  destroy = false,
  prepareInput?: () => Promise<void>,
  afterApply?: () => Promise<void>,
) {
  const legacy = Bun.file(join(dir, "terraform.tfstate"));
  if (await legacy.exists()) {
    const contents = await legacy.json();
    if (contents.resources?.length)
      throw new Error(
        `Legacy Terraform state found at ${legacy.name}. Reconcile its resource identities with ${join(state, "terraform.tfstate")} before provisioning; do not recreate existing resources.`,
      );
  }
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  const lock = join(state, "operation.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error(`Another Terraform operation holds ${lock}`);
  }
  try {
    // Generated inputs share the state's lock with plan/apply, including dry runs.
    await prepareInput?.();
    const plan = join(state, "review.tfplan");
    await provisionOperations.run(["terraform", `-chdir=${dir}`, "init", "-input=false"]);
    console.log(
      await provisionOperations.run([
        "terraform",
        `-chdir=${dir}`,
        "plan",
        "-input=false",
        ...(destroy ? ["-destroy"] : []),
        `-var-file=${resolve(file)}`,
        `-state=${join(state, "terraform.tfstate")}`,
        `-out=${plan}`,
      ]),
    );
    if (destroy)
      assertDestroyPlan(
        JSON.parse(
          await provisionOperations.run(["terraform", `-chdir=${dir}`, "show", "-json", plan]),
        ),
      );
    if (apply) {
      console.log(
        await provisionOperations.run([
          "terraform",
          `-chdir=${dir}`,
          "apply",
          "-input=false",
          `-state=${join(state, "terraform.tfstate")}`,
          plan,
        ]),
      );
      await afterApply?.();
    }
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
