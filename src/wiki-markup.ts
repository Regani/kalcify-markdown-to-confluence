import type {
  BlockContent,
  DefinitionContent,
  List,
  ListItem,
  PhrasingContent,
  RootContent,
  Table,
} from 'mdast';
import {
  codeLanguage,
  isHtmlComment,
  isLineBreakHtml,
  wikiUrl,
  type MarkdownDocument,
} from './document.js';

/** Places where wiki markup cannot express the Markdown exactly. */
export interface WikiIssues {
  /** Backslashes directly before a markup character: wiki markup has no escape for them. */
  droppedBackslashes: number;
  /** Code blocks, tables or quotes inside a list item, written after the item. */
  blocksAfterListItem: number;
  /** Code blocks whose text contains both `{code}` and `{noformat}`. */
  unfencedCode: number;
}

export interface WikiMarkup {
  markup: string;
  issues: WikiIssues;
}

/**
 * Confluence wiki markup (Data Center / Server, and the Cloud REST API's
 * `wiki` body representation).
 *
 * Text is escaped with a backslash wherever a character could start markup,
 * following the escapable set of Atlassian's wiki renderer
 * (`- # * _ + ? ^ ~ | % { } [ ] ( ) ! @`) and its word-boundary rule: a
 * formatting delimiter between two letters or digits is inert, so
 * `snake_case` stays readable while ` _x_ ` is escaped.
 */
export function toWikiMarkup(doc: MarkdownDocument): WikiMarkup {
  const issues: WikiIssues = { droppedBackslashes: 0, blocksAfterListItem: 0, unfencedCode: 0 };
  const writer = new WikiWriter(doc, issues);
  return { markup: writer.blocks(doc.root.children), issues };
}

/** Characters Atlassian's renderer treats as escapable after a backslash. */
const ESCAPABLE = new Set([
  '-',
  '#',
  '*',
  '_',
  '+',
  '?',
  '^',
  '~',
  '|',
  '%',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '!',
  '@',
]);
/** Macro, link and table syntax: escaped wherever it appears. */
const ALWAYS_ESCAPED = new Set(['{', '}', '[', ']', '|']);
/** Phrase delimiters: bold, italic, underline, superscript, subscript, strikethrough/dashes. */
const PHRASE_DELIMITERS = new Set(['*', '_', '+', '^', '~', '-']);
/** Confluence emoticon codes written in parentheses, e.g. (y), (/), (on). */
const PAREN_EMOTICON = /^\((?:y|n|i|\/|x|!|\+|-|\?|on|off|\*[rgby]?|flag|flagoff)\)/i;

/**
 * Letters, digits and any non-ASCII character except a no-break space —
 * the renderer's definition of a character that makes an adjacent
 * delimiter part of a word.
 */
function isWordChar(char: string | undefined): boolean {
  if (char === undefined || char === ' ') return false;
  return /[A-Za-z0-9]/.test(char) || char.charCodeAt(0) > 0x7f;
}

/**
 * Backslash-escapes wiki markup characters in literal text. In `code` mode
 * (inside `{{…}}`) phrase delimiters are escaped even inside a word, because
 * code is where `a*b*c` and `__init__` cluster.
 */
export function escapeWikiText(
  text: string,
  issues: WikiIssues,
  mode: 'text' | 'code' = 'text'
): string {
  const source = text.replaceAll(/\r?\n/g, ' ');
  let out = '';
  for (let index = 0; index < source.length; index++) {
    const char = source.charAt(index);
    const prev = index > 0 ? source.charAt(index - 1) : undefined;
    const next = index + 1 < source.length ? source.charAt(index + 1) : undefined;

    if (char === '\\') {
      // `\*` would render `*` and `\\` a line break; a backslash at the end may
      // meet an emitted delimiter. None of these can be written, so drop it.
      if (next === undefined || next === '\\' || ESCAPABLE.has(next)) {
        issues.droppedBackslashes++;
        continue;
      }
      out += char;
      continue;
    }

    let escape = false;
    if (ALWAYS_ESCAPED.has(char)) {
      escape = true;
    } else if (PHRASE_DELIMITERS.has(char)) {
      escape = mode === 'code' || !(isWordChar(prev) && isWordChar(next));
    } else if (char === '?') {
      escape = prev === '?' || next === '?';
    } else if (char === '!') {
      escape = next !== undefined && !/\s/.test(next);
    } else if (char === '#') {
      escape = index === 0;
    } else if (char === '(') {
      escape = prev === ':' || PAREN_EMOTICON.test(source.slice(index));
    } else if (char === ')') {
      escape = prev === ':' || prev === ';';
    }
    out += escape ? `\\${char}` : char;
  }
  return out;
}

/** A formatted span waits for its neighbours before choosing `*x*` or `{*}x{*}`. */
type Piece = { kind: 'text'; value: string } | { kind: 'mark'; delimiter: string; inner: string };

function firstChar(piece: Piece | undefined): string | undefined {
  if (piece === undefined) return undefined;
  return piece.kind === 'text' ? piece.value.charAt(0) || undefined : piece.delimiter;
}

/**
 * Joins inline pieces. A delimiter touching a letter or digit is written in
 * the braced form (`{*}bold{*}text`), the renderer's documented way to
 * format part of a word; whitespace just inside a span moves outside it,
 * because a delimiter followed or preceded by a space is not markup.
 */
function joinPieces(pieces: readonly Piece[]): string {
  let out = '';
  pieces.forEach((piece, index) => {
    if (piece.kind === 'text') {
      out += piece.value;
      return;
    }
    const lead = /^\s*/.exec(piece.inner)?.[0] ?? '';
    const core = piece.inner.slice(lead.length);
    const trail = /\s*$/.exec(core)?.[0] ?? '';
    const body = core.slice(0, core.length - trail.length);
    if (body === '') {
      out += piece.inner;
      return;
    }
    const before = (out + lead).slice(-1) || undefined;
    const after = trail !== '' ? trail.charAt(0) : firstChar(pieces[index + 1]);
    const delimiter =
      isWordChar(before) || isWordChar(after) ? `{${piece.delimiter}}` : piece.delimiter;
    out += `${lead}${delimiter}${body}${delimiter}${trail}`;
  });
  return out;
}

const HARD_BREAK = '\\\\ ';

class WikiWriter {
  constructor(
    private readonly doc: MarkdownDocument,
    private readonly issues: WikiIssues
  ) {}

  blocks(nodes: readonly RootContent[]): string {
    return nodes
      .map((node) => this.block(node))
      .filter((text) => text !== '')
      .join('\n\n');
  }

  private block(node: RootContent): string {
    switch (node.type) {
      case 'paragraph':
        return this.inlines(node.children);
      case 'heading':
        return `h${String(node.depth)}. ${this.inlines(node.children)}`;
      case 'thematicBreak':
        return '----';
      case 'blockquote':
        return `{quote}\n${this.quoteBody(node.children)}\n{quote}`;
      case 'code':
        return this.codeBlock(node.value, codeLanguage(node.lang));
      case 'html':
        if (isHtmlComment(node.value) || isLineBreakHtml(node.value)) return '';
        return this.codeBlock(node.value, 'html');
      case 'list':
        return this.listLines(node, '').join('\n');
      case 'table':
        return this.table(node);
      case 'footnoteDefinition':
        return this.footnoteDefinition(node.label ?? node.identifier, node.children);
      case 'definition':
      case 'yaml':
      case 'listItem':
      case 'tableRow':
      case 'tableCell':
        return '';
      default:
        return this.inlines([node]);
    }
  }

  /** `{quote}` cannot nest, so a quote inside a quote is written inline. */
  private quoteBody(children: ReadonlyArray<BlockContent | DefinitionContent>): string {
    return children
      .map((child) =>
        child.type === 'blockquote' ? this.quoteBody(child.children) : this.block(child)
      )
      .filter((text) => text !== '')
      .join('\n\n');
  }

  private codeBlock(value: string, language: string | null): string {
    if (!/\{code\}/i.test(value)) {
      return `${language === null ? '{code}' : `{code:language=${language}}`}\n${value}\n{code}`;
    }
    // A literal {code} would close the macro early; {noformat} has no language.
    if (/\{noformat\}/i.test(value)) this.issues.unfencedCode++;
    return `{noformat}\n${value}\n{noformat}`;
  }

  private listLines(node: List, parentMarker: string): string[] {
    const marker = parentMarker + (node.ordered === true ? '#' : '*');
    return node.children.flatMap((item) => this.listItemLines(item, marker));
  }

  private listItemLines(item: ListItem, marker: string): string[] {
    const text: string[] = [];
    const after: string[] = [];
    for (const child of item.children) {
      if (child.type === 'paragraph') {
        text.push(this.inlines(child.children));
      } else if (child.type === 'list') {
        after.push(...this.listLines(child, marker));
      } else {
        const block = this.block(child);
        if (block !== '') {
          this.issues.blocksAfterListItem++;
          after.push(block);
        }
      }
    }
    const task = item.checked === true ? '\\[x\\] ' : item.checked === false ? '\\[ \\] ' : '';
    return [`${marker} ${task}${text.join(` ${HARD_BREAK}`)}`.trimEnd(), ...after];
  }

  private table(node: Table): string {
    return node.children
      .map((row, rowIndex) => {
        const separator = rowIndex === 0 ? '||' : '|';
        const cells = row.children.map((cell) => {
          const content = this.inlines(cell.children).trim();
          // An empty cell needs a space to keep its column.
          return content === '' ? ' ' : content;
        });
        return `${separator}${cells.join(separator)}${separator}`;
      })
      .join('\n');
  }

  private footnoteDefinition(
    label: string,
    children: ReadonlyArray<BlockContent | DefinitionContent>
  ): string {
    const marker = joinPieces([
      { kind: 'mark', delimiter: '^', inner: escapeWikiText(label, this.issues) },
      { kind: 'text', value: ' ' },
    ]);
    const [first, ...rest] = children;
    if (first?.type === 'paragraph') {
      return [marker + this.inlines(first.children), this.blocks(rest)]
        .filter((text) => text !== '')
        .join('\n\n');
    }
    return [marker.trimEnd(), this.blocks(children)].filter((text) => text !== '').join('\n\n');
  }

  inlines(nodes: readonly PhrasingContent[]): string {
    return joinPieces(nodes.map((node) => this.piece(node)));
  }

  private piece(node: PhrasingContent): Piece {
    switch (node.type) {
      case 'text':
        return { kind: 'text', value: escapeWikiText(node.value, this.issues) };
      case 'strong':
        return { kind: 'mark', delimiter: '*', inner: this.inlines(node.children) };
      case 'emphasis':
        return { kind: 'mark', delimiter: '_', inner: this.inlines(node.children) };
      case 'delete':
        return { kind: 'mark', delimiter: '-', inner: this.inlines(node.children) };
      case 'footnoteReference':
        return {
          kind: 'mark',
          delimiter: '^',
          inner: escapeWikiText(node.label ?? node.identifier, this.issues),
        };
      case 'inlineCode':
        return { kind: 'text', value: this.monospace(node.value) };
      case 'break':
        return { kind: 'text', value: HARD_BREAK };
      case 'html':
        if (isHtmlComment(node.value)) return { kind: 'text', value: '' };
        if (isLineBreakHtml(node.value)) return { kind: 'text', value: HARD_BREAK };
        return { kind: 'text', value: this.monospace(node.value) };
      case 'link':
        return {
          kind: 'text',
          value: this.link(node.url, this.inlines(node.children), node.children),
        };
      case 'linkReference': {
        const definition = this.doc.definitions.get(node.identifier);
        const content = this.inlines(node.children);
        return {
          kind: 'text',
          value:
            definition === undefined ? content : this.link(definition.url, content, node.children),
        };
      }
      case 'image':
        return { kind: 'text', value: this.image(node.url, node.alt) };
      case 'imageReference': {
        const definition = this.doc.definitions.get(node.identifier);
        return {
          kind: 'text',
          value:
            definition === undefined
              ? escapeWikiText(node.alt ?? '', this.issues)
              : this.image(definition.url, node.alt),
        };
      }
    }
  }

  /** `{{…}}` still parses markup inside, so its text is escaped too; leading/trailing spaces would void it. */
  private monospace(value: string): string {
    const body = escapeWikiText(value.trim(), this.issues, 'code');
    return body === '' ? '' : `{{${body}}}`;
  }

  private link(url: string, content: string, children: readonly PhrasingContent[]): string {
    const target = wikiUrl(url, 'link');
    if (target === null) return content;
    const isBare =
      children.length === 1 && children[0]?.type === 'text' && children[0].value === url;
    return isBare || content === '' ? `[${target}]` : `[${content}|${target}]`;
  }

  /** `!url|alt=…!` — the alt list is comma-separated, so `,`, `|` and `!` are removed from it. */
  private image(url: string, alt: string | null | undefined): string {
    const source = wikiUrl(url, 'image');
    if (source === null) return escapeWikiText(alt ?? '', this.issues);
    const altText = (alt ?? '')
      .replaceAll(/[,|!\r\n]/g, ' ')
      .replaceAll(/\s+/g, ' ')
      .trim();
    return altText === '' ? `!${source}!` : `!${source}|alt=${altText}!`;
  }
}
