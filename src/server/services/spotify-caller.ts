import { AsyncLocalStorage } from "async_hooks";

export type SpotifyApiCaller = "sync" | "search" | "prefetch" | "admin" | "other";

const callerStorage = new AsyncLocalStorage<SpotifyApiCaller>();

export function getSpotifyApiCaller(): SpotifyApiCaller {
  return callerStorage.getStore() ?? "other";
}

export function withSpotifyCaller<T>(caller: SpotifyApiCaller, fn: () => T): T {
  return callerStorage.run(caller, fn);
}

export async function withSpotifyCallerAsync<T>(
  caller: SpotifyApiCaller,
  fn: () => Promise<T>,
): Promise<T> {
  return callerStorage.run(caller, fn);
}
