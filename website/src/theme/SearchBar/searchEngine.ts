/**
 * Thin typed facade over the client of @easyops-cn/docusaurus-search-local (pinned in package.json).
 * We reuse its web worker, which loads the lunr index the build generated (same origin, no third
 * party) and answers queries; the dialog UI itself is ours (see ./index.tsx).
 * If an upgrade of the plugin moves these files, this is the only module to change; the dialog
 * then still renders, and shows the topics list.
 */
import {fetchIndexesByWorker as fetchIndexes, searchByWorker as search} from '@easyops-cn/docusaurus-search-local/dist/client/client/theme/searchByWorker';
import {Mark as MarkClass} from '@easyops-cn/docusaurus-search-local/dist/client/client/utils/proxiedGenerated';

/** Mirrors SearchDocumentType in the plugin. */
const DocType = {Title: 0, Heading: 1, Description: 2, Keywords: 3, Content: 4} as const;

interface RawDocument {
  /** id */
  i: number;
  /** title / heading text / content snippet */
  t: string;
  /** url */
  u: string;
  /** hash (headings) */
  h?: string;
  /** keywords text */
  s?: string;
  /** page id (headings, content) */
  p?: number;
  /** breadcrumbs (pages) */
  b?: string[];
}

interface RawResult {
  document: RawDocument;
  type: number;
  page: RawDocument | false | undefined;
  tokens: string[];
  score: number;
}

export interface SearchHit {
  key: string;
  kind: 'page' | 'heading';
  /** Page title. */
  page: string;
  /** Heading text for kind === 'heading'. */
  heading?: string;
  /** Section trail of the page, for example "Guides". */
  trail: string;
  url: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  tokens: string[];
}

export const Mark: (new (el: Element) => {unmark(): void; mark(k: string[], o?: object): void}) | null = MarkClass;

export function loadIndex(baseUrl: string): Promise<void> {
  return fetchIndexes(baseUrl, '') as Promise<void>;
}

/** Pages and headings that match `query`, best first, one entry per page or heading. */
export async function searchDocs(baseUrl: string, query: string, limit = 12): Promise<SearchOutcome> {
  const raw = (await search(baseUrl, '', query, limit * 3)) as RawResult[];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const tokens = new Set<string>();
  for (const r of raw) {
    for (const t of r.tokens as unknown[]) {
      const value = typeof t === 'string' ? t : (t as {value?: unknown} | null)?.value;
      if (typeof value === 'string' && value) tokens.add(value);
    }
    const page = r.type === DocType.Title || r.type === DocType.Keywords ? r.document : r.page || undefined;
    if (!page) continue;
    const trail = (page.b ?? []).join(' › ');
    let hit: SearchHit;
    if (r.type === DocType.Heading) {
      hit = {
        key: `${r.document.u}${r.document.h ?? ''}`,
        kind: 'heading',
        page: page.t,
        heading: r.document.t,
        trail,
        url: `${r.document.u}${r.document.h ?? ''}`,
      };
    } else {
      hit = {key: page.u, kind: 'page', page: page.t, trail, url: page.u};
    }
    if (seen.has(hit.key)) continue;
    seen.add(hit.key);
    hits.push(hit);
    if (hits.length >= limit) break;
  }
  return {hits, tokens: Array.from(tokens)};
}
