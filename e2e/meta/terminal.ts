/**
 * A tiny terminal: feeds on the output of a program that rewrites lines in place (Playwright's
 * list reporter) and returns the screen it would show. Understands what that output uses:
 * printable text, \n, \r, CSI `n A` (up), `n E` (down, to column 0), `2K` (clear line), `n G`
 * (column), and ignores colours. No wrapping: runs are given a wide terminal.
 */
export function renderTerminal(output: string): string[] {
  const rows: string[][] = [[]];
  let row = 0;
  let col = 0;
  const line = (): string[] => {
    while (rows.length <= row) rows.push([]);
    return rows[row] as string[];
  };
  const put = (ch: string): void => {
    const cells = line();
    while (cells.length < col) cells.push(' ');
    cells[col++] = ch;
  };
  for (let i = 0; i < output.length; i++) {
    const ch = output[i] as string;
    if (ch === '\u001b' && output[i + 1] === '[') {
      // eslint-disable-next-line no-control-regex
      const match = /^\u001b\[([0-9;]*)([A-Za-z])/.exec(output.slice(i));
      if (!match) continue;
      i += match[0].length - 1;
      const n = Number((match[1] ?? '').split(';')[0] || 1);
      switch (match[2]) {
        case 'A': row = Math.max(0, row - n); break;
        case 'B': row += n; break;
        case 'E': row += n; col = 0; break;
        case 'G': col = Math.max(0, (Number(match[1] || 1)) - 1); break;
        case 'K': if (match[1] === '2') rows[row] = []; break;
        default: break; // colours and the like
      }
      continue;
    }
    if (ch === '\n') {
      row++;
      col = 0;
      line();
    } else if (ch === '\r') {
      col = 0;
    } else {
      put(ch);
    }
  }
  return rows.map((cells) => cells.join('').trimEnd());
}
