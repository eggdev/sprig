export type ErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'empty';

const statusByCode: Record<ErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  empty: 422,
};

/** An error the caller can act on. The daemon sends `code` and `message` back as JSON. */
export class ScnError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }

  get status(): number {
    return statusByCode[this.code];
  }
}
