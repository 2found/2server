import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { productRoot } from "../skills/2server/scripts/product-root";

test("copied skill resolves an installed launcher and rejects missing/foreign packages", () => {
  const dir = mkdtempSync(join(tmpdir(), "2server-skill-"));
  try {
    const root = join(dir, "node_modules/@2server/cli");
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "src"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(root, "bin/2server.cjs"), "");
    writeFileSync(join(root, "src/cli.ts"), "");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@2server/cli" }));
    const launcher = join(dir, "bin/2srv");
    symlinkSync(join(root, "bin/2server.cjs"), launcher);
    expect(productRoot(launcher)).toBe(realpathSync(root));
    expect(() => productRoot(null)).toThrow("not on PATH");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "foreign-package" }));
    expect(() => productRoot(launcher)).toThrow("Cannot locate");
    writeFileSync(join(root, "package.json"), "private-invalid-content");
    expect(() => productRoot(launcher)).toThrow("Cannot locate");
    expect(() => productRoot(join(dir, "missing"))).toThrow("Cannot locate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both marketplace sources resolve the same self-contained skill plugin", async () => {
  const root = resolve(import.meta.dir, "..");
  const claudeCatalog = await Bun.file(join(root, ".claude-plugin/marketplace.json")).json();
  const codexCatalog = await Bun.file(join(root, ".agents/plugins/marketplace.json")).json();
  expect(claudeCatalog.name).toBe(codexCatalog.name);
  const pluginRoot = resolve(root, claudeCatalog.plugins[0].source);
  expect(pluginRoot).toBe(resolve(root, codexCatalog.plugins[0].source.path));
  const claude = await Bun.file(join(pluginRoot, ".claude-plugin/plugin.json")).json();
  const codex = await Bun.file(join(pluginRoot, ".codex-plugin/plugin.json")).json();
  expect(claude.name).toBe(claudeCatalog.plugins[0].name);
  expect(codex.name).toBe(codexCatalog.plugins[0].name);
  expect(claude.version).toBe(codex.version);
  for (const path of claude.skills) {
    expect(await Bun.file(join(pluginRoot, path, "SKILL.md")).exists()).toBe(true);
  }
  // Codex ignores a bare ./ root; name the actual skill directory.
  expect(codex.skills).not.toBe("./");
  expect(await Bun.file(join(pluginRoot, codex.skills, "SKILL.md")).exists()).toBe(true);
});
