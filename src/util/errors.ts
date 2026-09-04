/** The message of a thrown value, whatever it turned out to be. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
