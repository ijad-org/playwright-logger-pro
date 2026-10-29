// The fixtures under test: ../src by default, ../dist with PLP_E2E_FROM=dist.
import type * as Src from '../src/fixtures';

/* eslint-disable @typescript-eslint/no-require-imports */
const mod = process.env.PLP_E2E_FROM === 'dist' ? require('../dist/fixtures.js') : require('../src/fixtures');
export const test = mod.test as typeof Src.test;
export const expect = mod.expect as typeof Src.expect;
export const lib = (process.env.PLP_E2E_FROM === 'dist' ? require('../dist/index.js') : require('../src/index')) as
  typeof import('../src/index');
export type { LoggerOptions } from '../src/fixtures';
