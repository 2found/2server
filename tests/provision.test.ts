import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionRoot } from "../src/provision";

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
