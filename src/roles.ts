/**
 * Why this file exists: each document section is readable only by some roles.
 * This file decides which roles a section gets and whether a caller may read
 * it. Without it, a billing user could be shown admin-only text.
 */
import type { RolePreset } from './types.js';

/**
 * Every role a section or a caller can hold.
 * A caller who sends no roles gets this whole list.
 */
export const ALL_ROLES = ['admin', 'billing', 'engineering', 'all'] as const;

/**
 * The roles each named preset grants.
 * Every preset includes "all", so every caller can read sections marked "all".
 */
export const ROLE_PRESETS: Record<RolePreset, string[]> = {
  all: ['all'],
  billing: ['billing', 'all'],
  engineering: ['engineering', 'all'],
  admin: ['admin', 'billing', 'engineering', 'all'],
};

/**
 * Says which roles may read one Markdown section.
 * The answer depends only on the source file name and the section heading.
 *
 * If the file is not listed here: only "admin" may read it.
 * A new document therefore stays hidden until someone lists it.
 */
export function rolesForChunk({
  sourceFile,
  headingPath,
}: {
  sourceFile: string;
  headingPath: string;
}): string[] {
  const file = sourceFile.toLowerCase();
  if (file === 'billing-and-refunds.md') return ['billing', 'admin'];
  if (file === 'sso-and-authentication.md') return ['engineering', 'admin'];
  if (file === 'api-and-webhooks.md') return ['engineering', 'admin'];
  if (file === 'how-bm25-works.md' || file === 'how-cosine-works.md') {
    return ['all', 'billing', 'engineering', 'admin'];
  }
  if (file === 'data-export-and-deletion.md') {
    /**
     * Checks only the last heading in the path.
     * The top heading "Data Export & Deletion" would otherwise make every
     * child section admin-only.
     */
    const leaf = (headingPath.split('>').pop() || headingPath).trim().toLowerCase();
    if (
      leaf.includes('delete') ||
      leaf.includes('deletion') ||
      leaf.includes('gdpr') ||
      leaf.includes('transfer')
    ) {
      return ['admin'];
    }
    return ['all', 'billing', 'engineering', 'admin'];
  }
  /** Unknown document: admin-only, so nothing leaks by mistake. */
  return ['admin'];
}

/**
 * True if the caller holds at least one role that the section allows.
 * Role names are compared without regard to letter case.
 *
 * If the section has no roles at all: false. An unlabeled section stays hidden.
 */
export function chunkAccessibleToRoles({
  chunkRoles,
  callerRoles,
}: {
  chunkRoles: string[] | undefined;
  callerRoles: string[];
}): boolean {
  if (!chunkRoles || chunkRoles.length === 0) return false;
  const caller = new Set(callerRoles.map((r) => r.toLowerCase()));
  return chunkRoles.some((r) => caller.has(String(r).toLowerCase()));
}

/**
 * Works out which roles a request holds.
 *
 * Normally: the explicit `roles` list from the request.
 * If there is no list: the roles of the named `rolePreset`.
 * If there is neither, or the preset name is unknown: every role.
 * So a request that names no roles gets full access. Callers that must not
 * see everything have to send roles.
 */
export function resolveCallerRoles(input: { roles?: unknown; rolePreset?: unknown }): string[] {
  if (Array.isArray(input.roles) && input.roles.length > 0) {
    return input.roles.map((r) => String(r));
  }
  const preset = String(input.rolePreset || '').toLowerCase() as RolePreset;
  if (preset && ROLE_PRESETS[preset]) return [...ROLE_PRESETS[preset]];
  /** Default for requests with no roles: full access, the same as admin. */
  return [...ALL_ROLES];
}
