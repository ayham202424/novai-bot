import { BRIEF_QUESTIONS, CATEGORIES, GAME_TYPES, PLATFORMS } from './config';

export type Brief = {
  step?: number;
  game?: string;
  category?: string;
  platforms?: string[];
  answers?: Record<string, string[]>;
  title?: string;
  description?: string;
  references?: string;
    wid?: string; // id of the wizard message
};

const labels = (list: { value: string; label: string }[], values: string[] = []) =>
  values.map((v) => list.find((o) => o.value === v)?.label ?? v);

// Lines for the review screens, e.g. "**Features**  Drift physics, Nitro / boost"
export function summaryLines(brief: Brief): string[] {
  const lines: string[] = [];
  const game = GAME_TYPES.find((g) => g.value === brief.game)?.label;
  const cat = CATEGORIES.find((c) => c.value === brief.category)?.label;
  if (game) lines.push(`**Game type**  ${game}`);
  if (cat) lines.push(`**You need**  ${cat}`);
  const platforms = labels(PLATFORMS, brief.platforms);
  if (platforms.length) lines.push(`**Platforms**  ${platforms.join(', ')}`);
  for (const q of BRIEF_QUESTIONS[brief.category ?? ''] ?? []) {
    const picked = labels(q.options, brief.answers?.[q.id]);
    if (picked.length) lines.push(`**${q.label}**  ${picked.join(', ')}`);
  }
  return lines;
}

// The same answers as question/answer pairs (for the AI and the Claude prompt package)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function briefToQa(order: Record<string, any>): { q: string; a: string }[] {
  const brief: Brief = order.brief ?? {};
  const out: { q: string; a: string }[] = [];
  const platforms = labels(PLATFORMS, brief.platforms);
  if (platforms.length) out.push({ q: 'Target platforms', a: platforms.join(', ') });
  for (const q of BRIEF_QUESTIONS[brief.category ?? ''] ?? []) {
    const picked = labels(q.options, brief.answers?.[q.id]);
    if (picked.length) out.push({ q: q.label, a: picked.join(', ') });
  }
  if (brief.references?.trim()) out.push({ q: 'References', a: brief.references.trim() });
  return out;
}