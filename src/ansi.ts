export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
} as const

/**
 * Color the console only when a human is watching: an explicit FORCE_COLOR wins,
 * a non-empty NO_COLOR (https://no-color.org) forces plain text, otherwise the
 * stream must be a TTY so piped/CI output stays plain.
 */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env, isTTY: boolean = Boolean(process.stdout.isTTY)): boolean {
  const force = env.FORCE_COLOR
  if (force !== undefined && force !== "") return force !== "0" && force !== "false"
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false
  return isTTY
}

export function paint(code: string, text: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text
}
