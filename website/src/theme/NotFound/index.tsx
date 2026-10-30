import React, {type ReactNode} from 'react';
import {PageMetadata} from '@docusaurus/theme-common';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import TerminalOutput from '../../components/TerminalOutput';

const NOT_FOUND =
  '\u001b[31m✖\u001b[39m \u001b[36mGET\u001b[39m /this/page \u001b[1m\u001b[31m404 Not Found\u001b[39m\u001b[22m \u001b[2m(0ms)\u001b[22m\n' +
  '  \u001b[2mhint:\u001b[22m the page moved, or the link is old. Search the docs or start from the beginning.';

/** On-brand 404 (swizzled: the theme renders this for every unknown URL and for 404.html). */
export default function NotFound(): ReactNode {
  return (
    <>
      <PageMetadata title="Page not found" />
      <Layout>
        <main className="container margin-vert--xl" style={{maxWidth: '44rem'}}>
          <h1>Page not found</h1>
          <p>We could not find what you were looking for.</p>
          <TerminalOutput ansi={NOT_FOUND} title="404" />
          <p>
            Press <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> on macOS) or <kbd>/</kbd> to search the docs, or go to{' '}
            <Link to="/docs/intro">Getting started</Link>.
          </p>
          <div className="margin-top--md" style={{display: 'flex', gap: '0.75rem', flexWrap: 'wrap'}}>
            <button
              type="button"
              className="button button--primary"
              onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', ctrlKey: true, bubbles: true}))}>
              Search the docs
            </button>
            <Link className="button button--outline button--primary" to="/docs/intro">
              Getting started
            </Link>
          </div>
        </main>
      </Layout>
    </>
  );
}
