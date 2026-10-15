export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request",
  ) {
    super(message);
  }
}

export function toErrorResponse(error: unknown): { status: number; body: { error: string } } {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: error.message } };
  }
  console.error("Unhandled application error");
  return { status: 500, body: { error: "Something went wrong. Please try again." } };
}
