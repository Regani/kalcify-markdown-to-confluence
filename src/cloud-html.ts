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
  htmlUrl,
  isHtmlComment,
  isLineBreakHtml,
  type MarkdownDocument,
} from './document.js';

/**
 * Rich-text HTML for the Confluence Cloud editor's paste handler.
 *
 * Only elements the Cloud editor has native equivalents for are emitted:
 * h1–h6, p, strong, em, del, code, a, img, br, hr, blockquote, ul/ol/li,
 * table with th header cells, and pre code blocks. Two attributes follow the
 * Atlassian editor's own published parse rules (@atlaskit/adf-schema):
 * `pre[data-language]` carries the code block language, and
 * `div[data-node-type="actionList"] > div[data-task-local-id][data-task-state]`
 * is its action-item (task list) markup.
 *
 * Every text and attribute value is escaped here, and URLs pass the protocol
 * allow-list in document.ts, so the result is also safe to render as the
 * on-page preview.
 */
export function toCloudHtml(doc: MarkdownDocument): string {
  return blocks(doc.root.children, doc);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function blocks(nodes: readonly RootContent[], doc: MarkdownDocument): string {
  return nodes.map((node) => block(node, doc)).join('');
}

function block(node: RootContent, doc: MarkdownDocument): string {
  switch (node.type) {
    case 'paragraph':
      return `<p>${inlines(node.children, doc)}</p>`;
    case 'heading':
      return `<h${String(node.depth)}>${inlines(node.children, doc)}</h${String(node.depth)}>`;
    case 'thematicBreak':
      return '<hr>';
    case 'blockquote':
      return `<blockquote>${quoteBody(node.children, doc)}</blockquote>`;
    case 'code':
      return codeBlock(node.value, codeLanguage(node.lang));
    case 'html':
      if (isHtmlComment(node.value) || isLineBreakHtml(node.value)) return '';
      return codeBlock(node.value, 'html');
    case 'list':
      return list(node, doc);
    case 'table':
      return table(node, doc);
    case 'footnoteDefinition':
      return footnoteDefinition(node.label ?? node.identifier, node.children, doc);
    case 'definition':
    case 'yaml':
    case 'listItem':
    case 'tableRow':
    case 'tableCell':
      // Definitions render nothing; list and table internals render through their parents.
      return '';
    default:
      return inline(node, doc);
  }
}

/** Confluence quotes do not nest, so a quote inside a quote contributes its content. */
function quoteBody(
  children: ReadonlyArray<BlockContent | DefinitionContent>,
  doc: MarkdownDocument
): string {
  return children
    .map((child) =>
      child.type === 'blockquote' ? quoteBody(child.children, doc) : block(child, doc)
    )
    .join('');
}

function codeBlock(value: string, language: string | null): string {
  if (language === null) return `<pre><code>${escapeHtml(value)}</code></pre>`;
  const lang = escapeHtml(language);
  return `<pre data-language="${lang}"><code class="language-${lang}">${escapeHtml(value)}</code></pre>`;
}

function isTask(item: ListItem): boolean {
  return typeof item.checked === 'boolean';
}

function list(node: List, doc: MarkdownDocument): string {
  if (node.children.length > 0 && node.children.every(isTask)) {
    return `<div data-node-type="actionList">${node.children.map((item) => taskItem(item, doc)).join('')}</div>`;
  }
  const items = node.children.map((item) => listItem(item, node.spread === true, doc)).join('');
  if (node.ordered === true) {
    const start = node.start ?? 1;
    return start === 1 ? `<ol>${items}</ol>` : `<ol start="${String(start)}">${items}</ol>`;
  }
  return `<ul>${items}</ul>`;
}

function taskPrefix(item: ListItem): string {
  if (item.checked === true) return '[x] ';
  if (item.checked === false) return '[ ] ';
  return '';
}

function listItem(item: ListItem, spread: boolean, doc: MarkdownDocument): string {
  const prefix = taskPrefix(item);
  const parts = item.children.map((child, index) => {
    const lead = index === 0 ? prefix : '';
    if (child.type === 'paragraph') {
      const content = lead + inlines(child.children, doc);
      return spread ? `<p>${content}</p>` : content;
    }
    return lead + block(child, doc);
  });
  if (parts.length === 0) return `<li>${prefix}</li>`;
  return `<li>${parts.join('')}</li>`;
}

/** An action item holds inline content; nested task lists sit beside it inside the action list. */
function taskItem(item: ListItem, doc: MarkdownDocument): string {
  const state = item.checked === true ? 'DONE' : 'TODO';
  const text: string[] = [];
  const rest: string[] = [];
  for (const child of item.children) {
    if (child.type === 'paragraph') {
      text.push(inlines(child.children, doc));
    } else {
      rest.push(block(child, doc));
    }
  }
  return `<div data-task-local-id="" data-task-state="${state}">${text.join('<br>')}</div>${rest.join('')}`;
}

function table(node: Table, doc: MarkdownDocument): string {
  const [head, ...body] = node.children;
  if (head === undefined) return '';
  const headRow = head.children.map((cell) => `<th>${inlines(cell.children, doc)}</th>`).join('');
  const bodyRows = body
    .map(
      (row) =>
        `<tr>${row.children.map((cell) => `<td>${inlines(cell.children, doc)}</td>`).join('')}</tr>`
    )
    .join('');
  return `<table><thead><tr>${headRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function footnoteDefinition(
  label: string,
  children: ReadonlyArray<BlockContent | DefinitionContent>,
  doc: MarkdownDocument
): string {
  const marker = `<sup>[${escapeHtml(label)}]</sup> `;
  const [first, ...rest] = children;
  if (first?.type === 'paragraph') {
    return `<p>${marker}${inlines(first.children, doc)}</p>${blocks(rest, doc)}`;
  }
  return `<p>${marker}</p>${blocks(children, doc)}`;
}

function inlines(nodes: readonly PhrasingContent[], doc: MarkdownDocument): string {
  return nodes.map((node) => inline(node, doc)).join('');
}

function inline(node: PhrasingContent, doc: MarkdownDocument): string {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.value);
    case 'strong':
      return `<strong>${inlines(node.children, doc)}</strong>`;
    case 'emphasis':
      return `<em>${inlines(node.children, doc)}</em>`;
    case 'delete':
      return `<del>${inlines(node.children, doc)}</del>`;
    case 'inlineCode':
      return `<code>${escapeHtml(node.value)}</code>`;
    case 'break':
      return '<br>';
    case 'html':
      if (isHtmlComment(node.value)) return '';
      if (isLineBreakHtml(node.value)) return '<br>';
      return `<code>${escapeHtml(node.value)}</code>`;
    case 'link':
      return link(node.url, node.title, inlines(node.children, doc));
    case 'linkReference': {
      const definition = doc.definitions.get(node.identifier);
      const content = inlines(node.children, doc);
      return definition === undefined ? content : link(definition.url, definition.title, content);
    }
    case 'image':
      return image(node.url, node.alt, node.title);
    case 'imageReference': {
      const definition = doc.definitions.get(node.identifier);
      return definition === undefined
        ? escapeHtml(node.alt ?? '')
        : image(definition.url, node.alt, definition.title);
    }
    case 'footnoteReference':
      return `<sup>[${escapeHtml(node.label ?? node.identifier)}]</sup>`;
  }
}

function titleAttribute(title: string | null | undefined): string {
  return title === null || title === undefined || title === ''
    ? ''
    : ` title="${escapeHtml(title)}"`;
}

function link(url: string, title: string | null | undefined, content: string): string {
  const href = htmlUrl(url, 'link');
  if (href === null) return content;
  return `<a href="${href}"${titleAttribute(title)}>${content}</a>`;
}

function image(
  url: string,
  alt: string | null | undefined,
  title: string | null | undefined
): string {
  const src = htmlUrl(url, 'image');
  const altText = escapeHtml(alt ?? '');
  if (src === null) return altText;
  return `<img src="${src}" alt="${altText}"${titleAttribute(title)}>`;
}
