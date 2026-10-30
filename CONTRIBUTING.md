# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Development

Requires Node.js >= 18. The commands below use `npm`; CI installs with the pnpm lockfile (`pnpm-lock.yaml`), so if you add or change a dependency, update that lockfile with `pnpm install` as well.

```sh
npm install              # or: pnpm install --frozen-lockfile
npm run typecheck        # tsc --noEmit
npm run lint             # eslint, no warnings allowed
npm test                 # unit tests (tsx --test)
npm run build            # tsup -> dist/
npm run smoke            # CJS and ESM smoke tests of dist/
npm run test:e2e         # browser tests (needs Chromium: npx playwright install chromium)
```

`npm run check:pkg` runs `publint` and `@arethetypeswrong/cli` on the packed package.

## Documentation site

The site lives in `website/` (Docusaurus, its own `package.json` and `package-lock.json`; it is not part of the published package):

```sh
cd website
npm ci
npm run build   # syncs the changelog, checks the config docs, generates the API reference, builds
npm run serve   # serve the build (search only works in a build, not in `npm start`)
```

Every option in `website/docs/configuration.mdx` is checked against the library (`npm run check-config`, run `npm run build` in the repository root first). When you add an option, add it to that page.

## Pull requests

- Keep changes focused, and add a test for behaviour changes.
- Update `CHANGELOG.md` for user-visible changes (plain language; mark behaviour changes in **bold**).
- Never put real secrets in tests or docs. Use obvious canaries.

## Releasing

Maintainers only. A `vX.Y.Z` tag push verifies, packs and publishes to npm (with provenance) through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (GitHub Actions OIDC). There is no `NPM_TOKEN` secret and no npm secret anywhere; do not add one. `id-token: write` is granted to the `publish` job of the `Release` workflow only.

1. In a release PR, set the version in `package.json` and add the `## <version>` section to `CHANGELOG.md` (`## 0.4.0` or `## [0.4.0] - 2026-01-12`). Merge it to `main`.
2. From that commit on `main`, push an annotated tag: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`. A pre-release uses a `-` suffix, for example `v0.4.0-rc.1`.
3. The `Release` workflow then runs without further input:
   - `verify`: the tag must match the `package.json` version, the commit must be on `main` and `CHANGELOG.md` must have the section (a pre-release may omit it). Then lint, type-check, tests, build, smoke tests, package checks and `pnpm pack`. The tarball is uploaded as a run artifact.
   - `github-release`: creates a **draft** GitHub release with the tarball attached.
   - `publish`: downloads the verified tarball, checks its SHA-256 against the asset on the draft release, runs `npm publish --provenance --access public` and then publishes the GitHub release, marked **Latest**. A pre-release (version contains `-`) is published to npm with `--tag next` and stays a pre-release, never Latest. If that version is already on npm, the npm step is skipped with a notice and the release is still published, so a failed run can be repaired by re-running the `publish` job.

**Anyone who can push a `v*` tag to this repository can publish a release to npm.** There is no manual approval step and no GitHub environment. Restrict tag creation (for example with a tag ruleset) to the people who may release.

### One-time trusted publisher setup

On npmjs.com, open the package's **Settings > Trusted publisher** and choose GitHub Actions with:

| Field | Value |
| --- | --- |
| Organization or user | `ijad-org` |
| Repository | `playwright-logger-pro` |
| Workflow filename | `release.yml` |
| Environment name | leave blank |

These must match the workflow exactly, and the `repository` field in `package.json` must point to the same GitHub repository (npm checks it for provenance). Trusted publishing needs npm 11.5.1 or newer; the workflow installs it.

## Reporting security issues

Privately, see [SECURITY.md](SECURITY.md).
