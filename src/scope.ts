import { CATEGORIES } from './config';
import type { Brief } from './briefdata';

// One order = one role = one result. These words hint that the customer wants something from another role.
const WORDS: Record<string, { re: RegExp; label: string }> = {
  scripter: { re: /\b(script(ed|ing|s)?|code[ds]?|functional|functioning|working|mechanics?|physics|gameplay)\b/i, label: 'scripting' },
  animator: { re: /\b(animat\w*|rigged?|rigging|cutscene|emotes?)\b/i, label: 'animation' },
  modeller: { re: /\b(3d|model(l?ed|ling|s)?|mesh|blender|sculpt\w*)\b/i, label: '3D modelling' },
  ui: { re: /\b(ui|gui|hud|menus?|interface|buttons?)\b/i, label: 'UI design' },
  vfx: { re: /\b(vfx|particles?|explosions?|visual effects?|muzzle flash)\b/i, label: 'VFX' },
  music: { re: /\b(music|soundtrack|sfx|sound effects?|songs?|audio|jingles?)\b/i, label: 'music & sound' },
  gfx: { re: /\b(icons?|thumbnails?|logos?|banners?|posters?)\b/i, label: 'GFX' },
  builder: { re: /\b(maps?|terrain|houses?|interiors?|environments?)\b/i, label: 'building' },
};

export type Scope = { block: { title: string; body: string } | null; notes: string[] };

export function checkScope(brief: Brief): Scope {
  const own = brief.category ?? '';
  const ownLabel = CATEGORIES.find((c) => c.value === own)?.label ?? 'this role';
  const base = brief.answers?.base?.[0];

  // Animations need something to animate
  if (own === 'animator' && (!base || base === 'none')) {
    return {
      block: {
        title: '🎞️ Animation needs a model',
        body:
          'Animations are made for an existing model or rig, so we cannot start from scratch.\n\n' +
          '**What to do:** order the **3D model** first. When it is delivered you can order the animation and choose ' +
          '**"A model delivered by Novai"**. If you already have a model, go back to step 2 and choose **"My own model / files"**.',
      },
      notes: [],
    };
  }

  const text = `${brief.title ?? ''} ${brief.description ?? ''} ${brief.references ?? ''}`;
  const notes: string[] = [];
  for (const [role, { re, label }] of Object.entries(WORDS)) {
    if (role === own) continue;
    if (role === 'modeller' && (own === 'scripter' || own === 'animator')) continue; // they talk about a model they already have
    if (re.test(text)) {
      notes.push(
        `Your text also mentions **${label}**. This order covers only **${ownLabel}**. ` +
          `Order ${label} separately, you can do that right after delivery.`
      );
    }
    if (notes.length >= 3) break;
  }
  return { block: null, notes };
}
