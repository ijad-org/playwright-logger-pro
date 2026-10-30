import * as tty from 'node:tty';
import type { CurlColorDepth } from './curlPalette';

/** Environment variables as `process.env` has them. */
export type Env = Record<string, string | undefined>;

/** True for the values the colour env vars use to mean "off". */
export function isOff(value: string | undefined): boolean {
  return value !== undefined && (value === '0' || value.toLowerCase() === 'false');
}

/** Set to anything but "", "0" and "false". */
function isOn(value: string | undefined): boolean {
  return Boolean(value) && !isOff(value);
}

/** Variables the common CI services set; `CI` itself is checked first. */
export const CI_VARIABLES: readonly string[] = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TRAVIS', 'APPVEYOR', 'TF_BUILD',
  'TEAMCITY_VERSION', 'JENKINS_URL', 'BITBUCKET_BUILD_NUMBER', 'CODEBUILD_BUILD_ID', 'DRONE',
];

/** Whether the process runs on a CI service: `CI` or one of the service-specific variables is on. */
export function inCI(env: Env = process.env): boolean {
  return CI_VARIABLES.some((name) => isOn(env[name]));
}

/**
 * Variable the test runner sets for its workers when ITS OWN stdout is a terminal. Its value is
 * `<runner pid>` or `<runner pid>:<colour depth in bits>`; see markRunnerTty().
 */
export const RUNNER_TTY_VAR = 'PLP_RUNNER_TTY';

interface MaybeTTY { isTTY?: boolean; getColorDepth?: unknown; hasColors?: unknown }

/**
 * Whether the stream is a terminal. Playwright 1.30–1.39 make every worker's stdout look like
 * one although it is a pipe (process.js setTtyParams): it assigns `isTTY = true` plus its own
 * `getColorDepth` and `hasColors` to the stream. On a real tty.WriteStream those two live on
 * the prototype, and a pipe has neither, so own properties give the fake away.
 */
function isRealTTY(stream: MaybeTTY | undefined): boolean {
  if (!stream?.isTTY) return false;
  return !(Object.hasOwn(stream, 'getColorDepth') || Object.hasOwn(stream, 'hasColors'));
}

/** A real terminal's colour depth in bits (4 = 16 colours, 8 = 256, 24 = true colour), if it reports one. */
function streamColorDepth(stream: MaybeTTY | undefined): number | undefined {
  if (!isRealTTY(stream) || typeof stream?.getColorDepth !== 'function') return undefined;
  try {
    const depth: unknown = stream.getColorDepth();
    return typeof depth === 'number' ? depth : undefined;
  } catch {
    return undefined;
  }
}

/** What the runner told this process: its terminal's colour depth (0 when unknown), or undefined if it said nothing. */
function runnerTty(env: Env, ppid: number): { depth: number } | undefined {
  const match = /^(\d+)(?::(\d+))?$/.exec(env[RUNNER_TTY_VAR] ?? '');
  // A worker is a direct child of the runner. A value left by another process (an outer runner
  // whose child runs `playwright test` again, a value typed by hand) names a different pid.
  if (!match || Number(match[1]) !== ppid) return undefined;
  return { depth: Number(match[2] ?? 0) };
}

/**
 * Called in the test runner process (by the package entry points, when a spec file imports them).
 * If the runner itself writes to a terminal, tells its workers so through RUNNER_TTY_VAR: a worker's
 * stdout is a pipe, so it cannot see this.
 *
 * Playwright loads the spec files in the runner process on every version this package supports
 * (checked on 1.30, 1.39, 1.48 and the latest), where fd 1 is the terminal, and forks the workers
 * with the runner's environment, so a variable set here reaches them. In a worker fd 1 is a pipe,
 * so the same call does nothing there.
 *
 * Nothing is set when the runner would not colour its own output: CI, NO_COLOR, FORCE_COLOR=0 or
 * DEBUG_COLORS=0, TERM=dumb. The value holds the runner's pid and workers only trust it when that
 * pid is their parent's, so a copy inherited by a nested `playwright test` (piped or not) is ignored.
 */
export function markRunnerTty(
    env: Env = process.env,
    stdout: MaybeTTY | undefined = process.stdout,
    pid: number = process.pid,
    isatty: (fd: number) => boolean = tty.isatty,
): void {
  if (!isatty(1) || env.NO_COLOR || inCI(env) || env.TERM === 'dumb') return;
  if (isOff(env.FORCE_COLOR) || isOff(env.DEBUG_COLORS)) return;
  env[RUNNER_TTY_VAR] = `${pid}:${streamColorDepth(stdout) ?? 0}`;
}

/**
 * Whether the printed curl command is coloured under `curlFormat.colors: 'auto'`
 * (the further condition, that the resolved `colors` is on and the console is the
 * sink, is applied by resolveConfig()):
 *
 * - NO_COLOR (non-empty) always wins;
 * - never in CI, and never on TERM=dumb;
 * - only when the output really reaches a terminal: stdout is a TTY (not the fake that
 *   Playwright 1.30–1.39 puts on its piped workers), or the runner said its own stdout is one
 *   (markRunnerTty), or PLAYWRIGHT_FORCE_TTY (anything but empty, 0, false) says it is.
 *
 * FORCE_COLOR does not count: `playwright test` sets it for its workers, whose stdout is
 * a pipe.
 */
export function autoCurlColors(
    env: Env = process.env,
    stdout: MaybeTTY | undefined = process.stdout,
    ppid: number = process.ppid,
): boolean {
  if (env.NO_COLOR || inCI(env) || env.TERM === 'dumb') return false;
  return isRealTTY(stdout) || isOn(env.PLAYWRIGHT_FORCE_TTY) || runnerTty(env, ppid) !== undefined;
}

/**
 * How many colours the terminal behind the curl output shows: 8 (256 colours, which includes true
 * colour) when COLORTERM says truecolor/24bit, TERM names 256color, the runner reported 8 or more bits,
 * or the stream is a real terminal that reports so; else 4 (the 16 basic colours).
 */
export function curlColorDepth(
    env: Env = process.env,
    stdout: MaybeTTY | undefined = process.stdout,
    ppid: number = process.ppid,
): CurlColorDepth {
  const colorTerm = env.COLORTERM?.toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 8;
  if (/256color/i.test(env.TERM ?? '')) return 8;
  const bits = runnerTty(env, ppid)?.depth ?? streamColorDepth(stdout) ?? 0;
  return bits >= 8 ? 8 : 4;
}
