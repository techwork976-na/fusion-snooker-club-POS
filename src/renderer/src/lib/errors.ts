/** An error whose message is safe and helpful to show to the operator. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

interface ErrorLike {
  message?: string
  code?: string
  hint?: string
  details?: string
  status?: number
  name?: string
}

const NETWORK = /failed to fetch|networkerror|load failed|fetch failed|network request failed/i

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const e = (error ?? {}) as ErrorLike
  const message = e.message ?? String(error)
  if (NETWORK.test(message)) {
    return new AppError("Can't reach the server. Check the internet connection and try again.", 'network')
  }
  if (e.code === 'PGRST301' || /jwt expired/i.test(message)) {
    return new AppError('Your session expired. Please sign in again.', 'not_authenticated')
  }
  // Messages raised by FUSION's database functions carry a machine-readable
  // hint and are already written for the operator.
  if (e.hint && /^[a-z_]+$/.test(e.hint)) return new AppError(message, e.hint)
  if (e.code === '42501') return new AppError('You do not have permission to do that.', 'forbidden')
  if (e.code === '23505') return new AppError('That already exists.', 'duplicate')
  if (e.code === '23514' || e.code === '22023' || e.code === '22P02') {
    return new AppError('Some of the values entered are not valid.', 'invalid_input')
  }
  if (e.code?.startsWith('PGRST') || e.code?.match(/^\d{2}[0-9A-Z]{3}$/)) {
    return new AppError('The server could not complete that request. Please try again.', e.code)
  }
  return new AppError(message || 'Something went wrong.', e.code)
}

export function errorMessage(error: unknown): string {
  return toAppError(error).message
}
