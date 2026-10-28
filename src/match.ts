/** Glob patterns for permission rules and shell commands: `*` any text, `?` one character. */
function globRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, ".")
  return new RegExp(`^${body}$`)
}

/** For shell commands, "make *" also matches a bare "make". */
export function matches(pattern: string, value: string, shell: boolean): boolean {
  if (globRegExp(pattern).test(value)) return true
  return shell && pattern.endsWith(" *") && globRegExp(pattern.slice(0, -2)).test(value)
}

/** The parts of a shell command: unwraps `bash -c '…'`, splits on && || ; | and newlines. */
export function commandParts(command: string): string[] {
  const unwrapped = command.replace(/\b(?:bash|sh|csh|tcsh)\s+-l?c\s+(['"])([\s\S]*)\1/g, (_, __, inner: string) => ` ; ${inner} ; `)
  return unwrapped
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim().replace(/^(?:\w+=\S*\s+)*/, "").replace(/^(?:cd\s+\S+\s*)$/, ""))
    .filter(Boolean)
}

/** True when the whole command or one of its parts matches a pattern. */
export function matchesAny(command: string, patterns: string[]): boolean {
  return [command.trim(), ...commandParts(command)].some((part) => patterns.some((p) => matches(p, part, true)))
}
