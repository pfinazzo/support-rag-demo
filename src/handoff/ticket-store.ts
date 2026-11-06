/**
 * Why this file exists: the support assistant can look up a ticket and raise an
 * escalation. This file holds the sample tickets and the escalation records. It
 * only shows a ticket to a role that is allowed to see it. Without it, a billing
 * question could leak an engineering or legal ticket.
 */
import { randomUUID } from 'node:crypto';

/** One support ticket. `roles` lists who may see it. */
export interface Ticket {
  id: string;
  subject: string;
  status: string;
  roles: string[];
  failedPayments: number;
  details: string;
}

/** The sample tickets the lookup tool can find. */
export const TICKETS: Ticket[] = [
  {
    id: 'TCK-1042',
    subject: 'Renewal ERR_PAYMENT_402',
    status: 'open',
    roles: ['billing', 'admin'],
    failedPayments: 2,
    details:
      'Two renewal payment retries failed. Workspace is in the 7-day grace period. Billing specialist review required.',
  },
  {
    id: 'TCK-2089',
    subject: 'SAML certificate outage',
    status: 'investigating',
    roles: ['engineering', 'admin'],
    failedPayments: 0,
    details:
      'Expired signing certificate; rotate certificate and update identity-provider metadata.',
  },
  {
    id: 'TCK-3115',
    subject: 'Webhook signature mismatch',
    status: 'open',
    roles: ['engineering', 'admin'],
    failedPayments: 0,
    details:
      'Verify X-Hub-Signature-256 against the raw request body using the webhook signing secret.',
  },
  {
    id: 'TCK-4002',
    subject: 'GDPR erasure request',
    status: 'pending-verification',
    roles: ['admin'],
    failedPayments: 0,
    details: 'Verify workspace-owner identity before processing the GDPR erasure request.',
  },
];

/**
 * Finds a ticket by id, if the caller has a role that may see it.
 * The id is matched in upper case.
 * If the ticket does not exist or the roles do not match: returns `found: false`.
 * A hidden ticket looks the same as a missing one, so a caller cannot learn that it exists.
 * Returns a copy, so the caller cannot change the stored ticket.
 */
export function lookupTicket({ id, roles }: { id: string; roles: string[] }) {
  const ticket = TICKETS.find(
    (t) => t.id === id.toUpperCase() && t.roles.some((r) => roles.includes(r)),
  );
  return ticket
    ? { found: true, ticket: { ...ticket, roles: [...ticket.roles] } }
    : { found: false, ticket: null };
}

/** A request for a person to take over. `delivery` says nothing was sent anywhere. */
export interface Escalation {
  id: string;
  summary: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  queue: string;
  ticketId: string | null;
  createdAt: string;
  delivery: 'local-record-only';
}

/**
 * Keeps escalation records in memory.
 * Nothing reaches a real person or queue. The module exports one shared instance.
 */
export class TicketStore {
  /** Records, newest last. */
  private escalations: Escalation[] = [];

  /**
   * Saves a new escalation and returns it with its id and time.
   * The id is ESC- plus eight random characters. Keeps only the newest 500.
   */
  create(input: Omit<Escalation, 'id' | 'createdAt' | 'delivery'>) {
    const record = {
      ...input,
      id: 'ESC-' + randomUUID().slice(0, 8).toUpperCase(),
      createdAt: new Date().toISOString(),
      delivery: 'local-record-only' as const,
    };
    this.escalations.push(record);
    this.escalations = this.escalations.slice(-500);
    return record;
  }

  /** Returns copies of all records, so the caller cannot change them. */
  list() {
    return this.escalations.map((e) => ({ ...e }));
  }

  /** Deletes every record. */
  reset() {
    this.escalations = [];
  }
}

/** The shared store used by the tools and the human handoff. */
export const ticketStore = new TicketStore();
