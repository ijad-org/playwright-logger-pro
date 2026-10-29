# Security policy

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's private vulnerability reporting:

<https://github.com/ijad-org/playwright-logger-pro/security/advisories/new>

Do not open a public issue for a vulnerability. Include the version of `playwright-logger-pro` and `@playwright/test`, what you expected and what happened, and a minimal reproduction if you can. You will get a first answer within a few days.

## What counts

Examples: a secret that this library should mask but prints (headers, query parameters, typed values, cookies), terminal escape sequences from a response or page reaching the log, or the package doing something other than logging.

Known limits are documented and are not vulnerabilities: Playwright's own artifacts (HTML report step titles, `error-context.md`, traces, screenshots, videos) are not redacted by this library. See [Redaction & security](https://ijad-org.github.io/playwright-logger-pro/docs/redaction-security).

## Supported versions

Only the latest release receives fixes.
