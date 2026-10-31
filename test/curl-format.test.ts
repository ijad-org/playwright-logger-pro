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
import { CURL_COLORS } from '../src/curlPalette';
import { CURL_SCRIPT_NOTICE, renderCurlScript, specLocation, stripControl, writeCurlScript } from '../src/curlFile';
import { RUNNER_TTY_VAR, autoCurlColors, curlColorDepth, inCI, markRunnerTty } from '../src/env';
import type { TestInfoLike } from '../src/browser/output';
import { resolveConfig } from '../src/types';
import { resetWarnings } from '../src/warn';
import { wrapRequestContext } from '../src/wrapRequestContext';
import { CURL_CASES } from './helpers/curlCases';
import type { CurlCase } from './helpers/curlCases';

const execFileAsync = promisify(execFile);
const pc = createColors(true);
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const HAS_ANSI = /\u001b[[\]]/;

const GOLDEN: Record<string, string> = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'curl-golden.json'), 'utf8'),
);

const build = (c: CurlCase, extra: { colors?: boolean; multiline?: boolean; colorDepth?: 4 | 8 } = {}): string =>
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

/** Run `fn` with `process.stdout.isTTY` set to `isTTY`. */
function withTty<T>(isTTY: boolean | undefined, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  const restore = (): void => {
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
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

/** Environment of a plain interactive terminal: nothing that changes the colours is set. */
const CLEAN_ENV: Record<string, string | undefined> = {
  NO_COLOR: undefined, FORCE_COLOR: undefined, DEBUG_COLORS: undefined, PLAYWRIGHT_FORCE_TTY: undefined,
  PLP_RUNNER_TTY: undefined, COLORTERM: undefined,
  TERM: 'xterm-256color', CI: undefined, GITHUB_ACTIONS: undefined, GITLAB_CI: undefined, BUILDKITE: undefined,
  CIRCLECI: undefined, TRAVIS: undefined, APPVEYOR: undefined, TF_BUILD: undefined, TEAMCITY_VERSION: undefined,
  JENKINS_URL: undefined, BITBUCKET_BUILD_NUMBER: undefined, CODEBUILD_BUILD_ID: undefined, DRONE: undefined,
};

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

/** A foreground colouring function as the curl command writes it: palette index `c256` or, with 16 colours, `c16`. */
const fg = (depth: 4 | 8, c256: number, c16: number) => (s: string): string =>
  `\u001b[${depth === 8 ? `38;5;${c256}` : c16 < 8 ? 30 + c16 : 90 + c16 - 8}m${s}\u001b[39m`;

for (const depth of [8, 4] as const) {
  describe(`colour mapping, ${depth === 8 ? '256 colours' : '16 colours'}`, () => {
    const colored = (info: Parameters<typeof buildCurl>[0], redact: string[] = [], options = {}) =>
      buildCurl(info, redact, { ...options, colors: true, colorDepth: depth });
    // The palette as (256-colour index, 16-colour index) pairs; see src/curlPalette.ts.
    const blue = fg(depth, 63, 12);
    const green = fg(depth, 29, 5);
    const purple = fg(depth, 98, 13);
    const red = fg(depth, 131, 1);
    const magenta = fg(depth, 163, 5);
    const string = fg(depth, 29, 9);
    const grey = fg(depth, 243, 8);
    const mask = pc.bold(pc.inverse('***'));

    test('curl is bold; flags, quotes and continuations keep the default colour', () => {
      const out = colored({ method: 'post', url: 'https://a.test/x', data: 'raw' });
      assert.ok(out.startsWith(`${pc.bold('curl')} -X `), out);
      assert.ok(out.includes(`'${blue('https://a.test/x')}' \\\n  `), out);
      assert.ok(out.includes("--data-raw 'raw'"), out);
    });

    test('every method has its own colour; other methods are bold', () => {
      const expected: Record<string, (s: string) => string> = {
        post: green, put: purple, patch: purple, delete: red, options: pc.bold,
      };
      for (const [method, paint] of Object.entries(expected)) {
        const out = colored({ method, url: 'https://a.test/x' });
        assert.ok(out.includes(`-X ${paint(method.toUpperCase())} `), `${method}: ${out}`);
      }
      // GET is implied; with a body it is spelled out in blue.
      const get = colored({ method: 'get', url: 'https://a.test/x', data: { a: 1 } });
      assert.ok(get.includes(`-X ${blue('GET')} `), get);
    });

    test('-L and --head are flags', () => {
      assert.ok(colored({ method: 'head', url: 'https://a.test/x' }).includes(' --head'));
      assert.ok(colored({ method: 'get', url: 'https://a.test/x', followRedirects: true }).includes(' -L '));
    });

    test('URL blue, parameter names magenta, ? & = plain, masked value bold + inverse', () => {
      const out = colored({ method: 'get', url: 'https://a.test/p?a=1&token=zzz' }, [], { redactQueryParams: ['token'] });
      assert.ok(out.includes(
          `${blue('https://a.test/p')}?${magenta('a')}=1&${magenta('token')}=${mask}`,
      ), out);
    });

    test('header names magenta, colon and value plain, masked value bold + inverse', () => {
      const out = colored({ method: 'get', url: 'https://a.test/', headers: { Accept: 'text/plain', Authorization: 'x' } }, ['authorization']);
      assert.ok(out.includes(`-H '${magenta('Accept')}: text/plain'`), out);
      assert.ok(out.includes(`${magenta('Authorization')}: ${mask}'`), out);
    });

    test('JSON body: keys blue, strings green (16 colours: red), punctuation and the rest plain', () => {
      const out = colored({ method: 'post', url: 'https://a.test/', data: '{"k": ["v", 12, true, null], "m": "***"}' });
      const expected = [
        '{', blue('"k"'), ': [', string('"v"'), ', 12, true, null]', ', ', blue('"m"'), ': ',
        string('"'), mask, string('"'), '}',
      ].join('');
      assert.ok(out.includes(`'${expected}'`), out);
    });

    test('a body that is not valid JSON stays uncoloured', () => {
      for (const body of ['a=1&b=2', '{"a": 1', "{'a': 1}", 'plain text']) {
        const out = colored({ method: 'post', url: 'https://a.test/', data: body });
        assert.ok(out.includes(`'${body.replace(/'/g, `'\\''`)}'`), `${body}: ${out}`);
      }
      // truncation cuts JSON in the middle
      const cut = colored({ method: 'post', url: 'https://a.test/', data: { text: 'abcdefghijkl' } }, [], { maxBodyLength: 9 });
      assert.ok(!cut.includes(blue('"text"')), cut);
    });

    test('# lines are grey, one by one', () => {
      const out = colored({ method: 'put', url: 'https://a.test/', data: Buffer.from([1]), followRedirects: true });
      const notes = out.split('\n').filter((line) => stripAnsi(line).startsWith('#'));
      assert.equal(notes.length, 2);
      for (const line of notes) assert.equal(line, grey(stripAnsi(line)));
      assert.equal(
          buildCurl({ method: 'get', url: 'nope' }, [], { colors: true, colorDepth: depth }),
          grey('# could not build curl: invalid URL'),
      );
    });

    test('the form, multipart and binary options use the same colours', () => {
      const form = colored({ method: 'post', url: 'https://a.test/', form: { user: 'jo' } });
      assert.ok(form.includes(`--data-urlencode '${magenta('user')}=jo'`), form);
      const multi = colored({ method: 'post', url: 'https://a.test/', multipart: { f: 'v' } });
      assert.ok(multi.includes(`--form-string '${magenta('f')}=v'`), multi);
    });

    test('only the palette colours are used: no dim, white, yellow, cyan or black text', () => {
      const allowed = new Set(Object.values(CURL_COLORS).map((c) => (depth === 8 ? `38;5;${c.c256}` : String(c.c16 < 8 ? 30 + c.c16 : 90 + c.c16 - 8))));
      // bold, inverse and their off codes (the mask), plus the foreground reset
      const plainCodes = new Set(['1', '7', '22', '27', '39']);
      for (const c of CURL_CASES) {
        const out = build(c, { colors: true, colorDepth: depth });
        for (const [, code] of out.matchAll(/\u001b\[([0-9;]*)m/g)) {
          assert.ok(allowed.has(code) || plainCodes.has(code), `${c.name}: SGR ${code}`);
        }
      }
    });

    test('the colours off are the golden output, the colours stripped too', () => {
      for (const c of CURL_CASES) {
        assert.equal(build(c, { colors: false, colorDepth: depth }), GOLDEN[c.name], c.name);
        assert.equal(stripAnsi(build(c, { colors: true, colorDepth: depth })), GOLDEN[c.name], c.name);
      }
    });
  });
}

describe('the palette follows the terminal', () => {
  const coloured = (env: Record<string, string | undefined>, tty = true): string =>
    withEnv({ ...CLEAN_ENV, COLORTERM: undefined, ...env }, () => withTty(tty, () =>
      buildCurl({ method: 'get', url: 'https://a.test/' }, [], { colors: true })));

  test('256 colours from COLORTERM or TERM, else the 16 basic ones', () => {
    assert.ok(coloured({ COLORTERM: 'truecolor', TERM: 'xterm' }).includes('\u001b[38;5;63m'));
    assert.ok(coloured({ COLORTERM: '24bit', TERM: 'xterm' }).includes('\u001b[38;5;63m'));
    assert.ok(coloured({ TERM: 'xterm-256color' }).includes('\u001b[38;5;63m'));
    assert.ok(coloured({ TERM: 'xterm' }, false).includes('\u001b[94m'), 'bright blue');
    assert.ok(!coloured({ TERM: 'xterm' }, false).includes('38;5;'));
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
  // A terminal (stdout is a TTY) unless a test says otherwise.
  const resolved = (
      config: Parameters<typeof resolveConfig>[0],
      env: Record<string, string | undefined> = {},
      tty: boolean | undefined = true,
  ) => withEnv({ ...CLEAN_ENV, ...env }, () => withTty(tty, () => resolveConfig(config)));

  test('defaults: colours follow the detected support, multiline and file on', () => {
    assert.deepEqual(resolved({}, { FORCE_COLOR: '1' }).curlFormat, { colors: true, multiline: true, file: true });
    assert.deepEqual(resolved({}, { NO_COLOR: '1' }).curlFormat, { colors: false, multiline: true, file: true });
    assert.equal(resolved({ curlFormat: {} }, { FORCE_COLOR: '1' }).curlFormat.colors, true);
  });

  test("'auto' follows the resolved colors", () => {
    assert.equal(resolved({ curlFormat: { colors: 'auto' }, colors: true }).curlFormat.colors, true);
    assert.equal(resolved({ curlFormat: { colors: 'auto' }, colors: false }, { FORCE_COLOR: '1' }).curlFormat.colors, false);
  });

  test('NO_COLOR always wins under auto, even over colors: true; curlFormat.colors: true overrides it', () => {
    assert.equal(resolved({}, { NO_COLOR: '1', FORCE_COLOR: '1' }).curlFormat.colors, false);
    assert.equal(resolved({ colors: true }, { NO_COLOR: '1' }).curlFormat.colors, false);
    assert.equal(resolved({ colors: true }, { NO_COLOR: '1' }).colors, true, 'the log lines keep colors: true');
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

describe("curlFormat.colors 'auto' in CI and when the output is not a terminal", () => {
  const CI_VARS = [
    'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TRAVIS', 'APPVEYOR', 'TF_BUILD',
    'TEAMCITY_VERSION', 'JENKINS_URL', 'BITBUCKET_BUILD_NUMBER', 'CODEBUILD_BUILD_ID', 'DRONE',
  ];
  /** The resolved curl colours for `config` in an environment, with stdout a TTY or not. */
  const curlColors = (
      config: Parameters<typeof resolveConfig>[0],
      env: Record<string, string | undefined>,
      tty: boolean | undefined,
  ): boolean => withEnv({ ...CLEAN_ENV, ...env }, () => withTty(tty, () => resolveConfig(config))).curlFormat.colors;

  test('baseline: an interactive terminal gets coloured curl', () => {
    assert.equal(curlColors({}, { FORCE_COLOR: '1' }, true), true);
    assert.equal(curlColors({}, {}, true), true);
    assert.equal(curlColors({ colors: true }, {}, true), true);
  });

  test('CI plus FORCE_COLOR: plain, whatever the terminal says', () => {
    for (const tty of [true, false, undefined]) {
      assert.equal(curlColors({}, { CI: '1', FORCE_COLOR: '1' }, tty), false, String(tty));
    }
  });

  test('every CI variable counts; 0 and false do not', () => {
    for (const name of CI_VARS) {
      assert.equal(curlColors({}, { [name]: 'true', FORCE_COLOR: '1' }, true), false, name);
      assert.equal(inCI({ [name]: 'true' }), true, name);
    }
    for (const value of ['0', 'false', 'FALSE', '']) {
      assert.equal(inCI({ CI: value }), false, `CI=${JSON.stringify(value)}`);
      assert.equal(curlColors({}, { CI: value }, true), true, `CI=${JSON.stringify(value)}`);
    }
  });

  test('stdout not a TTY plus FORCE_COLOR (a Playwright worker): plain', () => {
    // playwright test gives its workers FORCE_COLOR=1 and DEBUG_COLORS=1 and pipes their stdout.
    for (const tty of [false, undefined]) {
      const env = { FORCE_COLOR: '1', DEBUG_COLORS: '1' };
      assert.equal(curlColors({}, env, tty), false, String(tty));
      const cfg = withEnv({ ...CLEAN_ENV, ...env }, () => withTty(tty, () => resolveConfig({})));
      assert.equal(cfg.colors, true, 'the other log lines are still coloured');
    }
  });

  test('top-level colors: true alone does not colour the curl in CI or when piped', () => {
    assert.equal(curlColors({ colors: true }, { CI: 'true' }, true), false);
    assert.equal(curlColors({ colors: true }, { GITHUB_ACTIONS: 'true' }, true), false);
    assert.equal(curlColors({ colors: true }, {}, false), false);
    assert.equal(curlColors({ colors: true }, { FORCE_COLOR: '1' }, false), false);
    assert.equal(curlColors({ colors: true, curlFormat: { colors: 'auto' } }, { CI: '1' }, true), false);
    const cfg = withEnv({ ...CLEAN_ENV, CI: '1' }, () => withTty(false, () => resolveConfig({ colors: true })));
    assert.equal(cfg.colors, true, 'the log lines keep colors: true');
  });

  test('colors: false keeps the curl plain on a terminal', () => {
    assert.equal(curlColors({ colors: false }, {}, true), false);
  });

  test('NO_COLOR: plain, even with FORCE_COLOR, PLAYWRIGHT_FORCE_TTY and a TTY', () => {
    assert.equal(curlColors({}, { NO_COLOR: '1' }, true), false);
    assert.equal(curlColors({}, { NO_COLOR: '1', FORCE_COLOR: '1', PLAYWRIGHT_FORCE_TTY: '1' }, true), false);
    assert.equal(curlColors({ colors: true }, { NO_COLOR: 'yes', PLAYWRIGHT_FORCE_TTY: '1' }, false), false);
  });

  test('PLAYWRIGHT_FORCE_TTY says the runner terminal is a TTY: a piped worker is coloured', () => {
    const worker = { FORCE_COLOR: '1', DEBUG_COLORS: '1' };
    for (const value of ['1', 'true', '120', '120x40']) {
      assert.equal(curlColors({}, { ...worker, PLAYWRIGHT_FORCE_TTY: value }, false), true, value);
    }
    for (const value of ['0', 'false', '']) {
      assert.equal(curlColors({}, { ...worker, PLAYWRIGHT_FORCE_TTY: value }, false), false, `"${value}"`);
    }
  });

  test('PLAYWRIGHT_FORCE_TTY does not override CI, TERM=dumb or colors: false', () => {
    assert.equal(curlColors({}, { PLAYWRIGHT_FORCE_TTY: '1', CI: '1' }, false), false);
    assert.equal(curlColors({}, { PLAYWRIGHT_FORCE_TTY: '1', TERM: 'dumb' }, false), false);
    assert.equal(curlColors({}, { TERM: 'dumb' }, true), false);
    assert.equal(curlColors({ colors: false }, { PLAYWRIGHT_FORCE_TTY: '1' }, false), false);
    assert.equal(curlColors({}, { PLAYWRIGHT_FORCE_TTY: '1', FORCE_COLOR: '0' }, false), false);
  });

  test('a custom sink stays plain even on a terminal', () => {
    assert.equal(curlColors({ sink: () => undefined, colors: true }, { PLAYWRIGHT_FORCE_TTY: '1' }, true), false);
  });

  test('explicit curlFormat.colors: true bypasses the CI, NO_COLOR and terminal checks', () => {
    const on = { curlFormat: { colors: true } };
    assert.equal(curlColors(on, { CI: '1', FORCE_COLOR: '1' }, false), true);
    assert.equal(curlColors(on, { NO_COLOR: '1' }, false), true);
    assert.equal(curlColors(on, {}, false), true);
    assert.equal(curlColors({ ...on, colors: false }, { CI: '1' }, false), true);
    assert.equal(curlColors({ curlFormat: { colors: false } }, {}, true), false);
  });

  test('autoCurlColors takes the environment and stream as arguments', () => {
    assert.equal(autoCurlColors({}, { isTTY: true }), true);
    assert.equal(autoCurlColors({}, { isTTY: false }), false);
    assert.equal(autoCurlColors({}, undefined), false);
    assert.equal(autoCurlColors({ PLAYWRIGHT_FORCE_TTY: '1' }, { isTTY: false }), true);
    assert.equal(autoCurlColors({ FORCE_COLOR: '1' }, { isTTY: false }), false);
    assert.equal(autoCurlColors({ CI: '1' }, { isTTY: true }), false);
    assert.equal(autoCurlColors({ NO_COLOR: '1' }, { isTTY: true }), false);
  });
});

describe('a local run: the runner tells its workers that its stdout is a terminal', () => {
  const RUNNER = 4242;
  /** A tty.WriteStream: `getColorDepth` lives on the prototype, which is what tells it from Playwright's fake. */
  const terminal = (bits?: number, isTTY = true) =>
    Object.create(bits === undefined ? {} : { getColorDepth: () => bits }, { isTTY: { value: isTTY } }) as { isTTY: boolean };
  /** The variable the runner would leave for its workers, `env` being the runner's environment. */
  const marked = (
      env: Record<string, string | undefined>,
      { tty = true, depth }: { tty?: boolean; depth?: number } = {},
  ): string | undefined => {
    const target: Record<string, string | undefined> = { ...env };
    markRunnerTty(target, terminal(depth, tty), RUNNER, () => tty);
    return target[RUNNER_TTY_VAR];
  };
  /** The curl colours of a worker (pid `process.ppid` is its parent): piped stdout, FORCE_COLOR=1 like Playwright's. */
  const workerColors = (
      config: Parameters<typeof resolveConfig>[0],
      env: Record<string, string | undefined>,
  ): boolean => withEnv(
      { ...CLEAN_ENV, FORCE_COLOR: '1', DEBUG_COLORS: '1', ...env },
      () => withTty(false, () => resolveConfig(config)),
  ).curlFormat.colors;
  const fromRunner = (suffix = ':8') => ({ [RUNNER_TTY_VAR]: `${process.ppid}${suffix}` });

  test('the runner marks itself with its pid and colour depth when stdout is a terminal', () => {
    assert.equal(marked({}, { depth: 8 }), `${RUNNER}:8`);
    assert.equal(marked({}, { depth: 4 }), `${RUNNER}:4`);
    assert.equal(marked({}, { depth: 24 }), `${RUNNER}:24`);
    assert.equal(marked({}), `${RUNNER}:0`, 'a depth that is not known');
    assert.equal(marked({ FORCE_COLOR: '1', TERM: 'xterm-256color' }, { depth: 8 }), `${RUNNER}:8`);
  });

  test('nothing is set when stdout is not a terminal, or the runner would not colour its output', () => {
    assert.equal(marked({}, { tty: false }), undefined, 'piped');
    for (const env of [
      { CI: '1' }, { GITHUB_ACTIONS: 'true' }, { NO_COLOR: '1' }, { TERM: 'dumb' },
      { FORCE_COLOR: '0' }, { FORCE_COLOR: 'false' }, { DEBUG_COLORS: '0' },
    ]) {
      assert.equal(marked(env, { depth: 8 }), undefined, JSON.stringify(env));
    }
    // CI=0, NO_COLOR='' and an unset TERM are not "off"
    assert.equal(marked({ CI: '0', NO_COLOR: '', TERM: undefined }, { depth: 8 }), `${RUNNER}:8`);
  });

  test('it is a no-op in a worker, whose fd 1 is a pipe: it does not erase what the runner set', () => {
    const env: Record<string, string | undefined> = { [RUNNER_TTY_VAR]: '4242:8' };
    markRunnerTty(env, terminal(8), 4300, () => false);
    assert.equal(env[RUNNER_TTY_VAR], '4242:8');
  });

  test('a worker whose parent is the marking runner colours the curl, and uses the depth it was given', () => {
    assert.equal(workerColors({}, fromRunner()), true);
    assert.equal(workerColors({}, fromRunner(':0')), true);
    assert.equal(workerColors({}, fromRunner('')), true);
    assert.equal(workerColors({ curlFormat: { colors: 'auto' } }, fromRunner()), true);
    assert.equal(workerColors({ colors: true }, fromRunner()), true);
    const worker = { TERM: 'xterm', ...fromRunner(':8') };
    assert.equal(withEnv({ ...CLEAN_ENV, ...worker }, () => withTty(false, () => curlColorDepth())), 8);
    assert.equal(withEnv({ ...CLEAN_ENV, TERM: 'xterm', ...fromRunner(':4') }, () => withTty(false, () => curlColorDepth())), 4);
  });

  test('every gate still applies in the worker', () => {
    const fromTerminal = fromRunner();
    assert.equal(workerColors({}, { ...fromTerminal, CI: '1' }), false, 'CI');
    assert.equal(workerColors({}, { ...fromTerminal, GITHUB_ACTIONS: 'true' }), false, 'GITHUB_ACTIONS');
    assert.equal(workerColors({}, { ...fromTerminal, NO_COLOR: '1' }), false, 'NO_COLOR');
    assert.equal(workerColors({}, { ...fromTerminal, TERM: 'dumb' }), false, 'TERM=dumb');
    assert.equal(workerColors({ sink: () => undefined }, fromTerminal), false, 'custom sink');
    assert.equal(workerColors({ sink: () => undefined, colors: true }, fromTerminal), false, 'custom sink, colors: true');
    assert.equal(workerColors({ colors: false }, fromTerminal), false, 'colors: false');
    assert.equal(workerColors({ curlFormat: { colors: false } }, fromTerminal), false, 'curlFormat.colors: false');
    assert.equal(workerColors({}, { ...fromTerminal, FORCE_COLOR: '0' }), false, 'FORCE_COLOR=0');
    assert.equal(workerColors({ sink: () => undefined, curlFormat: { colors: true } }, fromTerminal), true, 'curlFormat.colors: true overrides');
    assert.equal(workerColors({ curlFormat: { colors: true } }, { ...fromTerminal, CI: '1', NO_COLOR: '1' }), true, 'curlFormat.colors: true overrides');
  });

  test('a value that is not the parent pid is ignored: nested runs, a copy made by hand', () => {
    for (const value of [`${process.ppid + 1}:8`, '1', '1:8', 'true', '', `${process.ppid}x`, `${process.ppid}:`, `-${process.ppid}`]) {
      assert.equal(workerColors({}, { [RUNNER_TTY_VAR]: value }), false, JSON.stringify(value));
    }
    assert.equal(workerColors({}, {}), false, 'no variable');
  });

  test('without the variable a piped worker stays plain, also with the fake terminal of Playwright 1.30-1.39', () => {
    // setTtyParams: isTTY = true plus own getColorDepth/hasColors on a stream that is a pipe
    const fake = { isTTY: true, getColorDepth: () => 8, hasColors: () => true };
    assert.equal(autoCurlColors({ FORCE_COLOR: '1' }, fake, 100), false);
    assert.equal(autoCurlColors({ FORCE_COLOR: '1', [RUNNER_TTY_VAR]: '100:8' }, fake, 100), true, 'the runner says it is a terminal');
    assert.equal(autoCurlColors({ [RUNNER_TTY_VAR]: '100:8', CI: '1' }, fake, 100), false);
    assert.equal(autoCurlColors({ [RUNNER_TTY_VAR]: '100:8', NO_COLOR: '1' }, fake, 100), false);
    assert.equal(autoCurlColors({ [RUNNER_TTY_VAR]: '100:8', TERM: 'dumb' }, fake, 100), false);
    assert.equal(autoCurlColors({ [RUNNER_TTY_VAR]: '100:8' }, { isTTY: false }, 101), false, 'another parent');
    assert.equal(autoCurlColors({ [RUNNER_TTY_VAR]: '100:8' }, undefined, 100), true);
  });

  test('colour depth: COLORTERM, TERM, the runner, then a real terminal; else 16 colours', () => {
    assert.equal(curlColorDepth({ COLORTERM: 'truecolor' }, undefined, 1), 8);
    assert.equal(curlColorDepth({ COLORTERM: 'TrueColor' }, undefined, 1), 8);
    assert.equal(curlColorDepth({ COLORTERM: '24bit' }, undefined, 1), 8);
    assert.equal(curlColorDepth({ TERM: 'screen-256color' }, undefined, 1), 8);
    assert.equal(curlColorDepth({ TERM: 'xterm' }, undefined, 1), 4);
    assert.equal(curlColorDepth({}, undefined, 1), 4);
    assert.equal(curlColorDepth({ TERM: 'xterm', [RUNNER_TTY_VAR]: '1:24' }, undefined, 1), 8);
    assert.equal(curlColorDepth({ TERM: 'xterm', [RUNNER_TTY_VAR]: '1:4' }, undefined, 1), 4);
    assert.equal(curlColorDepth({ TERM: 'xterm', [RUNNER_TTY_VAR]: '2:8' }, undefined, 1), 4, 'not the parent');
    assert.equal(curlColorDepth({ TERM: 'xterm' }, terminal(8), 1), 8, 'a real terminal that reports 8 bits');
    assert.equal(curlColorDepth({ TERM: 'xterm' }, terminal(4), 1), 4);
    assert.equal(curlColorDepth({ TERM: 'xterm' }, { isTTY: true, getColorDepth: () => 8 }, 1), 4, "Playwright's fake terminal does not count");
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
    const api = withEnv({ ...CLEAN_ENV, ...env }, () => withTty(true, () =>
      wrapRequestContext(ctx, { format: 'verbose', curl: true, ...config, sink: config?.sink ?? ((l) => lines.push(l)) }, {
        onCurl: (c) => plain.push(c),
      })));
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
    const api = withEnv({ ...CLEAN_ENV, NO_COLOR: '1', FORCE_COLOR: '1' }, () => withTty(true, () =>
      wrapRequestContext(ctx, { format: 'verbose', curl: true, sink: (l) => lines.push(l), colors: undefined, curlFormat: { colors: 'auto' } })));
    await api.get('/y');
    assert.ok(lines.every((l) => !HAS_ANSI.test(l)), lines.join('\n'));
  });

  test('the default console sink: CI with FORCE_COLOR, or a pipe, prints a plain curl', async () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => printed.push(String(line));
    try {
      for (const [env, tty] of [[{ CI: '1', FORCE_COLOR: '1' }, true], [{ FORCE_COLOR: '1' }, false]] as const) {
        printed.length = 0;
        const api = withEnv({ ...CLEAN_ENV, ...env }, () => withTty(tty, () => wrapRequestContext(ctx, { format: 'verbose', curl: true })));
        await api.get('/z?token=abc');
        const curl = printed.filter((l) => stripAnsi(l).startsWith('curl '));
        assert.equal(curl.length, 1, printed.join('\n'));
        assert.ok(!HAS_ANSI.test(curl[0]), JSON.stringify(curl[0]));
        assert.ok(printed.some((l) => HAS_ANSI.test(l) && l.includes('→')), 'the request line is still coloured');
      }
      printed.length = 0;
      const api = withEnv({ ...CLEAN_ENV, FORCE_COLOR: '1' }, () => withTty(true, () => wrapRequestContext(ctx, { format: 'verbose', curl: true })));
      await api.get('/z');
      assert.ok(printed.some((l) => stripAnsi(l).startsWith('curl ') && HAS_ANSI.test(l)), 'a terminal gets colour');
    } finally {
      console.log = original;
    }
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

  type Attachment = { name: string; options: { body?: string | Buffer; contentType?: string; path?: string } };
  function fakeTestInfo(dir: string, extra: Partial<TestInfoLike> = {}): TestInfoLike & { attachments: Attachment[] } {
    const attachments: Attachment[] = [];
    return {
      title: 'my test',
      attachments,
      outputPath: (...segments: string[]) => path.join(dir, 'out', ...segments),
      attach: async (name, options) => {
        attachments.push({ name, options });
      },
      ...extra,
    };
  }

  async function inTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plp-curl-'));
    try {
      return await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('renderCurlScript: shebang, the spec location, a generic comment, the commands separated by a blank line', () => {
    assert.equal(
        renderCurlScript('tests/api/users.spec.ts:42', COMMANDS),
        '#!/bin/sh\n# tests/api/users.spec.ts:42\n# redacted curl commands of this test; run with: sh curl.sh\n\n' +
        `${COMMANDS[0]}\n\n${COMMANDS[1]}\n`,
    );
    assert.equal(
        renderCurlScript(undefined, COMMANDS).split('\n').slice(0, 3).join('\n'),
        '#!/bin/sh\n# redacted curl commands of this test; run with: sh curl.sh\n',
    );
  });

  test('stripControl removes line breaks, CSI, OSC 8, OSC 52 and other control characters', () => {
    const hostile = 'a\nb\r\u2028c\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u001b\\link\u001b]8;;\u001b\\' +
      '\u001b]52;c;Y2FuYXJ5\u0007\u009d52;c;eA\u009c\u001bP1;2|data\u001b\\\u0000\u007f\u202e!';
    const clean = stripControl(hostile);
    assert.equal(clean, 'abcredlink!');
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202e]/.test(clean));
    assert.equal(stripControl('tests/ok.spec.ts:7'), 'tests/ok.spec.ts:7');
    // an unterminated OSC does not leave its payload behind
    assert.equal(stripControl('x\u001b]52;c;Y2FuYXJ5'), 'x');
  });

  test('renderCurlScript strips control characters of a location it is given', () => {
    const script = renderCurlScript('a/b.spec.ts:1\n; rm -rf /\u001b]8;;http://x\u001b\\', COMMANDS);
    assert.equal(script.split('\n')[1], '# a/b.spec.ts:1; rm -rf /');
    assert.equal(script.split('\n').filter((l) => l.startsWith('#')).length, 3);
  });

  test('specLocation: relative to rootDir, else testDir, else the file name', () => {
    const at = (extra: Partial<TestInfoLike>) => specLocation({ ...fakeTestInfo('/tmp'), ...extra });
    assert.equal(at({ file: '/repo/tests/a/b.spec.ts', line: 12, config: { rootDir: '/repo' } }), 'tests/a/b.spec.ts:12');
    assert.equal(at({
      file: '/repo/tests/a/b.spec.ts', line: 3, config: { rootDir: '/elsewhere' }, project: { testDir: '/repo/tests' },
    }), 'a/b.spec.ts:3');
    assert.equal(at({ file: '/repo/tests/a/b.spec.ts', line: 3, config: { rootDir: '/elsewhere' } }), 'b.spec.ts:3');
    assert.equal(at({ file: '/repo/x.spec.ts' }), 'x.spec.ts', 'no line');
    assert.equal(at({ file: '/repo/x.spec.ts', line: 0 }), 'x.spec.ts', 'no line');
    assert.equal(at({}), undefined);
    assert.equal(at({ file: '/repo/we\u001b]52;c;eA\u0007ird\n.spec.ts', line: 1, config: { rootDir: '/repo' } }), 'weird.spec.ts:1');
  });

  test('the script is valid sh (curl stubbed)', async () => {
    await inTmp(async (dir) => {
      const file = path.join(dir, 'curl.sh');
      fs.writeFileSync(file, renderCurlScript('a.spec.ts:1', COMMANDS.map((c) => c.replace(/^curl/, 'curl --silent'))));
      const { stdout } = await execFileAsync('sh', ['-c', `curl() { echo "$# $1"; }; . ${file}`]);
      assert.equal(stdout, '4 --silent\n4 --silent\n');
    });
  });

  test('writes the file, attaches it and announces it without any path', async () => {
    await inTmp(async (dir) => {
      const info = fakeTestInfo(dir, {
        title: 'GET /echo?token=TITLE-SECRET', file: path.join(dir, 'tests', 'a.spec.ts'), line: 9, config: { rootDir: dir },
      });
      const lines: string[] = [];
      await writeCurlScript(COMMANDS, info, { log: (l) => lines.push(l) });
      const file = path.join(dir, 'out', 'curl.sh');
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(content, renderCurlScript('tests/a.spec.ts:9', COMMANDS));
      assert.ok(content.includes('Authorization: ***') && !HAS_ANSI.test(content));
      assert.ok(!content.includes('TITLE-SECRET') && !content.includes('/echo'), 'no title in the file');
      assert.deepEqual(info.attachments, [{ name: 'curl.sh', options: { path: file, contentType: 'text/plain' } }]);
      assert.deepEqual(lines, [CURL_SCRIPT_NOTICE]);
      assert.match(CURL_SCRIPT_NOTICE, /^curl\.sh: attached to the test report \(see "curl\.sh" in the HTML report; also saved in this test's output folder\)$/);
      assert.ok(!lines[0].includes(dir) && !lines[0].includes(path.sep) && !HAS_ANSI.test(lines[0]), 'no path, no escapes');
    });
  });

  test('no commands: nothing is written, attached or printed', async () => {
    await inTmp(async (dir) => {
      const info = fakeTestInfo(dir);
      const lines: string[] = [];
      await writeCurlScript([], info, { log: (l) => lines.push(l) });
      assert.deepEqual(lines, []);
      assert.deepEqual(info.attachments, []);
      assert.ok(!fs.existsSync(path.join(dir, 'out')));
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
          await writeCurlScript(COMMANDS, info, { log: () => undefined });
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
        const wrapped = wrapRequestContext(api, { format: 'verbose',
          curl: true, colors: true, curlFormat: { colors: true }, redactBodyKeys: ['pin'], sink: (l) => shown.push(l),
        }, { onCurl: (c) => commands.push(c) });
        await wrapped.post('/p?api_key=KEY-1', {
          data: { pin: 'PIN-2', ok: 1 }, headers: { Authorization: 'Bearer TOKEN-3', Cookie: 'sid=COOKIE-4' },
        });
        const info = fakeTestInfo(dir);
        await writeCurlScript(commands, info, { log: () => undefined });
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
