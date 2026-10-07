import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { definitionPaths } from '../src/modules/extensions/infrastructure/catalog';

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

test('template implementations stay behind composition and never import sibling template behavior', () => {
  const templates = join(root, 'modules/extensions/infrastructure/templates');
  const templateKeys = new Set(definitionPaths(templates).map(file => {
    const definition = Bun.YAML.parse(readFileSync(file,'utf8')) as {metadata:{name:string;key?:string}};
    return definition.metadata.key ?? definition.metadata.name;
  }));
  const composition = new Set(['modules/extensions/application/registry.ts','modules/extensions/cli/legacy.ts']);
  const violations: string[] = [];
  for (const file of sourceFiles(root)) {
    const path = relative(root, file);
    const owner = relative(templates,file).split('/')[0];
    const inTemplate = !relative(templates,file).startsWith('..');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        const target = relative(templates, resolve(dirname(file), specifier.text));
        if (!target.startsWith('..')) {
          if (inTemplate && target.split('/')[0] !== owner)
            violations.push(`${path} imports sibling template ${target}`);
          else if (!inTemplate && !composition.has(path))
            violations.push(`${path} imports template ${target} outside composition`);
          else if (path === 'modules/extensions/cli/legacy.ts' && !target.endsWith('/legacy'))
            violations.push(`${path} imports non-compatibility template behavior ${target}`);
        }
      }
      if (!inTemplate && ts.isPropertyAccessExpression(node)) {
        if (node.name.text === 'runtimeEngine') violations.push(`${path} dispatches by runtime identity`);
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'extensions'
          && templateKeys.has(node.name.text))
          violations.push(`${path} reads a template-specific config field`);
      }
      if (!inTemplate && ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'extensions' && ts.isStringLiteral(node.argumentExpression)
        && templateKeys.has(node.argumentExpression.text))
        violations.push(`${path} reads a template-specific config field`);
      if (!inTemplate && ts.isBinaryExpression(node)
        && [ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
        for (const [selector,value] of [[node.left,node.right],[node.right,node.left]])
          if (ts.isPropertyAccessExpression(selector) && selector.name.text === 'template' && ts.isStringLiteral(value))
            violations.push(`${path} dispatches by template name`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
