/**
 * The interpreters run_code can drive. A fixed table, not a registry: adding a language is one
 * entry here, and [run_code] languages picks which entries an instance offers.
 */
export interface Language {
  /** Looked up on PATH unless [run_code.binaries] names a path for this language. */
  binary: string
  /** Arguments after the binary, given the script's path inside the sandbox. */
  args: (script: string) => string[]
  /** File extension the interpreter expects on a script. */
  extension: string
  /**
   * Host paths the interpreter needs read-only besides /usr and its own binary's directory,
   * e.g. a standard library installed under /usr/local/lib.
   */
  readPaths: string[]
  /** One line for the tool description: what a program can use. */
  note: string
}

export const LANGUAGES: Record<string, Language> = {
  python: {
    binary: 'python3',
    // -I: ignore PYTHON* env vars and the user site directory, and keep the script's own
    // directory off sys.path.
    args: (script) => ['-I', script],
    extension: '.py',
    readPaths: [],
    note: 'Python 3 with the standard library and whatever is installed system-wide',
  },
  hemlock: {
    binary: 'hemlock',
    args: (script) => [script],
    extension: '.hml',
    // The stdlib ("@stdlib/...") installs next to the binary's prefix; under /usr it is
    // already visible, and try-binds skip a path that does not exist.
    readPaths: ['/usr/local/lib/hemlock', '/opt/hemlock'],
    note: 'Hemlock (let/fn/print, imports from "@stdlib/...")',
  },
}
