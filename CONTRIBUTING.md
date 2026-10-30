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

Maintainers only. **Nothing is ever published to npm from GitHub.** Do not add an `NPM_TOKEN` secret (to the repository or to any environment) or an npm trusted publisher (OIDC) for this repository, and do not add a publish job or a `workflow_dispatch` trigger to the `Release` workflow.

1. In a release PR, set the version in `package.json` and add the `## <version>` section to `CHANGELOG.md`. Merge it to `main`.
2. Push the tag `vX.Y.Z` from that commit. The `Release` workflow verifies it (lint, type-check, tests, build, pack, package checks), uploads the tarball as an artifact and creates a **draft** GitHub release with the tarball attached (a draft pre-release for a tag like `v0.2.0-rc.1`). That is all a tag push does.
3. Review the draft release. Publishing to npm needs LQA's GO and Abdul's explicit yes.
4. The maintainer publishes locally, from a clean checkout of the tag, with `npm publish --auth-type=web`. npm asks for web 2FA approval each time.
5. Publish the draft GitHub release.

## Reporting security issues

Privately, see [SECURITY.md](SECURITY.md).
