import type { DedupTrack } from "./types";

/** Max duration delta (ms) when both tracks have duration — corroborates fold match. */
export const DEDUP_DURATION_TOLERANCE_MS = 5000;

const COSMETIC_SUFFIX =
  /\s*(?:[-–—]\s*)?(?:\([^)]*\)|\[[^\]]*\])\s*$/i;
const COSMETIC_SUFFIX_KEYWORDS =
  /\b(?:remaster(?:ed)?|explicit|clean)\b/i;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCombiningMarks(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "");
}

function stripCosmeticSuffixes(title: string): string {
  let result = title.trim();
  for (let i = 0; i < 4; i++) {
    const match = result.match(COSMETIC_SUFFIX);
    if (!match) break;
    const segment = match[0];
    if (!COSMETIC_SUFFIX_KEYWORDS.test(segment)) break;
    result = result.slice(0, -segment.length).trim();
  }
  return result.replace(/\s*(?:[-–—]\s*)?(?:remaster(?:ed)?(?:\s+\d{4})?)\s*$/i, "").trim();
}

/** Alphanumeric fold for track titles — absorbs punctuation and cosmetic suffix drift. */
export function foldTitle(title: string): string {
  const stripped = stripCosmeticSuffixes(stripCombiningMarks(title).toLowerCase());
  return stripped.replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Alphanumeric fold for artist names — primary artist, no leading "The". */
export function foldArtist(artist: string): string {
  let name = stripCombiningMarks(artist).toLowerCase().trim();
  name = name.replace(/^the\s+/, "").replace(/,\s*the$/, "");
  const primary = name.split(/\s*(?:,|&|\s(?:feat\.?|ft\.?|featuring)\s)/i)[0] ?? name;
  return primary.replace(/[^\p{L}\p{N}]+/gu, "");
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) matrix[i]![0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }
  return matrix[a.length]![b.length]!;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function durationsCompatible(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= DEDUP_DURATION_TOLERANCE_MS;
}

function foldedMetadataMatch(candidate: DedupTrack, entry: DedupTrack): boolean {
  const title = foldTitle(candidate.trackName);
  if (!title) return false;
  const otherTitle = foldTitle(entry.trackName);
  if (!otherTitle) return false;

  const artist = foldArtist(candidate.artistName);
  const otherArtist = foldArtist(entry.artistName);

  const titleMatch =
    title === otherTitle || similarity(title, otherTitle) >= 0.85;
  if (!titleMatch) return false;

  if (!artist || !otherArtist) {
    return durationsCompatible(candidate.durationMs, entry.durationMs);
  }

  const artistMatch =
    artist === otherArtist || similarity(artist, otherArtist) >= 0.85;
  if (!artistMatch) return false;

  return durationsCompatible(candidate.durationMs, entry.durationMs);
}

export function isDuplicateTitle(
  candidateTitle: string,
  existingTitles: string[],
): boolean {
  const normalized = normalizeTitle(candidateTitle);
  if (!normalized) return false;
  return existingTitles.some((title) => {
    const other = normalizeTitle(title);
    if (!other) return false;
    if (normalized === other) return true;
    return similarity(normalized, other) >= 0.85;
  });
}

export function isDuplicateTrack(
  candidate: DedupTrack,
  existing: DedupTrack[],
): boolean {
  return existing.some((entry) => foldedMetadataMatch(candidate, entry));
}

export function normalizeDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isDuplicateDisplayName(
  candidate: string,
  existing: string[],
): boolean {
  const normalized = normalizeDisplayName(candidate);
  if (!normalized) return false;
  return existing.some((name) => {
    const other = normalizeDisplayName(name);
    if (!other) return false;
    if (normalized === other) return true;
    return similarity(normalized, other) >= 0.85;
  });
}
