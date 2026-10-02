import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '../src');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

// Config composes the catalog at application level. Type-only references to its
// inferred shape are allowed; domain code must never load that composition.
test('domain rules and shared helpers retain their runtime dependency boundaries', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(root)) {
    const path = relative(root, file);
    const domain = path.includes('/domain/');
    const shared = path.startsWith('shared/');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function checkImport(specifier: string, typeOnly: boolean) {
      if (typeOnly) return;
      if (specifier.startsWith('.')) {
        const target = relative(root, resolve(dirname(file), specifier));
        if (domain && !target.includes('/domain/')) violations.push(`${path} loads ${target}`);
        if (shared && !target.startsWith('shared/')) violations.push(`${path} loads feature ${target}`);
        if (path.includes('/application/') && (target.startsWith('cli/') || /modules\/[^/]+\/cli\//.test(target)))
          violations.push(`${path} loads CLI adapter ${target}`);
      } else if (domain && !['zod', 'node:util'].includes(specifier)) {
        violations.push(`${path} loads external adapter ${specifier}`);
      }
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typeOnly = !!clause?.isTypeOnly || (!!named && ts.isNamedImports(named)
          && !clause?.name && named.elements.every(element => element.isTypeOnly));
        checkImport(node.moduleSpecifier.text, typeOnly);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const named = node.exportClause;
        const typeOnly = node.isTypeOnly || (!!named && ts.isNamedExports(named) && named.elements.every(element => element.isTypeOnly));
        checkImport(node.moduleSpecifier.text, typeOnly);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (ts.isStringLiteral(node.arguments[0])) checkImport(node.arguments[0].text, false);
        else if (domain || shared) violations.push(`${path} dynamically loads an adapter`);
      }
      if (domain && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && ['Bun', 'process'].includes(node.expression.text)) violations.push(`${path} accesses ${node.expression.text}`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});

test('only the executable stays at src root and relative runtime imports resolve', () => {
  expect(readdirSync(root).filter(file => file.endsWith('.ts'))).toEqual(['cli.ts']);
  const missing: string[] = [];
  for (const file of sourceFiles(root)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        const target = resolve(dirname(file), specifier.text);
        if (![target, `${target}.ts`, join(target, 'index.ts')].some(existsSync))
          missing.push(`${relative(root, file)}: ${specifier.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(missing).toEqual([]);
});
