export const API = `http://127.0.0.1:${process.env.PLP_DEMO_API_PORT || 4310}`;
export const CDN = `http://127.0.0.1:${process.env.PLP_DEMO_CDN_PORT || 4311}`;

/** Pads a test to roughly the duration it is shown with in the docs. */
export const until = (startedAt: number, totalMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, totalMs - (Date.now() - startedAt))));
