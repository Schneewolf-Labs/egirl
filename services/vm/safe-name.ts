/**
 * Turn an uploaded filename into something safe to write inside the share directory.
 *
 * The upload target is a directory a sandboxed agent reads from, so the threat runs the other way
 * to the usual one: the risk is not the guest reaching the host, it is a crafted filename walking
 * *out* of the share and landing somewhere on the host that the guest was never meant to touch.
 * `../../.ssh/authorized_keys` is the whole attack, and it arrives as an ordinary form field.
 *
 * Kept apart from the server so the rules can be tested directly rather than through HTTP.
 */

const MAX_LENGTH = 200

/**
 * Reduce a client-supplied name to a single safe path segment.
 *
 * Returns undefined when nothing usable survives, which the caller must treat as a rejection
 * rather than substituting a default -- a silent fallback name means an upload the user believes
 * landed somewhere it did not.
 */
export function safeName(raw: string): string | undefined {
  // Take the last segment under both separators before anything else: a Windows client sends
  // `C:\Users\x\evil.bin`, and splitting on '/' alone leaves the backslashes intact.
  const base = raw.split(/[/\\]/).pop() ?? ''

  const cleaned = base
    // Control characters and NUL: a NUL can truncate the path in a lower layer, so the name that
    // gets validated is not the name that gets opened.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: filtering control chars is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    // A leading dot would hide the file from a plain `ls` in the guest, and `.` / `..` are the
    // traversal case that survives basename extraction.
    .replace(/^\.+/, '')

  if (!cleaned) return undefined
  if (cleaned === '.' || cleaned === '..') return undefined

  return cleaned.slice(0, MAX_LENGTH)
}

/**
 * Non-clobbering destination: `report.pdf` becomes `report (2).pdf` when taken.
 *
 * Overwriting silently is the wrong default when a person is dropping files for an agent to read
 * -- two files with one name means the agent analyses the wrong one and nothing reports it.
 */
export function uniqueName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name

  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!exists(candidate)) return candidate
  }

  throw new Error(`cannot find a free name for ${name}`)
}
