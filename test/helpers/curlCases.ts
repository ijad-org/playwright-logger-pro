import type { RequestInfo } from '../../src/types';
import type { CurlOptions } from '../../src/curl';

export interface CurlCase {
  name: string;
  info: RequestInfo;
  redact?: string[];
  options?: CurlOptions;
}

const REDACT = ['authorization', 'cookie', 'x-api-key'];
const KEYS = { redactQueryParams: ['token', 'api_key'], redactBodyKeys: ['password', 'secret'] };

/** Requests covering every branch of buildCurl; shared by the golden-output and colour tests. */
export const CURL_CASES: CurlCase[] = [
  { name: 'plain GET', info: { method: 'get', url: 'http://localhost:3000/vegetables' } },
  {
    name: 'GET with query and redacted params',
    info: { method: 'get', url: 'https://api.test/items?page=2&token=abc123&q=a%20b#top' },
    options: KEYS,
  },
  {
    name: 'GET with headers and redaction',
    info: {
      method: 'GET',
      url: 'https://api.test/me',
      headers: { Authorization: 'Bearer s3cret', Accept: 'application/json', 'X-Api-Key': 'k' },
    },
    redact: REDACT,
  },
  { name: 'HEAD', info: { method: 'head', url: 'https://api.test/ping' } },
  {
    name: 'POST JSON object',
    info: { method: 'post', url: 'https://api.test/users', data: { name: 'Ann', tags: ['a', 'b'], n: 1.5, ok: true, none: null } },
  },
  {
    name: 'POST JSON with redacted keys',
    info: { method: 'post', url: 'https://api.test/login', data: { user: 'ann', password: 'hunter2', nested: { secret: 'x' } } },
    options: KEYS,
  },
  {
    name: 'POST JSON string body with content type',
    info: {
      method: 'POST', url: 'https://api.test/users', headers: { 'Content-Type': 'application/json' },
      data: '{"a": 1, "b": [true, null, "x y"], "password": "pw"}',
    },
    options: KEYS,
  },
  { name: 'POST non-JSON string body', info: { method: 'post', url: 'https://x.test/y', data: 'raw-payload' } },
  {
    name: 'PUT / PATCH / DELETE',
    info: { method: 'put', url: 'https://api.test/u/1', data: { a: 1 } },
  },
  { name: 'PATCH', info: { method: 'patch', url: 'https://api.test/u/1', data: { a: 1 } } },
  { name: 'DELETE', info: { method: 'delete', url: 'https://api.test/u/1' } },
  { name: 'OPTIONS', info: { method: 'options', url: 'https://api.test/u/1' } },
  { name: 'GET with body', info: { method: 'get', url: 'https://api.test/search', data: { q: 'x' } } },
  {
    name: 'form',
    info: { method: 'post', url: 'https://api.test/login', form: { user: 'jo', active: true, n: 3, password: 'pw' } },
    options: KEYS,
  },
  {
    name: 'multipart fields and files',
    info: {
      method: 'post',
      url: 'https://api.test/upload',
      multipart: {
        title: 'hello world',
        secret: 'shh',
        file: { name: 'a b.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') },
      },
    },
    options: KEYS,
  },
  {
    name: 'binary body',
    info: { method: 'post', url: 'https://api.test/blob', data: Buffer.from([1, 2, 3, 4]) },
  },
  {
    name: 'binary body with content type',
    info: { method: 'put', url: 'https://api.test/blob', headers: { 'content-type': 'image/png' }, data: Buffer.from([1, 2]) },
  },
  {
    name: 'truncated body',
    info: { method: 'post', url: 'https://api.test/x', data: { text: 'abcdefghijklmnopqrstuvwxyz' } },
    options: { maxBodyLength: 12 },
  },
  {
    name: 'truncated form',
    info: { method: 'post', url: 'https://api.test/x', form: { a: 'abcdefghij', b: 'z' } },
    options: { maxBodyLength: 4 },
  },
  {
    name: 'follow redirects GET',
    info: { method: 'get', url: 'https://api.test/old', followRedirects: true },
  },
  {
    name: 'follow redirects POST with body',
    info: { method: 'post', url: 'https://api.test/old', data: { a: 1 }, followRedirects: true },
  },
  {
    name: 'redirected PUT without hops',
    info: { method: 'put', url: 'https://api.test/old', data: { a: 1 }, followRedirects: true },
  },
  {
    name: 'redirect chain',
    info: {
      method: 'post',
      url: 'https://a.test/start',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', Cookie: 'sid=1' },
      data: { a: 1 },
      followRedirects: true,
      playwrightVersion: '1.50.0',
      redirects: [
        { method: 'POST', url: 'https://a.test/start', status: 303 },
        { method: 'GET', url: 'https://b.test/next', status: 302 },
        { method: 'GET', url: 'https://b.test/final', status: 200 },
      ],
    },
    redact: REDACT,
  },
  { name: 'invalid URL', info: { method: 'get', url: 'not a url' } },
  {
    name: 'hostile values',
    info: {
      method: 'post',
      url: "https://api.test/q?name=it's&x=$HOME&y=`id`",
      headers: { 'X-Note': "it's $HOME `id` $(id)\nline2", 'X-Quote': "'; rm -rf / #" },
      data: "{\"k\": \"it's $HOME `id`\\n\", \"nl\": \"a\nb\"}",
    },
  },
  {
    name: 'hostile form and multipart',
    info: { method: 'post', url: 'https://api.test/f', form: { "k'ey": "v'al$x`y`\nz" } },
  },
];
