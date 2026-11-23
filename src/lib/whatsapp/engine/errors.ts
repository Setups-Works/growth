/**
 * An engine refusal or failure, with an HTTP-style status the API routes pass
 * through (400 bad input, 404 not found, 409 not linked, 0 unreachable).
 * Re-exported from ../client, where callers have always imported it.
 */
export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }
}
