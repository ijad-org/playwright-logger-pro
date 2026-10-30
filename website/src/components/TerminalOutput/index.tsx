import React, {useState, type ReactNode} from 'react';
import clsx from 'clsx';
import {parseAnsi, stripAnsi} from './ansi';
import {samples, type SampleName} from '../../data/samples';
import styles from './styles.module.css';

interface Props {
  /** Name of a generated sample (src/data/samples/<name>.ansi). */
  sample?: SampleName;
  /** Raw ANSI text, instead of a sample. */
  ansi?: string;
  /** Window title, for example the command that produced the output. */
  title?: string;
  className?: string;
}

/**
 * Terminal window showing real, coloured library output. The colours come from CSS variables
 * (--ansi-*) that meet AA contrast in both themes; glyphs and status text carry the meaning too.
 */
export default function TerminalOutput({sample, ansi, title, className}: Props): ReactNode {
  const source = (sample ? samples[sample] : ansi) ?? '';
  const text = source.replace(/\n$/, '');
  const plain = stripAnsi(text);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(plain).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <figure className={clsx(styles.terminal, className)}>
      <figcaption className={styles.bar}>
        <span className={styles.dots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={styles.title}>{title ?? 'Terminal output'}</span>
        <button type="button" className={styles.copy} onClick={copy} aria-label="Copy output as plain text">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre className={styles.pre} tabIndex={0} aria-label={title ?? 'Terminal output'}>
        <code>
          {parseAnsi(text).map((span, i) =>
            span.className ? (
              <span key={i} className={span.className}>
                {span.text}
              </span>
            ) : (
              span.text
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}
