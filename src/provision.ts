import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "./process";
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
) {
  if (!["gcp", "aws"].includes(provider))
    throw new Error("VM provider must be gcp or aws");
  const dir = new URL(`../terraform/${provider}/`, import.meta.url).pathname;
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
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lock = join(state, "operation.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error(`Another Terraform operation holds ${lock}`);
  }
  try {
    const plan = join(state, "review.tfplan");
    await run(["terraform", `-chdir=${dir}`, "init", "-input=false"]);
    console.log(
      await run([
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
          await run(["terraform", `-chdir=${dir}`, "show", "-json", plan]),
        ),
      );
    if (apply)
      console.log(
        await run([
          "terraform",
          `-chdir=${dir}`,
          "apply",
          "-input=false",
          plan,
        ]),
      );
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
