/**
 * Refusal codes. Every failure a caller can see has a code and a message
 * written for a person, and nothing else ever reaches the browser: an
 * unexpected error becomes INTERNAL with the detail in the function log.
 */
export const REFUSAL = {
  NOT_FOUND: { status: 404, message: 'That map could not be found. It may have been archived.' },
  UNAUTHENTICATED: { status: 401, message: 'Please sign in again.' },
  /**
   * One message for every way a sign-in can fail, so the endpoint cannot be
   * used to find out who has an account.
   */
  SIGNIN_FAILED: { status: 401, message: 'That email and password did not work. Check them, or ask an admin to reset your password.' },
  FORBIDDEN: { status: 403, message: 'You do not have access to do that.' },
  READ_ONLY: { status: 403, message: 'You have view-only access to process maps. Ask an admin if you need to edit.' },
  MAP_ARCHIVED: { status: 409, message: 'This map is archived. Restore it before making changes.' },
  MAP_FULL: { status: 409, message: 'This map has reached its size limit. Split it into two maps.' },
  EMAIL_TAKEN: { status: 409, message: 'Somebody on the team already uses that email address.' },
  CANNOT_CHANGE_SELF: { status: 409, message: 'You cannot remove your own admin access. Ask another admin.' },
  PASSWORD_CHANGE_REQUIRED: { status: 403, message: 'Please choose your own password before carrying on.' },
  PASSWORD_REJECTED: { status: 400, message: 'Please choose a different password.' },
  RATE_LIMITED: { status: 429, message: 'Too many attempts. Please wait a few minutes and try again.' },
  INVALID_REQUEST: { status: 400, message: 'That request was not valid.' },
  INTERNAL: { status: 500, message: 'Something went wrong at our end. Please try again.' },
} as const;

export type RefusalCode = keyof typeof REFUSAL;

export class AppError extends Error {
  readonly code: RefusalCode;
  readonly status: number;
  readonly userMessage: string;
  readonly detail: unknown;

  constructor(code: RefusalCode, detail?: unknown, overrideMessage?: string) {
    const spec = REFUSAL[code];
    super(`${code}: ${spec.message}`);
    this.name = 'AppError';
    this.code = code;
    this.status = spec.status;
    this.userMessage = overrideMessage ?? spec.message;
    this.detail = detail ?? null;
  }
}

export function refuse(code: RefusalCode, detail?: unknown, overrideMessage?: string): never {
  throw new AppError(code, detail, overrideMessage);
}
