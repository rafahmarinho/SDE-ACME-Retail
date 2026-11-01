import { randomUUID } from "node:crypto";
import { appErrorLog } from "./security-log";

export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request",
  ) {
    super(message);
  }
}

export interface ErrorBody {
  error: string;
  code?: string;
  errorId?: string;
}

/**
 * Global error mapping. Expected errors keep their user-safe message; anything else is logged
 * with a unique id and answered with a generic message that carries only that id, so support
 * can find the log entry without the client seeing internal details.
 */
export function toErrorResponse(error: unknown, context: { method?: string; path?: string } = {}): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  const errorId = randomUUID();
  appErrorLog(errorId, error, context);
  return { status: 500, body: { error: "Something went wrong. Please try again.", errorId } };
}
