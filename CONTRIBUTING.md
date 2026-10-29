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

Maintainers only. Nothing is published to npm by a tag push.

1. In a release PR, set the version in `package.json` and add the `## <version>` section to `CHANGELOG.md`. Merge it to `main`.
2. Push the tag `vX.Y.Z` from that commit. The `Release` workflow verifies it (lint, type-check, tests, build, pack, package checks). A pre-release tag (`v0.2.0-rc.1`) also creates a GitHub pre-release; a stable tag stops after verify.
3. To publish a stable version: **Actions -> Release -> Run workflow**. Under **Use workflow from**, pick the `vX.Y.Z` tag (**not `main`**), then enter the same tag in the `tag` input. The `npm-publish` environment only allows `v*` tag refs, so a run started from `main` is rejected, and the publish job fails if the selected ref is not the entered tag.
4. Approve the `npm-publish` environment when asked. The tarball is published with provenance and the GitHub Release is created.

## Reporting security issues

Privately, see [SECURITY.md](SECURITY.md).
