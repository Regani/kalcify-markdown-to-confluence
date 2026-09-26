import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const failures = [];
for (const directory of ['src', 'test', 'scripts']) {
  for (const name of readdirSync(directory)) {
    if (!/\.(ts|mjs)$/.test(name)) continue;
    const file = `${directory}/${name}`;
    const source = readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
          ts.isNonNullExpression(node) || node.kind === ts.SyntaxKind.AnyKeyword ||
          node.kind === ts.SyntaxKind.UnknownKeyword) failures.push(`${file}: type escape`);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ['parse', 'safeParse'].includes(node.expression.name.text)) {
        failures.push(`${file}: manual parsing`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    if (/@ts-(?:ignore|expect-error)|process\.env|\b(?:SELECT|INSERT INTO|CREATE TABLE)\b/.test(source) &&
        file !== 'scripts/check-architecture.mjs') failures.push(`${file}: forbidden boundary or suppression`);
  }
}
if (failures.length > 0) throw new Error(failures.join('\n'));
console.log('Architecture check passed: no type escapes, manual parsing, raw SQL or environment reads.');
