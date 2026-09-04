/**
 * Keep the head and tail of a long output, noting how much was cut from the middle. The
 * default cap is what a tool result may hand back to the model.
 */
export function truncate(text: string, max = 20_000): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const omitted = text.length - max
  return `${text.slice(0, half)}\n\n... (${omitted} characters omitted) ...\n\n${text.slice(-half)}`
}
