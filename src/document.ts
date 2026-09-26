import type { Definition, Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { normalizeUri, sanitizeUri } from 'micromark-util-sanitize-uri';

/**
 * The single parse every output derives from: a CommonMark + GFM syntax tree
 * (tables, task lists, strikethrough, autolinks, footnotes) plus the link
 * reference definitions it contains.
 */
export interface MarkdownDocument {
  root: Root;
  definitions: ReadonlyMap<string, Definition>;
}

export function parseMarkdown(markdown: string): MarkdownDocument {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map<string, Definition>();
  walk(root, (node) => {
    // CommonMark: the first definition of a label wins.
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
  });
  return { root, definitions };
}

/** Depth-first, document-order visit of every node. */
export function walk(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ('children' in node) {
    for (const child of node.children) {
      walk(child, visit);
    }
  }
}

/** Links may point at the web, e-mail or phone numbers; anything else (javascript:, data:, file:) is dropped. */
const LINK_PROTOCOLS = /^(https?|mailto|tel)$/i;
/** Images must be fetchable web URLs — the rule GitHub applies to img[src]. */
const IMAGE_PROTOCOLS = /^https?$/i;

export type UrlKind = 'link' | 'image';

function isAllowed(url: string, kind: UrlKind): boolean {
  return sanitizeUri(url, kind === 'link' ? LINK_PROTOCOLS : IMAGE_PROTOCOLS) !== '';
}

/** Percent-encoded and HTML-attribute-escaped URL, or null when the protocol is not allowed. */
export function htmlUrl(url: string, kind: UrlKind): string | null {
  return isAllowed(url, kind) ? sanitizeUri(url) : null;
}

/**
 * Percent-encoded URL for wiki markup, or null when the protocol is not
 * allowed. Percent-encoding already covers `[ ] { } |` and spaces; `!` is
 * encoded as well because it closes an image.
 */
export function wikiUrl(url: string, kind: UrlKind): string | null {
  return isAllowed(url, kind) ? normalizeUri(url).replaceAll('!', '%21') : null;
}

/** True for a path with no scheme and no host, e.g. `images/diagram.png` or `../a.png`. */
export function isRelativeUrl(url: string): boolean {
  if (url === '' || url.startsWith('//') || url.startsWith('#')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

/** Raw HTML that is only a line break (common inside GFM table cells). */
export function isLineBreakHtml(value: string): boolean {
  return /^<br\s*\/?>$/i.test(value.trim());
}

/** Raw HTML that is only a comment — dropped from both outputs. */
export function isHtmlComment(value: string): boolean {
  return /^<!--[\s\S]*-->$/.test(value.trim());
}

/**
 * The fence language when it is a plain identifier (`python`, `c++`, `c#`,
 * `objective-c`); decorated info strings such as `{python}` carry no usable
 * language.
 */
export function codeLanguage(lang: string | null | undefined): string | null {
  if (lang === null || lang === undefined) return null;
  return /^[A-Za-z0-9_#+.-]+$/.test(lang) ? lang : null;
}
