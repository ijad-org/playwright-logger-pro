import apiCompact from './api-compact.ansi';
import apiPost from './api-post.ansi';
import apiFailure from './api-failure.ansi';
import apiRefused from './api-refused.ansi';
import apiRedaction from './api-redaction.ansi';
import browserFailure from './browser-failure.ansi';
import browserLive from './browser-live.ansi';

/** Real, coloured output of the library (regenerate with scripts/gen-doc-samples.mjs). */
export const samples = {
  'api-compact': apiCompact,
  'api-post': apiPost,
  'api-failure': apiFailure,
  'api-refused': apiRefused,
  'api-redaction': apiRedaction,
  'browser-failure': browserFailure,
  'browser-live': browserLive,
} as const;

export type SampleName = keyof typeof samples;
