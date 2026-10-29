/** One part of a multipart/form-data body, normalised for logging and curl. */
export type MultipartPart =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; mimeType?: string; size?: number; path?: string };

interface FilePayloadLike {
  name: string;
  mimeType?: string;
  buffer: Buffer;
}

interface BlobLike {
  name?: string;
  type?: string;
  size?: number;
}

function isFilePayload(value: unknown): value is FilePayloadLike {
  return typeof value === 'object' && value !== null &&
    typeof (value as FilePayloadLike).name === 'string' &&
    Buffer.isBuffer((value as FilePayloadLike).buffer);
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

function toPart(name: string, value: unknown): MultipartPart {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'field', name, value: String(value) };
  }
  if (isFilePayload(value)) {
    return {
      kind: 'file',
      name,
      filename: value.name,
      mimeType: value.mimeType,
      size: value.buffer.length,
    };
  }
  // fs.ReadStream
  const path = (value as { path?: unknown } | null)?.path;
  if (typeof path === 'string' || Buffer.isBuffer(path)) {
    const p = String(path);
    return { kind: 'file', name, filename: p.split(/[\\/]/).pop() || p, path: p };
  }
  // File / Blob from FormData
  const blob = (value ?? {}) as BlobLike;
  return {
    kind: 'file',
    name,
    filename: blob.name || 'blob',
    mimeType: blob.type || undefined,
    size: blob.size,
  };
}

/**
 * Normalise Playwright's `multipart` option (a plain object or a FormData)
 * into a list of parts. Returns undefined when there is no multipart body.
 */
export function multipartParts(multipart: unknown): MultipartPart[] | undefined {
  if (multipart === undefined || multipart === null) return undefined;
  if (isFormData(multipart)) {
    return [...multipart.entries()].map(([name, value]) => toPart(name, value));
  }
  if (typeof multipart !== 'object') return undefined;
  return Object.entries(multipart as Record<string, unknown>)
      .map(([name, value]) => toPart(name, value));
}

/** Human-readable summary of a multipart body, one part per line. */
export function describeMultipart(multipart: unknown): string | undefined {
  const parts = multipartParts(multipart);
  if (!parts) return undefined;
  const lines = parts.map((part) => {
    if (part.kind === 'field') return `${part.name}: ${part.value}`;
    const details = [part.mimeType, part.size !== undefined ? `${part.size} bytes` : undefined]
        .filter(Boolean)
        .join(', ');
    return `${part.name}: <file ${part.filename}${details ? ` (${details})` : ''}>`;
  });
  return ['<multipart/form-data>', ...lines].join('\n');
}
