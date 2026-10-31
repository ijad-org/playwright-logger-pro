import React, {useState, type ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import TerminalOutput from '../components/TerminalOutput';
import HomepageFeatures from '../components/HomepageFeatures';
import styles from './index.module.css';

function InstallSnippet(): ReactNode {
  const command = 'npm i -D playwright-logger-pro';
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.install}>
      <code>
        <span aria-hidden="true">$ </span>
        {command}
      </code>
      <button
        type="button"
        className={styles.copy}
        aria-label="Copy install command"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title="Readable API and browser-action logs for Playwright" description={siteConfig.tagline}>
      <header className={styles.hero}>
        <div className={clsx('container', styles.heroInner)}>
          <div className={styles.heroText}>
            <h1 className={styles.title}>
              Playwright tests you can <span className={styles.accent}>read</span> when they fail
            </h1>
            <p className={styles.tagline}>
              Colourful API request logs with replayable curl, and a per-test browser timeline with secrets masked, quiet
              while tests pass and attached to the report when they fail.
            </p>
            <div className={styles.buttons}>
              <Link className="button button--primary button--lg" to="/docs/intro">
                Get started
              </Link>
              <Link className="button button--outline button--primary button--lg" href="https://github.com/ijad-org/playwright-logger-pro">
                View on GitHub
              </Link>
            </div>
            <InstallSnippet />
          </div>
          <div className={styles.heroTerminal}>
            <TerminalOutput sample="api-compact" title="npx playwright test · one line per call, detail where it failed" />
          </div>
        </div>
      </header>
      <main>
        <HomepageFeatures />
        <section className={clsx('container', styles.browserSection)} aria-labelledby="browser-sample">
          <h2 id="browser-sample">When a browser test fails, you get the timeline</h2>
          <p>
            One block, printed once and attached to the report as <code>browser-log</code>. Passwords stay <code>***</code>.
          </p>
          <TerminalOutput sample="browser-failure" title="login.spec.ts · failed" />
        </section>
        <section className={styles.strip} aria-label="Compatibility">
          <ul className="container">
            <li>Playwright ≥ 1.30</li>
            <li>Node ≥ 18</li>
            <li>CJS + ESM</li>
            <li>Chromium · Firefox · WebKit</li>
          </ul>
        </section>
      </main>
    </Layout>
  );
}
