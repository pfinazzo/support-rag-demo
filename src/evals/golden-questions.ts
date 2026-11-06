/**
 * Why this file exists: a fixed set of questions whose right answers we already
 * know. The golden evaluation asks each one and marks the answer as drifted if a
 * required fact or source is missing. Without a fixed set, a change to a prompt
 * or a model could make answers worse and nobody would see it.
 */

/** One question with a known good answer. */
export interface GoldenQuestion {
  /** Made from the row's position, such as GQ-01. */
  id: string;
  question: string;
  /** A known good answer. The LLM judge compares the real answer with it. */
  expectedAnswer: string;
  /**
   * Facts the answer must contain. Matching ignores capital letters.
   * A plain string must appear. A list of strings means any one of them is enough.
   */
  requiredKeywords: Array<string | string[]>;
  /** Source files the answer must cite. */
  requiredSources: string[];
  /** The topic group: billing, sso, api, data or tickets. */
  domain: string;
}

/**
 * The questions, one per row. Each row has five columns, in this order:
 * 1. domain: the topic group.
 * 2. question: the text sent to the pipeline.
 * 3. expectedAnswer: a known good answer.
 * 4. requiredKeywords: facts the answer must contain. A nested list is any-of.
 * 5. source: the one file the answer must cite.
 * Ids come from the row position. Inserting a row in the middle renames every id after it.
 */
const rows: Array<[string, string, string, Array<string | string[]>, string]> = [
  [
    'billing',
    'How much is the Starter plan and how many seats are included?',
    'Starter costs $29 per month and includes 5 seats.',
    ['29', '5 seats'],
    'billing-and-refunds.md',
  ],
  [
    'billing',
    'What is the Growth plan monthly price and included seat count?',
    'Growth is $99 per month with 25 seats.',
    ['99', '25 seats'],
    'billing-and-refunds.md',
  ],
  [
    'billing',
    'How much does the Enterprise plan start at?',
    'Enterprise starts at $499 per month, quoted annually.',
    ['499', 'annually'],
    'billing-and-refunds.md',
  ],
  [
    'billing',
    'How are mid-cycle upgrades prorated and when do downgrades take effect?',
    'Upgrades charge a prorated remainder; downgrades take effect at the next renewal.',
    ['prorat', ['next renewal', 'renewal']],
    'billing-and-refunds.md',
  ],
  [
    'billing',
    'What is the refund policy for first-time annual subscriptions?',
    'First-time annual subscriptions have a 14-day refund policy.',
    ['14', 'annual'],
    'billing-and-refunds.md',
  ],
  [
    'billing',
    'When do approved refunds appear on the original payment method?',
    'Approved refunds appear within 5–10 business days. No partial refunds for unused seats.',
    [['5–10', '5-10', '5 to 10'], 'business days'],
    'billing-and-refunds.md',
  ],
  [
    'billing',
    'How do I download a PDF invoice?',
    'Open Settings → Billing → Invoices, find the charge and click Download PDF.',
    ['invoices', 'PDF'],
    'billing-and-refunds.md',
  ],
  [
    'billing',
    'Getting ERR_PAYMENT_402 on renewal; how do I retry payment?',
    'Update the payment method under Billing and retry failed payment.',
    ['ERR_PAYMENT_402', ['retry', 'retry failed payment']],
    'billing-and-refunds.md',
  ],
  [
    'sso',
    'Which plans support SAML SSO?',
    'SAML SSO is available on Growth and Enterprise plans.',
    ['Growth', 'Enterprise'],
    'sso-and-authentication.md',
  ],
  [
    'sso',
    'What causes SAML_CERT_EXPIRED and how is the certificate rotated?',
    'Replace the expired IdP signing certificate under SSO Certificates and test SSO login.',
    ['SAML_CERT_EXPIRED', ['certificate', 'cert']],
    'sso-and-authentication.md',
  ],
  [
    'sso',
    'How do I upload IdP metadata XML to configure SSO?',
    'Use Settings → Security → SSO and Upload IdP metadata XML; enforce SSO only after a test succeeds.',
    ['metadata', 'SSO'],
    'sso-and-authentication.md',
  ],
  [
    'sso',
    'How many 2FA backup codes are provided and can each be reused?',
    'Ten backup codes are provided, each usable once.',
    [
      ['10', 'ten'],
      ['once', 'one-time'],
    ],
    'sso-and-authentication.md',
  ],
  [
    'api',
    'How should a client handle HTTP 429 and Retry-After?',
    'Honor Retry-After seconds, add jitter and retry at most three times.',
    ['429', 'Retry-After', ['3', 'three']],
    'api-and-webhooks.md',
  ],
  [
    'api',
    'How do I verify X-Hub-Signature-256 webhook signatures?',
    'Compute HMAC-SHA256 over the raw request body with the webhook secret and compare in constant time.',
    ['X-Hub-Signature-256', 'HMAC-SHA256', 'raw'],
    'api-and-webhooks.md',
  ],
  [
    'api',
    'What happens after five failed webhook delivery attempts?',
    'After five attempts, the delivery is dead and can be manually redelivered from Webhook logs.',
    [['five', '5'], 'dead', ['Redeliver', 'redeliver']],
    'api-and-webhooks.md',
  ],
  [
    'data',
    'Which formats are available for a full workspace data export?',
    'Owners and Data Admins can export JSON or CSV.',
    ['JSON', 'CSV'],
    'data-export-and-deletion.md',
  ],
  [
    'data',
    'How long is the workspace export download link valid?',
    'The time-limited export link is valid for 72 hours.',
    ['72', 'hours'],
    'data-export-and-deletion.md',
  ],
  [
    'data',
    'What is the GDPR deletion grace window and when is primary data purged?',
    'Deletion has a 30-day grace window and primary data is purged on day 31.',
    ['30', '31'],
    'data-export-and-deletion.md',
  ],
  [
    'tickets',
    'Look up TCK-1042 and check billing guidance for the failed renewal.',
    'TCK-1042 is open after two failed payment retries and is in the 7-day grace period.',
    ['TCK-1042', ['two', '2'], 'grace'],
    'billing-and-refunds.md',
  ],
  [
    'tickets',
    'Look up ticket TCK-3115 and find the webhook signature verification policy.',
    'TCK-3115 concerns a signature mismatch; verify X-Hub-Signature-256 on the raw body.',
    ['TCK-3115', 'X-Hub-Signature-256', 'raw'],
    'api-and-webhooks.md',
  ],
];

/** The rows above, turned into question objects. */
export const GOLDEN_QUESTIONS: GoldenQuestion[] = rows.map(
  ([domain, question, expectedAnswer, requiredKeywords, source], i) => ({
    id: 'GQ-' + String(i + 1).padStart(2, '0'),
    domain,
    question,
    expectedAnswer,
    requiredKeywords,
    requiredSources: [source],
  }),
);
