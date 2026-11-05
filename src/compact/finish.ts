import { didFail } from '../browser/output';
import type { TestInfoLike } from '../browser/output';
import { specLocation } from '../curlFile';
import { warnOnce } from '../warn';
import type { ResolvedConfig } from '../types';
import type { CompactCall } from '../wrapRequestContext';
import type { FailedTestCurl } from './options';
import { displayOptionsOf, renderOptionsOf } from './capture';
import { curlFileName } from './curlScript';
import { renderCalls } from './render';
import { ATTACHMENT_NAME } from './types';
import type { CallsAttachment } from './types';

/** Set in the runner process by `playwright-logger-pro/reporter`; workers inherit it. */
export const REPORTER_VAR = 'PLP_REPORTER';

const REPORTER_PATH = /playwright-logger-pro[\\/](?:dist[\\/])?reporter(?:\.[cm]?[jt]s)?$|[\\/]src[\\/]reporter(?:\.[cm]?[jt]s)?$/;

/** Whether the reporter will print this test's calls (so the fixture must not). */
export function reporterActive(
    testInfo: Pick<TestInfoLike, 'config'>,
    env: Record<string, string | undefined> = process.env,
    ppid: number = process.ppid,
): boolean {
  // A worker is a direct child of the runner; a value left by another process names another pid.
  if (Number(env[REPORTER_VAR]) === ppid) return true;
  const reporters = (testInfo.config as { reporter?: unknown } | undefined)?.reporter;
  return Array.isArray(reporters) && reporters.some((r) => typeof r?.[0] === 'string' && REPORTER_PATH.test(r[0]));
}

/**
 * The calls of one test, in order. With `curlOnFailedTest` it also decides which calls keep the curl
 * the wrapper built for them: calls made after the test had already failed never do (a cleanup in
 * `afterEach` is not "the last call before the failure"), and with `'last'` only the latest does,
 * so a long test holds one curl, not one per call.
 */
export class CallCollector {
  readonly calls: CompactCall[] = [];
  private latest: CompactCall | undefined;

  constructor(
      private readonly mode: FailedTestCurl | false,
      private readonly testInfo: Pick<TestInfoLike, 'errors'>,
  ) {}

  add(call: CompactCall): void {
    this.calls.push(call);
    if (!call.curlParts) return;
    if (this.mode === false || (this.testInfo.errors?.length ?? 0) > 0) {
      call.curlParts = undefined;
    } else if (this.mode === 'last') {
      if (this.latest) this.latest.curlParts = undefined;
      this.latest = call;
    }
  }
}

/** The failed test's selected calls get their curl, a script and the flag that makes the renderer show them. */
function applyFailedTestCurls(calls: readonly CompactCall[], cfg: ResolvedConfig): void {
  if (cfg.curlOnFailedTest === false) return;
  for (const call of calls) {
    const parts = call.curlParts;
    if (!parts) continue;
    call.record.curl = parts.terminal;
    call.record.curlOnFailedTest = true;
    if (cfg.curlFormat.file) call.script ??= parts.script;
  }
}

export interface FinishOptions {
  cfg: ResolvedConfig;
  /** The sink is the user's own: print there, never leave it to the reporter. */
  customSink: boolean;
  reporter: boolean;
  /**
   * The `colors` the user set, when they set one. It travels in the attachment for the reporter and
   * colours what the fixture prints; without it the reporter decides by itself.
   */
  colors?: boolean;
  /** Receives the plain request lines when the sink does not (see BrowserLogSession.addApi). */
  note?: (plainLine: string) => void;
}

/**
 * End of a test with compact output: attach `curl*.sh` and the JSON the reporter reads, and print
 * the calls here when no reporter will. Never throws.
 */
export async function finishCompact(
    calls: readonly CompactCall[],
    testInfo: TestInfoLike,
    options: FinishOptions,
): Promise<void> {
  if (calls.length === 0) return;
  const { cfg } = options;
  const failed = didFail(testInfo);
  try {
    if (failed) applyFailedTestCurls(calls, cfg);
    // Scripts follow the detail blocks: only for a failed test, unless details are always shown.
    if (failed || cfg.details === 'always') {
      const withScript = calls.filter((c) => c.script !== undefined && c.record.curl !== undefined);
      const location = specLocation(testInfo);
      let index = 0;
      for (const call of withScript) {
        const name = curlFileName(++index, withScript.length, call.record.method, call.record.url);
        const script = location ? call.script?.replace(/\n\n/, `\n# ${location}\n\n`) : call.script;
        try {
          await testInfo.attach(name, { body: script as string, contentType: 'text/x-shellscript' });
          call.record.curlFile = name;
        } catch (error) {
          warnOnce(`could not attach ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const records = calls.map((c) => c.record);
    const attachment: CallsAttachment = { version: 1, options: displayOptionsOf(cfg, options.colors), calls: records };
    await testInfo.attach(ATTACHMENT_NAME, { body: JSON.stringify(attachment), contentType: 'application/json' });
  } catch (error) {
    warnOnce(`could not attach the API log: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (options.reporter && !options.customSink) return;
  try {
    const width = process.stdout.columns || 120;
    cfg.sink(renderCalls(calls.map((c) => c.record), renderOptionsOf(cfg, cfg.curlFormat.colors || options.colors === true, width), failed).join('\n'));
  } catch (error) {
    warnOnce(`could not print the API calls: ${error instanceof Error ? error.message : String(error)}`);
  }
}
