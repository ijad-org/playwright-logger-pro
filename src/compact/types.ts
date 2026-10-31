/** What the response body of a call looked like; the text is already masked. */
export type BodyRecord =
  | { kind: 'empty' }
  | { kind: 'text'; text: string; truncated?: boolean }
  | { kind: 'binary'; bytes: number; type?: string };

/**
 * One API call as the fixture records it (worker process) and the reporter or the pure renderer
 * prints it. Everything in here is masked: this is what the JSON attachment holds.
 */
export interface CallRecord {
  method: string;
  /** The URL that was requested, query values masked. */
  url: string;
  /** Final URL when the request was redirected. */
  redirectedTo?: string;
  /** Absent for a network failure. */
  status?: number;
  statusText?: string;
  durationMs: number;
  /** A failure without a response: connection refused, timeout, abort... */
  error?: { code: string; message: string };
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: BodyRecord;
  /** The curl command as printed in the terminal: masked with `***`, long bodies cut with `…`. */
  curl?: string;
  /** Name of the attached script that replays the call (placeholders for the masked values). */
  curlFile?: string;
}

/** The JSON attachment of a test (`playwright-logger-pro.json`). */
export interface CallsAttachment {
  version: 1;
  /** Display options the fixture resolved; the reporter's own options win over them. */
  options?: Record<string, unknown>;
  calls: CallRecord[];
}

export const ATTACHMENT_NAME = 'playwright-logger-pro.json';

/** A call failed: status >= 400, or no response at all. */
export function isErrorCall(call: Pick<CallRecord, 'status' | 'error'>): boolean {
  return call.status === undefined || call.status >= 400;
}
