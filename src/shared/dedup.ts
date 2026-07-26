export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
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

import type { DedupTrack } from "./types";

export function isDuplicateTrack(
  candidate: DedupTrack,
  existing: DedupTrack[],
): boolean {
  const title = normalizeTitle(candidate.trackName);
  if (!title) return false;
  const artist = normalizeTitle(candidate.artistName);
  return existing.some((entry) => {
    const otherTitle = normalizeTitle(entry.trackName);
    if (!otherTitle) return false;
    const otherArtist = normalizeTitle(entry.artistName);
    const titleMatch =
      title === otherTitle || similarity(title, otherTitle) >= 0.85;
    if (!titleMatch) return false;
    if (!artist || !otherArtist) return titleMatch;
    return artist === otherArtist || similarity(artist, otherArtist) >= 0.85;
  });
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
