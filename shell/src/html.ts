/** HTML text escaping for server-rendered pages. */

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 * Every page in the team shell renders operator- or applicant-supplied strings
 * (email addresses, display names, usernames), so every interpolation goes
 * through here.
 * @param value - the raw value to escape.
 * @returns the value with HTML-significant characters replaced by entities.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, char => ENTITIES[char] ?? char)
}
