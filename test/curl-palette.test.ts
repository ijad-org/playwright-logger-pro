import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CURL_COLORS } from '../src/curlPalette';
import { BLACK, WHITE, contrast, curlContrastRows, xterm256Hex } from './helpers/contrast';

describe('xterm palette helpers', () => {
  test('the 256-colour palette: cube levels, greys and the 16 basic colours', () => {
    assert.equal(xterm256Hex(1), '#cd0000');
    assert.equal(xterm256Hex(12), '#5c5cff');
    assert.equal(xterm256Hex(16), '#000000');
    assert.equal(xterm256Hex(63), '#5f5fff');
    assert.equal(xterm256Hex(98), '#875fd7');
    assert.equal(xterm256Hex(231), '#ffffff');
    assert.equal(xterm256Hex(232), '#080808');
    assert.equal(xterm256Hex(243), '#767676');
    assert.equal(xterm256Hex(255), '#eeeeee');
    assert.throws(() => xterm256Hex(256));
  });

  test('WCAG ratios', () => {
    assert.equal(contrast(BLACK, WHITE), 21);
    assert.equal(contrast(WHITE, WHITE), 1);
    assert.ok(Math.abs(contrast('#767676', WHITE) - 4.54) < 0.01);
  });
});

describe('curl colour contrast on the default xterm black and white', () => {
  const rows = curlContrastRows();

  test('every element is covered for both palettes', () => {
    assert.equal(rows.length, Object.keys(CURL_COLORS).length * 2);
  });

  test('256 colours: every element reaches 4.5:1 on both backgrounds', () => {
    for (const row of rows.filter((r) => r.palette === '256')) {
      assert.ok(row.index >= 16 && row.index <= 255, `${row.element}: ${row.index}`);
      assert.ok(row.onBlack >= 4.5, `${row.element} ${row.hex} on black: ${row.onBlack.toFixed(2)}`);
      assert.ok(row.onWhite >= 4.5, `${row.element} ${row.hex} on white: ${row.onWhite.toFixed(2)}`);
    }
  });

  test('16 colours: every element reaches 3:1 on both backgrounds', () => {
    for (const row of rows.filter((r) => r.palette === '16')) {
      assert.ok(row.index >= 0 && row.index <= 15, `${row.element}: ${row.index}`);
      assert.ok(row.min >= 3, `${row.element} ${row.hex}: ${row.onBlack.toFixed(2)} on black, ${row.onWhite.toFixed(2)} on white`);
    }
  });
});
