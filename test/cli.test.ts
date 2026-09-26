import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const directory = mkdtempSync(join(process.cwd(), '.cli-test-'));
const file = join(directory, 'sample.md');
const markdown = '# Hello\n\n**World**\n';

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  writeFileSync(file, markdown);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function cli(args: string[] = [], input = '') {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], { input, encoding: 'utf8' });
}

describe('CLI', () => {
  it('reads a file and defaults to Cloud HTML', () => {
    const result = cli([file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('<h1>Hello</h1><p><strong>World</strong></p>\n');
    expect(result.stderr).toBe('');
  });

  it('reads a file for wiki output', () => {
    const result = cli(['--target', 'wiki', file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('h1. Hello\n\n*World*\n');
  });

  it.each([[], ['-']])('reads stdin with arguments %j', (...args) => {
    const result = cli(args, markdown);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('<h1>Hello</h1>');
  });

  it('keeps target-specific notices off stdout', () => {
    const wiki = cli(['--target=wiki'], '- [x] done');
    expect(wiki.status).toBe(0);
    expect(wiki.stdout).toBe('* \\[x\\] done\n');
    expect(wiki.stderr).toContain('1 task item: wiki markup has no task-list syntax');
    expect(cli([], '- [x] done').stderr).toBe('');
  });

  it.each([
    ['--target', 'invalid'],
    ['--target'],
    ['--unknown'],
    ['one.md', 'two.md'],
    [join(directory, 'missing.md')],
  ])('rejects invalid input %j', (...args) => {
    const result = cli(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Error: /);
  });

  it('prints help without reading input', () => {
    const result = cli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('preserves empty input', () => {
    expect(cli().stdout).toBe('');
    expect(cli().status).toBe(0);
  });
});
