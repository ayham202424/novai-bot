// All settings and customer-facing texts live here. Edit freely!

export const SETTINGS = {
  minAccountAgeDays: 14,    // Discord accounts younger than this can't open tickets
  draftTimeoutMinutes: 30,  // Ticket closes automatically if the form isn't completed
  closeDelaySeconds: 5,
};

export const TIERS = {
  essential: {
    name: 'Novai Essential',
    emoji: '📦',
    color: 0x57f287,
    days: '2 – 5 days',
    description: 'Cleanly built assets & basic scripts.\nPerfect for low-poly, anime & simulators.',
  },
  pro: {
    name: 'Novai Pro',
    emoji: '⚡',
    color: 0x5865f2,
    days: '3 – 7 days',
    description: 'Detailed models, complex scripts, VFX & custom UIs.\nBuilt for polished Roblox games.',
  },
  apex: {
    name: 'Novai Apex',
    emoji: '💎',
    color: 0xeb459e,
    days: '5 – 10 days',
    description: 'Highest detail level, advanced VFX & complex systems.\nPriority queue.',
  },
} as const;

export type TierKey = keyof typeof TIERS;

export const GAME_TYPES = [
  { value: 'battleground', label: 'Battleground', emoji: '⚔️' },
  { value: 'rpg', label: 'RPG', emoji: '🧙' },
  { value: 'fps', label: 'FPS / Shooter', emoji: '🔫' },
  { value: 'simulator', label: 'Simulator / Tycoon', emoji: '🏭' },
  { value: 'racing', label: 'Racing', emoji: '🏎️' },
  { value: 'open_world', label: 'Open World', emoji: '🌍' },
  { value: 'other', label: 'Other', emoji: '✨' },
];

export const CATEGORIES = [
  { value: 'ui', label: 'UI design', emoji: '🖼️' },
  { value: 'builder', label: 'Building / maps', emoji: '🏗️' },
  { value: 'modeller', label: '3D model', emoji: '🧊' },
  { value: 'scripter', label: 'Scripting', emoji: '💻' },
  { value: 'animator', label: 'Animation', emoji: '🎞️' },
  { value: 'music', label: 'Music & sound', emoji: '🎵' },
  { value: 'vfx', label: 'VFX', emoji: '🎆' },
  { value: 'gfx', label: 'GFX & icons', emoji: '🎨' },
];

export const TEXT = {
  footer: 'Nova-Creations • Quality you can play',
  status: 'Nova-Creations ⚡ Novai',
  dashboardTitle: '⚡ NOVAI – Your Roblox Development Service',
  dashboardDescription:
    'Choose your package and start your order. ' +
    'Our system guides you through every step.\n\u200b',
  pingReply: (ms: number) => `🏓 Pong! Latency: ${ms} ms`,
  dashboardPosted: '✅ Dashboard posted!',

  // ----- Tickets -----
  genericError: '⚠️ Something went wrong on our side. Please try again in a moment.',
  accountTooNew: (days: number) =>
    `🛡️ To protect our service from spam, your Discord account must be at least **${days} days** old to place an order.`,
  blacklisted:
    '🚫 You are currently not able to open orders. If you think this is a mistake, please contact the staff.',
  alreadyOpen: (channelId: string) =>
    `📌 You already have an open order: <#${channelId}>\nPlease finish or close it before starting a new one.`,
  channelFailed: '⚠️ I could not create your ticket channel. Please try again or contact the staff.',
  ticketReady: (channelId: string) => `✅ Your ticket is ready: <#${channelId}>`,
  ticketWelcome: (minutes: number) =>
    'Welcome! Let\'s set up your order in 3 quick steps:\n\n' +
    '**1.** Choose your game type\n' +
    '**2.** Choose a category\n' +
    '**3.** Describe your project\n\n' +
    'After that, our AI assistant will ask a few short questions to nail down every detail.\n\n' +
    `⏱️ This ticket closes automatically after ${minutes} minutes without a reply.`,
  stepGame: 'Step 1/3 • Choose your game type',
  stepCategory: 'Step 2/3 • Choose a category',
  stepBrief: 'Step 3/3 • Describe your project',
  formSaved: '✅ Got it! Your brief is saved. Our AI assistant will now ask a few short follow-up questions.',
  alreadySubmitted: 'This form was already completed, or the ticket is no longer open.',
  notOwner: 'Only the ticket owner or the staff can do that.',
  cannotClose:
    '🔒 This order is already in progress and can\'t be closed here. Please contact the staff.',
  closing: (seconds: number) => `🔒 This ticket will close in ${seconds} seconds…`,
  expiredDm: (minutes: number) =>
    `⏰ Your Novai ticket was closed automatically because there was no reply for ${minutes} minutes. ` +
    "You're welcome to open a new one anytime!",
};

// ---------- Pricing (YOU decide these numbers!) ----------
export const PRICING = {
  // Suggested price in USD = base + perPoint × complexity (1–10), rounded to the nearest 5
  essential: { base: 10, perPoint: 5 },
  pro:       { base: 25, perPoint: 12 },
  apex:      { base: 60, perPoint: 30 },
  depositPercent: 50, // share of the price due before work starts
  robuxPerUsd: 120,   // how many Robux a customer pays per 1 USD of price
};

// ---------- Robux payments ----------
export const ROBUX = {
  placeId: 85268643294256,            // your Novai Studio place ID
  minRobloxAgeDays: 7,   // keep in sync with MIN_ACCOUNT_AGE_DAYS in the game script
  // Your developer product ladder: [from, to, step]
  ladder: [
    [80, 500, 10],
    [500, 1000, 50],
    [1000, 2000, 200],
    [2000, 6000, 250],
    [6000, 10000, 500],
  ] as [number, number, number][],
};

// ---------- Brief builder (edit questions and options here) ----------
export const PLATFORMS = [
  { value: 'pc', label: 'PC', emoji: '🖥️' },
  { value: 'mobile', label: 'Mobile', emoji: '📱' },
  { value: 'console', label: 'Console', emoji: '🎮' },
];

export type BriefQuestion = {
  id: string;
  label: string;   // shown as the dropdown placeholder
  multi: boolean;  // can the customer pick several options?
  options: { value: string; label: string; emoji?: string }[];
};

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));
const ask = (id: string, label: string, multi: boolean, options: BriefQuestion['options']): BriefQuestion => ({
  id, label, multi, options,
});

const STYLES = [
  { value: 'realistic', label: 'Realistic', emoji: '📸' },
  { value: 'stylized', label: 'Stylized', emoji: '🎨' },
  { value: 'lowpoly', label: 'Low-poly', emoji: '🔷' },
  { value: 'anime', label: 'Anime', emoji: '🌸' },
  { value: 'scifi', label: 'Sci-fi / Neon', emoji: '🚀' },
  { value: 'fantasy', label: 'Fantasy', emoji: '🧙' },
  { value: 'cartoon', label: 'Cartoon', emoji: '🎈' },
  { value: 'minimal', label: 'Minimal / Clean', emoji: '⬜' },
];

// "What do we build on?" is what stops people from ordering animation without a model
const BASE = ask('base', 'What do we build on?', false, opts(
  ['none', 'Nothing, start from scratch'],
  ['novai', 'A model delivered by Novai'],
  ['own', 'My own model / files'],
));

// Unified Brief Questions configuration mapping category values to questions
export const BRIEF_QUESTIONS: Record<string, BriefQuestion[]> = {
  ui: [
    ask('screens', 'Screens', true, opts(['hud', 'HUD'], ['inventory', 'Inventory'], ['shop', 'Shop'], ['menu', 'Main menu'], ['settings', 'Settings'], ['popups', 'Pop-ups & notifications'], ['loading', 'Loading screen'], ['leaderboard', 'Leaderboard'])),
    ask('style', 'Visual style', false, STYLES),
    ask('motion', 'Animation', false, opts(['subtle', 'Subtle'], ['polished', 'Smooth & polished'], ['flashy', 'Flashy'])),
  ],
  builder: [
    ask('scale', 'Size', false, opts(['prop', 'Single prop'], ['room', 'Small build / room'], ['building', 'Large building'], ['map', 'Full map / cluster'])),
    ask('style', 'Visual style', false, STYLES),
    ask('features', 'Extras', true, opts(['interior', 'Interior'], ['lighting', 'Lighting setup'], ['terrain', 'Terrain'], ['optimized', 'Optimized (low part count)'], ['zones', 'Collisions & gameplay zones'], ['daynight', 'Day / night support'])),
  ],
  modeller: [
    ask('mtype', 'Model type', true, opts(['vehicle', 'Vehicle'], ['weapon', 'Weapon / tool'], ['character', 'Character / NPC'], ['props', 'Props & items'], ['env', 'Environment piece'], ['other', 'Other'])),
    ask('style', 'Visual style', false, STYLES),
    ask('detail', 'Detail level', false, opts(['low', 'Low-poly, game-ready'], ['mid', 'Balanced'], ['high', 'High detail'])),
  ],
  scripter: [
    ask('systems', 'Systems', true, opts(['combat', 'Combat'], ['inventory', 'Inventory'], ['economy', 'Shop & economy'], ['data', 'Data saving'], ['quests', 'Quests & progression'], ['admin', 'Admin tools'], ['lobby', 'Lobby & matchmaking'], ['vehicle', 'Vehicle / weapon system'])),
    ask('tech', 'Requirements', true, opts(['anticheat', 'Anti-exploit (server-authoritative)'], ['mobile', 'Mobile controls'], ['gamepad', 'Gamepad support'], ['leaderboards', 'Leaderboards'], ['settings', 'Settings menu'], ['logging', 'Analytics / logging'])),
    BASE,
  ],
  animator: [
    ask('atype', 'Animation type', true, opts(['character', 'Character / rig'], ['vehicle', 'Vehicle'], ['weapon', 'Weapon / tool'], ['cutscene', 'Cutscene'], ['ui', 'UI animation'])),
    BASE,
    ask('amount', 'Amount', false, opts(['single', 'One animation'], ['pack', 'Pack of 3–5'], ['large', 'Large pack (6+)'])),
  ],
  music: [
    ask('mtype', 'Music type', true, opts(['loop', 'Background loop'], ['battle', 'Battle'], ['menu', 'Menu / lobby'], ['cinematic', 'Cinematic'], ['jingle', 'Jingles & stingers'], ['sfx', 'Sound effects'])),
    ask('mood', 'Mood', true, opts(['epic', 'Epic'], ['chill', 'Chill'], ['dark', 'Dark / tense'], ['upbeat', 'Upbeat'], ['retro', 'Retro / 8-bit'], ['mystic', 'Mystic'])),
    ask('length', 'Length', false, opts(['short', 'Short loop (under 1 min)'], ['medium', '1–2 minutes'], ['full', 'Full track (2–4 min)'])),
  ],
  vfx: [
    ask('effects', 'Effect types', true, opts(['combat', 'Combat & impacts'], ['abilities', 'Abilities & magic'], ['explosions', 'Explosions'], ['environment', 'Environment (weather, ambient)'], ['trails', 'Trails & auras'], ['screen', 'Screen effects'])),
    ask('intensity', 'Intensity', false, opts(['subtle', 'Subtle'], ['balanced', 'Balanced'], ['extreme', 'Over the top'])),
    ask('quality', 'Performance target', false, opts(['mobile', 'Mobile-friendly'], ['balanced', 'Balanced'], ['high', 'High-end PCs'])),
  ],
  gfx: [
    ask('gtype', 'What for?', true, opts(['icon', 'Game icon'], ['thumb', 'Thumbnails'], ['logo', 'Logo'], ['banner', 'Banner / social'], ['products', 'Gamepass / product icons'], ['render', 'Character render'])),
    ask('style', 'Visual style', false, STYLES),
    ask('count', 'Amount', false, opts(['single', 'Single'], ['set', 'Set of 3'], ['pack', 'Pack of 6+'])),
  ],
  vehicle: [
    {
      id: 'vtype', label: 'Vehicle type', multi: true,
      options: [
        { value: 'car', label: 'Car' }, { value: 'bike', label: 'Motorbike' }, { value: 'truck', label: 'Truck' },
        { value: 'boat', label: 'Boat' }, { value: 'air', label: 'Aircraft' }, { value: 'military', label: 'Tank / military' },
        { value: 'other', label: 'Other' },
      ],
    },
    { id: 'style', label: 'Visual style', multi: false, options: STYLES },
    {
      id: 'features', label: 'Features', multi: true,
      options: [
        { value: 'drift', label: 'Drift physics' }, { value: 'nitro', label: 'Nitro / boost' },
        { value: 'damage', label: 'Damage system' }, { value: 'lights', label: 'Working lights' },
        { value: 'sound', label: 'Engine sound' }, { value: 'custom', label: 'Customization' },
        { value: 'seats', label: 'Passenger seats' }, { value: 'garage', label: 'Garage / spawn UI' },
      ],
    },
  ],
  full_system: [
    {
      id: 'modules', label: 'Modules', multi: true,
      options: [
        { value: 'loop', label: 'Core gameplay loop' }, { value: 'economy', label: 'Economy & shops' },
        { value: 'data', label: 'Data saving' }, { value: 'ui', label: 'UI' }, { value: 'vfx', label: 'VFX & audio' },
        { value: 'assets', label: '3D assets' }, { value: 'admin', label: 'Anti-exploit & admin tools' },
      ],
    },
    { id: 'style', label: 'Visual style', multi: false, options: STYLES },
    {
      id: 'scope', label: 'Scope', multi: false,
      options: [
        { value: 'prototype', label: 'Prototype / vertical slice' }, { value: 'feature', label: 'Full feature' },
        { value: 'polish', label: 'Launch-ready with polish' },
      ],
    },
  ],
};

// ---------- Marketplace: developer roles and rules ----------
export const DEV_ROLES = [
  { key: 'ui', name: 'UI Artist', emoji: '🖼️' },
  { key: 'builder', name: 'Builder', emoji: '🏗️' },
  { key: 'modeller', name: 'Modeller', emoji: '🧊' },
  { key: 'scripter', name: 'Scripter', emoji: '💻' },
  { key: 'animator', name: 'Animator', emoji: '🎞️' },
  { key: 'music', name: 'Music Artist', emoji: '🎵' },
  { key: 'vfx', name: 'VFX Artist', emoji: '🎆' },
  { key: 'gfx', name: 'GFX Artist', emoji: '🎨' },
];

export const DEV_SETTINGS = {
  maxSkills: 3,
  minDiscordAgeDays: 7,  // younger accounts get a red flag on the application
  minRobloxAgeDays: 30,
  reapplyDays: 14,       // wait time after a rejected application
};

export const SERVER_RULES = [
  'Be respectful. No harassment, hate, threats or discrimination.',
  'No scams, fake offers, phishing or "pay me outside" requests. Report them to Support.',
  'Orders, payments and deals happen only through Novai\'s bot and deal channels.',
  'Never share passwords, cookies, 2FA codes or private files with anyone, staff included.',
  'No spam, self-promotion, invite links or unsolicited DMs.',
  'No NSFW, gore or illegal content. Keep it Roblox-friendly.',
  'Staff will never DM you first to ask for payment or login details. If someone does, report them.',
  'Follow Discord\'s Terms of Service and Roblox\'s Terms of Use. Staff decisions are final.',
];

export const CUSTOMER_RULES = [
  'Describe your project accurately. Big changes after a developer accepted need a new order.',
  'The platform fee is paid in Novai Studio. The deal price is paid only the way your deal card shows. Never pay anywhere else.',
  'Keep all talk in your deal channel and never take the developer to DMs. Deal chats are recorded for dispute resolution.',
  '2 revisions are included, for reasonable changes inside the agreed scope.',
  'Confirm the delivery or report a problem within 72 hours. Silence completes the order automatically.',
  'Never ask for free extra work. Scope changes are a new order.',
  'The fee is not refundable once a developer accepted your order. If a developer disappears you get a new developer or a fee credit.',
  'Abuse, chargebacks, harassment or fake disputes lead to a permanent ban.',
];

export const DEV_RULES = [
  'The agreed price is final. No renegotiation after accepting. Extra work is a new order through the bot.',
  'Stay inside the deal channel. No DMs, no other platforms, never move a customer off Novai.',
  'Take payment only the way the deal card shows. Never ask for other Robux, items, gift cards, accounts or personal data.',
  'Never ask for passwords, cookies or 2FA codes, and never ask a customer to run unknown scripts or open unknown links.',
  'Deliver only work you made or are licensed to sell. No stolen, ripped or resold assets presented as your own. Say if you used free models or AI.',
  'Deliver in the time you set. Ask for more time with /extend before the deadline. Silent delays are a strike.',
  'Post honest progress at least every 48 hours (screenshots or videos).',
  'Deliver the complete agreed scope in the agreed format and fix reasonable revision requests (2 are included).',
  'Be professional and respectful. No pressure, insults or spam.',
  'Keep customer projects private. No portfolio use without the customer\'s OK.',
  'Never abandon an order. If you must stop, use /release before work starts or contact Support. Abandoning leads to strikes or removal.',
  'Never delete or edit messages to hide things. Deal chats are recorded. Tampering means removal.',
  'Support decides disputes based on the recorded deal chat. Their decision is final.',
  'Never pretend to be staff and never use another person\'s work, name or account.',
];

// ---------- Marketplace settings ----------
export const FEE = { percent: 10, min: 80 }; // suggested platform fee: % of the deal price (R$), never below min

export const PRIORITY = {
  apex: { minutes: 15, minRating: 4.5, minRatings: 3 }, // top-rated developers see Apex tasks first
  pro: { minutes: 5, minCompleted: 1 },                 // developers with a finished order see Pro tasks first
  essential: { minutes: 0 },                            // everyone, immediately
};

export const TASKS = { setupMinutes: 15, maxActivePerDev: 3, maxChanges: 2, openAlertHours: 12 };