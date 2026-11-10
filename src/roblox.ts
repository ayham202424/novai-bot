import { ROBUX } from './config';

export const gameUrl = `https://www.roblox.com/games/${ROBUX.placeId}`;
export const linkUrl = (token: string) =>
  `https://www.roblox.com/games/start?placeId=${ROBUX.placeId}&launchData=${encodeURIComponent(token)}`;

// ---------- Your developer product ladder ----------
const LADDER_MAX = ROBUX.ladder[ROBUX.ladder.length - 1][1];

function roundUpToStep(amount: number): number {
  const first = ROBUX.ladder[0][0];
  if (amount <= first) return first;
  for (const [from, to, step] of ROBUX.ladder) {
    if (amount <= to) return from + Math.ceil((amount - from) / step) * step;
  }
  return LADDER_MAX;
}

// Rounds an amount up so it can be paid with your products (above the biggest one: several purchases)
export function payableRobux(amount: number): number {
  let left = Math.ceil(amount);
  let total = 0;
  while (left > LADDER_MAX) {
    total += LADDER_MAX;
    left -= LADDER_MAX;
  }
  return total + roundUpToStep(left);
}

// ---------- Roblox public API ----------
export async function robloxLookup(username: string): Promise<{ id: number; name: string } | null> {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Roblox lookup failed (${res.status})`);
  const json = (await res.json()) as { data?: { id: number; name: string }[] };
  return json.data?.[0] ?? null;
}

export async function robloxProfile(id: number): Promise<{ name: string; displayName: string; created: string }> {
  const res = await fetch(`https://users.roblox.com/v1/users/${id}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Roblox profile failed (${res.status})`);
  return (await res.json()) as { name: string; displayName: string; created: string };
}

export async function robloxHeadshot(id: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { imageUrl?: string; state?: string }[] };
    const item = json.data?.[0];
    return item?.state === 'Completed' && item.imageUrl ? item.imageUrl : null;
  } catch {
    return null;
  }
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'dev';