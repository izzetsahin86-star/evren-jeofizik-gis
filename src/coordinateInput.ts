export function splitBulkCoordinateEntries(value: string) {
  return value
    .split(/\r?\n|;/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith('#'))
}
