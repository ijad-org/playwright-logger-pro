import { getRegistry } from './registry';
import { getActiveSession } from './attach';
import { callSite } from './callSite';
import { ensureStackHygiene } from './stackHygiene';
import { honoursStepLocation } from './pwVersion';

type StepBody = (...args: never[]) => unknown;
interface StepOptions {
  box?: boolean;
  timeout?: number;
  location?: { file: string; line: number; column: number };
  [key: string]: unknown;
}
type StepFn = ((title: string, body: StepBody, options?: StepOptions) => Promise<unknown>) & Record<string, unknown>;

/** Anything shaped like Playwright's TestType: a function with `step` and `extend`. */
export type TestTypeLike = object;

const WRAPPED = Symbol.for('playwright-logger-pro/wrapped-test-type');

/**
 * Make `test.step` visible to the browser log (Playwright 1.48+; older versions are left alone): step boundaries become events
 * and every action inside a step records the step path. The report keeps the
 * user's source location for the step (explicit `location` from 1.48, hidden
 * wrapper frame before that). `extend` is re-wrapped so the integration
 * survives `test.extend(...)`.
 */
export function wrapTestType<T extends TestTypeLike>(testType: T): T {
  const t = testType as Record<string | symbol, unknown>;
  if (t[WRAPPED] || typeof t.step !== 'function') return testType;
  // Before Playwright 1.48 a step's location is the direct caller of `test.step`, which would be
  // this wrapper: the report would link every step into the library. So no integration there.
  if (!honoursStepLocation()) return testType;
  const original = t.step as StepFn;

  const step = function (title: string, body: StepBody, options?: StepOptions): Promise<unknown> {
    const session = getActiveSession();
    const on = session !== null && session.capturing && session.cfg.steps !== false;
    ensureStackHygiene();
    let opts = options;
    if (!options?.location) {
      const location = callSite(getRegistry().libDirs);
      if (location) opts = { ...options, location };
    }
    if (!on || !session) return original(title, body, opts);
    return original(title, (...args: never[]) => session.runStep(String(title), () => body(...args)), opts);
  } as StepFn;
  Object.assign(step, original); // keep static members such as step.skip
  Object.defineProperty(step, 'name', { value: 'step', configurable: true });

  t.step = step;
  if (typeof t.extend === 'function') {
    const extend = t.extend as (...args: unknown[]) => TestTypeLike;
    t.extend = function (this: unknown, ...args: unknown[]) {
      return wrapTestType(extend.apply(this ?? testType, args));
    };
  }
  t[WRAPPED] = true;
  return testType;
}
