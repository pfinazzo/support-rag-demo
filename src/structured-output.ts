/**
 * Why this file exists: every answer must have one fixed shape, because later
 * steps read its fields by name. This file defines that shape, checks any model
 * reply against it, and rejects a reply that does not match.
 * Without the check, a reply with a missing field or a wrong type would fail
 * later, far from the model call that caused it.
 */

/** The answer in the one shape the whole pipeline uses. */
export interface SupportResponse {
  answer: string;
  /** The documents the answer relies on. Only `sourceFile` is required. */
  citedSources: Array<{
    sourceFile: string;
    sectionTitle?: string;
    url?: string;
    excerpt?: string;
  }>;
  /** From 0 to 1. */
  confidence: number;
  /** The prompt guard's verdict on the question. */
  guardVerdict: 'clean' | 'contained' | 'blocked';
  /** The citation checker's verdict. `pending` means not checked yet. `unverified` means a person released it without a check. */
  citationVerdict: 'verified' | 'flagged' | 'pending' | 'unverified';
  /** Names of the tools the model called while answering. */
  toolsInvoked: string[];
  /** Id of the support ticket opened for this question. Null if none was opened. */
  escalationId: string | null;
}

/**
 * The same shape as `SupportResponse`, written as a JSON Schema.
 * Two jobs: the model is told this schema, and the validator takes its list of
 * allowed keys from it. It must be kept in step with `SupportResponse` by hand.
 */
export const SupportResponseJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'answer',
    'citedSources',
    'confidence',
    'guardVerdict',
    'citationVerdict',
    'toolsInvoked',
    'escalationId',
  ],
  properties: {
    answer: { type: 'string', minLength: 1 },
    citedSources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceFile'],
        properties: {
          sourceFile: { type: 'string', minLength: 1 },
          sectionTitle: { type: 'string' },
          url: { type: 'string' },
          excerpt: { type: 'string' },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    guardVerdict: { enum: ['clean', 'contained', 'blocked'] },
    citationVerdict: { enum: ['verified', 'flagged', 'pending', 'unverified'] },
    toolsInvoked: { type: 'array', items: { type: 'string' } },
    escalationId: { type: ['string', 'null'] },
  },
} as const;

/**
 * Thrown when a reply does not match the shape.
 * `errors` lists every problem, each with the path of the bad field.
 */
export class StructuredOutputError extends Error {
  readonly code = 'STRUCTURED_OUTPUT_REJECTED';

  readonly errors: Array<{ path: string; message: string }>;

  constructor({ errors }: { errors: Array<{ path: string; message: string }> }) {
    super(errors.map((e) => e.path + ': ' + e.message).join('; '));
    this.errors = errors;
  }
}

/**
 * Checks a model reply against the shape and returns it as a `SupportResponse`.
 * Accepts an object or a JSON string.
 * Throws `StructuredOutputError` if the text is not JSON, is not an object, or breaks any rule.
 * A missing field, an extra field and a wrong type each count as a rule.
 * It reports every broken rule at once, so a caller sees all problems in one error.
 */
export function validateStructuredOutput({ input }: { input: unknown }): SupportResponse {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new StructuredOutputError({ errors: [{ path: '$', message: 'Invalid JSON' }] });
    }
  }
  const errors: Array<{ path: string; message: string }> = [];
  const fail = ({ path, message }: { path: string; message: string }) =>
    errors.push({ path, message });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StructuredOutputError({ errors: [{ path: '$', message: 'Expected object' }] });
  const v = value as Record<string, unknown>;
  const allowed = Object.keys(SupportResponseJsonSchema.properties);
  for (const key of allowed)
    if (!Object.hasOwn(v, key)) fail({ path: '$.' + key, message: 'Required field missing' });
  for (const key of Object.keys(v))
    if (!allowed.includes(key)) fail({ path: '$.' + key, message: 'Unexpected key' });
  if (typeof v.answer !== 'string' || !v.answer.trim())
    fail({ path: '$.answer', message: 'Expected non-empty string' });
  if (
    typeof v.confidence !== 'number' ||
    !Number.isFinite(v.confidence) ||
    v.confidence < 0 ||
    v.confidence > 1
  )
    fail({ path: '$.confidence', message: 'Expected number in [0,1]' });
  for (const [key, values] of [
    ['guardVerdict', ['clean', 'contained', 'blocked']],
    ['citationVerdict', ['verified', 'flagged', 'pending', 'unverified']],
  ] as const)
    if (!values.includes(v[key] as never))
      fail({ path: '$.' + key, message: 'Invalid enum value' });
  if (v.escalationId !== null && typeof v.escalationId !== 'string')
    fail({ path: '$.escalationId', message: 'Expected string or null' });
  if (!Array.isArray(v.toolsInvoked) || v.toolsInvoked.some((x) => typeof x !== 'string'))
    fail({ path: '$.toolsInvoked', message: 'Expected string[]' });
  if (!Array.isArray(v.citedSources)) fail({ path: '$.citedSources', message: 'Expected array' });
  else
    v.citedSources.forEach((source, i) => {
      const path = '$.citedSources[' + i + ']';
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        fail({ path, message: 'Expected object' });
        return;
      }
      const s = source as Record<string, unknown>;
      if (typeof s.sourceFile !== 'string' || !s.sourceFile.trim())
        fail({ path: path + '.sourceFile', message: 'Expected non-empty string' });
      for (const k of Object.keys(s)) {
        if (!['sourceFile', 'sectionTitle', 'url', 'excerpt'].includes(k))
          fail({ path: path + '.' + k, message: 'Unexpected key' });
        else if (typeof s[k] !== 'string')
          fail({ path: path + '.' + k, message: 'Expected string' });
      }
    });
  if (errors.length) throw new StructuredOutputError({ errors });
  return v as unknown as SupportResponse;
}

/**
 * Reads the answer text from JSON that is still arriving.
 * Returns what has arrived so far, or an empty string if the answer has not started or cannot be read yet.
 * It trims a half-arrived escape such as `\u00` first. Without that, reading the text would fail on every chunk that ends mid-escape.
 * Used to show the answer on the page while the model is still writing it.
 */
export function partialAnswer({ json }: { json: string }): string {
  const m = /"answer"\s*:\s*"((?:\\.|[^"\\])*)/.exec(json);
  if (!m) return '';
  let raw = m[1];
  if (raw.endsWith('\\')) raw = raw.slice(0, -1);
  raw = raw.replace(/\\u[0-9a-f]{0,3}$/i, '');
  try {
    return JSON.parse('"' + raw + '"') as string;
  } catch {
    return '';
  }
}

type ResponseEnvelopeParams = {
  answer: string;
  sources?: SupportResponse['citedSources'];
  extra?: Partial<SupportResponse>;
};

/**
 * Wraps an answer in a complete, valid `SupportResponse`.
 * The defaults are confidence 0.82, a clean guard verdict, a pending citation check, no tools and no ticket.
 * Fields in `extra` replace the defaults.
 * Throws if the result is invalid, for example if `extra` holds a confidence above 1.
 */
export function responseEnvelope({
  answer,
  sources = [],
  extra = {},
}: ResponseEnvelopeParams): SupportResponse {
  return validateStructuredOutput({
    input: {
      answer,
      citedSources: sources,
      confidence: 0.82,
      guardVerdict: 'clean',
      citationVerdict: 'pending',
      toolsInvoked: [],
      escalationId: null,
      ...extra,
    },
  });
}
