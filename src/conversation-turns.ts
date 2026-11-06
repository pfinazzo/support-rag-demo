/**
 * Why this file exists: three routes accept a list of chat turns from the page
 * (chat history, context building, hand-off checks). They share one check, so
 * a malformed list is rejected the same way everywhere and later code can
 * trust every turn has a text role and text content.
 */
import { createHttpError, isJsonObject } from './http-exchange.js';
import type { ChatHistoryTurn } from './types.js';

/** True for a turn with a text role and text content. Extra fields are allowed. */
const isConversationTurn = (value: unknown): value is ChatHistoryTurn =>
  isJsonObject(value) && typeof value.role === 'string' && typeof value.content === 'string';

/**
 * Reads a list of chat turns from request JSON. Anything that is not a list is
 * treated as no turns. Throws a 400 naming the field when a turn is malformed.
 * Extra fields on a turn are kept, because the hand-off package records them.
 */
export const parseConversationTurns = ({
  value,
  fieldName,
}: {
  value: unknown;
  fieldName: string;
}): ChatHistoryTurn[] => {
  if (!Array.isArray(value)) return [];
  if (!value.every(isConversationTurn)) {
    throw createHttpError({
      statusCode: 400,
      message: `${fieldName} must be a list of { role, content } turns`,
    });
  }
  return value;
};
