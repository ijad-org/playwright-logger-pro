import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { warnOnce } from '../warn';
import { renderBrowserTimeline } from './render';
import type { TimelineMeta } from './render';
import type { BrowserLogSession } from './session';
import type { WhenToWrite } from './types';

/** The part of Playwright's TestInfo that we use. */
export interface TestInfoLike {
  title: string;
  titlePath?: string[];
  status?: string;
  expectedStatus?: string;
  project?: { name?: string };
  retry?: number;
  repeatEachIndex?: number;
  testId?: string;
  outputPath(...segments: string[]): string;
  attach(name: string, options: { body?: string | Buffer; contentType?: string; path?: string }): Promise<void>;
}

/** "Failed" means the outcome differs from the expectation, so `test.fail()` is handled correctly. */
export function didFail(testInfo: Pick<TestInfoLike, 'status' | 'expectedStatus'>): boolean {
  return testInfo.status !== undefined && testInfo.status !== testInfo.expectedStatus;
}

const wants = (when: WhenToWrite, failed: boolean): boolean => when === true || (when === 'on-failure' && failed);

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'test';
}

function fileName(testInfo: TestInfoLike, ext: string): string {
  const titles = (testInfo.titlePath ?? [testInfo.title]).filter(Boolean);
  const id = (testInfo.testId ?? crypto.createHash('sha1').update(titles.join('\0')).digest('hex')).slice(0, 8);
  const retry = testInfo.retry ? `-retry${testInfo.retry}` : '';
  const repeat = testInfo.repeatEachIndex ? `-repeat${testInfo.repeatEachIndex}` : '';
  return `${slug(titles.join(' '))}-${id}${retry}${repeat}.${ext}`;
}

export function timelineMeta(session: BrowserLogSession, testInfo: TestInfoLike): TimelineMeta {
  return { title: session.meta.title, project: session.meta.project, status: testInfo.status };
}

/**
 * Write what the configuration asks for once the test is over: the on-failure
 * print block, the report attachment and the per-test file. Never throws and
 * never deletes anything. Nothing is produced for a session without events.
 */
export async function writeOutputs(session: BrowserLogSession, testInfo: TestInfoLike): Promise<void> {
  const cfg = session.cfg;
  const events = session.events();
  // API lines alone are not a browser timeline: an API-only test produces no output.
  if (!events.some((e) => e.kind !== 'api' && e.kind !== 'dropped')) return;
  const failed = didFail(testInfo);
  const meta = timelineMeta(session, testInfo);

  // Live printing already happened event by event; only the on-failure block is left.
  if (cfg.print === 'on-failure' && failed) {
    const shown = events.filter((e) => e.kind !== 'api');
    try {
      cfg.sink(renderBrowserTimeline(shown, { colors: cfg.colors, meta }));
    } catch (error) {
      warnOnce(`the browserLog "sink" threw (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (wants(cfg.attach, failed)) {
    try {
      const jsonl = cfg.attachFormat === 'jsonl';
      await testInfo.attach(jsonl ? 'browser-log.jsonl' : 'browser-log', {
        body: renderBrowserTimeline(events, { format: cfg.attachFormat, colors: false, meta }),
        contentType: jsonl ? 'application/x-ndjson' : 'text/plain',
      });
    } catch (error) {
      warnOnce(`could not attach the browser log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (wants(cfg.file, failed)) {
    try {
      const ext = cfg.fileFormat === 'jsonl' ? 'jsonl' : 'txt';
      let target: string;
      if (cfg.fileDir) {
        await fs.mkdir(cfg.fileDir, { recursive: true });
        target = path.join(cfg.fileDir, fileName(testInfo, ext));
      } else {
        target = testInfo.outputPath(`browser-log.${ext}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
      }
      await fs.writeFile(target, renderBrowserTimeline(events, { format: cfg.fileFormat, colors: false, meta }), 'utf8');
    } catch (error) {
      warnOnce(`could not write the browser log file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
