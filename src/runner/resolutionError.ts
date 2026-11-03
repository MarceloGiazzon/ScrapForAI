/** An error with an HTTP status that the request-resolution layer raises on purpose. */
export class RequestResolutionError extends Error {
  constructor(
    readonly status: number,
    name: string,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}
