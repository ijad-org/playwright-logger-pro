import { test, expect } from '@playwright/test';
import { parseAnsi, stripAnsi, xterm256Hex } from '../src/components/TerminalOutput/ansi';

const ESC = '\u001b[';
const colorOf = (input: string) => parseAnsi(input).map((s) => s.style?.color);

test.describe('xterm 256-colour palette', () => {
  test('standard, cube and grey ranges', () => {
    expect(xterm256Hex(0)).toBe('#000000');
    expect(xterm256Hex(12)).toBe('#5c5cff');
    expect(xterm256Hex(15)).toBe('#ffffff');
    expect(xterm256Hex(16)).toBe('#000000');
    expect(xterm256Hex(231)).toBe('#ffffff');
    expect(xterm256Hex(232)).toBe('#080808');
    expect(xterm256Hex(255)).toBe('#eeeeee');
    expect(xterm256Hex(256)).toBeUndefined();
    expect(xterm256Hex(-1)).toBeUndefined();
  });

  test('the colours of the curl command (src/curlPalette.ts)', () => {
    expect(xterm256Hex(63)).toBe('#5f5fff'); // url, GET, keys
    expect(xterm256Hex(163)).toBe('#d700af'); // header and query names
    expect(xterm256Hex(29)).toBe('#00875f'); // POST, strings
    expect(xterm256Hex(98)).toBe('#875fd7'); // PUT, PATCH
    expect(xterm256Hex(131)).toBe('#af5f5f'); // DELETE
    expect(xterm256Hex(243)).toBe('#767676'); // comments
  });
});

test.describe('parseAnsi', () => {
  test('38;5;N sets the exact hex as an inline colour and 39 resets it', () => {
    const spans = parseAnsi(`${ESC}38;5;63mGET${ESC}39m rest`);
    expect(spans).toEqual([
      { text: 'GET', className: '', style: { color: '#5f5fff' } },
      { text: ' rest', className: '' },
    ]);
  });

  test('48;5;N and 49 set and clear the background', () => {
    const [on, off] = parseAnsi(`${ESC}48;5;29mA${ESC}49mB`);
    expect(on!.style).toEqual({ background: '#00875f' });
    expect(off!.style).toBeUndefined();
  });

  test('true colour', () => {
    expect(colorOf(`${ESC}38;2;1;2;255mx`)).toEqual(['#0102ff']);
    expect(parseAnsi(`${ESC}48;2;10;20;30mx`)[0]!.style).toEqual({ background: '#0a141e' });
  });

  test('a colour inside a combined sequence keeps the codes after it', () => {
    const [span] = parseAnsi(`${ESC}1;38;5;163;4mname`);
    expect(span).toEqual({ text: 'name', className: 'ansi-bold ansi-underline', style: { color: '#d700af' } });
  });

  test('malformed extended colours are ignored without eating text', () => {
    expect(parseAnsi(`${ESC}38;5;999mx`)).toEqual([{ text: 'x', className: '' }]);
    expect(parseAnsi(`${ESC}38;2;1;2mx`)).toEqual([{ text: 'x', className: '' }]);
  });

  test('bold + inverse (a mask) swaps the terminal default colours; 27 undoes it', () => {
    const [mask, after] = parseAnsi(`${ESC}1m${ESC}7m***${ESC}27m${ESC}22mnext`);
    expect(mask).toEqual({
      text: '***',
      className: 'ansi-bold',
      style: { color: 'var(--ansi-bg)', background: 'var(--ansi-fg)' },
    });
    expect(after).toEqual({ text: 'next', className: '' });
  });

  test('inverse swaps an explicit foreground into the background', () => {
    expect(parseAnsi(`${ESC}38;5;63;7mx`)[0]!.style).toEqual({ color: 'var(--ansi-bg)', background: '#5f5fff' });
  });

  test('bright 90-97 use the xterm bright colours; 30-37 use the panel variables', () => {
    expect(colorOf(`${ESC}94mx`)).toEqual(['#5c5cff']);
    expect(colorOf(`${ESC}90mx`)).toEqual(['#7f7f7f']);
    expect(colorOf(`${ESC}32mx`)).toEqual(['var(--ansi-green)']);
  });

  test('dim without a colour is a class; 0 and an empty sequence reset everything', () => {
    expect(parseAnsi(`${ESC}2mx${ESC}22my`)).toEqual([
      { text: 'x', className: 'ansi-dim' },
      { text: 'y', className: '' },
    ]);
    expect(parseAnsi(`${ESC}1;38;5;63mx${ESC}my`)[1]).toEqual({ text: 'y', className: '' });
  });

  test('a real curl line: no escape is left in the text, stripping gives the plain command', () => {
    const line = `${ESC}1mcurl${ESC}22m -X ${ESC}38;5;29mPOST${ESC}39m '${ESC}38;5;63mhttp://x/v${ESC}39m'`;
    const spans = parseAnsi(line);
    expect(spans.map((s) => s.text).join('')).toBe("curl -X POST 'http://x/v'");
    expect(stripAnsi(line)).toBe("curl -X POST 'http://x/v'");
    expect(spans.find((s) => s.text === 'POST')!.style).toEqual({ color: '#00875f' });
    expect(spans.find((s) => s.text === 'http://x/v')!.style).toEqual({ color: '#5f5fff' });
  });
});
