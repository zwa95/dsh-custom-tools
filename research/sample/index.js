/**
 * Bundle root row. Its only job is to anchor the browser half: the client module
 * system serves `./client` from the row whose specifier is the bare package name,
 * so every other row here is mounted as a subpath and can never carry one.
 */
export const name = 'custom-tools-sample'

export function apply() {}
