import { fastLoad } from './safe';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Interaction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { supabase } from './db';
import { BRIEF_QUESTIONS, CATEGORIES, GAME_TYPES, PLATFORMS, TEXT, TIERS, type TierKey } from './config';
import { COLORS, card, v2, v2Ephemeral } from './ui';
import { checkScope } from './scope';
import { summaryLines, type Brief } from './briefdata';
import { generateSpec } from './interview';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Order = Record<string, any>;

const pad = (id: number) => String(id).padStart(4, '0');
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);

const opt = (value: string, label: string, emoji: string | undefined, selected: boolean) => {
  const o = new StringSelectMenuOptionBuilder().setValue(value).setLabel(label).setDefault(selected);
  if (emoji) o.setEmoji(emoji);
  return o;
};

const btn = (customId: string, label: string, style: ButtonStyle, emoji?: string, disabled = false) => {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
  if (emoji) b.setEmoji(emoji);
  return b;
};

const dropdown = (customId: string, placeholder: string, options: StringSelectMenuOptionBuilder[], min: number, max: number) =>
  new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(clip(placeholder, 150))
    .setMinValues(min)
    .setMaxValues(Math.min(25, Math.max(min, max)))
    .addOptions(options);

const parseOrderId = (raw: string | undefined) => {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
};

// Title, body, rules, the button row and the footer already use 7 of a container's 10 slots.
const MAX_DETAIL_QUESTIONS = 3;

// ---------- The wizard message (3 pages, one message that updates itself) ----------
export function wizardMessage(order: Order) {
  const brief: Brief = order.brief ?? {};
  const step = Math.min(3, Math.max(0, brief.step ?? 1));
  const tier = TIERS[order.tier as TierKey];
  const id = order.id;
  const subtitle = `Order #${pad(id)} · ${tier.name} · ${'●'.repeat(step)}${'○'.repeat(3 - step)}`;
  const close = btn(`close:${id}`, 'Close ticket', ButtonStyle.Secondary, '🔒');

  if (step === 0) {
    return v2(
      card({
        accent: tier.color,
        title: 'Before we start · Who are you?',
        subtitle,
        body:
          'Link your **Roblox account**. This tells your developer who you are, protects both sides from scams and sets your server nickname to your Roblox name. ' +
          'It takes about 20 seconds and you only do it once.',
        buttons: [
          btn(`idn:start:${id}`, 'Link Roblox account', ButtonStyle.Success, '🔗'),
          btn(`bnext:${id}`, 'I already linked', ButtonStyle.Secondary, '🔄'),
          close,
        ],
        footer: TEXT.footer,
      })
    );
  }

  if (step === 1) {
    const selects = [
      dropdown(
        `bq:${id}:game`,
        '🎮 What kind of game is it for?',
        GAME_TYPES.map((g) => opt(g.value, g.label, g.emoji, brief.game === g.value)),
        1,
        1
      ),
      dropdown(
        `bq:${id}:category`,
        '🧰 What do you need?',
        CATEGORIES.map((c) => opt(c.value, c.label, c.emoji, brief.category === c.value)),
        1,
        1
      ),
    ];
    const ready = Boolean(brief.game && brief.category);
    return v2(
      card({
        accent: tier.color,
        title: 'Step 1 of 3 · The basics',
        subtitle,
        body: 'Pick your game type and what you need. The whole briefing takes about two minutes.',
        selects,
        buttons: [btn(`bnext:${id}`, 'Next', ButtonStyle.Primary, '▶️', !ready), close],
        footer: TEXT.footer,
      })
    );
  }

  if (step === 2) {
    const questions = (brief.category ? BRIEF_QUESTIONS[brief.category] ?? [] : []).slice(0, MAX_DETAIL_QUESTIONS);

    const selects = questions.flatMap((q) => {
      const choices = q.options.slice(0, 25);
      if (!choices.length) return [];
      return [dropdown(
        `bq:${id}:${q.id}`,
        q.multi ? `${q.label} (pick any)` : q.label,
        choices.map((o) => opt(o.value, clip(o.label, 100), o.emoji, (brief.answers?.[q.id] ?? []).includes(o.value))),
        0,
        q.multi ? choices.length : 1
      )];
    });
    return v2(
      card({
        accent: tier.color,
        title: 'Step 2 of 3 · The details',
        subtitle,
        body: 'Choose what fits. Everything here is optional, so skip what you are unsure about.',
        selects,
        buttons: [btn(`bback:${id}`, 'Back', ButtonStyle.Secondary, '◀️'), btn(`bnext:${id}`, 'Next', ButtonStyle.Primary, '▶️'), close],
        footer: TEXT.footer,
      })
    );
  }

  // Step 3: describe the project
  const lines = summaryLines(brief);
  const hasText = Boolean(brief.title && brief.description);
  const body = hasText
    ? [
        ...lines,
        '',
        `**Project**  ${clip(brief.title, 100)}`,
        clip(brief.description, 900)
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n'),
        brief.references ? `**References**  ${clip(brief.references, 300)}` : '',
      ]
        .filter((l) => l !== '')
        .join('\n')
    : [...lines, '', 'Last step: tell us what you want built. The more specific you are, the more accurate your quote will be.'].join('\n');

  return v2(
    card({
      accent: tier.color,
      title: 'Step 3 of 3 · Your project',
      subtitle,
      body,
      buttons: hasText
        ? [
            btn(`bcreate:${id}`, 'Create specification', ButtonStyle.Success, '✅'),
            btn(`bdesc:${id}`, 'Edit description', ButtonStyle.Secondary, '✏️'),
            btn(`bback:${id}`, 'Back', ButtonStyle.Secondary, '◀️'),
            close,
          ]
        : [btn(`bdesc:${id}`, 'Describe your project', ButtonStyle.Primary, '📝'), btn(`bback:${id}`, 'Back', ButtonStyle.Secondary, '◀️'), close],
      footer: TEXT.footer,
    })
  );
}

// ---------- Helpers ----------
async function loadOwned(
  i: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  orderId: number
): Promise<Order | null> {
  const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (!order) {
    await i.reply({ content: TEXT.genericError, flags: MessageFlags.Ephemeral });
    return null;
  }
  if (order.customer_id !== i.user.id) {
    await i.reply({ content: TEXT.notOwner, flags: MessageFlags.Ephemeral });
    return null;
  }
  if (order.status !== 'DRAFT') {
    await i.reply({ content: TEXT.alreadySubmitted, flags: MessageFlags.Ephemeral });
    return null;
  }
  return order;
}

async function saveBrief(orderId: number, brief: Brief, extra: Record<string, unknown> = {}) {
  const { error } = await supabase.from('orders').update({ brief, ...extra }).eq('id', orderId);
  if (error) console.error('❌ saveBrief:', error.message);
  return !error;
}

async function showWizard(
  i: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  order: Order
) {
  const message = wizardMessage(order);
  if (i.isModalSubmit()) {
    if (!i.isFromMessage()) {
      await i.reply({ content: TEXT.genericError, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.update(message);
    return;
  }
  await i.update(message);
}

// ---------- Handlers ----------
async function onSelect(i: StringSelectMenuInteraction, orderId: number, qid: string) {
  const order = await loadOwned(i, orderId);
  if (!order) return;
  const brief: Brief = { ...(order.brief ?? {}) };
  const extra: Record<string, unknown> = {};

  if (qid === 'game') {
    const game = i.values[0];
    if (!game || !GAME_TYPES.some((g) => g.value === game)) {
      await showWizard(i, order);
      return;
    }
    brief.game = game;
    extra.game_type = brief.game;
  } else if (qid === 'category') {
    const category = i.values[0];
    if (!category || !CATEGORIES.some((c) => c.value === category)) {
      await showWizard(i, order);
      return;
    }
    if (brief.category !== category) brief.answers = {}; // answers belong to the old category
    brief.category = category;
    extra.category = brief.category;
  } else if (qid === 'platforms') {
    brief.platforms = i.values.filter((v) => PLATFORMS.some((p) => p.value === v));
  } else {
    const q = (BRIEF_QUESTIONS[brief.category ?? ''] ?? []).find((x) => x.id === qid);
    if (!q) {
      await showWizard(i, order);
      return;
    }
    brief.answers = { ...(brief.answers ?? {}), [qid]: i.values.filter((v) => q.options.some((o) => o.value === v)) };
  }

  const saved = await saveBrief(orderId, brief, extra);
  await showWizard(i, saved ? { ...order, ...extra, brief } : order);
  if (!saved) await i.followUp({ content: TEXT.genericError, flags: MessageFlags.Ephemeral });
}

async function onNav(i: ButtonInteraction, orderId: number, dir: 1 | -1) {
  const order = await loadOwned(i, orderId);
  if (!order) return;
  const brief: Brief = { ...(order.brief ?? {}) };
  const step = brief.step ?? 1;

  if (dir === 1 && step === 1 && (!brief.game || !brief.category)) {
    await i.reply({ content: 'Please choose a game type and a category first.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (dir === 1 && step === 0) {
    const { data: linked } = await supabase.from('customers').select('roblox_id').eq('discord_id', i.user.id).maybeSingle();
    if (!linked?.roblox_id) {
      await i.reply({ content: 'Please link your Roblox account first.', flags: MessageFlags.Ephemeral });
      return;
    }
  }
  brief.step = Math.min(3, Math.max(0, step + dir));
  const saved = await saveBrief(orderId, brief);
  await showWizard(i, saved ? { ...order, brief } : order);
  if (!saved) await i.followUp({ content: TEXT.genericError, flags: MessageFlags.Ephemeral });
}

async function onDescribe(i: ButtonInteraction, orderId: number) {
  // The popup must open within 3 seconds, so we only wait briefly for the old text to pre-fill it.
  // Ownership is checked again when the form is submitted (onFormSubmit).
  const fast = await fastLoad(supabase.from('orders').select('brief').eq('id', orderId).maybeSingle());
  const brief: Brief = (fast?.data?.brief as Brief | undefined) ?? {};

  const title = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Project title')
    .setPlaceholder('e.g. 3 realistic sports cars with drift physics')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);
  if (brief.title) title.setValue(clip(brief.title, 100));

  const description = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('What should we build?')
    .setPlaceholder('Describe your idea. Details about look, behaviour and your game help a lot.')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(20)
    .setMaxLength(1000)
    .setRequired(true);
  if (brief.description) description.setValue(clip(brief.description, 1000));

  const references = new TextInputBuilder()
    .setCustomId('references')
    .setLabel('Reference links (optional)')
    .setPlaceholder('Images, videos or games that show what you have in mind')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(300)
    .setRequired(false);
  if (brief.references) references.setValue(clip(brief.references, 300));

  await i.showModal(
    new ModalBuilder()
      .setCustomId(`bform:${orderId}`)
      .setTitle('Describe your project')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(title),
        new ActionRowBuilder<TextInputBuilder>().addComponents(description),
        new ActionRowBuilder<TextInputBuilder>().addComponents(references)
      )
  );
}

async function onFormSubmit(i: ModalSubmitInteraction, orderId: number) {
  const order = await loadOwned(i, orderId);
  if (!order) return;
  const brief: Brief = { ...(order.brief ?? {}) };
  brief.title = i.fields.getTextInputValue('title').trim();
  brief.description = i.fields.getTextInputValue('description').trim();
  brief.references = i.fields.getTextInputValue('references').trim();
  brief.step = 3;

  const saved = await saveBrief(orderId, brief, { title: brief.title, instructions: brief.description });
  const next = saved ? { ...order, title: brief.title, instructions: brief.description, brief } : order;
  await showWizard(i, next);
  if (!saved) await i.followUp({ content: TEXT.genericError, flags: MessageFlags.Ephemeral });
}

async function onCreate(i: ButtonInteraction, orderId: number) {
  const order = await loadOwned(i, orderId);
  if (!order) return;
  const brief: Brief = order.brief ?? {};
  if (!brief.game || !brief.category || !brief.title || !brief.description) {
    await i.reply({ content: 'Please describe your project first.', flags: MessageFlags.Ephemeral });
    return;
  }

  const scope = checkScope(brief);
  if (scope.block) {
    await i.reply(v2Ephemeral(card({ accent: COLORS.warn, title: scope.block.title, body: scope.block.body, footer: TEXT.footer })));
    return;
  }

  // Claim the order so a double click can't create two specifications
  const { data: claimed } = await supabase
    .from('orders')
    .update({ status: 'INTERVIEW' })
    .eq('id', orderId)
    .eq('status', 'DRAFT')
    .select()
    .maybeSingle();
  if (!claimed) {
    await i.reply({ content: TEXT.alreadySubmitted, flags: MessageFlags.Ephemeral });
    return;
  }

  const tier = TIERS[claimed.tier as TierKey];
  let specPosted = false;
  try {
    await i.update(
      v2(
        card({
          accent: COLORS.brand,
          title: '⏳ Creating your specification…',
          subtitle: `Order #${pad(orderId)} · ${tier.name}`,
          body: 'Our assistant is turning your answers into a clear specification. This takes a few seconds.',
        })
      )
    );

    const channel = i.channel;
    if (!channel || !('send' in channel)) {
      throw new Error('Cannot create a specification outside a sendable text channel');
    }
    await generateSpec(channel as TextChannel, claimed);
    specPosted = true;
    await i.editReply(
      v2(
        card({
          accent: COLORS.success,
          title: '✅ Brief submitted',
          subtitle: `Order #${pad(orderId)} · ${tier.name}`,
          body: summaryLines(brief).join('\n'),
          footer: TEXT.footer,
        })
      )
    );
  } catch (err) {
    console.error('❌ spec:', err);
    if (!specPosted) {
      await supabase.from('orders').update({ status: 'DRAFT' }).eq('id', orderId).eq('status', 'INTERVIEW');
    }
    const notice = { content: TEXT.genericError, flags: MessageFlags.Ephemeral } as const;
    if (specPosted) {
      await i.followUp({
        content: 'Your specification was created. If the message above is still loading, use the new message in this channel.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }
    if (i.replied || i.deferred) {
      await i.editReply(wizardMessage({ ...claimed, status: 'DRAFT', brief })).catch(() => {});
      await i.followUp(notice).catch(() => {});
    } else {
      await i.reply(notice).catch(() => {});
    }
  }
}

// "Edit brief" on the review card: reopens the wizard
export async function onEditBrief(i: ButtonInteraction, orderId: number) {
  const { data: order } = await supabase
    .from('orders')
    .update({ status: 'DRAFT' })
    .eq('id', orderId)
    .eq('customer_id', i.user.id)
    .eq('status', 'AWAITING_CONFIRMATION')
    .select()
    .maybeSingle();
  if (!order) {
    await i.reply({ content: TEXT.alreadySubmitted, flags: MessageFlags.Ephemeral });
    return;
  }
  const brief: Brief = { ...(order.brief ?? {}), step: 1 };
  await saveBrief(orderId, brief);
  await i.update(
    v2(
      card({
        accent: COLORS.warn,
        title: '✏️ Brief reopened',
        body: 'Update your answers in the message below, then create a new specification.',
      })
    )
  );
  if (i.channel && 'send' in i.channel) await i.channel.send(wizardMessage({ ...order, brief }));
}

// ---------- Router ----------
export async function handleBriefInteraction(i: Interaction): Promise<boolean> {
  const reject = async () => {
    if (i.isRepliable() && !i.replied && !i.deferred) {
      await i.reply({ content: TEXT.genericError, flags: MessageFlags.Ephemeral });
    }
  };

  if (i.isStringSelectMenu() && i.customId.startsWith('bq:')) {
    const [, id, qid] = i.customId.split(':');
    const orderId = parseOrderId(id);
    if (orderId == null || !qid) {
      await reject();
      return true;
    }
    await onSelect(i, orderId, qid);
    return true;
  }
  if (i.isButton()) {
    const [kind, id] = i.customId.split(':');
    if (kind !== 'bnext' && kind !== 'bback' && kind !== 'bdesc' && kind !== 'bcreate') return false;
    const orderId = parseOrderId(id);
    if (orderId == null) {
      await reject();
      return true;
    }
    if (kind === 'bnext') await onNav(i, orderId, 1);
    else if (kind === 'bback') await onNav(i, orderId, -1);
    else if (kind === 'bdesc') await onDescribe(i, orderId);
    else await onCreate(i, orderId);
    return true;
  }
  if (i.isModalSubmit() && i.customId.startsWith('bform:')) {
    const orderId = parseOrderId(i.customId.split(':')[1]);
    if (orderId == null) {
      await reject();
      return true;
    }
    await onFormSubmit(i, orderId);
    return true;
  }
  return false;
}