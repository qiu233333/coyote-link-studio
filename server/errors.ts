export class AppError extends Error {
  constructor(
    message: string,
    public code = "INVALID_REQUEST",
    public status = 400,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  message: string,
  code = "INVALID_REQUEST",
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(message, code, status);
}
