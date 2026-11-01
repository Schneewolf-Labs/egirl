import pkg from '../package.json'

/** The egirl release, read from package.json so every handshake and endpoint reports the same one. */
export const VERSION: string = pkg.version
