#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { convertMarkdown, noticesFor, noticeText } from './convert.js';

try {
  const { values, positionals } = parseArgs({
    options: {
      target: { type: 'string', default: 'cloud' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      'Usage: kalcify-markdown-to-confluence [--target cloud|wiki] [file]\n' +
        'Read Markdown from a UTF-8 file or stdin (also: -). Default target: cloud.\n' +
        'Output goes to stdout; conversion notices go to stderr.\n'
    );
  } else {
    const target = values.target;
    if (target !== 'cloud' && target !== 'wiki') {
      throw new Error('--target must be cloud or wiki');
    }
    if (positionals.length > 1) throw new Error('Expected at most one input file');
    const file = positionals[0];
    const markdown = readFileSync(file === undefined || file === '-' ? 0 : file, 'utf8');
    const result = convertMarkdown(markdown);
    for (const notice of noticesFor(target, result.notices)) {
      process.stderr.write(`${noticeText(notice)}\n`);
    }
    const output = target === 'cloud' ? result.cloudHtml : result.wikiMarkup;
    process.stdout.write(output === '' ? '' : `${output}\n`);
  }
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : 'Conversion failed'}\n`);
  process.exitCode = 1;
}
