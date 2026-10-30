import React, {type ReactNode} from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

const FEATURES: Array<{title: string; glyph: string; to: string; body: ReactNode}> = [
  {
    title: 'API logs and replayable curl',
    glyph: '→ ←',
    to: '/docs/api-logging',
    body: (
      <>
        Every <code>request.get/post/…</code> prints its request and response with timing, headers and bodies. Turn on{' '}
        <code>curl: &apos;on-failure&apos;</code> and get a command you can paste into a shell, including multipart, redirects and cookies.
      </>
    ),
  },
  {
    title: 'Browser action timeline',
    glyph: '▸ ✓',
    to: '/docs/browser-logging',
    body: (
      <>
        Clicks, fills, navigations, console messages, page errors, dialogs and <code>test.step</code> markers, each with a duration.
        Quiet while a test passes; printed and attached to the report when it fails.
      </>
    ),
  },
  {
    title: 'Secrets masked by default',
    glyph: '***',
    to: '/docs/redaction-security',
    body: (
      <>
        Authorization headers, cookies, token-like query parameters and password fields are masked, and so is anything you list
        in <code>redact.values</code>. Values you type into a sensitive field are learned for the rest of the test.
      </>
    ),
  },
];

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features} aria-label="Features">
      <div className="container">
        <div className={styles.grid}>
          {FEATURES.map((f) => (
            <article key={f.title} className={styles.card}>
              <span className={styles.glyph} aria-hidden="true">
                {f.glyph}
              </span>
              <h2 className={styles.cardTitle}>{f.title}</h2>
              <p>{f.body}</p>
              <Link to={f.to} className={styles.more}>
                Learn more<span className="sr-only"> about {f.title}</span> →
              </Link>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
