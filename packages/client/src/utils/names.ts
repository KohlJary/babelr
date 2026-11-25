// SPDX-License-Identifier: MIT

/** A username written as a person's name: "barbara" -> "Barbara", "mary_ann" -> "Mary Ann". */
export function nameFromUsername(username: string): string {
  return username
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
