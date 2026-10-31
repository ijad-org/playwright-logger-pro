import * as fs from 'node:fs';
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { autoCurlColors } from './env';
import { REPORTER_VAR } from './compact/finish';
import { curlModeOf, resolveDisplay } from './compact/options';
import type { CompactDisplayConfig, CurlMode, ResolvedDisplay } from './compact/options';
import { renderCalls, renderFooter, summarize, symbolsFor } from './compact/render';
import type { RenderOptions } from './compact/render';
import { makeStyle } from './compact/style';
import { ATTACHMENT_NAME } from './compact/types';
import type { CallRecord, CallsAttachment } from './compact/types';
import { detectColorSupport } from './types';

export interface ReporterOptions extends CompactDisplayConfig {
  /**
   * Which calls get a curl in their block. The fixture decides which calls carry one
   * (`apiLog.curl`); this can only show fewer, or more of the failed ones.
   */
  curl?: CurlMode;
  /**
   * ANSI colours. `'auto'` (default): the rules of the `curlFormat.colors: 'auto'` option, so
   * none on CI, with `NO_COLOR`, or when stdout is not a terminal. `true` forces them on.
   */
  colors?: boolean | 'auto';
}

interface Block {
  lines: string[];
  header: string[];
  /** Waited for an idle terminal; its result line is no longer right above it. */
  held: boolean;
}

const quiet = (): void => undefined;

/** Whether the list reporter treats stdout as a terminal it can rewrite in place (as Playwright decides it). */
function liveTerminal(env: Record<string, string | undefined> = process.env): boolean {
  const force = env.PLAYWRIGHT_FORCE_TTY;
  if (force === 'false' || force === '0') return false;
  if (force) return true;
  return Boolean(process.stdout.isTTY);
}

function terminalWidth(): number {
  return process.stdout.columns || 120;
}

/**
 * Prints the API calls of every test under the result line of the list reporter, and a one-line
 * total after its summary. Register it after `list`:
 *
 *     reporter: [['list'], ['playwright-logger-pro/reporter']]
 *
 * The `test` fixture records the calls of a test (masked) in a `playwright-logger-pro.json`
 * attachment; this reporter, in the runner process, renders it when the test ends. Printing from
 * the workers cannot give this layout: their output reaches the terminal before the result line
 * and interleaves between parallel tests.
 *
 * Two things about the list reporter shape the printing:
 *
 * - Without colours (CI, a pipe) it writes through a stream wrapper that finishes a line on the
 *   next tick, so a direct `process.stdout.write` here would land in the middle of its result
 *   line. Output therefore waits one `setImmediate`. Should several tests end in that same tick
 *   their blocks carry a title line, as the result lines may no longer sit right above them.
 * - In a terminal it rewrites its result lines in place, counting the rows it printed. Extra lines
 *   printed while a test is still running shift those rows and the next rewrite lands on the wrong
 *   line. So while another test runs the output is held back, then printed with a title line once
 *   the terminal is idle (at the latest at the end of the run). With one worker nothing is held.
 */
export default class ApiLogReporter implements Reporter {
  private readonly input: Record<string, unknown>;
  private readonly colors: boolean;
  private display: ResolvedDisplay;
  private curl: CurlMode = '5xx';
  private running = 0;
  private pending: Block[] = [];
  private endedInBatch = 0;
  private scheduled = false;
  private readonly all: CallRecord[] = [];
  private listReporter = false;
  private readonly live = liveTerminal();

  constructor(options: ReporterOptions = {}) {
    const input = options !== null && typeof options === 'object' ? options : {};
    this.input = input as Record<string, unknown>;
    const colors = this.input.colors;
    this.colors = typeof colors === 'boolean' ? colors : detectColorSupport() && autoCurlColors();
    this.display = resolveDisplay(this.input);
    this.curl = curlModeOf(this.input.curl) ?? '5xx';
    // The fixtures in the workers learn from this that the reporter prints, so they do not.
    process.env[REPORTER_VAR] = String(process.pid);
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    this.listReporter = config.reporter.some((r) => r[0] === 'list');
  }

  onTestBegin(): void {
    this.running++;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.running = Math.max(0, this.running - 1);
    this.endedInBatch++;
    const attachment = readAttachment(result);
    if (attachment && attachment.calls.length > 0) {
      const display = resolveDisplay(this.input, resolveDisplay(attachment.options ?? {}, undefined, quiet));
      this.display = display;
      this.curl = curlModeOf(this.input.curl) ?? curlModeOf(attachment.options?.curl) ?? '5xx';
      const opts = this.renderOptions();
      const failed = result.status !== 'skipped' && result.status !== test.expectedStatus;
      this.all.push(...attachment.calls);
      this.pending.push({
        lines: renderCalls(attachment.calls, opts, failed),
        header: this.header(test, result, opts),
        held: false,
      });
    }
    this.schedule();
  }

  async onEnd(): Promise<void> {
    // Let the list reporter's own summary reach the terminal first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.drain(true);
    const footer = renderFooter(summarize(this.all, this.display), this.renderOptions());
    if (footer !== undefined) this.write([footer]);
  }

  private renderOptions(): RenderOptions {
    return { ...this.display, curl: this.curl, colors: this.colors, width: terminalWidth() };
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.drain(false);
    });
  }

  private drain(final: boolean): void {
    // A terminal the list reporter is still rewriting: wait until no test is running.
    if (this.live && this.running > 0 && !final) {
      for (const block of this.pending) block.held = true;
      return;
    }
    const crowded = this.endedInBatch > 1;
    this.endedInBatch = 0;
    const lines = this.pending.splice(0).flatMap((block) =>
      !this.listReporter || block.held || crowded ? [...block.header, ...block.lines] : block.lines);
    this.write(lines);
  }

  /** The one place that writes; the tests replace it. */
  protected write(lines: string[]): void {
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
  }

  /** `✓  [chromium] › cart.spec.ts:8:5 › adds product`: the title line of a block printed away from its result line. */
  private header(test: TestCase, result: TestResult, opts: RenderOptions): string[] {
    const style = makeStyle(opts.colors, opts.theme);
    const sym = symbolsFor(opts.ascii);
    const [, project, file, ...rest] = test.titlePath();
    const title = [project ? `[${project}]` : undefined, `${file}:${test.location.line}:${test.location.column}`, ...rest]
        .filter(Boolean)
        .join(' › ');
    const ok = result.status === 'skipped' || result.status === test.expectedStatus;
    const mark = ok ? style.status(200)(sym.pass) : style.errors(sym.fail);
    return [`  ${mark}  ${title}`];
  }
}

/** The records of a test, from its JSON attachment; undefined when it has none or it cannot be read. */
function readAttachment(result: TestResult): CallsAttachment | undefined {
  const found = result.attachments.find((a) => a.name === ATTACHMENT_NAME);
  if (!found) return undefined;
  try {
    const text = found.body ? found.body.toString('utf8') : found.path ? fs.readFileSync(found.path, 'utf8') : undefined;
    const parsed = text === undefined ? undefined : JSON.parse(text) as CallsAttachment;
    return parsed && Array.isArray(parsed.calls) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export { ApiLogReporter };
