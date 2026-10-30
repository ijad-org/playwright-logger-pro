import type { BrowserLogEvent } from './types';
import { browserPalette, stripAnsi } from './palette';
import type { BrowserPalette } from './palette';

export interface RenderOptions {
  /** ANSI colors. Only the `print` destination should ever pass true. */
  colors?: boolean;
}

// eslint-disable-next-line no-control-regex
const ESC_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Single-line, control-character-free rendition of untrusted text. */
function oneLine(s: string): string {
  return stripAnsi(s).replace(/\r?\n/g, ' ⏎ ').replace(ESC_CHARS, '');
}

function firstLine(s: string): string {
  return oneLine(s.split('\n', 1)[0] ?? '');
}

function formatTime(t: number): string {
  return `+${(Math.max(0, t) / 1000).toFixed(3)}s`;
}

function formatDuration(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function pageLabel(n: number): string {
  return `page#${n}`;
}

function body(ev: BrowserLogEvent, p: BrowserPalette): string {
  switch (ev.kind) {
    case 'action': {
      const icon = ev.status === 'ok' ? p.ok('✓') : ev.status === 'error' ? p.fail('✗') : p.warn('⧗');
      const subject = ev.subject ?? ev.target;
      const prefix = ev.page !== undefined && ev.target !== 'page' ? `[${pageLabel(ev.page)}] ` : '';
      const name = ev.target === 'page' && ev.page !== undefined ? pageLabel(ev.page) : subject;
      const call = `${prefix}${p.subject(oneLine(name))}.${p.method(ev.method)}(${oneLine(ev.args)})`;
      let line = `${icon} ${call}`;
      if (ev.status === 'pending') {
        line += `  ${p.warn(`still pending after ${formatDuration(ev.durationMs ?? 0)}`)}`;
      } else if (ev.durationMs !== undefined) {
        const dur = formatDuration(ev.durationMs);
        line += `  ${ev.slow ? p.warn(dur) : p.dim(dur)}`;
      }
      if (ev.error) {
        line += `  ${p.fail(`${oneLine(ev.error.name)}: ${firstLine(ev.error.message)}`)}`;
      }
      if (ev.location) {
        line += `  ${p.dim(`(${ev.location.file.split(/[\\/]/).pop()}:${ev.location.line})`)}`;
      }
      return line;
    }
    case 'navigation':
      return `${p.nav('↪')} ${oneLine(ev.url)}`;
    case 'page': {
      const id = pageLabel(ev.page ?? 1);
      const url = ev.url ? ` ${oneLine(ev.url)}` : '';
      switch (ev.event) {
        case 'opened': return `${id} opened${url}`;
        case 'popup': return `${id} popup opened${ev.opener !== undefined ? ` from ${pageLabel(ev.opener)}` : ''}${url}`;
        case 'closed': return `${id} closed`;
        case 'crashed': return p.fail(`${id} crashed`);
      }
      return id;
    }
    case 'console': {
      const level = oneLine(ev.level);
      const text = oneLine(ev.text);
      const where = ev.location ? `  ${p.dim(`(${oneLine(ev.location)})`)}` : '';
      if (level === 'error') return `${p.fail('⚠')} ${p.fail(`console.${level}`)}  ${text}${where}`;
      if (level === 'warning' || level === 'warn') return `${p.warn('⚠')} ${p.warn(`console.${level}`)}  ${text}${where}`;
      return `• console.${level}  ${text}${where}`;
    }
    case 'pageerror': {
      const head = `${p.fail('✗')} ${p.pageError('pageerror')}  ${firstLine(ev.message)}`;
      if (!ev.stack) return head;
      const frames = ev.stack.split('\n').map((l) => oneLine(l).trim()).filter(Boolean).slice(0, 5);
      return [head, ...frames.map((f) => `    ${p.dim(f)}`)].join('\n');
    }
    case 'network': {
      const failed = ev.failure !== undefined || (ev.status !== undefined && ev.status >= 400);
      const icon = failed ? p.fail('✗') : '↔';
      const status = ev.status !== undefined ? ` ${p.status(ev.status)(String(ev.status))}` : '';
      const dur = ev.durationMs !== undefined ? `  ${p.dim(formatDuration(ev.durationMs))}` : '';
      const fail = ev.failure !== undefined ? `  ${p.fail(oneLine(ev.failure))}` : '';
      return `${icon} network ${oneLine(ev.method)} ${oneLine(ev.url)}${status}${dur}${fail}`;
    }
    case 'dialog':
      return `◇ dialog ${oneLine(ev.dialogType)} "${oneLine(ev.message)}"`;
    case 'download':
      return `⤓ download "${oneLine(ev.suggestedFilename)}"  ${p.dim(oneLine(ev.url))}`;
    case 'step':
      if (ev.phase === 'start') return p.step(`▸ ${oneLine(ev.title)}`);
      return [
        p.step(`◂ ${oneLine(ev.title)}`),
        ev.status === undefined ? '' : (ev.status === 'failed' ? p.fail(ev.status) : ev.status === 'passed' ? p.ok(ev.status) : p.dim(ev.status)),
        ev.durationMs === undefined ? '' : p.dim(formatDuration(ev.durationMs)),
      ].filter(Boolean).join('  ');
    case 'note':
      return `✎ ${oneLine(ev.message)}`;
    case 'api': {
      const lines = ev.text.split('\n').map(oneLine);
      return [`api  ${lines[0] ?? ''}`, ...lines.slice(1).map((l) => `     ${l}`)].join('\n');
    }
    case 'dropped':
      return p.dim(`… ${ev.count} earlier event${ev.count === 1 ? '' : 's'} dropped (maxEvents)`);
  }
}

/**
 * Render one event as text: `+0.010s  │ ✓ page.goto('…')  412ms`. Steps indent
 * their contents with `│ `. Multi-line events (pageerror stacks, api blocks)
 * keep the indent on every line. With `colors: false` the result never
 * contains an ANSI escape, whatever the event text held.
 */
export function renderBrowserEventText(ev: BrowserLogEvent, options: RenderOptions = {}): string {
  const colors = options.colors === true;
  const p = browserPalette(colors);
  const depth = ev.step?.length ?? 0;
  const indent = depth > 0 ? p.dim('│ ').repeat(depth) : '';
  const time = p.dim(formatTime(ev.t));
  const [first = '', ...more] = body(ev, p).split('\n');
  const pad = ' '.repeat(formatTime(ev.t).length + 2);
  const lines = [`${time}  ${indent}${first}`, ...more.map((l) => `${pad}${indent}${l}`)];
  const text = lines.join('\n');
  return colors ? text : stripAnsi(text);
}

export function renderBrowserEventJsonl(ev: BrowserLogEvent): string {
  return JSON.stringify(ev);
}

export interface TimelineMeta {
  /** e.g. "login.spec.ts › rejects wrong password" */
  title?: string;
  project?: string;
  status?: string;
}

export function renderBrowserHeader(meta: TimelineMeta, options: RenderOptions = {}): string {
  const p = browserPalette(options.colors === true);
  const parts = ['browser log', meta.title, meta.project, meta.status]
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map(oneLine);
  const text = `── ${parts.join(' · ')} ──`;
  return meta.status && /fail|timed|interrupt/i.test(meta.status) ? p.bold(text) : p.dim(text);
}

/** Header (when `meta` is given) plus all events, one event per block. */
export function renderBrowserTimeline(
    events: readonly BrowserLogEvent[],
    options: RenderOptions & { format?: 'text' | 'jsonl'; meta?: TimelineMeta } = {},
): string {
  if (options.format === 'jsonl') return events.map(renderBrowserEventJsonl).join('\n') + (events.length ? '\n' : '');
  const lines = events.map((ev) => renderBrowserEventText(ev, options));
  if (options.meta) lines.unshift(renderBrowserHeader(options.meta, options));
  return lines.join('\n');
}

