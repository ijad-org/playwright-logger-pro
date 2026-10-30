/**
 * Coloured curl output, single-line mode, the curlFormat option and curl.sh.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { createColors } from 'picocolors';
import { request } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { buildCurl } from '../src/curl';
import { renderCurlScript, terminalLink, writeCurlScript } from '../src/curlFile';
import type { TestInfoLike } from '../src/browser/output';
import { resolveConfig } from '../src/types';
import { resetWarnings } from '../src/warn';
import { wrapRequestContext } from '../src/wrapRequestContext';
import { CURL_CASES } from './helpers/curlCases';
import type { CurlCase } from './helpers/curlCases';

const execFileAsync = promisify(execFile);
const pc = createColors(true);
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m|\u001b\]8;[^\u001b]*\u001b\\/g, '');
const HAS_ANSI = /\u001b[[\]]/;

const GOLDEN: Record<string, string> = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'curl-golden.json'), 'utf8'),
);

const build = (c: CurlCase, extra: { colors?: boolean; multiline?: boolean } = {}): string =>
  buildCurl(c.info, c.redact ?? [], { ...c.options, ...extra });

/** Run `fn` with `env` applied; a promise is awaited before the environment is restored. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = (): void => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}

function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: unknown) => warnings.push(String(message));
  resetWarnings();
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
    resetWarnings();
  }
}

describe('colours off: output is byte-identical to the output before colours existed', () => {
  test('the golden file covers every case', () => {
    assert.deepEqual(Object.keys(GOLDEN), CURL_CASES.map((c) => c.name));
  });

  for (const c of CURL_CASES) {
    test(c.name, () => {
      assert.equal(build(c), GOLDEN[c.name], 'no options');
      assert.equal(build(c, { colors: false, multiline: true }), GOLDEN[c.name], 'explicit defaults');
      assert.ok(!HAS_ANSI.test(build(c)));
    });
  }

  test('the three-argument signature still works without options', () => {
    assert.equal(buildCurl({ method: 'get', url: 'http://x/y' }), "curl 'http://x/y'");
    assert.equal(buildCurl({ method: 'get', url: 'http://x/y' }, ['authorization']), "curl 'http://x/y'");
  });
});

describe('stripping the colours gives the plain command', () => {
  for (const c of CURL_CASES) {
    test(c.name, () => {
      const coloured = build(c, { colors: true });
      assert.ok(HAS_ANSI.test(coloured), 'is coloured');
      assert.equal(stripAnsi(coloured), GOLDEN[c.name]);
      const single = build(c, { colors: true, multiline: false });
      assert.equal(stripAnsi(single), build(c, { multiline: false }));
    });
  }

  test('a body with colour-like text and masks does not break the invariant', () => {
    const c: CurlCase = {
      name: 'x',
      info: { method: 'post', url: 'https://a.test/?q=***', data: '{"a": "*** ***", "b": "x***y", "***": 1}' },
    };
    assert.equal(stripAnsi(build(c, { colors: true })), build(c));
  });
});

describe('colour mapping', () => {
  const colored = (info: Parameters<typeof buildCurl>[0], redact: string[] = [], options = {}) =>
    buildCurl(info, redact, { ...options, colors: true });

  test('curl is bold and flags, quotes and continuations are dim', () => {
    const out = colored({ method: 'post', url: 'https://a.test/x', data: 'raw' });
    assert.ok(out.startsWith(`${pc.bold('curl')} ${pc.dim('-X')} `), out);
    assert.ok(out.includes(`${pc.dim("'")}${pc.cyan('https://a.test/x')}${pc.dim("'")} ${pc.dim('\\')}\n  `), out);
    assert.ok(out.includes(`${pc.dim('--data-raw')} ${pc.dim("'")}raw${pc.dim("'")}`), out);
  });

  test('the method has its log-line colour', () => {
    const expected: Record<string, (s: string) => string> = {
      post: pc.green, put: pc.yellow, patch: pc.magenta, delete: pc.red, options: pc.white,
    };
    for (const [method, paint] of Object.entries(expected)) {
      const out = colored({ method, url: 'https://a.test/x' });
      assert.ok(out.includes(`${pc.dim('-X')} ${paint(method.toUpperCase())} `), `${method}: ${out}`);
    }
    // GET is implied; with a body it is spelled out in cyan.
    const get = colored({ method: 'get', url: 'https://a.test/x', data: { a: 1 } });
    assert.ok(get.includes(`${pc.dim('-X')} ${pc.cyan('GET')} `), get);
  });

  test('-L and --head are flags', () => {
    assert.ok(colored({ method: 'head', url: 'https://a.test/x' }).includes(pc.dim('--head')));
    assert.ok(colored({ method: 'get', url: 'https://a.test/x', followRedirects: true }).includes(pc.dim('-L')));
  });

  test('URL cyan, parameter names blue, ? & = dim, masked value bold yellow', () => {
    const out = colored({ method: 'get', url: 'https://a.test/p?a=1&token=zzz' }, [], { redactQueryParams: ['token'] });
    const mask = pc.bold(pc.yellow('***'));
    assert.ok(out.includes(
        `${pc.cyan('https://a.test/p')}${pc.dim('?')}${pc.blue('a')}${pc.dim('=')}1${pc.dim('&')}` +
        `${pc.blue('token')}${pc.dim('=')}${mask}`,
    ), out);
  });

  test('header names magenta, colon dim, value default, masked value bold yellow', () => {
    const out = colored({ method: 'get', url: 'https://a.test/', headers: { Accept: 'text/plain', Authorization: 'x' } }, ['authorization']);
    assert.ok(out.includes(`${pc.dim('-H')} ${pc.dim("'")}${pc.magenta('Accept')}${pc.dim(':')} text/plain${pc.dim("'")}`), out);
    assert.ok(out.includes(`${pc.magenta('Authorization')}${pc.dim(':')} ${pc.bold(pc.yellow('***'))}${pc.dim("'")}`), out);
  });

  test('JSON body: keys blue, strings yellow, punctuation dim, the rest default', () => {
    const out = colored({ method: 'post', url: 'https://a.test/', data: '{"k": ["v", 12, true, null], "m": "***"}' });
    const dim = pc.dim;
    const expected = [
      dim('{'), pc.blue('"k"'), dim(':'), ' ', dim('['), pc.yellow('"v"'), dim(','), ' 12', dim(','), ' true', dim(','),
      ' null', dim(']'), dim(','), ' ', pc.blue('"m"'), dim(':'), ' ', pc.yellow('"'), pc.bold(pc.yellow('***')), pc.yellow('"'), dim('}'),
    ].join('');
    assert.ok(out.includes(`${dim("'")}${expected}${dim("'")}`), out);
  });

  test('a body that is not valid JSON stays uncoloured', () => {
    for (const body of ['a=1&b=2', '{"a": 1', "{'a': 1}", 'plain text']) {
      const out = colored({ method: 'post', url: 'https://a.test/', data: body });
      assert.ok(out.includes(`${pc.dim("'")}${body.replace(/'/g, `'\\''`)}${pc.dim("'")}`), `${body}: ${out}`);
    }
    // truncation cuts JSON in the middle
    const cut = colored({ method: 'post', url: 'https://a.test/', data: { text: 'abcdefghijkl' } }, [], { maxBodyLength: 9 });
    assert.ok(!cut.includes(pc.blue('"text"')), cut);
  });

  test('# lines are dim, one by one', () => {
    const out = colored({ method: 'put', url: 'https://a.test/', data: Buffer.from([1]), followRedirects: true });
    const notes = out.split('\n').filter((line) => stripAnsi(line).startsWith('#'));
    assert.equal(notes.length, 2);
    for (const line of notes) assert.equal(line, pc.dim(stripAnsi(line)));
    assert.equal(buildCurl({ method: 'get', url: 'nope' }, [], { colors: true }), pc.dim('# could not build curl: invalid URL'));
  });

  test('the form, multipart and binary options use the same colours', () => {
    const form = colored({ method: 'post', url: 'https://a.test/', form: { user: 'jo' } });
    assert.ok(form.includes(`${pc.dim('--data-urlencode')} ${pc.dim("'")}${pc.blue('user')}${pc.dim('=')}jo${pc.dim("'")}`), form);
    const multi = colored({ method: 'post', url: 'https://a.test/', multipart: { f: 'v' } });
    assert.ok(multi.includes(`${pc.dim('--form-string')} ${pc.dim("'")}${pc.blue('f')}${pc.dim('=')}v${pc.dim("'")}`), multi);
  });
});

describe('quoting is safe', () => {
  const HOSTILE = CURL_CASES.filter((c) => c.name.startsWith('hostile'));

  /** The arguments a shell passes to curl for `command` (curl itself is a function that prints them). */
  async function argsOf(command: string): Promise<string[]> {
    const script = `curl() { for a in "$@"; do printf '%s\\0' "$a"; done; }\n${command}`;
    const { stdout } = await execFileAsync('sh', ['-c', script], { env: { ...process.env, HOME: '/home/PLP-HOME' } });
    return stdout.split('\0').slice(0, -1);
  }

  test('values with quotes, $, backticks and newlines reach curl unchanged, coloured or not', async () => {
    const [headerCase, formCase] = HOSTILE;
    for (const colors of [false, true]) {
      const plain = await argsOf(stripAnsi(build(headerCase, { colors })));
      assert.deepEqual(plain, [
        '-X', 'POST',
        "https://api.test/q?name=it's&x=$HOME&y=`id`",
        '-H', "X-Note: it's $HOME `id` $(id)\nline2",
        '-H', "X-Quote: '; rm -rf / #",
        '--data-raw', "{\"k\": \"it's $HOME `id`\\n\", \"nl\": \"a\nb\"}",
      ]);
      const form = await argsOf(stripAnsi(build(formCase, { colors })));
      assert.deepEqual(form.slice(-2), ['--data-urlencode', "k'ey=v'al$x`y`\nz"]);
    }
  });

  test('single-line output parses to the same arguments', async () => {
    for (const c of HOSTILE) {
      assert.deepEqual(await argsOf(build(c, { multiline: false })), await argsOf(build(c)));
    }
  });

  test('every case with a valid URL parses to the same arguments, coloured stripped or plain', async () => {
    for (const c of CURL_CASES.filter((x) => !x.info.redirects && x.name !== 'invalid URL')) {
      assert.deepEqual(await argsOf(stripAnsi(build(c, { colors: true }))), await argsOf(build(c)), c.name);
    }
  });

  test('escaped quotes inside a coloured value keep the quote structure', () => {
    const out = buildCurl({ method: 'get', url: 'https://a.test/', headers: { A: "it's" } }, [], { colors: true });
    assert.equal(stripAnsi(out), "curl 'https://a.test/' \\\n  -H 'A: it'\\''s'");
  });
});

describe('single-line mode', () => {
  test('options are joined by single spaces', () => {
    const c = CURL_CASES.find((x) => x.name === 'POST JSON with redacted keys')!;
    const out = build(c, { multiline: false });
    assert.ok(!out.includes('\n') && !out.includes('\\'), out);
    assert.equal(out, GOLDEN[c.name].replace(/ \\\n {2}/g, ' '));
  });

  test('notes stay on their own preceding lines and start with #', () => {
    for (const name of ['binary body', 'truncated body', 'redirected PUT without hops', 'redirect chain']) {
      const c = CURL_CASES.find((x) => x.name === name)!;
      const lines = build(c, { multiline: false }).split('\n');
      const notes = lines.filter((l) => l.startsWith('#'));
      assert.ok(notes.length > 0, name);
      for (const line of lines) {
        if (!line.startsWith('#')) assert.match(line, /^curl /, name);
        assert.ok(!line.includes(' \\'), name);
      }
      if (name !== 'redirect chain') assert.ok(lines[lines.length - 1].startsWith('curl '), name);
    }
  });

  test('a redirect chain has one single-line command per step', () => {
    const c = CURL_CASES.find((x) => x.name === 'redirect chain')!;
    const lines = build(c, { multiline: false }).split('\n');
    assert.equal(lines.filter((l) => l.startsWith('curl ')).length, 3);
  });

  test('the invalid-URL note is unchanged', () => {
    assert.equal(buildCurl({ method: 'get', url: 'x' }, [], { multiline: false }), '# could not build curl: invalid URL');
  });
});

describe('curlFormat option', () => {
  const resolved = (config: Parameters<typeof resolveConfig>[0], env: Record<string, string | undefined> = {}) =>
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined, DEBUG_COLORS: undefined, ...env }, () => resolveConfig(config));

  test('defaults: colours follow the detected support, multiline and file on', () => {
    assert.deepEqual(resolved({}, { FORCE_COLOR: '1' }).curlFormat, { colors: true, multiline: true, file: true });
    assert.deepEqual(resolved({}, { NO_COLOR: '1' }).curlFormat, { colors: false, multiline: true, file: true });
    assert.equal(resolved({ curlFormat: {} }, { FORCE_COLOR: '1' }).curlFormat.colors, true);
  });

  test("'auto' follows the resolved colors", () => {
    assert.equal(resolved({ curlFormat: { colors: 'auto' }, colors: true }).curlFormat.colors, true);
    assert.equal(resolved({ curlFormat: { colors: 'auto' }, colors: false }, { FORCE_COLOR: '1' }).curlFormat.colors, false);
  });

  test('NO_COLOR turns the curl colours off under auto; colors: true still wins', () => {
    assert.equal(resolved({}, { NO_COLOR: '1', FORCE_COLOR: '1' }).curlFormat.colors, false);
    assert.equal(resolved({ colors: true }, { NO_COLOR: '1' }).curlFormat.colors, true);
    assert.equal(resolved({ curlFormat: { colors: true } }, { NO_COLOR: '1' }).curlFormat.colors, true);
  });

  test('explicit true / false override colors', () => {
    assert.equal(resolved({ colors: false, curlFormat: { colors: true } }).curlFormat.colors, true);
    assert.equal(resolved({ colors: true, curlFormat: { colors: false } }).curlFormat.colors, false);
  });

  test('a custom sink: apiLog lines and curl default to no colours', () => {
    const sink = () => undefined;
    const cfg = resolved({ sink }, { FORCE_COLOR: '1' });
    assert.equal(cfg.colors, false);
    assert.equal(cfg.curlFormat.colors, false);
  });

  test('a custom sink with colors: true keeps the colours of the lines, not of the curl', () => {
    const cfg = resolved({ sink: () => undefined, colors: true });
    assert.equal(cfg.colors, true);
    assert.equal(cfg.curlFormat.colors, false);
  });

  test('a custom sink with curlFormat.colors: true gets coloured curl', () => {
    const cfg = resolved({ sink: () => undefined, curlFormat: { colors: true } }, { FORCE_COLOR: '1' });
    assert.equal(cfg.colors, false);
    assert.equal(cfg.curlFormat.colors, true);
  });

  test('colors: false with a custom sink stays false', () => {
    assert.equal(resolved({ sink: () => undefined, colors: false }, { FORCE_COLOR: '1' }).colors, false);
  });

  test('an invalid sink falls back to the console and its colours', () => {
    const { result, warnings } = captureWarnings(() => resolved({ sink: 'nope' as never }, { FORCE_COLOR: '1' }));
    assert.equal(result.colors, true);
    assert.equal(result.curlFormat.colors, true);
    assert.equal(warnings.length, 1);
  });

  test('multiline and file', () => {
    const cfg = resolved({ curlFormat: { multiline: false, file: false } });
    assert.equal(cfg.curlFormat.multiline, false);
    assert.equal(cfg.curlFormat.file, false);
  });

  test('invalid values warn once and fall back to the defaults', () => {
    const cases: Array<[unknown, RegExp, Partial<ReturnType<typeof resolveConfig>['curlFormat']>]> = [
      ['yes', /option "curlFormat" must be an object \(got the string "yes"\)/, {}],
      [null, /option "curlFormat" must be an object \(got null\)/, {}],
      [[], /option "curlFormat" must be an object \(got an array\)/, {}],
      [{ colors: 'always' }, /option "curlFormat.colors" must be true, false or 'auto' \(got the string "always"\); using 'auto'/, { colors: true }],
      [{ colors: 1 }, /option "curlFormat.colors" must be true, false or 'auto'/, { colors: true }],
      [{ multiline: 'no' }, /option "curlFormat.multiline" must be true or false \(got the string "no"\); using true/, { multiline: true }],
      [{ file: 0 }, /option "curlFormat.file" must be true or false \(got number 0\); using true/, { file: true }],
      [{ colour: true }, /unknown option "curlFormat.colour" ignored/, {}],
    ];
    for (const [value, message, expected] of cases) {
      const { result, warnings } = captureWarnings(() => resolved({ curlFormat: value as never }, { FORCE_COLOR: '1' }));
      assert.equal(warnings.length, 1, JSON.stringify(value));
      assert.match(warnings[0], message);
      assert.match(warnings[0], /^\[playwright-logger-pro\]/);
      assert.deepEqual(result.curlFormat, { colors: true, multiline: true, file: true, ...expected }, JSON.stringify(value));
    }
  });

  test('the same invalid value only warns once', () => {
    const { warnings } = captureWarnings(() => {
      resolved({ curlFormat: { multiline: 'no' as never } });
      resolved({ curlFormat: { multiline: 'no' as never } });
    });
    assert.equal(warnings.length, 1);
  });

  test('curlFormat is a known option', () => {
    const { warnings } = captureWarnings(() => resolved({ curlFormat: { colors: 'auto' } }));
    assert.deepEqual(warnings, []);
  });
});

describe('the request wrapper prints the curl with curlFormat', () => {
  let server: http.Server;
  let ctx: APIRequestContext;

  before(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    ctx = await request.newContext({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  });

  after(async () => {
    await ctx.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function curlLine(
      config: Parameters<typeof wrapRequestContext>[1],
      env: Record<string, string | undefined> = {},
  ): Promise<{ curl: string; lines: string[]; plain: string[] }> {
    const lines: string[] = [];
    const plain: string[] = [];
    const api = withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined, DEBUG_COLORS: undefined, ...env }, () =>
      wrapRequestContext(ctx, { curl: true, ...config, sink: config?.sink ?? ((l) => lines.push(l)) }, {
        onCurl: (c) => plain.push(c),
      }));
    // A config without a sink must reach the default console sink, which the test cannot see:
    // those tests pass `sink` only to read the lines, and say so via the resolved config below.
    await api.post('/x?token=abc', { data: { a: 1 }, headers: { Authorization: 'Bearer s' } });
    return { curl: lines.find((l) => l.includes('curl')) ?? '', lines, plain };
  }

  test('colours on: the curl is coloured, the collected copy is plain and redacted', async () => {
    const { curl, plain } = await curlLine({ curlFormat: { colors: true } });
    assert.ok(HAS_ANSI.test(curl), curl);
    assert.equal(plain.length, 1);
    assert.ok(!HAS_ANSI.test(plain[0]), plain[0]);
    assert.equal(stripAnsi(curl), plain[0]);
    assert.ok(plain[0].includes('Authorization: ***') && plain[0].includes('token=***'));
    assert.ok(!plain[0].includes('Bearer s') && !plain[0].includes('abc'));
  });

  test('NO_COLOR under auto: no colours in the curl', async () => {
    // wrapRequestContext resolves the config when it is called.
    const lines: string[] = [];
    const api = withEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }, () =>
      wrapRequestContext(ctx, { curl: true, sink: (l) => lines.push(l), colors: undefined, curlFormat: { colors: 'auto' } }));
    await api.get('/y');
    assert.ok(lines.every((l) => !HAS_ANSI.test(l)), lines.join('\n'));
  });

  test('a custom sink gets a plain curl unless curlFormat.colors is true', async () => {
    const env = { FORCE_COLOR: '1' };
    const plainRun = await curlLine({}, env);
    assert.ok(plainRun.lines.every((l) => !HAS_ANSI.test(l)), 'no ANSI at all for a custom sink');
    const colours = await curlLine({ colors: true }, env);
    assert.ok(colours.lines.some((l) => HAS_ANSI.test(l) && l.includes('→')), 'explicit colors: true keeps the line colours');
    assert.ok(!HAS_ANSI.test(colours.curl), 'but the curl stays plain under auto');
    const forced = await curlLine({ curlFormat: { colors: true } }, env);
    assert.ok(HAS_ANSI.test(forced.curl));
  });

  test('multiline: false prints a single line', async () => {
    const { curl } = await curlLine({ curlFormat: { multiline: false, colors: false } });
    assert.ok(!curl.includes('\n') && !curl.includes('\\'), curl);
    assert.match(curl, /^curl -X POST 'http:\/\/127\.0\.0\.1:\d+\/x\?token=\*\*\*' -H 'Authorization: \*\*\*'/);
  });

  test('curlFormat.file: false collects nothing; curl: false prints nothing', async () => {
    const off = await curlLine({ curlFormat: { file: false } });
    assert.deepEqual(off.plain, []);
    assert.ok(off.curl.startsWith('curl '));
    const none = await curlLine({ curl: false });
    assert.deepEqual(none.plain, []);
    assert.equal(none.curl, '');
  });
});

describe('curl.sh', () => {
  const COMMANDS = ["curl 'https://a.test/x?token=***' \\\n  -H 'Authorization: ***'", "curl -X POST 'https://a.test/y'"];

  function fakeTestInfo(dir: string, title = 'my test'): TestInfoLike & {
    attachments: Array<{ name: string; options: { body?: string | Buffer; contentType?: string; path?: string } }>;
  } {
    const attachments: Array<{ name: string; options: { body?: string | Buffer; contentType?: string; path?: string } }> = [];
    return {
      title,
      attachments,
      outputPath: (...segments: string[]) => path.join(dir, 'out', ...segments),
      attach: async (name, options) => {
        attachments.push({ name, options });
      },
    };
  }

  function withTty<T>(isTTY: boolean | undefined, fn: () => Promise<T>): Promise<T> {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    return fn().finally(() => {
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    });
  }

  async function inTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plp-curl-'));
    try {
      return await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('renderCurlScript: shebang, the title as a comment, the commands separated by a blank line', () => {
    assert.equal(
        renderCurlScript('my test', COMMANDS),
        `#!/bin/sh\n# my test\n\n${COMMANDS[0]}\n\n${COMMANDS[1]}\n`,
    );
  });

  test('a title with line breaks stays one comment line', () => {
    const script = renderCurlScript('a\nb\r\n; rm -rf /\u2028c', COMMANDS);
    assert.equal(script.split('\n')[1], '# a b ; rm -rf / c');
  });

  test('the script is valid sh (curl stubbed)', async () => {
    await inTmp(async (dir) => {
      const file = path.join(dir, 'curl.sh');
      fs.writeFileSync(file, renderCurlScript('t', COMMANDS.map((c) => c.replace(/^curl/, 'curl --silent'))));
      const { stdout } = await execFileAsync('sh', ['-c', `curl() { echo "$# $1"; }; . ${file}`]);
      assert.equal(stdout, '4 --silent\n4 --silent\n');
    });
  });

  test('writes the file, attaches it and prints the path through the sink', async () => {
    await inTmp(async (dir) => {
      const info = fakeTestInfo(dir);
      const lines: string[] = [];
      await withTty(true, () => writeCurlScript(COMMANDS, info, { log: (l) => lines.push(l), consoleColors: false }));
      const file = path.join(dir, 'out', 'curl.sh');
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(content, renderCurlScript('my test', COMMANDS));
      assert.ok(content.includes('Authorization: ***') && !HAS_ANSI.test(content));
      assert.deepEqual(info.attachments, [{ name: 'curl.sh', options: { path: file, contentType: 'text/plain' } }]);
      assert.deepEqual(lines, [`curl.sh: ${path.relative(process.cwd(), file)}`]);
    });
  });

  test('no commands: nothing is written, attached or printed', async () => {
    await inTmp(async (dir) => {
      const info = fakeTestInfo(dir);
      const lines: string[] = [];
      await writeCurlScript([], info, { log: (l) => lines.push(l), consoleColors: true });
      assert.deepEqual(lines, []);
      assert.deepEqual(info.attachments, []);
      assert.ok(!fs.existsSync(path.join(dir, 'out')));
    });
  });

  test('the path is an OSC 8 hyperlink only with colours, a TTY and no CI', async () => {
    await inTmp(async (dir) => {
      const file = path.join(dir, 'out', 'curl.sh');
      const run = async (consoleColors: boolean, tty: boolean | undefined, ci: string | undefined) => {
        const lines: string[] = [];
        await withEnv({ CI: ci }, () => withTty(tty, () =>
          writeCurlScript(COMMANDS, fakeTestInfo(dir), { log: (l) => lines.push(l), consoleColors })));
        return lines[0];
      };
      const shown = path.relative(process.cwd(), file);
      const link = `curl.sh: ${terminalLink(file, shown)}`;
      assert.equal(await run(true, true, undefined), link);
      assert.ok(link.includes(`\u001b]8;;file://`) && link.endsWith('\u001b]8;;\u001b\\'));
      assert.equal(stripAnsi(link), `curl.sh: ${shown}`);
      assert.equal(await run(true, true, '0'), link, 'CI=0 is not CI');
      for (const [colours, tty, ci] of [[false, true, undefined], [true, false, undefined], [true, undefined, undefined], [true, true, '1'], [true, true, 'true']] as const) {
        assert.equal(await run(colours, tty, ci), `curl.sh: ${shown}`, JSON.stringify([colours, tty, ci]));
      }
    });
  });

  test('a failing attach does not throw', async () => {
    await inTmp(async (dir) => {
      const info = fakeTestInfo(dir);
      info.attach = async () => {
        throw new Error('no attach');
      };
      const { warnings } = await (async () => {
        const warnings: string[] = [];
        const original = console.warn;
        console.warn = (m: unknown) => warnings.push(String(m));
        resetWarnings();
        try {
          await writeCurlScript(COMMANDS, info, { log: () => undefined, consoleColors: false });
        } finally {
          console.warn = original;
          resetWarnings();
        }
        return { warnings };
      })();
      assert.match(warnings[0], /could not write curl\.sh: no attach/);
    });
  });

  test('redacted values stay *** in the file and the attachment (requests through the wrapper)', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const api = await request.newContext({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    try {
      await inTmp(async (dir) => {
        const commands: string[] = [];
        const shown: string[] = [];
        const wrapped = wrapRequestContext(api, {
          curl: true, colors: true, curlFormat: { colors: true }, redactBodyKeys: ['pin'], sink: (l) => shown.push(l),
        }, { onCurl: (c) => commands.push(c) });
        await wrapped.post('/p?api_key=KEY-1', {
          data: { pin: 'PIN-2', ok: 1 }, headers: { Authorization: 'Bearer TOKEN-3', Cookie: 'sid=COOKIE-4' },
        });
        const info = fakeTestInfo(dir);
        await writeCurlScript(commands, info, { log: () => undefined, consoleColors: true });
        const file = fs.readFileSync(path.join(dir, 'out', 'curl.sh'), 'utf8');
        const attached = fs.readFileSync(info.attachments[0].options.path!, 'utf8');
        for (const text of [file, attached]) {
          assert.ok(text.includes('api_key=***') && text.includes('Authorization: ***') && text.includes('Cookie: ***'), text);
          assert.ok(text.includes('"pin":"***"'), text);
          for (const secret of ['KEY-1', 'PIN-2', 'TOKEN-3', 'COOKIE-4']) assert.ok(!text.includes(secret), secret);
          assert.ok(!HAS_ANSI.test(text), 'never coloured');
        }
        assert.ok(shown.some((l) => HAS_ANSI.test(l) && l.includes('curl')), 'while the console copy is coloured');
      });
    } finally {
      await api.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
