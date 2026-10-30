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

interface MaybeTTY { isTTY?: boolean }

/**
 * Whether the printed curl command is coloured under `curlFormat.colors: 'auto'`
 * (the further condition, that the resolved `colors` is on and the console is the
 * sink, is applied by resolveConfig()):
 *
 * - NO_COLOR (non-empty) always wins;
 * - never in CI, and never on TERM=dumb;
 * - only when the output really reaches a terminal: stdout is a TTY, or
 *   PLAYWRIGHT_FORCE_TTY (anything but empty, 0, false) says the runner's terminal is one.
 *
 * FORCE_COLOR does not count: `playwright test` sets it for its workers, whose stdout is
 * a pipe. The workers get no other signal about the runner's terminal, so they stay plain
 * unless PLAYWRIGHT_FORCE_TTY is set.
 */
export function autoCurlColors(
    env: Env = process.env,
    stdout: MaybeTTY | undefined = process.stdout,
): boolean {
  if (env.NO_COLOR || inCI(env) || env.TERM === 'dumb') return false;
  return Boolean(stdout?.isTTY) || isOn(env.PLAYWRIGHT_FORCE_TTY);
}
