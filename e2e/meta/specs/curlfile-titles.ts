// Titles that must never reach curl.sh, its attachment or the notice (shared by the spec and its meta test).
export const TITLE_QUERY = 'title with /echo?token=CANARY1-QUERY&n=1';
export const VALUE_CANARY = 'PLP-VALUE-CANARY-9d2e';
export const TITLE_VALUE = `title with ${VALUE_CANARY} inside`;
export const TITLE_ESCAPES = 'title \u001b[31mred\u001b[0m \u001b]8;;https://evil.test/CANARY-OSC8\u001b\\link\u001b]8;;\u001b\\ ' +
  '\u001b]52;c;Q0FOQVJZ\u0007 end\nline2';
