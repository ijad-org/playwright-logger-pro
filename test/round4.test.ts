/**
 * Regression tests for PCL-44 (browserLog, 0.2.0): camelCase-aware sensitive-field detection.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SENSITIVE_SELECTORS, matchesSensitiveSelector, splitSelectorTokens } from '../src/browser/sensitive';
import { BrowserLogSession } from '../src/browser/session';
import { getRegistry } from '../src/browser/registry';
import { resolveBrowserConfig } from '../src/browser/types';
import { FakeContext, FakePage } from './helpers/fakes';

const isSensitive = (s: string): boolean => matchesSensitiveSelector(s, DEFAULT_SENSITIVE_SELECTORS);

describe('PCL-44: tokens are split on camelCase, _ - and space', () => {
  test('splitSelectorTokens', () => {
    assert.equal(splitSelectorTokens('cardExpDate'), 'card Exp Date');
    assert.equal(splitSelectorTokens('panNumber'), 'pan Number');
    assert.equal(splitSelectorTokens('cardPAN'), 'card PAN');
    assert.equal(splitSelectorTokens('PANNumber'), 'PAN Number');
    assert.equal(splitSelectorTokens('exp_mm-yy'), 'exp mm yy');
    assert.equal(splitSelectorTokens('Japan'), 'Japan');
  });

  const positives = [
    // new
    '#cardExpDate', '#panNumber', '[name=cardPAN]', "getByPlaceholder('MM/YY')", "getByPlaceholder('MM/YYYY')",
    "getByLabel('Valid thru')", "getByLabel('Valid through')", 'MM/YY', 'MM/YYYY', 'Valid thru', 'Valid through',
    '#cardExpDate', 'panNumber', 'cardPAN', "getByLabel('validThru')",
    // existing
    '#expDate', '#cardExpiry', '#ExpDate', 'pan-number', 'Card PAN', '#expiryMonth', 'exp_mm', 'Expiry (MM/YY)', 'pan_no',
    '#ccExp', 'cc-exp', 'cc-exp-year', 'cc-csc',
  ];
  const negatives = [
    'company', 'panel', 'span', 'expires in', 'express', 'expand', 'pantry', 'Japan', 'Expense',
    '#company', "getByLabel('Company')", '.panel', '#span', "getByLabel('Expires in days')", '#expenses', '#companyPanel',
    '#spanNumber', '#mmmYY', "getByLabel('Valid for 30 days')",
  ];

  test('positives are sensitive', () => {
    for (const p of positives) assert.ok(isSensitive(p), p);
  });

  test('negatives stay clear', () => {
    for (const n of negatives) assert.ok(!isSensitive(n), n);
  });

  test('a value filled into a camelCase expiry field is masked in its action line', async () => {
    getRegistry().activeSession = null;
    const cfg = resolveBrowserConfig({ colors: false, print: false });
    const s = new BrowserLogSession(cfg, { title: 'round4.test.ts › case', project: 'unit' }, false);
    s.attachContext(new FakeContext());
    const page = new FakePage();
    s.attachPage(page);
    await page.fill('#cardExpDate', '12/2031');
    await page.locator('#panNumber').fill('4111111111111111');
    const lines = s.events().flatMap((e) => (e.kind === 'action' ? [e.method + ' ' + JSON.stringify(e.args)] : []));
    assert.ok(lines.length >= 2);
    assert.ok(lines.every((l) => !l.includes('12/2031') && !l.includes('4111111111111111')), lines.join('\n'));
  });
});
