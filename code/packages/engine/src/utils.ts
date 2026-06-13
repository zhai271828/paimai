import type { ArtifactTag } from "@auctioneer/shared";

export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function makeJoinCode(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function makeRng(seedText: string): () => number {
  let hash = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i += 1) {
    hash = Math.imul(hash ^ seedText.charCodeAt(i), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    const result = (hash ^= hash >>> 16) >>> 0;
    return result / 4294967296;
  };
}

export function shuffled<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

export function pick<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)]!;
}

export function tagMultiplier(tag: ArtifactTag, dayAcquired: number | undefined, currentDay: number): number {
  if (tag === "treasure") return 1.15;
  if (tag === "heirloom") {
    const heldDays = Math.max(0, currentDay - (dayAcquired ?? currentDay));
    return 1 + heldDays * 0.02;
  }
  if (tag === "fake") return 0.7;
  if (tag === "fragile") return 0.9;
  return 1;
}
