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

## Release and publishing policy

- npm releases are published from GitHub Actions by npm trusted publishing (OIDC) with provenance, in the `publish` job of the `Release` workflow only. No `NPM_TOKEN` or other npm secret may be added to this repository or its environments, and `id-token: write` is granted to that job only.
- A `vX.Y.Z` tag push from a commit on `main` verifies and packs the release, creates a draft GitHub release, publishes to npm and then publishes the GitHub release. Anyone who can push a `v*` tag can publish, so tag creation should be restricted to maintainers.
- If you find an npm publish token, or a publish path other than the `Release` workflow, in this repository, report it as described above.
