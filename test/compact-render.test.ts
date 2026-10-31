import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCurlParts } from '../src/compact/curlScript';
import { DEFAULT_DISPLAY } from '../src/compact/options';
import {
  bodyPreview, formatDuration, renderCallLine, renderCalls, renderDetail, renderFooter, shortenQuery, summarize,
} from '../src/compact/render';
import type { RenderOptions } from '../src/compact/render';
import type { CallRecord } from '../src/compact/types';
import { DEFAULT_REDACT_BODY_KEYS, DEFAULT_REDACT_HEADERS, DEFAULT_REDACT_QUERY_PARAMS } from '../src/types';

const ESC = '\u001b[';
const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

const opts = (over: Partial<RenderOptions> = {}): RenderOptions =>
  ({ ...DEFAULT_DISPLAY, ascii: false, curl: '5xx', colors: true, width: 120, ...over });

const call = (method: string, status: number | undefined, url: string, durationMs: number, extra: Partial<CallRecord> = {}): CallRecord =>
  ({ method, status, url, durationMs, ...extra });

const json = (text: string): CallRecord['responseBody'] => ({ kind: 'text', text });

const checkoutCurl = buildCurlParts({
  method: 'POST',
  url: 'https://api.shop.test/v1/checkout?token=sk_live_1&currency=EUR',
  headers: { Authorization: 'Bearer sk_live_2', 'Content-Type': 'application/json' },
  data: { cartId: 'c_812', cardToken: 'tok_3' },
}, {
  redactHeaders: DEFAULT_REDACT_HEADERS,
  redactQueryParams: DEFAULT_REDACT_QUERY_PARAMS,
  redactBodyKeys: DEFAULT_REDACT_BODY_KEYS,
  multiline: true,
});

/** The scenario of the reference screenshots, as the three tests' calls. */
const cart = [
  call('GET', 200, 'https://api.shop.test/v1/products?page=2&limit=20', 142),
  call('POST', 201, 'https://api.shop.test/v1/cart/items', 88),
  call('PUT', 200, 'https://api.shop.test/v1/cart/items/42', 97),
];
const profile = [
  call('PATCH', 204, 'https://api.shop.test/v1/users/7', 61),
  call('DELETE', 204, 'https://api.shop.test/v1/sessions/old', 45),
  call('GET', 304, 'https://cdn.shop.test/assets/catalog.json', 12),
];
const checkout = [
  call('GET', 404, 'https://api.shop.test/v1/orders/99999', 73, {
    statusText: 'Not Found', responseBody: json('{"error":"order not found"}'),
  }),
  call('POST', 500, 'https://api.shop.test/v1/checkout?token=***&currency=EUR', 1830, {
    statusText: 'Internal Server Error',
    responseBody: json('{"error":"payment gateway timeout"}'),
    curl: checkoutCurl.terminal,
    curlFile: 'curl.sh',
  }),
];

// The part of the reference output this package prints (section 1 of the spec), line by line.
const REFERENCE_PLAIN = {
  cart: [
    '    GET    200  https://api.shop.test/v1/products?page=2&limit=20            142ms',
    '    POST   201  https://api.shop.test/v1/cart/items                           88ms',
    '    PUT    200  https://api.shop.test/v1/cart/items/42                        97ms',
  ],
  profile: [
    '    PATCH  204  https://api.shop.test/v1/users/7                              61ms',
    '    DELETE 204  https://api.shop.test/v1/sessions/old                         45ms',
    '    GET    304  https://cdn.shop.test/assets/catalog.json                     12ms',
  ],
  checkout: [
    '    GET    404  https://api.shop.test/v1/orders/99999                         73ms',
    '    │ ← 404 Not Found  {"error":"order not found"}',
    '    POST   500  https://api.shop.test/v1/checkout?token=***&currency=EUR   ▲ 1.83s',
    '    │ ← 500 Internal Server Error  {"error":"payment gateway timeout"}',
    '    │',
    "    │ curl -X POST 'https://api.shop.test/v1/checkout?token=***&currency=EUR' \\",
    "    │   -H 'Authorization: ***' \\",
    "    │   -H 'Content-Type: application/json' \\",
    `    │   --data-raw '{"cartId":"c_812","cardToken":"***"}'`,
    '    │',
    '    │ ↳ replay: curl.sh attached to the HTML report',
  ],
  footer: '  8 requests · 2 errors · 1 slow ≥1s',
};

const scenario = (o: RenderOptions) => ({
  cart: renderCalls(cart, o, false),
  profile: renderCalls(profile, o, false),
  checkout: renderCalls(checkout, o, true),
  footer: renderFooter(summarize([...cart, ...profile, ...checkout], o), o),
});

describe('the reference scenario', () => {
  for (const theme of ['ansi', 'dark', 'light'] as const) {
    test(`${theme}: the colour-stripped output is the reference, byte for byte`, () => {
      const out = scenario(opts({ theme }));
      assert.deepEqual(out.cart.map(strip), REFERENCE_PLAIN.cart);
      assert.deepEqual(out.profile.map(strip), REFERENCE_PLAIN.profile);
      assert.deepEqual(out.checkout.map(strip), REFERENCE_PLAIN.checkout);
      assert.equal(strip(out.footer ?? ''), REFERENCE_PLAIN.footer);
    });
  }

  test('the timing column ends at column 82 on every line that has one', () => {
    const lines = [...cart, ...profile, ...checkout].map((c) => strip(renderCallLine(c, opts())));
    for (const line of lines) assert.equal(line.length, 82, line);
  });

  // Goldens: the raw output with its escape sequences. UPDATE_GOLDEN=1 rewrites them.
  for (const theme of ['ansi', 'dark', 'light'] as const) {
    test(`${theme}: the raw ANSI output matches the golden file`, () => {
      const out = scenario(opts({ theme }));
      const text = [...out.cart, ...out.profile, ...out.checkout, out.footer].join('\n').replaceAll(ESC, '\\e[') + '\n';
      const file = path.join(__dirname, 'fixtures', `compact-${theme}.golden.txt`);
      if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, text);
      assert.equal(text, fs.readFileSync(file, 'utf8'));
    });
  }
});

describe('colours', () => {
  const line = (method: string, status: number | undefined, over: Partial<RenderOptions> = {}) =>
    renderCallLine(call(method, status, 'https://h.test/p', 50, { statusText: 'x' }), opts(over));

  test('every method has its colour, bold; other methods are cyan', () => {
    const codes: Record<string, number> = { GET: 34, POST: 32, PUT: 33, PATCH: 35, DELETE: 31, HEAD: 36, OPTIONS: 36, TRACE: 36 };
    for (const [method, code] of Object.entries(codes)) {
      assert.ok(line(method, 200).includes(`${ESC}1m${ESC}${code}m${method}`), method);
    }
  });

  test('1xx gray, 2xx bold green, 3xx bold cyan; none of them is a chip', () => {
    assert.ok(line('GET', 101).includes(`${ESC}90m101${ESC}39m`));
    assert.ok(line('GET', 200).includes(`${ESC}1m${ESC}32m200`));
    assert.ok(line('GET', 304).includes(`${ESC}1m${ESC}36m304`));
    for (const status of [101, 200, 304]) assert.ok(!/\u001b\[4\dm/.test(line('GET', status)), String(status));
  });

  test('4xx is black on yellow, 5xx and a network error white on red; the chip adds no characters', () => {
    assert.ok(line('GET', 404).includes(`${ESC}43m${ESC}1m${ESC}30m404`));
    for (const status of [500, 503, undefined]) {
      const text = line('GET', status);
      assert.ok(text.includes(`${ESC}41m${ESC}1m${ESC}97m${status ?? 'ERR'}`), String(status));
    }
    const plain = strip(line('GET', 404));
    assert.equal(plain, strip(line('GET', 200)).replace('200', '404'));
    assert.equal(strip(line('GET', undefined)), strip(line('GET', 200)).replace('200', 'ERR'));
  });

  test('host dim, path plain, mask highlighted, timing gray, slow timing bold yellow', () => {
    const text = renderCallLine(call('GET', 200, 'https://h.test:8080/a?token=***&b=1', 1500), opts());
    assert.ok(text.includes(`${ESC}90mhttps://h.test:8080${ESC}39m`), text);
    assert.ok(text.includes(`${ESC}100m`) && text.includes('***'), text);
    assert.ok(text.includes(`${ESC}1m${ESC}33m▲ 1.50s`), text);
    assert.ok(renderCallLine(call('GET', 200, 'https://h.test/', 20), opts()).includes(`${ESC}90m20ms`));
  });

  test('the dark and light themes use the palette of the screenshots in true colour', () => {
    const dark = renderCallLine(call('GET', 404, 'https://h.test/p', 50), opts({ theme: 'dark' }));
    assert.ok(dark.includes(`${ESC}38;2;88;166;255m`), 'GET #58a6ff');
    assert.ok(dark.includes(`${ESC}48;2;210;153;34m`), '404 chip background #d29922');
    const light = renderCallLine(call('POST', 500, 'https://h.test/p', 50), opts({ theme: 'light' }));
    assert.ok(light.includes(`${ESC}38;2;26;127;55m`), 'POST #1a7f37');
    assert.ok(light.includes(`${ESC}48;2;207;34;46m`), '500 chip background #cf222e');
  });

  test('the detail gutter is yellow for a 4xx and red for a 5xx or a network error', () => {
    const gutter = (c: CallRecord) => renderDetail(c, opts())[0] ?? '';
    assert.ok(gutter(checkout[0] as CallRecord).includes(`${ESC}33m│`));
    assert.ok(gutter(checkout[1] as CallRecord).includes(`${ESC}31m│`));
    assert.ok(gutter(call('GET', undefined, 'https://h.test/', 5, { error: { code: 'ECONNREFUSED', message: 'x' } })).includes(`${ESC}31m│`));
  });

  test('curl: quoted strings blue, flags and continuations gray, the method in its colour, masks highlighted', () => {
    const lines = renderDetail(checkout[1] as CallRecord, opts());
    const first = lines.find((l) => strip(l).includes('curl -X')) ?? '';
    assert.ok(first.includes(`${ESC}1mcurl${ESC}22m`), first);
    assert.ok(first.includes(`${ESC}90m-X${ESC}39m`), first);
    assert.ok(first.includes(`${ESC}1m${ESC}32mPOST`), first);
    assert.ok(first.includes(`${ESC}34m'https://api.shop.test/v1/checkout?token=${ESC}39m${ESC}97m`) || first.includes(`${ESC}34m'`), first);
    assert.ok(first.includes(`${ESC}90m\\${ESC}39m`), first);
    assert.ok(lines.at(-1)?.includes(`${ESC}1mcurl.sh${ESC}22m`), 'curl.sh is bold');
  });
});

describe('the request line', () => {
  const plain = (c: CallRecord, over: Partial<RenderOptions> = {}) => strip(renderCallLine(c, opts(over)));

  test('timing formats around the boundaries', () => {
    assert.equal(formatDuration(0), '0ms');
    assert.equal(formatDuration(999), '999ms');
    assert.equal(formatDuration(1000), '1.00s');
    assert.equal(formatDuration(1830), '1.83s');
    assert.equal(formatDuration(59_990), '59.99s');
    assert.equal(formatDuration(61_000), '1m 01s');
    assert.equal(formatDuration(62_000), '1m 02s');
    assert.equal(formatDuration(125_400), '2m 05s');
    assert.equal(formatDuration(999.6), '1.00s'); // rounds up to a second, never "1000ms"
  });

  test('999 ms is not slow, 1000 ms is; the prefix counts toward the alignment', () => {
    const fast = plain(call('GET', 200, 'https://h.test/a', 999));
    const slow = plain(call('GET', 200, 'https://h.test/a', 1000));
    assert.ok(!fast.includes('▲') && fast.endsWith('999ms'));
    assert.ok(slow.endsWith('▲ 1.00s'));
    assert.equal(fast.length, 82);
    assert.equal(slow.length, 82);
  });

  test('slowThresholdMs moves the boundary', () => {
    assert.ok(plain(call('GET', 200, 'https://h.test/a', 500), { slowThresholdMs: 500 }).includes('▲ 500ms'));
    assert.ok(!plain(call('GET', 200, 'https://h.test/a', 499), { slowThresholdMs: 500 }).includes('▲'));
  });

  test('a URL past the column keeps a 2-space gap; the timing then ends past column 82', () => {
    const url = `https://api.shop.test/v1/${'segment/'.repeat(8)}end`;
    const line = plain(call('GET', 200, url, 12));
    assert.ok(line.endsWith(`${url}  12ms`), line);
    assert.ok(line.length > 82 && line.length <= 120);
  });

  test('over the terminal width the query is shortened in the middle, the timing stays aligned', () => {
    const url = `https://api.shop.test/v1/search?${Array.from({ length: 12 }, (_, i) => `param${i}=value${i}`).join('&')}`;
    const line = plain(call('GET', 200, url, 12), { width: 100 });
    assert.equal(line.length, 100, line);
    assert.ok(line.startsWith('    GET    200  https://api.shop.test/v1/search?param0=value0'), line);
    assert.ok(line.includes('…') && line.endsWith('param11=value11  12ms'), line);
    assert.ok(line.includes('https://api.shop.test/v1/search?'), 'host and path are whole');
  });

  test('the host and the path are never shortened, even when they do not fit', () => {
    const url = `https://api.shop.test/${'very-long-path-segment/'.repeat(8)}end?a=1&b=2`;
    const line = plain(call('GET', 200, url, 12), { width: 100 });
    assert.ok(line.includes(`${url.split('?')[0]}?…`), line);
    assert.equal(shortenQuery('https://h.test/a/b', 5), 'https://h.test/a/b', 'no query: unchanged');
    assert.equal(shortenQuery('https://h.test/a?x=1', 50), 'https://h.test/a?x=1');
  });

  test('timeColumn: a number, and "auto" for the terminal width', () => {
    assert.equal(plain(call('GET', 200, 'https://h.test/a', 12), { timeColumn: 60 }).length, 60);
    assert.equal(plain(call('GET', 200, 'https://h.test/a', 12), { timeColumn: 'auto', width: 140 }).length, 140);
  });

  test('a method of 7 or more characters still gets a space before the status', () => {
    assert.ok(plain(call('OPTIONS', 204, 'https://h.test/a', 5)).startsWith('    OPTIONS 204  '));
    assert.ok(plain(call('PROPFIND', 207, 'https://h.test/a', 5)).startsWith('    PROPFIND 207  '));
  });

  test('control characters in a URL cannot reach the terminal', () => {
    const line = renderCallLine(call('GET', 200, 'https://h.test/\u001b]0;x\u0007a', 5), opts({ colors: false }));
    assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(line), JSON.stringify(line));
  });
});

describe('the detail block', () => {
  test('a 404 in a passing test has its chip and no block; in a failing test it has the block', () => {
    const [get404] = checkout;
    const passing = renderCalls([get404 as CallRecord], opts(), false).map(strip);
    assert.equal(passing.length, 1);
    assert.ok(passing[0]?.includes('404'));
    const failing = renderCalls([get404 as CallRecord], opts(), true).map(strip);
    assert.equal(failing.length, 2);
    assert.equal(failing[1], '    │ ← 404 Not Found  {"error":"order not found"}');
  });

  test('details: always and never', () => {
    const [get404] = checkout;
    assert.equal(renderCalls([get404 as CallRecord], opts({ details: 'always' }), false).length, 2);
    assert.equal(renderCalls([get404 as CallRecord], opts({ details: 'never' }), true).length, 1);
    assert.equal(renderCalls([cart[0] as CallRecord], opts({ details: 'always' }), true).length, 1, '2xx never gets one');
  });

  test('curl modes: 5xx (default), 4xx+, always, never', () => {
    const withCurl = (c: CallRecord): CallRecord => ({ ...c, curl: "curl 'https://x.test'" });
    const rows = (mode: RenderOptions['curl'], c: CallRecord) =>
      renderCalls([withCurl(c)], opts({ curl: mode, colors: false }), true).filter((l) => l.includes('curl ')).length;
    const [c404, c500] = checkout as [CallRecord, CallRecord];
    assert.deepEqual([rows('5xx', c404), rows('5xx', c500)], [0, 1]);
    assert.deepEqual([rows('4xx+', c404), rows('4xx+', c500)], [1, 1]);
    assert.deepEqual([rows('never', c404), rows('never', c500)], [0, 0]);
    assert.equal(rows('always', cart[0] as CallRecord), 0, 'a 2xx has no detail block to hold it');
    // without an attached script there is no replay line
    assert.ok(!renderCalls([{ ...withCurl(c500), curlFile: undefined }], opts({ colors: false }), true).join('\n').includes('replay'));
  });

  test('a network failure: ERR chip, the code and message, curl', () => {
    const failure = call('GET', undefined, 'https://h.test/a', 7, {
      error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9' }, curl: "curl 'https://h.test/a'",
    });
    const lines = renderCalls([failure], opts(), true).map(strip);
    assert.equal(lines[0], '    GET    ERR  https://h.test/a                                               7ms');
    assert.equal(lines[1], '    │ ← ECONNREFUSED  connect ECONNREFUSED 127.0.0.1:9');
    assert.equal(lines[3], "    │ curl 'https://h.test/a'");
  });

  test('body previews: minified JSON, first text line, cut with …, empty and binary', () => {
    assert.equal(bodyPreview(json('{\n  "a": 1,\n  "b": [1, 2]\n}'), 200), '{"a":1,"b":[1,2]}');
    assert.equal(bodyPreview(json('  first line  \nsecond'), 200), 'first line');
    assert.equal(bodyPreview(json('x'.repeat(250)), 200), `${'x'.repeat(200)}…`);
    assert.equal(bodyPreview(json('x'.repeat(200)), 200), 'x'.repeat(200));
    assert.equal(bodyPreview({ kind: 'empty' }, 200), '<empty body>');
    assert.equal(bodyPreview(json('  \n '), 200), '<empty body>');
    assert.equal(bodyPreview({ kind: 'binary', bytes: 12_698, type: 'application/pdf' }, 200), '<binary 12.4 KB application/pdf>');
    assert.equal(bodyPreview({ kind: 'binary', bytes: 300 }, 200), '<binary 300 B>');
    assert.equal(bodyPreview(json('{"a":\n"cut'), 200), '{"a":"cut', 'JSON that does not parse: lines are joined');
    assert.ok(!/[\u0000-\u001f]/.test(bodyPreview(json('a\u001b[31mred\u0007'), 200)), 'control characters are escaped');
  });

  test('bodyPreviewChars is honoured', () => {
    const c = call('GET', 500, 'https://h.test/a', 5, { statusText: 'Err', responseBody: json('y'.repeat(100)) });
    assert.equal(strip(renderDetail(c, opts({ bodyPreviewChars: 10 }))[0] as string), `    │ ← 500 Err  ${'y'.repeat(10)}…`);
  });
});

describe('plain mode and ASCII', () => {
  const plainOpts = opts({ colors: false });

  test('without colours the status column is 5 wide: " 200 " and "[404]"; the columns stay aligned', () => {
    const lines = [...cart, ...checkout].map((c) => renderCallLine(c, plainOpts));
    assert.deepEqual(lines.map((l) => l.slice(0, 22)), [
      '    GET     200   http', '    POST    201   http', '    PUT     200   http', '    GET    [404]  http', '    POST   [500]  http',
    ]);
    // The 500 line is 1 column over: its URL leaves no room for a wider status column and the 2-space gap.
    assert.deepEqual(lines.map((l) => l.length), [82, 82, 82, 82, 83]);
    assert.ok(!lines.join('').includes(ESC));
    assert.ok(renderCallLine(call('GET', undefined, 'https://h.test/', 5), plainOpts).includes('[ERR]'));
  });

  test('ascii: true swaps │ ← ▲ ↳ for | <- ^ -> and nothing else changes', () => {
    const out = renderCalls(checkout, opts({ colors: false, ascii: true }), true).join('\n');
    assert.ok(/^ {4}\| <- 404 Not Found/m.test(out), out);
    assert.ok(out.includes('^ 1.83s') && out.includes('-> replay: curl.sh'), out);
    for (const symbol of ['│', '←', '▲', '↳']) assert.ok(!out.includes(symbol), symbol);
    assert.ok(out.includes('***'), 'the mask stays');
  });
});

describe('the footer', () => {
  const footer = (calls: CallRecord[], over: Partial<RenderOptions> = {}) =>
    renderFooter(summarize(calls, opts(over)), opts({ colors: false, ...over }));

  test('leaves out segments that are zero and uses singular forms', () => {
    assert.equal(footer(cart), '  3 requests');
    assert.equal(footer([cart[0] as CallRecord]), '  1 request');
    assert.equal(footer([...cart, checkout[0] as CallRecord]), '  4 requests · 1 error');
    assert.equal(footer([call('GET', 200, 'https://h.test/', 1500)]), '  1 request · 1 slow ≥1s');
    assert.equal(footer([]), undefined);
  });

  test('errors count 4xx, 5xx and network failures; the label follows slowThresholdMs', () => {
    const all = [call('GET', 399, 'https://h/', 1), call('GET', 400, 'https://h/', 600), call('GET', undefined, 'https://h/', 2000)];
    assert.equal(footer(all, { slowThresholdMs: 500 }), '  3 requests · 2 errors · 2 slow ≥500ms');
    assert.equal(footer(all, { slowThresholdMs: 1500 }), '  3 requests · 2 errors · 1 slow ≥1.5s');
  });

  test('colours: counts gray, errors bold red, slow bold yellow', () => {
    const raw = renderFooter(summarize([...cart, ...checkout], opts()), opts()) as string;
    assert.ok(raw.includes(`${ESC}90m5 requests${ESC}39m`), raw);
    assert.ok(raw.includes(`${ESC}1m${ESC}31m2 errors`), raw);
    assert.ok(raw.includes(`${ESC}1m${ESC}33m1 slow ≥1s`), raw);
  });
});
