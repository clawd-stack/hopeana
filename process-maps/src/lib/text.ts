/**
 * Text that Postgres will store. jsonb refuses a NUL and refuses half of a
 * surrogate pair, and either one would turn an edit into a 500 that the
 * browser retries forever. Truncating by UTF-16 unit can split an emoji in
 * two, so the cut is made first and the result is then made well-formed.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanText(value: string, max: number): string {
  return value.replace(/\u0000/g, '').slice(0, max).replace(LONE_SURROGATE, '�');
}

/** Control characters have no business in an email address or a name. */
export function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
