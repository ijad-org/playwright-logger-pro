/**
 * Human-readable descriptions of Playwright objects. `String(locator)` is
 * readable (`getByLabel('Password')`) on current Playwright, but on 1.30 it is
 * the raw selector with `internal:` engines (`Locator@internal:label="Password"i`),
 * which is rewritten here. See docs/adr/0001-browser-capture.md (c).
 */

/** `"text"i` / `"text"s` / `"text"` -> text (unescaped), or undefined. */
function unquote(raw: string): string | undefined {
  const m = /^"((?:[^"\\]|\\.)*)"[is]?$/.exec(raw);
  if (!m) return undefined;
  return m[1].replace(/\\(.)/g, '$1');
}

/** Single-quoted string literal, one line. */
export function quote(s: string): string {
  const escaped = s
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r?\n/g, '\\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '');
  return `'${escaped}'`;
}
const q = quote;

const GET_BY: Record<string, string> = {
  label: 'getByLabel',
  text: 'getByText',
  placeholder: 'getByPlaceholder',
  alt: 'getByAltText',
  title: 'getByTitle',
};

function describeSegment(segment: string): string {
  const seg = segment.trim();
  let m = /^internal:(label|text|placeholder|alt|title)=(.*)$/s.exec(seg);
  if (m) {
    const text = unquote(m[2]);
    if (text !== undefined) return `${GET_BY[m[1]]}(${q(text)})`;
  }
  m = /^internal:attr=\[(placeholder|alt|title|data-testid)=(".*?")[is]?\]$/s.exec(seg);
  if (m) {
    const text = unquote(m[2]);
    const fn = { placeholder: 'getByPlaceholder', alt: 'getByAltText', title: 'getByTitle', 'data-testid': 'getByTestId' }[m[1]];
    if (text !== undefined && fn) return `${fn}(${q(text)})`;
  }
  m = /^internal:testid=\[data-testid=(".*")[is]?\]$/s.exec(seg);
  if (m) {
    const id = unquote(m[1]);
    if (id !== undefined) return `getByTestId(${q(id)})`;
  }
  m = /^internal:role=([a-z]+)((?:\[[^\]]*\])*)$/.exec(seg);
  if (m) {
    const opts: string[] = [];
    for (const attr of m[2].matchAll(/\[([a-z-]+)=("(?:[^"\\]|\\.)*"|[^\]]*?)[is]?\]/g)) {
      const value = unquote(attr[2]) !== undefined && attr[2].startsWith('"') ? q(unquote(attr[2]) as string) : attr[2];
      opts.push(`${attr[1] === 'name' ? 'name' : attr[1]}: ${value}`);
    }
    return opts.length > 0 ? `getByRole(${q(m[1])}, { ${opts.join(', ')} })` : `getByRole(${q(m[1])})`;
  }
  m = /^internal:(has-text|has-not-text)=(.*)$/s.exec(seg);
  if (m) {
    const text = unquote(m[2]);
    if (text !== undefined) return `filter({ ${m[1] === 'has-text' ? 'hasText' : 'hasNotText'}: ${q(text)} })`;
  }
  m = /^nth=(-?\d+)$/.exec(seg);
  if (m) return m[1] === '0' ? 'first()' : m[1] === '-1' ? 'last()' : `nth(${m[1]})`;
  if (seg === 'internal:control=enter-frame') return 'contentFrame()';
  return `locator(${q(seg)})`;
}

/** `Locator@a >> b` (old Playwright) -> `locator('a').locator('b')` style text. */
function describeSelectorChain(selector: string): string {
  return selector.split(' >> ').map(describeSegment).join('.');
}

/** Description of a Locator. Never throws. */
export function describeLocator(locator: unknown): string {
  let s: string;
  try {
    s = String(locator);
  } catch {
    return 'locator(<?>)';
  }
  if (s.startsWith('Locator@')) return describeSelectorChain(s.slice('Locator@'.length));
  if (s === '[object Object]' || s.length === 0) return 'locator(<?>)';
  return s;
}

/** Description of a Frame: `frame("name")`, or `frame(<url>)` if unnamed. */
export function describeFrame(frame: unknown): string {
  try {
    const f = frame as { name?: () => string; url?: () => string };
    const name = typeof f.name === 'function' ? f.name() : '';
    if (name) return `frame(${JSON.stringify(name)})`;
    const url = typeof f.url === 'function' ? f.url() : '';
    return url ? `frame(${url})` : 'frame';
  } catch {
    return 'frame';
  }
}

/** Playwright class name of an object (`Locator`, `Page`, ...), or undefined. */
export function playwrightClass(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = (value as { constructor?: { name?: string } }).constructor?.name;
  const name = raw && raw.startsWith('_') ? raw.slice(1) : raw;
  switch (name) {
    case 'Locator': case 'FrameLocator': case 'Page': case 'Frame': case 'ElementHandle': case 'JSHandle':
    case 'BrowserContext': case 'Browser': case 'Dialog': case 'Download': case 'Request': case 'Response':
    case 'APIRequestContext': case 'Worker': case 'ConsoleMessage': case 'FileChooser': case 'Route':
      return name;
    default:
      return undefined;
  }
}
