import React, {useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import clsx from 'clsx';
import {useHistory, useLocation} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useIsBrowser from '@docusaurus/useIsBrowser';
import {usePluginData} from '@docusaurus/useGlobalData';
import type {Topic} from '../../../plugins/topics';
import {Mark, loadIndex, searchDocs, type SearchHit} from './searchEngine';
import styles from './styles.module.css';

const HIGHLIGHT_PARAM = '_highlight';
const FOCUSABLE = 'input:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

interface Item {
  id: string;
  href: string;
  label: ReactNode;
  detail?: string;
  group?: string;
  glyph: string;
  text: string;
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Wraps matches of `tokens` in <mark>. */
function highlight(text: string, tokens: string[]): ReactNode {
  const parts = tokens.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (parts.length === 0) return text;
  const re = new RegExp(`(${parts.join('|')})`, 'gi');
  return text.split(re).map((chunk, i) => (i % 2 === 1 ? <mark key={i}>{chunk}</mark> : chunk));
}

function SearchDialog({onClose, returnFocus}: {onClose: () => void; returnFocus: HTMLElement | null}): ReactNode {
  const history = useHistory();
  const baseUrl = useBaseUrl('/');
  const topics = (usePluginData('plp-topics') as {topics: Topic[]} | undefined)?.topics ?? [];
  const uid = useId();
  const listId = `${uid}-list`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [tokens, setTokens] = useState<string[]>([]);
  const [searched, setSearched] = useState('');

  useEffect(() => {
    inputRef.current?.focus();
    document.body.classList.add('plp-search-open');
    loadIndex(baseUrl).then(() => setState('ready'), () => setState('error'));
    return () => {
      document.body.classList.remove('plp-search-open');
      (returnFocus ?? document.body).focus?.();
    };
  }, [baseUrl, returnFocus]);

  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed || state !== 'ready') {
      setHits([]);
      setSearched('');
      return undefined;
    }
    let cancelled = false;
    searchDocs(baseUrl, trimmed).then((out) => {
      if (cancelled) return;
      setHits(out.hits);
      setTokens(out.tokens);
      setSearched(trimmed);
      setActive(0);
    }, () => !cancelled && setState('error'));
    return () => {
      cancelled = true;
    };
  }, [trimmed, state, baseUrl]);

  const items: Item[] = useMemo(() => {
    if (!trimmed) {
      return topics.map((t, i) => ({
        id: `${uid}-o${i}`,
        href: t.href,
        label: t.label,
        group: t.trail[0] ?? 'Getting started',
        glyph: '#',
        text: t.label,
      }));
    }
    return hits.map((h, i) => ({
      id: `${uid}-o${i}`,
      href: h.url,
      label:
        h.kind === 'heading' ? (
          <>
            {highlight(h.page, tokens)} <span className={styles.sep}>›</span> {highlight(h.heading ?? '', tokens)}
          </>
        ) : (
          highlight(h.page, tokens)
        ),
      detail: h.trail || undefined,
      glyph: h.kind === 'heading' ? '#' : '¶',
      text: h.kind === 'heading' ? `${h.page} › ${h.heading}` : h.page,
    }));
  }, [trimmed, topics, hits, tokens, uid]);

  const settled = !trimmed || searched === trimmed;
  const message = useMemo(() => {
    if (state === 'error') return 'Search is unavailable: the index could not be loaded.';
    if (!trimmed) return `${items.length} topics. Type to search pages and headings.`;
    if (!settled) return 'Searching…';
    return items.length === 0 ? `No results for ${trimmed}` : `${items.length} ${items.length === 1 ? 'result' : 'results'}`;
  }, [state, trimmed, settled, items.length]);

  const go = useCallback(
    (item: Item) => {
      let url = item.href;
      if (trimmed && tokens.length && Mark) {
        const [path, hash = ''] = url.split('#');
        const params = new URLSearchParams();
        tokens.forEach((t) => params.append(HIGHLIGHT_PARAM, t));
        url = `${path}?${params.toString()}${hash ? `#${hash}` : ''}`;
      }
      onClose();
      history.push(url);
    },
    [history, onClose, tokens, trimmed],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const n = items.length;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' && n) {
      event.preventDefault();
      setActive((i) => (i + 1) % n);
    } else if (event.key === 'ArrowUp' && n) {
      event.preventDefault();
      setActive((i) => (i - 1 + n) % n);
    } else if (event.key === 'Home' && n && event.target === inputRef.current && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'Enter' && event.target === inputRef.current && items[active]) {
      event.preventDefault();
      go(items[active]);
    } else if (event.key === 'Tab') {
      // Focus trap
      const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  useEffect(() => {
    document.getElementById(items[active]?.id ?? '')?.scrollIntoView?.({block: 'nearest'});
  }, [active, items]);

  const grouped = !trimmed;
  let lastGroup: string | undefined;

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Search the documentation"
        onKeyDown={onKeyDown}>
        <div className={styles.header}>
          <svg aria-hidden="true" className={styles.icon} viewBox="0 0 16 16" focusable="false">
            <path
              fill="currentColor"
              d="M6.02945 10.20327a4.17382 4.17382 0 1 1 4.17382-4.17382 4.15609 4.15609 0 0 1-4.17382 4.17382Zm9.69195 4.2199-4.8225-4.82338A5.88021 5.88021 0 0 0 12.058 6.02856 6.00467 6.00467 0 1 0 9.59979 10.8989l4.82338 4.82338a.89729.89729 0 0 0 1.29912 0 .89749.89749 0 0 0-.00087-1.29909Z"
            />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items[active]?.id}
            aria-autocomplete="list"
            aria-label="Search the documentation"
            placeholder="Search the docs"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close search">
            <kbd>Esc</kbd>
          </button>
        </div>
        <ul id={listId} role="listbox" aria-label={trimmed ? 'Search results' : 'Topics'} className={styles.list}>
          {items.map((item, i) => {
            const heading = grouped && item.group !== lastGroup ? item.group : undefined;
            lastGroup = item.group;
            return (
              <React.Fragment key={item.id}>
                {heading && (
                  <li role="presentation" className={styles.group}>
                    {heading}
                  </li>
                )}
                <li
                  id={item.id}
                  role="option"
                  aria-selected={i === active}
                  aria-label={item.text}
                  className={clsx(styles.item, i === active && styles.active)}
                  onMouseMove={() => i !== active && setActive(i)}>
                  <a
                    href={item.href}
                    tabIndex={-1}
                    className={styles.link}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      go(item);
                    }}>
                    <span className={styles.glyph} aria-hidden="true">
                      {item.glyph}
                    </span>
                    <span className={styles.label}>{item.label}</span>
                    {item.detail && <span className={styles.detail}>{item.detail}</span>}
                  </a>
                </li>
              </React.Fragment>
            );
          })}
        </ul>
        {settled && trimmed && items.length === 0 && state !== 'error' && (
          <p className={styles.empty}>No results for “{trimmed}”.</p>
        )}
        {state === 'error' && <p className={styles.empty}>{message}</p>}
        {process.env.NODE_ENV !== 'production' && (
          <p className={styles.empty}>Search results are only available in a production build (npm run build, npm run serve).</p>
        )}
        <div className={styles.footer} aria-hidden="true">
          <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span>
          <span><kbd>Enter</kbd> to open</span>
          <span><kbd>Esc</kbd> to close</span>
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {message}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Applies `?_highlight=` terms from a search result to the article, like the stock search bar. */
function useTargetHighlight(): void {
  const location = useLocation();
  useEffect(() => {
    const MarkJs = Mark;
    if (!MarkJs) return undefined;
    const keywords = new URLSearchParams(location.search).getAll(HIGHLIGHT_PARAM);
    const timer = setTimeout(() => {
      const root = document.querySelector('article');
      if (!root) return;
      const mark = new MarkJs(root);
      mark.unmark();
      if (keywords.length) mark.mark(keywords, {exclude: ['.theme-doc-toc-mobile > button']});
    });
    return () => clearTimeout(timer);
  }, [location.pathname, location.search]);
}

export default function SearchBar(): ReactNode {
  const isBrowser = useIsBrowser();
  const [open, setOpen] = useState(false);
  const [mac, setMac] = useState(false);
  const [ready, setReady] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  useTargetHighlight();

  useEffect(() => {
    setMac(isMac());
    setReady(true); // the shortcuts work from here on
  }, []);

  const show = useCallback(() => {
    returnTo.current = (document.activeElement as HTMLElement | null) ?? triggerRef.current;
    setOpen(true);
  }, []);
  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const k = event.key.toLowerCase();
      if (k === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        setOpen((o) => {
          if (!o) returnTo.current = (document.activeElement as HTMLElement | null) ?? triggerRef.current;
          return !o;
        });
      } else if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditable(event.target)) {
        event.preventDefault();
        show();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [show]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-label="Search"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="Control+K Meta+K"
        data-ready={ready}
        onClick={show}>
        <svg aria-hidden="true" className={styles.icon} viewBox="0 0 16 16" focusable="false">
          <path
            fill="currentColor"
            d="M6.02945 10.20327a4.17382 4.17382 0 1 1 4.17382-4.17382 4.15609 4.15609 0 0 1-4.17382 4.17382Zm9.69195 4.2199-4.8225-4.82338A5.88021 5.88021 0 0 0 12.058 6.02856 6.00467 6.00467 0 1 0 9.59979 10.8989l4.82338 4.82338a.89729.89729 0 0 0 1.29912 0 .89749.89749 0 0 0-.00087-1.29909Z"
          />
        </svg>
        <span className={styles.triggerText}>Search</span>
        <kbd className={styles.chip} aria-hidden="true">
          {mac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      {isBrowser && open && <SearchDialog onClose={hide} returnFocus={returnTo.current} />}
    </>
  );
}
