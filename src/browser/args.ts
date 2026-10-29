import * as path from 'node:path';
import { redactHeaders, splitChars } from '../format';
import { maskUrl, redactText, sanitizeDeep } from '../redact';
import { describeFrame, describeLocator, playwrightClass, quote } from './describe';
import type { MethodSpec } from './methods';
import type { ResolvedRedactConfig } from './types';

/** A value that is rendered as-is (not quoted), e.g. `***` or a locator description. */
export class Bare {
  constructor(readonly text: string) {}
}

export interface ArgsContext {
  redact: ResolvedRedactConfig;
  maxArgLength: number;
  /** Mask the secret-bearing argument of this call (decided by the session). */
  maskSecret: boolean;
}

export interface RenderedArgs {
  /** Arguments joined with ", ", already redacted and truncated. */
  text: string;
  redacted: boolean;
  /** Raw secret strings that were masked in this call (for scrubbing error messages). */
  secrets: string[];
}

function size(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function headOf(source: string, max = 80): string {
  const flat = source.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** `Shift+A`, `a`, `1`, `@` are typed characters; `Enter`, `Control+a` are not. */
export function isPrintableKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  const parts = key === '+' ? ['+'] : key.endsWith('++') ? [...key.slice(0, -2).split('+'), '+'] : key.split('+');
  const last = parts[parts.length - 1] ?? '';
  return [...last].length === 1 && parts.slice(0, -1).every((p) => p === 'Shift');
}

function collectStrings(v: unknown, out: string[], depth = 0): void {
  if (typeof v === 'string') {
    if (v.length > 0) out.push(v);
  } else if (depth < 3 && Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, depth + 1);
  } else if (depth < 3 && v !== null && typeof v === 'object' && !playwrightClass(v)) {
    for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
  }
}

type AnyFunction = (...args: never[]) => unknown;

class Renderer {
  constructor(private readonly ctx: ArgsContext, private readonly fnLabel: (fn: AnyFunction) => string) {}

  private get values(): readonly string[] {
    return this.ctx.redact.values;
  }

  private text(s: string): string {
    return redactText(maskUrl(s, undefined, this.ctx.redact.mask), this.values, this.ctx.redact.mask);
  }

  /** JS-like literal for an already sanitised value. */
  lit(v: unknown): string {
    if (v instanceof Bare) return v.text;
    if (typeof v === 'string') return quote(this.text(v));
    if (Array.isArray(v)) return `[${v.map((x) => this.lit(x)).join(', ')}]`;
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) return '{}';
      const key = (k: string): string => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k));
      return `{ ${entries.map(([k, x]) => `${key(k)}: ${this.lit(x)}`).join(', ')} }`;
    }
    return String(v);
  }

  sanitize(v: unknown): unknown {
    return sanitizeDeep(v, {
      keys: this.ctx.redact.keys,
      values: this.values,
      mask: this.ctx.redact.mask,
      custom: (x) => this.custom(x),
    });
  }

  private custom(x: unknown): Bare | undefined {
    if (typeof x === 'function') return new Bare(this.fnLabel(x as AnyFunction));
    const cls = playwrightClass(x);
    if (!cls) return undefined;
    switch (cls) {
      case 'Locator': case 'FrameLocator': return new Bare(describeLocator(x));
      case 'Page': return new Bare('page');
      case 'Frame': return new Bare(describeFrame(x));
      case 'ElementHandle': return new Bare('elementHandle');
      default: return new Bare(`<${cls}>`);
    }
  }

  generic(v: unknown): string {
    return this.lit(this.sanitize(v));
  }

  pattern(v: unknown): string {
    if (typeof v === 'string') return quote(this.text(v));
    if (v instanceof RegExp) return String(v);
    if (typeof v === 'function') return '<predicate>';
    return this.generic(v);
  }

  func(v: unknown): string {
    if (typeof v === 'function') {
      const fn = v as AnyFunction;
      return fn.name || this.text(headOf(Function.prototype.toString.call(fn)));
    }
    if (typeof v === 'string') return this.text(headOf(v));
    return this.generic(v);
  }

  files(v: unknown): string {
    const one = (f: unknown): string => {
      if (typeof f === 'string') return quote(path.basename(f));
      if (f !== null && typeof f === 'object') {
        const o = f as { name?: unknown; mimeType?: unknown; buffer?: unknown };
        if (typeof o.name === 'string') {
          const len = Buffer.isBuffer(o.buffer) ? o.buffer.length : undefined;
          const meta = [typeof o.mimeType === 'string' ? o.mimeType : undefined, len !== undefined ? size(len) : undefined]
              .filter(Boolean).join(', ');
          return `${this.text(o.name)}${meta ? ` (${meta})` : ''}`;
        }
      }
      return '<file>';
    };
    return Array.isArray(v) ? `[${v.map(one).join(', ')}]` : one(v);
  }

  script(v: unknown): string {
    if (typeof v === 'function') return `<script ${(v as AnyFunction).name || 'function'}>`;
    if (typeof v === 'string') return `<script ${size(Buffer.byteLength(v))}>`;
    if (v !== null && typeof v === 'object') {
      const o = v as { path?: unknown; content?: unknown; url?: unknown };
      const parts: string[] = [];
      if (typeof o.url === 'string') parts.push(`url: ${quote(this.text(o.url))}`);
      if (typeof o.path === 'string') parts.push(`path: ${quote(path.basename(o.path))}`);
      if (typeof o.content === 'string') parts.push(`content: <script ${size(Buffer.byteLength(o.content))}>`);
      return parts.length > 0 ? `{ ${parts.join(', ')} }` : '{}';
    }
    return this.generic(v);
  }

  cookies(v: unknown): string {
    if (!Array.isArray(v)) return this.generic(v);
    const mask = this.ctx.redact.mask;
    return this.lit(v.map((c) => {
      const o = (c !== null && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of ['name', 'domain', 'url', 'path']) if (typeof o[k] === 'string') out[k] = o[k];
      out.value = new Bare(mask);
      return out;
    }));
  }

  credentials(v: unknown): string {
    if (v === null || typeof v !== 'object') return this.generic(v);
    const o = v as { username?: unknown };
    return this.lit({ username: typeof o.username === 'string' ? o.username : undefined, password: new Bare(this.ctx.redact.mask) });
  }
}

/**
 * Render the arguments of one call. Never throws: on any error the result is
 * a placeholder, so a formatting bug can never leak or break a test.
 */
export function renderArgs(spec: MethodSpec, args: unknown[], ctx: ArgsContext): RenderedArgs {
  const secrets: string[] = [];
  let redacted = false;
  try {
    let n = args.length;
    while (n > 0 && args[n - 1] === undefined) n--;
    const r = new Renderer(ctx, (fn) => `<function${fn.name ? ` ${fn.name}` : ''}>`);
    const mask = ctx.redact.mask;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const arg = args[i];
      let piece: string;
      const secretHere = spec.secret !== undefined && spec.secret.index === i;
      if (secretHere && ctx.maskSecret && (spec.secret?.kind !== 'key' || (typeof arg === 'string' && isPrintableKey(arg)))) {
        collectStrings(arg, secrets);
        redacted = true;
        piece = mask;
      } else {
        switch (spec.render) {
          case 'url':
            piece = i === 0 ? r.pattern(arg) : r.generic(arg);
            break;
          case 'urlPattern':
            piece = i === 0 ? r.pattern(arg) : typeof arg === 'function' ? '<handler>' : r.generic(arg);
            break;
          case 'predicate':
            piece = typeof arg === 'function' ? '<predicate>' : r.generic(arg);
            break;
          case 'evaluate':
            piece = i === 0 ? r.func(arg) : r.generic(arg);
            break;
          case 'files':
            piece = i === (spec.selector ? 1 : 0) ? r.files(arg) : r.generic(arg);
            break;
          case 'html':
            piece = i === 0 && typeof arg === 'string' ? `<html ${size(Buffer.byteLength(arg))}>` : r.generic(arg);
            break;
          case 'script':
            piece = i === 0 ? r.script(arg) : r.generic(arg);
            break;
          case 'headers':
            piece = i === 0 && arg !== null && typeof arg === 'object' ?
              r.generic(redactHeaders(arg as Record<string, string>, ctx.redact.headers, mask)) :
              r.generic(arg);
            break;
          case 'cookies':
            piece = i === 0 ? r.cookies(arg) : r.generic(arg);
            break;
          case 'credentials':
            piece = i === 0 ? r.credentials(arg) : r.generic(arg);
            break;
          case 'har':
            piece = i === 0 && typeof arg === 'string' ? quote(path.basename(arg)) : r.generic(arg);
            break;
          default:
            piece = r.generic(arg);
        }
      }
      const { head, rest } = splitChars(piece, ctx.maxArgLength);
      out.push(rest > 0 ? `${head}…(+${rest})` : head);
    }
    return { text: out.join(', '), redacted, secrets };
  } catch {
    return { text: '<unprintable>', redacted, secrets };
  }
}
