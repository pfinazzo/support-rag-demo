/**
 * Why this file exists: after the LLM answers, our server must check that its
 * citations are real. This file fetches each cited page, then tests the
 * answer's claims and quotes against the text it got back. It trusts the
 * fetched page, never the source name the LLM claimed. Without it, an answer
 * could cite a page that is missing or says something different.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { inferNli, lexicalCosine, NLI_MODEL_ID, type NliResult } from './nli-model.js';

/** A source the LLM cited, before its page has been fetched. */
export interface CitationSource {
  sourceFile?: string;
  headingPath?: string;
  url?: string;
}

/** Result of fetching one cited URL. */
export interface UrlResult {
  url: string;
  valid: boolean;
  status: number | null;
  error: string | null;
  latencyMs: number;
  pageChars: number;
}

/** The NLI model's verdict on one claim, with the page sentence it was tested against. */
export interface ClaimResult extends NliResult {
  claim: string;
  premise: string;
  lexicalSimilarity: number;
}

/** Whether one quoted passage appears in the fetched page. */
export interface QuoteResult {
  quote: string;
  normalizedQuote: string;
  found: boolean;
}

/** All three checks for one cited source. */
export interface CitationRow {
  id: string;
  sourceFile: string;
  urlCheck: UrlResult;
  entailmentCheck: { passed: boolean; claims: ClaimResult[]; modelId: string; skipped?: string };
  quoteCheck: { passed: boolean; quotes: QuoteResult[]; skipped?: string };
}

/**
 * The full citation check for one answer.
 * Status is verified, flagged, or unverified when there were no sources.
 */
export interface CitationReport {
  checkedAt: string;
  status: 'verified' | 'flagged' | 'unverified';
  rows: CitationRow[];
  urlCheck: { passed: boolean; checked: number; valid: number };
  entailmentCheck: { passed: boolean; checked: number; supported: number; modelId: string };
  quoteCheck: { passed: boolean; checked: number; found: number };
  ignoredConfigUrls: string[];
  omittedClaims: number;
  latencyMs: number;
}

/** One progress message sent to the page as a check starts or finishes. */
export interface CitationEvent {
  citationIndex: number;
  sourceFile: string;
  step: number;
  check: string;
  phase: 'checking' | 'done';
  result?: unknown;
}

/** Lowercases text and collapses whitespace, so line breaks and case do not hide a match. */
export const normalizeQuote = ({ text }: { text: string }) =>
  text.toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * Returns the quoted passages in the answer that are long enough to check.
 * A quote needs at least four words or 15 characters.
 * Skipping tiny quotes stops scare quotes around single words from failing the check.
 */
export function extractQuotes({ answer }: { answer: string }): string[] {
  return [...answer.replace(/[“”]/g, '"').matchAll(/"([^"\n]*(?:\n[^"\n]*)*)"/g)]
    .map((m) => m[1])
    .filter((q) => q.trim().split(/\s+/).length >= 4 || q.trim().length >= 15);
}

/**
 * Tests each quote in the answer against the fetched page text.
 * A quote counts as found only if it appears word for word after normalizing.
 */
export function checkQuotes({
  answer,
  fetchedPageText,
}: {
  answer: string;
  fetchedPageText: string;
}): QuoteResult[] {
  const page = normalizeQuote({ text: fetchedPageText });
  return extractQuotes({ answer }).map((quote) => ({
    quote,
    normalizedQuote: normalizeQuote({ text: quote }),
    found: page.includes(normalizeQuote({ text: quote })),
  }));
}

/**
 * Builds the URL of a source file's page on our own docs route.
 * The heading path becomes the link anchor.
 * If the source has no file name: uses a placeholder name that will fail the URL check.
 */
export function sourceDocUrl({
  baseUrl,
  source,
}: {
  baseUrl: string;
  source: CitationSource;
}): string {
  return new URL(
    '/docs/' +
      encodeURIComponent(source.sourceFile || 'missing-source.md') +
      '#' +
      (source.headingPath || '')
        .toLowerCase()
        .replace(/[^a-z0-9_ -]/g, '')
        .trim()
        .replace(/\s+/g, '-'),
    baseUrl,
  ).href;
}

/**
 * True if the address is loopback, private, or link-local.
 * Covers IPv4 and IPv6.
 */
function privateAddress({ address }: { address: string }): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  return (
    /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(a) ||
    a === '::1' ||
    /^(?:f[cd][a-f0-9]{2}:|fe[89ab][a-f0-9]:)/.test(a)
  );
}

/**
 * Throws if our server should not fetch this URL.
 * Only credential-free HTTPS is allowed, plus our own docs route.
 * A host that resolves to a private address is refused.
 * Without this, an answer could make our server probe machines on our internal network.
 */
async function validateDestination({ url, base }: { url: URL; base: URL }): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only credential-free HTTP(S) citation URLs are permitted');
  if (url.origin === base.origin && url.pathname.startsWith('/docs/')) return;
  if (url.hostname.endsWith('.invalid')) return;
  if (url.protocol !== 'https:')
    throw new Error('External citations must use HTTPS; private service probes are not permitted');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((a) => privateAddress({ address: a.address })))
    throw new Error('Private-network citation destination is not permitted');
}

/**
 * Fetches one cited URL and returns its status, timing and page text.
 * Sends an HTTP request from our server.
 * Never throws: any failure comes back as a result with valid set to false and an error message.
 * Fails after 2.5 seconds, on a redirect, on a non-text page, or past 160 KB.
 * A redirect is refused because its target has not been validated.
 * HTML is stripped to plain text. Markdown is left as is.
 * Without the limits, a slow or huge page could hang the check or fill memory.
 */
export async function fetchCitation({
  url,
  baseUrl,
}: {
  url: string;
  baseUrl: string;
}): Promise<UrlResult & { pageText: string }> {
  const start = performance.now();
  let status: number | null = null;
  /** Aborts the request after 2.5 seconds. */
  const timeout = AbortSignal.timeout(2500);
  try {
    let target = new URL(url, baseUrl);
    await validateDestination({ url: target, base: new URL(baseUrl) });
    const response = await fetch(target, {
      signal: timeout,
      redirect: 'manual',
      headers: { Accept: 'text/plain,text/html,text/markdown' },
    });
    status = response.status;
    if (response.status >= 300 && response.status < 400)
      throw new Error('Redirect requires a separately validated cited URL');
    const type = response.headers.get('content-type') || '';
    if (response.ok && !/text|json|xml|markdown/i.test(type))
      throw new Error('Citation did not return readable page text');
    const reader = response.body?.getReader();
    let bytes = 0,
      pageText = '';
    /** Reads the page as a stream so that the size limit can stop it early. */
    const decoder = new TextDecoder();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 160000) {
          await reader.cancel();
          throw new Error('Citation page exceeds 160 KB safety limit');
        }
        pageText += decoder.decode(value, { stream: true });
      }
      pageText += decoder.decode();
    }
    if (/text\/html/i.test(type))
      pageText = pageText
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    return {
      url,
      valid: response.ok,
      status,
      error: response.ok ? null : `HTTP ${status}`,
      latencyMs: performance.now() - start,
      pageChars: pageText.length,
      pageText: response.ok ? pageText : '',
    };
  } catch (e) {
    const cause = (e as Error & { cause?: { code?: string } }).cause;
    return {
      url,
      valid: false,
      status,
      error: (e as Error).message + (cause?.code ? ' · ' + cause.code : ''),
      latencyMs: performance.now() - start,
      pageChars: 0,
      pageText: '',
    };
  }
}

/**
 * Splits the answer into sentences that make factual claims.
 * Drops quoted passages, link text, list markers, and sentences under five words.
 * Drops lead-in lines such as "Sources:".
 * Quotes are checked separately, so they stay out of this list.
 */
export function extractClaims({ answer }: { answer: string }): string[] {
  return answer
    .replace(/[“”]/g, '"')
    .replace(/"[^"\n]*(?:\n[^"\n]*)*"/g, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) =>
      s
        .replace(/^\s*(?:[-*]|\d+[.)])\s*/, '')
        .replace(/\*\*|`/g, '')
        .trim(),
    )
    .filter(
      (s) =>
        s.split(/\s+/).length >= 5 &&
        !/^(?:the policy states|sources?:|according to the policy:?\s*$)/i.test(s),
    );
}

/**
 * Picks the page sentence closest to the claim, cut to 1,800 characters.
 * The NLI model reads only a short passage, so it needs the most relevant one.
 * If the page has no sentence over 20 characters: uses the start of the page.
 */
function bestPremise({ page, claim }: { page: string; claim: string }): string {
  const sentences = page
    .replace(/\*\*|`/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
  return (
    sentences
      .sort((a, b) => lexicalCosine({ a: b, b: claim }) - lexicalCosine({ a, b: claim }))[0]
      ?.slice(0, 1800) || page.slice(0, 1800)
  );
}

type CheckCitationsParams = {
  answer: string;
  sources: CitationSource[];
  options: {
    baseUrl: string;
    forceRealNli?: boolean;
    onStep?: ({ event }: { event: CitationEvent }) => void | Promise<void>;
  };
};

type EmitParams = { step: number; check: string; phase: 'checking' | 'done'; result?: unknown };

/**
 * Runs the URL, entailment and quote checks on every cited source.
 * Fetches each page and runs the NLI model, so it can be slow.
 * Checks at most 12 sources and 24 claims. Anything over that makes the status flagged.
 * Every claim and every quote must be supported by at least one source to pass.
 * A URL in code ticks on the example cloud domain is a config sample, so it is ignored.
 * Without these checks, a wrong or invented citation would look verified.
 */
export async function checkCitations({
  answer,
  sources,
  options,
}: CheckCitationsParams): Promise<CitationReport> {
  const start = performance.now(),
    ignoredConfigUrls: string[] = [];
  const refs = new Map<string, CitationSource>();
  for (const source of sources) {
    const url = source.url || sourceDocUrl({ baseUrl: options.baseUrl, source });
    refs.set(url, { ...source, url });
  }
  const codeUrls = new Set(
    [...answer.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1].match(/https?:\/\/[^\s<>"`)]+/g) || []),
  );
  for (const match of answer.matchAll(/https?:\/\/[^\s<>"`\])]+/g)) {
    const raw = match[0].replace(/[.,;!?]+$/, '');
    try {
      const url = new URL(raw);
      if (codeUrls.has(raw) && url.hostname.endsWith('.examplecloud.example')) {
        ignoredConfigUrls.push(raw);
        continue;
      }
      refs.set(url.href, { sourceFile: 'Answer hyperlink', url: url.href });
    } catch {
      /** A malformed link in the answer is skipped, so it is never reported as a verified citation. */
    }
  }
  const allClaims = extractClaims({ answer }),
    claims = allClaims.slice(0, 24),
    rows: CitationRow[] = [];
  let index = 0;
  for (const [url, source] of [...refs].slice(0, 12)) {
    const citationIndex = ++index,
      sourceFile = source.sourceFile || 'Cited page';
    /** Reports progress for this source to the page, if it is listening. */
    const emit = ({ step, check, phase, result }: EmitParams) =>
      options.onStep?.({ event: { citationIndex, sourceFile, step, check, phase, result } });
    await emit({ step: 1, check: 'urlCheck', phase: 'checking' });
    const fetched = await fetchCitation({ url, baseUrl: options.baseUrl });
    const { pageText, ...urlCheck } = fetched;
    await emit({ step: 1, check: 'urlCheck', phase: 'done', result: urlCheck });
    await emit({ step: 2, check: 'entailmentCheck', phase: 'checking' });
    const results: ClaimResult[] = [];
    if (fetched.valid)
      for (const claim of claims) {
        const premise = bestPremise({ page: pageText, claim });
        const result = await inferNli({
          premise,
          hypothesis: claim,
          opts: { forceReal: options.forceRealNli },
        });
        results.push({
          ...result,
          claim,
          premise,
          lexicalSimilarity: lexicalCosine({ a: premise, b: claim }),
        });
      }
    const entailmentCheck = {
      passed: fetched.valid && results.length > 0 && results.every((r) => r.supported),
      claims: results,
      modelId: NLI_MODEL_ID,
      ...(!fetched.valid
        ? { skipped: 'No fetched source text — URL check failed' }
        : !claims.length
          ? { skipped: 'No unquoted factual claim; direct quotes are verified in Step 3' }
          : {}),
    };
    await emit({ step: 2, check: 'entailmentCheck', phase: 'done', result: entailmentCheck });
    await emit({ step: 3, check: 'quoteCheck', phase: 'checking' });
    const quotes = fetched.valid
      ? checkQuotes({ answer, fetchedPageText: pageText })
      : extractQuotes({ answer }).map((quote) => ({
          quote,
          normalizedQuote: normalizeQuote({ text: quote }),
          found: false,
        }));
    const quoteCheck = {
      passed: fetched.valid && quotes.every((q) => q.found),
      quotes,
      ...(!fetched.valid ? { skipped: 'Source unavailable — quotes cannot be verified' } : {}),
    };
    await emit({ step: 3, check: 'quoteCheck', phase: 'done', result: quoteCheck });
    rows.push({ id: String(citationIndex), sourceFile, urlCheck, entailmentCheck, quoteCheck });
  }
  const urlResults = rows.map((r) => r.urlCheck),
    nli = rows.flatMap((r) => r.entailmentCheck.claims),
    quotes = rows.flatMap((r) => r.quoteCheck.quotes);
  const urlPassed = rows.length > 0 && urlResults.every((r) => r.valid),
    entailPassed =
      rows.length > 0 &&
      claims.length > 0 &&
      claims.every((claim) =>
        rows.some((r) => r.entailmentCheck.claims.some((c) => c.claim === claim && c.supported)),
      ),
    quotePassed =
      rows.length > 0 &&
      extractQuotes({ answer }).every((quote) =>
        rows.some((r) => r.quoteCheck.quotes.some((q) => q.quote === quote && q.found)),
      );
  return {
    checkedAt: new Date().toISOString(),
    status: !rows.length
      ? 'unverified'
      : urlPassed && entailPassed && quotePassed && allClaims.length <= 24 && refs.size <= 12
        ? 'verified'
        : 'flagged',
    rows,
    urlCheck: {
      passed: urlPassed,
      checked: urlResults.length,
      valid: urlResults.filter((r) => r.valid).length,
    },
    entailmentCheck: {
      passed: entailPassed,
      checked: nli.length,
      supported: nli.filter((r) => r.supported).length,
      modelId: NLI_MODEL_ID,
    },
    quoteCheck: {
      passed: quotePassed,
      checked: quotes.length,
      found: quotes.filter((q) => q.found).length,
    },
    ignoredConfigUrls,
    omittedClaims: Math.max(0, allClaims.length - 24),
    latencyMs: performance.now() - start,
  };
}

/**
 * Builds a made-up answer and sources that fail one named check.
 * Each kind builds a different answer: a broken URL, a claim, or a quoted sentence.
 * Any unknown kind gets the quoted-sentence answer with curly quotes.
 * The demo uses these to show how each failure appears in the report.
 */
export function citationSimulation({ kind, baseUrl }: { kind: string; baseUrl: string }): {
  answer: string;
  sources: CitationSource[];
} {
  const source = {
    sourceFile: 'billing-and-refunds.md',
    url: sourceDocUrl({
      baseUrl,
      source: { sourceFile: 'billing-and-refunds.md', headingPath: 'Refund Policy' },
    }),
  };
  /** A claim that the refund page supports, used as the passing part of each simulated answer. */
  const supported =
    'Approved refunds appear on the original payment method within 5 to 10 business days.';
  if (kind === 'broken-url')
    return {
      answer: supported,
      sources: [{ ...source, url: new URL('/docs/legacy-refund-policy-v1.md', baseUrl).href }],
    };
  if (kind === 'negation')
    return { answer: 'Partial refunds are offered for unused seats.', sources: [source] };
  if (kind === 'quote')
    return {
      answer:
        supported +
        ' The policy states: "unused seats receive automatic pro-rata credits within 24 hours"',
      sources: [source],
    };
  return {
    answer:
      supported +
      ' The policy states: “WORKSPACES stay in a 7-day grace period after the first ERR_PAYMENT_402 before features are restricted.”',
    sources: [source],
  };
}
