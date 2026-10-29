import type {Config, Plugin} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import npm2yarn from '@docusaurus/remark-plugin-npm2yarn';
import topicsPlugin from './plugins/topics';
import {lightTheme, darkTheme} from './src/prism-themes.mjs';

const REPO = 'https://github.com/ijad-org/playwright-logger-pro';

/** Bundle src/data/samples/*.ansi as plain strings. */
function ansiLoaderPlugin(): Plugin {
  return {
    name: 'plp-ansi-loader',
    configureWebpack: () => ({module: {rules: [{test: /\.ansi$/, type: 'asset/source'}]}}),
  };
}

const config: Config = {
  title: 'Playwright Logger Pro',
  tagline: 'Readable API and browser-action logs for your Playwright tests',
  favicon: 'img/favicon.svg',
  url: 'https://ijad-org.github.io',
  baseUrl: '/playwright-logger-pro/',
  organizationName: 'ijad-org',
  projectName: 'playwright-logger-pro',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  // Preview phase: set DOCS_NOINDEX=1 (repository variable) to keep search engines out. Remove at release.
  noIndex: process.env.DOCS_NOINDEX === '1',
  i18n: {defaultLocale: 'en', locales: ['en']},

  markdown: {
    // Plain .md files (the generated changelog) are CommonMark; .mdx files are MDX.
    format: 'detect',
    hooks: {onBrokenMarkdownLinks: 'throw'},
  },

  headTags: [
    {tagName: 'link', attributes: {rel: 'icon', href: '/playwright-logger-pro/img/favicon.ico', sizes: '32x32'}},
    {tagName: 'link', attributes: {rel: 'apple-touch-icon', href: '/playwright-logger-pro/img/apple-touch-icon.png'}},
    {tagName: 'link', attributes: {rel: 'manifest', href: '/playwright-logger-pro/site.webmanifest'}},
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: `${REPO}/edit/main/website/`,
          showLastUpdateTime: true,
          remarkPlugins: [[npm2yarn, {sync: true, converters: ['pnpm', 'yarn']}]],
        },
        blog: false,
        theme: {customCss: './src/css/custom.css'},
        sitemap: {changefreq: null, priority: null},
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    topicsPlugin,
    ansiLoaderPlugin,
    [
      'docusaurus-plugin-typedoc',
      {
        entryPoints: ['../src/index.ts', '../src/fixtures.ts'],
        tsconfig: './tsconfig.typedoc.json',
        out: 'docs/api',
        plugin: ['./plugins/typedoc-module-names.mjs'],
        readme: 'none',
        // "Defined in src/fixtures.ts" links to the file on the main branch ({path} is relative to src/). No line anchors: they drift with every edit.
        disableGit: true,
        sourceLinkTemplate: `${REPO}/blob/main/src/{path}`,
        name: 'API reference',
        entryFileName: 'index',
        hideBreadcrumbs: true,
        hidePageHeader: true,
        sidebar: {autoConfiguration: true, pretty: false},
        // Warnings are expected for the low-level helpers; the build must still succeed.
        validation: {notExported: false, invalidLink: false, notDocumented: false},
        logLevel: 'Warn',
      },
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: 'filename',
        indexDocs: true,
        indexPages: true,
        indexBlog: false,
        ignoreFiles: ['404'],
        docsRouteBasePath: '/docs',
        language: 'en',
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        searchResultLimits: 12,
        // Our SearchBar wrapper (src/theme/SearchBar) owns Ctrl/Cmd+K and "/".
        searchBarShortcut: false,
        searchBarShortcutHint: false,
      },
    ],
  ],

  themeConfig: {
    image: 'img/social-card.png',
    colorMode: {defaultMode: 'light', respectPrefersColorScheme: true, disableSwitch: false},
    // PREVIEW BANNER: delete this block when 0.2.0 is published (release PR).
    announcementBar: {
      id: 'preview-0-2-0',
      content:
        'Preview: these docs describe playwright-logger-pro 0.2.0, which is not published yet. 0.1.0 on npm has API logging only.',
      isCloseable: true,
    },
    navbar: {
      title: 'Playwright Logger Pro',
      logo: {alt: 'Playwright Logger Pro logo', src: 'img/logo.svg', srcDark: 'img/logo-dark.svg', width: 28, height: 28},
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {type: 'docSidebar', sidebarId: 'api', position: 'left', label: 'API'},
        {to: '/changelog', position: 'left', label: 'Changelog'},
        {href: REPO, position: 'right', className: 'header-icon-link header-github-link', 'aria-label': 'GitHub repository'},
        {
          href: 'https://www.npmjs.com/package/playwright-logger-pro',
          position: 'right',
          className: 'header-icon-link header-npm-link',
          'aria-label': 'npm package',
        },
      ],
    },
    docs: {sidebar: {hideable: true, autoCollapseCategories: false}},
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Getting started', to: '/docs/intro'},
            {label: 'Configuration', to: '/docs/configuration'},
            {label: 'API reference', to: '/docs/api'},
          ],
        },
        {
          title: 'Community',
          items: [
            {label: 'Issues', href: `${REPO}/issues`},
            {label: 'Security policy', href: `${REPO}/security/policy`},
          ],
        },
        {
          title: 'More',
          items: [
            {label: 'npm', href: 'https://www.npmjs.com/package/playwright-logger-pro'},
            {label: 'Changelog', to: '/changelog'},
            {label: 'GitHub', href: REPO},
          ],
        },
      ],
      copyright:
        '© 2026 Shahul Hameed M Y and contributors · MIT<br/>' +
        'Playwright Logger Pro is an independent open-source project. It is not affiliated with or endorsed by Microsoft or the Playwright project.',
    },
    prism: {
      // github / vsDark with the token colours below 4.5:1 contrast fixed (npm run check-prism).
      theme: lightTheme,
      darkTheme: darkTheme,
      additionalLanguages: ['bash', 'json', 'diff', 'powershell'],
    },
    tableOfContents: {minHeadingLevel: 2, maxHeadingLevel: 3},
  } satisfies Preset.ThemeConfig,
};

export default config;
