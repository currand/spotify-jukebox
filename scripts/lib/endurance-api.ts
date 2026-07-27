export interface ApiResponse {
  status: number;
  json: any;
  latencyMs: number;
  setCookie: string | null;
}

export function createApiClient(baseUrl: string) {
  return async function api(
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
  ): Promise<ApiResponse> {
    const start = Date.now();
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    if (body) headers["Content-Type"] = "application/json";

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const latencyMs = Date.now() - start;
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // non-JSON
    }
    return {
      status: res.status,
      json,
      latencyMs,
      setCookie: res.headers.get("set-cookie"),
    };
  };
}

export function randomDelay(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
}

export function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export function weightedRandom(items: string[], weights: number[]): string {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

export function guestDisplayName(index: number): string {
  return `Guest-${String(index + 1).padStart(2, "0")}`;
}
