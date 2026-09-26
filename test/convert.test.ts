import { describe, expect, it } from 'vitest';
import { convertMarkdown, noticeText, noticesFor, type NoticeId } from '../src/convert.js';

function wiki(markdown: string): string {
  return convertMarkdown(markdown).wikiMarkup;
}

function html(markdown: string): string {
  return convertMarkdown(markdown).cloudHtml;
}

function noticeIds(markdown: string): NoticeId[] {
  return convertMarkdown(markdown).notices.map((notice) => notice.id);
}

describe('tables', () => {
  const table = ['| Name | Value |', '| :--- | ---: |', '| a \\| b | |', '| **x** | `y` |'].join(
    '\n'
  );

  it('writes a || header row, | body rows, a space for an empty cell and an escaped pipe', () => {
    expect(wiki(table)).toBe(['||Name||Value||', '|a \\| b| |', '|*x*|{{y}}|'].join('\n'));
  });

  it('emits th header cells for the Cloud editor', () => {
    expect(html(table)).toBe(
      '<table><thead><tr><th>Name</th><th>Value</th></tr></thead>' +
        '<tbody><tr><td>a | b</td><td></td></tr>' +
        '<tr><td><strong>x</strong></td><td><code>y</code></td></tr></tbody></table>'
    );
  });

  it('reports column alignment as not carried over', () => {
    expect(noticeIds(table)).toEqual(['table-alignment']);
    expect(noticeIds('| a |\n| - |\n| 1 |')).toEqual([]);
  });
});

describe('lists', () => {
  const nested = '- a\n  - b\n    1. c\n- d\n\n1. one\n2. two';

  it('stacks wiki list markers by depth, mixing * and #', () => {
    expect(wiki(nested)).toBe(['* a', '** b', '**# c', '* d', '', '# one', '# two'].join('\n'));
  });

  it('nests ul/ol for the Cloud editor', () => {
    expect(html(nested)).toBe(
      '<ul><li>a<ul><li>b<ol><li>c</li></ol></li></ul></li><li>d</li></ul><ol><li>one</li><li>two</li></ol>'
    );
  });

  it('keeps an ordered list start number in HTML', () => {
    expect(html('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  it('joins a list item’s paragraphs with an explicit wiki line break', () => {
    expect(wiki('- first\n\n  second\n- next')).toBe('* first \\\\ second\n* next');
  });

  it('writes a code block that sits inside a list item after the item', () => {
    const result = convertMarkdown('1. install\n\n   ```sh\n   npm i\n   ```\n2. run');
    expect(result.wikiMarkup).toBe(
      ['# install', '{code:language=sh}', 'npm i', '{code}', '# run'].join('\n')
    );
    expect(noticesFor('wiki', result.notices).map((notice) => notice.id)).toEqual([
      'wiki-blocks-in-lists',
    ]);
    expect(noticesFor('cloud', result.notices)).toEqual([]);
  });
});

describe('task lists', () => {
  const tasks = '- [x] ship it\n- [ ] write docs\n  - [ ] nested';

  it('uses the Atlassian editor’s action-item markup when every item is a task', () => {
    expect(html(tasks)).toBe(
      '<div data-node-type="actionList">' +
        '<div data-task-local-id="" data-task-state="DONE">ship it</div>' +
        '<div data-task-local-id="" data-task-state="TODO">write docs</div>' +
        '<div data-node-type="actionList"><div data-task-local-id="" data-task-state="TODO">nested</div></div>' +
        '</div>'
    );
  });

  it('keeps an escaped [x] / [ ] prefix in wiki markup, which has no task syntax', () => {
    expect(wiki(tasks)).toBe('* \\[x\\] ship it\n* \\[ \\] write docs\n** \\[ \\] nested');
    expect(noticeIds(tasks)).toEqual(['wiki-tasks']);
  });

  it('falls back to a text prefix when tasks share a list with ordinary items', () => {
    const mixed = '- [x] done\n- plain';
    expect(html(mixed)).toBe('<ul><li>[x] done</li><li>plain</li></ul>');
    expect(noticeIds(mixed)).toEqual(['cloud-mixed-tasks', 'wiki-tasks']);
  });
});

describe('fenced code', () => {
  it('carries the fence language into both outputs', () => {
    const markdown = '```python\nprint("{x}")\n```';
    expect(wiki(markdown)).toBe('{code:language=python}\nprint("{x}")\n{code}');
    expect(html(markdown)).toBe(
      '<pre data-language="python"><code class="language-python">print(&quot;{x}&quot;)</code></pre>'
    );
  });

  it('leaves code text unescaped inside the code macro', () => {
    expect(wiki('```\na*b | [c] _d_\n```')).toBe('{code}\na*b | [c] _d_\n{code}');
  });

  it('drops a decorated info string such as {r} rather than emitting a broken parameter', () => {
    expect(wiki('```{r}\nx <- 1\n```')).toBe('{code}\nx <- 1\n{code}');
    expect(html('```{r}\nx <- 1\n```')).toBe('<pre><code>x &lt;- 1</code></pre>');
  });

  it('switches to {noformat} when the code itself contains {code}', () => {
    expect(wiki('```\nuse {code} here\n```')).toBe('{noformat}\nuse {code} here\n{noformat}');
  });

  it('flags code that contains both {code} and {noformat}', () => {
    expect(noticeIds('```\n{code} and {noformat}\n```')).toEqual(['wiki-unfenced-code']);
  });
});

describe('inline code containing markup characters', () => {
  it('escapes every wiki markup character inside {{…}}', () => {
    expect(wiki('Use `a*b_{c}|[d]` and `my-var`.')).toBe(
      'Use {{a\\*b\\_\\{c\\}\\|\\[d\\]}} and {{my\\-var}}.'
    );
  });

  it('keeps the characters literal in HTML', () => {
    expect(html('Use `a*b_{c}|[d]`.')).toBe('<p>Use <code>a*b_{c}|[d]</code>.</p>');
  });
});

describe('links and images', () => {
  it('writes [alias|url] and percent-encodes | and ] in the URL', () => {
    expect(wiki('[Docs](https://ex.com/a|b "Tip")')).toBe('[Docs|https://ex.com/a%7Cb]');
    expect(html('[Docs](https://ex.com/a|b "Tip")')).toBe(
      '<p><a href="https://ex.com/a%7Cb" title="Tip">Docs</a></p>'
    );
  });

  it('writes a bare autolink as [url]', () => {
    expect(wiki('<https://ex.com/x_y>')).toBe('[https://ex.com/x_y]');
  });

  it('resolves reference-style links from their definition', () => {
    expect(wiki('See [the guide][g].\n\n[g]: https://ex.com/guide')).toBe(
      'See [the guide|https://ex.com/guide].'
    );
  });

  it('writes images with an alt parameter stripped of list separators', () => {
    expect(wiki('![a, b](https://ex.com/i.png)')).toBe('!https://ex.com/i.png|alt=a b!');
    expect(html('![a, b](https://ex.com/i.png)')).toBe(
      '<p><img src="https://ex.com/i.png" alt="a, b"></p>'
    );
  });

  it('flags relative image paths that cannot resolve inside Confluence', () => {
    expect(noticeIds('![d](images/d.png)')).toEqual(['relative-images']);
  });

  it('keeps javascript: and data: targets as plain text', () => {
    const markdown = '[bad](javascript:alert(1)) ![x](data:image/png;base64,AAAA)';
    expect(html(markdown)).toBe('<p>bad x</p>');
    expect(wiki(markdown)).toBe('bad x');
    expect(convertMarkdown(markdown).notices).toEqual([
      { id: 'unsafe-urls', target: 'both', count: 2 },
    ]);
  });
});

describe('escaping Confluence wiki special characters', () => {
  it('escapes macro, link and table characters everywhere', () => {
    expect(wiki('Use {config} and [tags] | pipes')).toBe(
      'Use \\{config\\} and \\[tags\\] \\| pipes'
    );
  });

  it('escapes delimiters at word boundaries but leaves them inside words', () => {
    expect(wiki('\\*not bold\\* and \\_not italic\\_ but snake_case and well-known')).toBe(
      '\\*not bold\\* and \\_not italic\\_ but snake_case and well-known'
    );
  });

  it('stops dashes, pluses and tildes from turning into symbols or formatting', () => {
    expect(wiki('--force, a - b, C++ and ~/x')).toBe('\\-\\-force, a \\- b, C\\+\\+ and \\~/x');
  });

  it('stops emoticons, citations and images from rendering', () => {
    expect(wiki('(y) :) ??cite?? !img! Wow!')).toBe('\\(y) :\\) \\?\\?cite\\?\\? \\!img! Wow!');
  });

  it('escapes a # that would start a numbered list', () => {
    expect(wiki('\\#1 priority')).toBe('\\#1 priority');
  });

  it('drops a backslash that sits before a markup character and reports it', () => {
    const result = convertMarkdown('path C:\\\\Users and a\\\\*b');
    expect(result.wikiMarkup).toBe('path C:\\Users and a\\*b');
    expect(result.notices).toEqual([{ id: 'wiki-backslashes', target: 'wiki', count: 1 }]);
  });
});

describe('inline formatting', () => {
  it('maps bold, italic, strikethrough and their nesting', () => {
    expect(wiki('**b** *i* ~~s~~ ***both***')).toBe('*b* _i_ -s- _*both*_');
    expect(html('**b** *i* ~~s~~')).toBe('<p><strong>b</strong> <em>i</em> <del>s</del></p>');
  });

  it('uses the braced {*} form when formatting touches a letter', () => {
    expect(wiki('**bold**text and *it*x')).toBe('{*}bold{*}text and {_}it{_}x');
  });

  it('turns soft line breaks into spaces and hard breaks into \\\\', () => {
    expect(wiki('one\ntwo  \nthree')).toBe('one two\\\\ three');
    expect(html('one\ntwo  \nthree')).toBe('<p>one\ntwo<br>three</p>');
  });
});

describe('blocks', () => {
  it('maps headings, rules and quotes; a nested quote is flattened', () => {
    const markdown = '## Title with `code`\n\n---\n\n> quote\n>\n> > inner';
    expect(wiki(markdown)).toBe(
      ['h2. Title with {{code}}', '----', '{quote}\nquote\n\ninner\n{quote}'].join('\n\n')
    );
    expect(html(markdown)).toBe(
      '<h2>Title with <code>code</code></h2><hr><blockquote><p>quote</p><p>inner</p></blockquote>'
    );
  });

  it('turns footnotes into superscript labels with the note where it was defined', () => {
    const markdown = 'Text[^1] here.\n\n[^1]: The note.';
    expect(wiki(markdown)).toBe('Text{^}1{^} here.\n\n^1^ The note.');
    expect(html(markdown)).toBe('<p>Text<sup>[1]</sup> here.</p><p><sup>[1]</sup> The note.</p>');
    expect(noticeIds(markdown)).toEqual(['footnotes']);
  });
});

describe('raw HTML', () => {
  it('keeps an HTML block as an HTML code block and drops comments', () => {
    const result = convertMarkdown('<div>raw</div>\n\n<!-- note -->\n\ntext');
    expect(result.wikiMarkup).toBe('{code:language=html}\n<div>raw</div>\n{code}\n\ntext');
    expect(result.cloudHtml).toBe(
      '<pre data-language="html"><code class="language-html">&lt;div&gt;raw&lt;/div&gt;</code></pre><p>text</p>'
    );
    expect(result.notices).toEqual([{ id: 'raw-html', target: 'both', count: 1 }]);
  });

  it('treats <br> in a table cell as a line break', () => {
    expect(wiki('| a |\n| - |\n| x<br>y |')).toBe('||a||\n|x\\\\ y|');
  });

  it('never lets markup through into the HTML', () => {
    expect(html('<script>alert(1)</script>')).toBe(
      '<pre data-language="html"><code class="language-html">&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>'
    );
    expect(html('a <img src=x onerror=alert(1)> b')).toBe(
      '<p>a <code>&lt;img src=x onerror=alert(1)&gt;</code> b</p>'
    );
  });
});

describe('edge cases', () => {
  it('returns empty outputs and no notices for empty input', () => {
    expect(convertMarkdown('')).toEqual({
      cloudHtml: '',
      wikiMarkup: '',
      notices: [],
      counts: {
        headings: 0,
        tables: 0,
        codeBlocks: 0,
        listItems: 0,
        tasks: 0,
        links: 0,
        images: 0,
      },
    });
  });

  it('runs an unclosed fence to the end of the document, as CommonMark specifies', () => {
    expect(wiki('```js\nconst a = 1;\n\n# not a heading')).toBe(
      '{code:language=js}\nconst a = 1;\n\n# not a heading\n{code}'
    );
  });

  it('counts what it converted', () => {
    expect(
      convertMarkdown(
        '# A\n\n- [ ] t\n\n- x\n\n[l](https://e.x) ![i](https://e.x/i.png)\n\n```\nc\n```'
      ).counts
    ).toEqual({
      headings: 1,
      tables: 0,
      codeBlocks: 1,
      listItems: 1,
      tasks: 1,
      links: 1,
      images: 1,
    });
  });
});

describe('notice text', () => {
  it('pluralises and names the count', () => {
    expect(noticeText({ id: 'unsafe-urls', target: 'both', count: 1 })).toBe(
      '1 link or image with a non-web address (for example javascript: or data:) was kept as plain text.'
    );
    expect(noticeText({ id: 'wiki-backslashes', target: 'wiki', count: 2 })).toBe(
      '2 backslashes directly before a markup character were dropped: wiki markup cannot write that sequence.'
    );
  });
});
