import { toCloudHtml } from './cloud-html.js';
import {
  htmlUrl,
  isHtmlComment,
  isLineBreakHtml,
  isRelativeUrl,
  parseMarkdown,
  walk,
  type MarkdownDocument,
  type UrlKind,
} from './document.js';
import { toWikiMarkup, type WikiIssues } from './wiki-markup.js';

export type Target = 'cloud' | 'wiki';

export type NoticeId =
  | 'raw-html'
  | 'footnotes'
  | 'relative-images'
  | 'unsafe-urls'
  | 'table-alignment'
  | 'cloud-mixed-tasks'
  | 'wiki-tasks'
  | 'wiki-blocks-in-lists'
  | 'wiki-backslashes'
  | 'wiki-unfenced-code';

/** Something in this document that one or both outputs cannot carry exactly. */
export interface Notice {
  id: NoticeId;
  /** Which output it affects. */
  target: Target | 'both';
  count: number;
}

export interface ElementCounts {
  headings: number;
  tables: number;
  codeBlocks: number;
  listItems: number;
  tasks: number;
  links: number;
  images: number;
}

export interface Conversion {
  /** Rich text for the Confluence Cloud editor (text/html on the clipboard). */
  cloudHtml: string;
  /** Confluence wiki markup for Data Center / Server and the REST API. */
  wikiMarkup: string;
  notices: readonly Notice[];
  counts: ElementCounts;
}

/** Parses once and derives both outputs, the element counts and the notices from that one tree. */
export function convertMarkdown(markdown: string): Conversion {
  const doc = parseMarkdown(markdown);
  const wiki = toWikiMarkup(doc);
  const { counts, found } = survey(doc);
  return {
    cloudHtml: toCloudHtml(doc),
    wikiMarkup: wiki.markup,
    counts,
    notices: notices(found, counts, wiki.issues),
  };
}

interface Findings {
  rawHtml: number;
  footnotes: number;
  relativeImages: number;
  unsafeUrls: number;
  alignedTables: number;
  mixedTasks: number;
}

function survey(doc: MarkdownDocument): { counts: ElementCounts; found: Findings } {
  const counts: ElementCounts = {
    headings: 0,
    tables: 0,
    codeBlocks: 0,
    listItems: 0,
    tasks: 0,
    links: 0,
    images: 0,
  };
  const found: Findings = {
    rawHtml: 0,
    footnotes: 0,
    relativeImages: 0,
    unsafeUrls: 0,
    alignedTables: 0,
    mixedTasks: 0,
  };

  const checkUrl = (url: string, kind: UrlKind): void => {
    if (htmlUrl(url, kind) === null) found.unsafeUrls++;
    else if (kind === 'image' && isRelativeUrl(url)) found.relativeImages++;
  };

  walk(doc.root, (node) => {
    switch (node.type) {
      case 'heading':
        counts.headings++;
        break;
      case 'table':
        counts.tables++;
        if ((node.align ?? []).some((align) => align !== null)) found.alignedTables++;
        break;
      case 'code':
        counts.codeBlocks++;
        break;
      case 'list': {
        const tasks = node.children.filter((item) => typeof item.checked === 'boolean').length;
        counts.listItems += node.children.length - tasks;
        counts.tasks += tasks;
        if (tasks > 0 && tasks < node.children.length) found.mixedTasks += tasks;
        break;
      }
      case 'link':
        counts.links++;
        checkUrl(node.url, 'link');
        break;
      case 'linkReference': {
        const definition = doc.definitions.get(node.identifier);
        if (definition !== undefined) {
          counts.links++;
          checkUrl(definition.url, 'link');
        }
        break;
      }
      case 'image':
        counts.images++;
        checkUrl(node.url, 'image');
        break;
      case 'imageReference': {
        const definition = doc.definitions.get(node.identifier);
        if (definition !== undefined) {
          counts.images++;
          checkUrl(definition.url, 'image');
        }
        break;
      }
      case 'html':
        if (!isHtmlComment(node.value) && !isLineBreakHtml(node.value)) found.rawHtml++;
        break;
      case 'footnoteDefinition':
        found.footnotes++;
        break;
      default:
        break;
    }
  });
  return { counts, found };
}

function notices(found: Findings, counts: ElementCounts, wiki: WikiIssues): Notice[] {
  const all: Notice[] = [
    { id: 'raw-html', target: 'both', count: found.rawHtml },
    { id: 'footnotes', target: 'both', count: found.footnotes },
    { id: 'relative-images', target: 'both', count: found.relativeImages },
    { id: 'unsafe-urls', target: 'both', count: found.unsafeUrls },
    { id: 'table-alignment', target: 'both', count: found.alignedTables },
    { id: 'cloud-mixed-tasks', target: 'cloud', count: found.mixedTasks },
    { id: 'wiki-tasks', target: 'wiki', count: counts.tasks },
    { id: 'wiki-blocks-in-lists', target: 'wiki', count: wiki.blocksAfterListItem },
    { id: 'wiki-backslashes', target: 'wiki', count: wiki.droppedBackslashes },
    { id: 'wiki-unfenced-code', target: 'wiki', count: wiki.unfencedCode },
  ];
  return all.filter((notice) => notice.count > 0);
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/** The sentence shown for a notice; every claim describes this converter's own output. */
export function noticeText(notice: Notice): string {
  const n = notice.count;
  switch (notice.id) {
    case 'raw-html':
      return `${plural(n, 'raw HTML fragment is', 'raw HTML fragments are')} kept as code instead of being rendered.`;
    case 'footnotes':
      return `${plural(n, 'footnote', 'footnotes')}: neither output has a footnote element, so each becomes a superscript [label] with its note text where you defined it.`;
    case 'relative-images':
      return `${plural(n, 'image uses', 'images use')} a relative path (such as images/diagram.png) that cannot resolve inside Confluence. Upload the file to the page and insert it there.`;
    case 'unsafe-urls':
      return `${plural(n, 'link or image', 'links or images')} with a non-web address (for example javascript: or data:) ${n === 1 ? 'was' : 'were'} kept as plain text.`;
    case 'table-alignment':
      return `Column alignment (:--- / :---: / ---:) in ${plural(n, 'table is', 'tables is')} not carried over.`;
    case 'cloud-mixed-tasks':
      return `${plural(n, 'task item shares', 'task items share')} a list with ordinary items, so ${n === 1 ? 'it keeps' : 'they keep'} a [ ] or [x] text prefix instead of becoming an action item.`;
    case 'wiki-tasks':
      return `${plural(n, 'task item', 'task items')}: wiki markup has no task-list syntax, so each keeps a [ ] or [x] text prefix.`;
    case 'wiki-blocks-in-lists':
      return `${plural(n, 'code block, table or quote sits', 'code blocks, tables or quotes sit')} inside a list item. A wiki list item is one line, so the block is written after the item and the list restarts below it.`;
    case 'wiki-backslashes':
      return `${plural(n, 'backslash', 'backslashes')} directly before a markup character ${n === 1 ? 'was' : 'were'} dropped: wiki markup cannot write that sequence.`;
    case 'wiki-unfenced-code':
      return `${plural(n, 'code block contains', 'code blocks contain')} both {code} and {noformat}, which cannot be fenced in wiki markup. Check ${n === 1 ? 'it' : 'them'} after inserting.`;
  }
}

/** Notices that apply to the chosen output. */
export function noticesFor(target: Target, all: readonly Notice[]): Notice[] {
  return all.filter((notice) => notice.target === 'both' || notice.target === target);
}
