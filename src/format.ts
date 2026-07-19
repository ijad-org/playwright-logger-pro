import pc from 'picocolors';
import type { ResolvedConfig } from './types';

type Colorizer = (s: string) => string;

interface Palette {
  method: (method: string) => Colorizer;
  status: (status: number) => Colorizer;
  dim: Colorizer;
  bold: Colorizer;
  arrowOut: Colorizer;
  arrowIn: Colorizer;
}

const identity: Colorizer = (s) => s;

function palette(colors: boolean): Palette {
  if (!colors) {
    return {
      method: () => identity,
      status: () => identity,
      dim: identity,
      bold: identity,
      arrowOut: identity,
      arrowIn: identity,
    };
  }
  return {
    method: (method: string) => {
      switch (method.toUpperCase()) {
        case 'GET': return pc.cyan;
        case 'POST': return pc.green;
        case 'PUT': return pc.yellow;
        case 'PATCH': return pc.magenta;
        case 'DELETE': return pc.red;
        default: return pc.white;
      }
    },
    status: (status: number) => {
      if (status >= 500) return pc.red;
      if (status >= 400) return pc.yellow;
      if (status >= 300) return pc.cyan;
      return pc.green;
    },
    dim: pc.dim,
    bold: pc.bold,
    arrowOut: pc.blue,
    arrowIn: pc.blue,
  };
}

export function redactHeaders(
    headers: Record<string, string>,
    redactList: string[],
): Record<string, string> {
  const lowered = redactList.map((h) => h.toLowerCase());
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = lowered.includes(key.toLowerCase()) ? '***' : value;
  }
  return out;
}

export function truncateBody(body: string, maxLength: number): string {
  if (body.length <= maxLength) return body;
  const extra = body.length - maxLength;
  return `${body.slice(0, maxLength)}... (${extra} more chars)`;
}

export function stringifyBody(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return `<Buffer ${data.length} bytes>`;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function formatRequestLine(
    method: string,
    url: string,
    config: ResolvedConfig,
): string {
  const p = palette(config.colors);
  const m = method.toUpperCase();
  return `${p.arrowOut('→')} ${p.bold(p.method(m)(m))} ${url}`;
}

export function formatResponseLine(
    method: string,
    url: string,
    status: number,
    statusText: string,
    durationMs: number,
    config: ResolvedConfig,
): string {
  const p = palette(config.colors);
  const m = method.toUpperCase();
  const statusStr = p.bold(p.status(status)(`${status} ${statusText}`.trim()));
  return `${p.arrowIn('←')} ${p.method(m)(m)} ${url} ${statusStr} ${p.dim(`(${durationMs}ms)`)}`;
}

export function formatHeaders(
    headers: Record<string, string>,
    config: ResolvedConfig,
): string {
  const p = palette(config.colors);
  const safe = redactHeaders(headers, config.redactHeaders);
  return Object.entries(safe)
      .map(([k, v]) => `  ${p.dim(`${k}:`)} ${v}`)
      .join('\n');
}

export function formatBody(data: unknown, config: ResolvedConfig): string | undefined {
  const body = stringifyBody(data);
  if (body === undefined || body.length === 0) return undefined;
  return truncateBody(body, config.maxBodyLength)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
}
