import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type InteractionReplyOptions,
} from 'discord.js';
import { TEXT, TIERS } from './config';

export const COLORS = { brand: 0x5865f2, success: 0x2ecc71, warn: 0xf1c40f, danger: 0xe74c3c };

const sep = (divider = true) => new SeparatorBuilder().setDivider(divider).setSpacing(SeparatorSpacingSize.Small);
const text = (content: string) => new TextDisplayBuilder().setContent(content);

export const progressBar = (pct: number, length = 12) => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * length);
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
};

export function linkButton(label: string, url: string, emoji?: string) {
  const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export type CardOptions = {
  accent?: number;
  title: string;
  subtitle?: string;
  body?: string;
  thumbnail?: string;
  fields?: [string, string][];
  // One menu, or a row that already holds one menu. Each menu is placed on its own row.
  selects?: Array<StringSelectMenuBuilder | ActionRowBuilder<StringSelectMenuBuilder>>;
  footer?: string;
  buttons?: ButtonBuilder[];
};

// Discord allows about 4000 characters of text per message, so long bodies are trimmed
const TEXT_BUDGET = 3700;
const CONTAINER_LIMIT = 10;

function unwrapSelect(component: StringSelectMenuBuilder | ActionRowBuilder<StringSelectMenuBuilder>) {
  if (!(component instanceof ActionRowBuilder)) return component;
  const select = component.components.find((child) => child instanceof StringSelectMenuBuilder);
  if (!(select instanceof StringSelectMenuBuilder)) {
    throw new TypeError('Each card select row needs one string select menu');
  }
  return select;
}

export function card(o: CardOptions) {
  const used =
    o.title.length +
    (o.subtitle?.length ?? 0) +
    (o.footer?.length ?? 0) +
    (o.fields?.reduce((n, [k, v]) => n + k.length + v.length + 4, 0) ?? 0) +
    30;
  const room = Math.max(200, TEXT_BUDGET - used);
  const body = o.body && o.body.length > room ? o.body.slice(0, room - 1) + '…' : o.body;

  const c = new ContainerBuilder().setAccentColor(o.accent ?? COLORS.brand);
  const header = `## ${o.title}${o.subtitle ? `\n-# ${o.subtitle}` : ''}`;

  if (o.thumbnail) {
    const section = new SectionBuilder().addTextDisplayComponents(text(header));
    if (body) section.addTextDisplayComponents(text(body));
    section.setThumbnailAccessory(new ThumbnailBuilder().setURL(o.thumbnail));
    c.addSectionComponents(section);
  } else {
    c.addTextDisplayComponents(text(header));
    if (body) {
      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(text(body));
    }
  }
  if (o.fields?.length) {
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(text(o.fields.map(([k, v]) => `**${k}**  ${v}`).join('\n')));
  }
  if (o.selects?.length) {
    c.addSeparatorComponents(sep(false));
    for (const s of o.selects) {
      c.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(unwrapSelect(s)));
    }
  }
  if (o.buttons?.length) {
    c.addSeparatorComponents(sep(false));
    c.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(o.buttons));
  }
  if (o.footer) c.addTextDisplayComponents(text(`-# ${o.footer}`));
  if (c.components.length > CONTAINER_LIMIT) {
    throw new Error(`Card has ${c.components.length} components; a Discord container allows ${CONTAINER_LIMIT}`);
  }
  return c;
}

type V2Message = { components: ContainerBuilder[]; flags: MessageFlags.IsComponentsV2 };
type V2EphemeralMessage = Pick<InteractionReplyOptions, 'components' | 'flags'>;

export function v2(...cards: ContainerBuilder[]): V2Message {
  return { components: cards, flags: MessageFlags.IsComponentsV2 };
}

export function v2Ephemeral(...cards: ContainerBuilder[]): V2EphemeralMessage {
  return {
    components: cards,
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

// The dashboard: one clean card, the buttons sit right next to each package
export function buildDashboard() {
  const styles = { essential: ButtonStyle.Success, pro: ButtonStyle.Primary, apex: ButtonStyle.Danger } as const;
  const c = new ContainerBuilder().setAccentColor(COLORS.brand);
  c.addTextDisplayComponents(
    text(
      '# ⚡ NOVAI\n**Roblox development, built like a studio.**\n' +
        'Scripts · 3D models · VFX · UI. Briefed in minutes, tracked live, paid in Robux.'
    )
  );
  c.addSeparatorComponents(sep());
  for (const [key, t] of Object.entries(TIERS)) {
    c.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(`### ${t.emoji} ${t.name}\n${t.description}\n-# ⏱️ ${t.days}`))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`tier:${key}`)
            .setLabel('Select')
            .setStyle(styles[key as keyof typeof styles])
        )
    );
  }
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(
    text(`-# 🟩 Robux payments are confirmed automatically · 🔒 Your project stays private · ${TEXT.footer}`)
  );
  return c;
}