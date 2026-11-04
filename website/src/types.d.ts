/// <reference types="@docusaurus/module-type-aliases" />
/// <reference types="@docusaurus/theme-classic" />

// Terminal samples (src/data/samples/*.ansi) are bundled as plain strings.
declare module '*.ansi' {
  const content: string;
  export default content;
}

// Client files of @easyops-cn/docusaurus-search-local that our SearchBar reuses (see src/theme/SearchBar/searchEngine.ts).
declare module '@easyops-cn/docusaurus-search-local/dist/client/client/theme/searchByWorker' {
  export function fetchIndexesByWorker(baseUrl: string, searchContext: string): Promise<void>;
  export function searchByWorker(baseUrl: string, searchContext: string, input: string, limit: number): Promise<unknown[]>;
}
declare module '@easyops-cn/docusaurus-search-local/dist/client/client/utils/proxiedGenerated' {
  export const Mark: (new (el: Element) => {unmark(): void; mark(keywords: string[], options?: object): void}) | null;
}
declare module '@easyops-cn/docusaurus-search-local/dist/client/client/utils/getStemmedPositions' {
  export function getStemmedPositions(metadata: object, field: string): Array<[number, number]>;
}
declare module '@easyops-cn/docusaurus-search-local/dist/client/client/utils/highlightStemmed' {
  export function highlightStemmed(content: string, positions: Array<[number, number]>, tokens: string[], maxLength?: number): string;
}
