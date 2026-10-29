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

## Reporting security issues

Privately, see [SECURITY.md](SECURITY.md).
