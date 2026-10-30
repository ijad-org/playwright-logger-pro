import * as path from 'node:path';

/**
 * Directory holding our compiled modules: `dist/` when installed or built,
 * `src/` when running from this repository. It is deliberately NOT the package
 * root, so the repo's own spec files are never treated as library frames.
 * (Relies on tsup's `shims` for `__dirname` in the ESM build.)
 */
export const LIB_DIR: string = path.resolve(__dirname) + path.sep;

/**
 * Every directory our frames can be reported under. With source maps (a local
 * build with them enabled, or a bundler that adds them) frames of `dist/` code
 * show up as `<package>/src/...`, so that sibling directory is covered too.
 */
export const LIB_DIRS: readonly string[] = path.basename(path.resolve(__dirname)) === 'dist' ?
  [LIB_DIR, path.resolve(__dirname, '..', 'src') + path.sep] :
  [LIB_DIR];
