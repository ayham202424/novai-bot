import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  Interaction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { supabase } from './db';
import { CATEGORIES, FEE, PRICING, TEXT, TIERS, type TierKey } from './config';
import { gameUrl, payableRobux } from './roblox';
import { COLORS, card, linkButton, v2 } from './ui';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Order = Record<string, any>;

const pad = (id: number) => String(id).padStart(4, '0');
const fmt = (n: number) => n.toLocaleString('en-US');
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const roleLabel = (category: string) => CATEGORIES.find((c) => c.value === category)?.label ?? 'Developer';

const C = {
  ownerOnly: '🔒 Only the owner can use this.',
  alreadyHandled: 'This was already handled, or the order has moved on.',
  badPrice: `⚠️ Please enter whole numbers. The platform fee must be at least ${FEE.min} R$ and the price at least 50 R$.`,
};

const isAdmin = (i: ButtonInteraction | ModalSubmitInteraction) => i.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;

async function log(orderId: number, actor: string | null, type: string, details: Record<string, unknown> = {}) {
  const { error } = await supabase
    .from('order_events')
    .insert({ order_id: orderId, actor_id: actor, event_type: type, details });
  if (error) console.error('❌ log:', error.message);
}

async function sendTo(client: Client, channelId: string | null | undefined, payload: object) {
  if (!channelId) return null;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (ch && ch.isTextBased() && 'send' in ch) {
    return ch.send(payload as never).catch((e: Error) => {
      console.error('❌ sendTo:', e.message);
      return null;
    });
  }
  return null;
}

const v2msg = (...cards: ReturnType<typeof card>[]) => ({ components: cards, flags: MessageFlags.IsComponentsV2 });

// ---------- Suggestions (you can change both) ----------
export function suggestPrice(tier: TierKey, complexity: number | null): number {
  const p = PRICING[tier];
  const usd = p.base + p.perPoint * (complexity ?? 5);
  return Math.max(100, Math.round((usd * PRICING.robuxPerUsd) / 50) * 50);
}
export const suggestFee = (price: number) => payableRobux(Math.max(FEE.min, Math.round((price * FEE.percent) / 100)));

// ---------- Owner card: your quote decision ----------
function ownerQuoteCard(order: Order, price: number, fee: number, done?: { text: string; accent: number }) {
  const tier = TIERS[order.tier as TierKey];
  const iv = order.interview ?? {};
  const risks: string[] = Array.isArray(iv.risks) ? iv.risks : [];

  const body = [
    `**${clip(order.title ?? '—', 200)}**`,
    '',
    clip(order.specs_summary ?? '—', 1500),
    risks.length ? `\n**⚠️ Risks / open questions**\n${risks.map((r) => `- ${r}`).join('\n')}` : '',
  ].join('\n');

  const buttons = done
    ? undefined
    : [
        new ButtonBuilder().setCustomId(`q-send:${order.id}`).setLabel(`Send quote · ${fmt(price)} R$ + ${fmt(fee)} R$ fee`).setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`q-price:${order.id}`).setLabel('Change price / fee').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`q-decline:${order.id}`).setLabel('Decline').setEmoji('❌').setStyle(ButtonStyle.Danger),
      ];

  return card({
    accent: done?.accent ?? tier.color,
    title: `🆕 Order #${pad(order.id)} · waiting for your quote`,
    body: clip(body, 2400),
    fields: [
      ['Customer', `<@${order.customer_id}>`],
      ['Package', `${tier.emoji} ${tier.name}`],
      ['Role needed', roleLabel(order.category)],
      ['Complexity (AI)', order.complexity_score ? `${order.complexity_score}/10` : 'n/a'],
      ['Suggested deal price', `**${fmt(price)} R$** (goes to the developer)`],
      ['Suggested fee', `**${fmt(fee)} R$** (goes to you)`],
      ['Package fit', String(iv.tier_fit ?? 'unknown')],
      ['Ticket', order.ticket_channel_id ? `<#${order.ticket_channel_id}>` : '—'],
    ],
    buttons,
    footer: done?.text,
  });
}

export async function postQuoteCard(client: Client, order: Order) {
  const price = suggestPrice(order.tier as TierKey, order.complexity_score);
  const fee = suggestFee(price);
  await supabase.from('orders').update({ price_robux: price, fee_robux: fee }).eq('id', order.id);

  const sent = await sendTo(client, process.env.OWNER_CHANNEL_ID, v2msg(ownerQuoteCard(order, price, fee)));
  if (!sent) console.warn('⚠️ Could not post the quote card. Check OWNER_CHANNEL_ID and the bot permissions.');
}

// ---------- Customer card: the receipt ----------
function receiptCard(order: Order, price: number, fee: number) {
  const tier = TIERS[order.tier as TierKey];
  return card({
    accent: tier.color,
    title: '🧾 Your receipt',
    subtitle: `Order #${pad(order.id)} · ${tier.name} · ${roleLabel(order.category)}`,
    body:
      `<@${order.customer_id}> Here is your quote. Pay the **platform fee** in Novai Studio now and your task goes live for our developers right away.`,
    fields: [
      ['Project', clip(order.title ?? '—', 120)],
      ['Deal price', `**${fmt(price)} R$**  ·  paid directly to your developer, after you approved a preview`],
      ['Platform fee', `**${fmt(fee)} R$**  ·  pay now in Novai Studio`],
      ['Total', `${fmt(price + fee)} R$`],
      ['Delivery', `${tier.days} once a developer starts`],
      ['Revisions', `${order.revisions_included ?? 2} included`],
    ],
    buttons: [linkButton('Pay fee in Novai Studio', gameUrl, '🎮')],
    footer: 'The fee is not refundable once a developer accepted your task. If nobody accepts or your developer disappears, you get a new developer or a fee credit.',
  });
}

async function sendQuote(client: Client, orderId: number, price: number, fee: number, actorId: string): Promise<Order | null> {
  const feePay = payableRobux(Math.max(FEE.min, fee)); // rounded up to your product ladder
  const { data: order } = await supabase
    .from('orders')
    .update({ status: 'PAYMENT_PENDING', price_robux: price, fee_robux: feePay })
    .eq('id', orderId)
    .eq('status', 'AWAITING_QUOTE')
    .select()
    .maybeSingle();
  if (!order) return null;

  await supabase.from('payments').update({ status: 'REJECTED' }).eq('order_id', orderId).eq('status', 'PENDING');
  await supabase.from('payments').insert({ order_id: orderId, method: 'robux', amount_robux: feePay, status: 'PENDING' });
  await log(orderId, actorId, 'QUOTE_SENT', { price_robux: price, fee_robux: feePay });

  const sent = await sendTo(client, order.ticket_channel_id, v2msg(receiptCard(order, price, feePay)));
  if (!sent) console.warn(`⚠️ Receipt for order ${orderId} could not be delivered (ticket channel missing?)`);
  return order;
}

// ---------- Owner buttons ----------
async function onQuoteSend(i: ButtonInteraction, orderId: number) {
  if (!isAdmin(i)) return void (await i.reply({ content: C.ownerOnly, flags: MessageFlags.Ephemeral }));

  const { data: cur } = await supabase.from('orders').select('price_robux, fee_robux').eq('id', orderId).maybeSingle();
  const price = Number(cur?.price_robux);
  const fee = Number(cur?.fee_robux);
  if (!price || !fee) return void (await i.reply({ content: C.badPrice, flags: MessageFlags.Ephemeral }));

  const order = await sendQuote(i.client, orderId, price, fee, i.user.id);
  if (!order) return void (await i.reply({ content: C.alreadyHandled, flags: MessageFlags.Ephemeral }));

  await i.update(
    v2msg(ownerQuoteCard(order, price, Number(order.fee_robux), { text: `✅ Quote sent: ${fmt(price)} R$ + ${fmt(Number(order.fee_robux))} R$ fee · by ${i.user.username}`, accent: COLORS.success }))
  );
}

async function onQuotePriceButton(i: ButtonInteraction, orderId: number) {
  if (!isAdmin(i)) return void (await i.reply({ content: C.ownerOnly, flags: MessageFlags.Ephemeral }));
  const { data: cur } = await supabase.from('orders').select('price_robux, fee_robux').eq('id', orderId).maybeSingle();

  const field = (id: string, label: string, value?: number) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(true);
    if (value) t.setValue(String(value));
    return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
  };
  await i.showModal(
    new ModalBuilder()
      .setCustomId(`q-price-form:${orderId}`)
      .setTitle(`Quote for order #${pad(orderId)}`)
      .addComponents(
        field('price', 'Deal price in R$ (goes to the developer)', cur?.price_robux),
        field('fee', `Platform fee in R$ (min ${FEE.min})`, cur?.fee_robux)
      )
  );
}

const wholeNumber = (s: string) => Math.round(Number(s.replace(/[^0-9]/g, '')));

async function onQuotePriceSubmit(i: ModalSubmitInteraction, orderId: number) {
  if (!isAdmin(i)) return void (await i.reply({ content: C.ownerOnly, flags: MessageFlags.Ephemeral }));

  const price = wholeNumber(i.fields.getTextInputValue('price'));
  const fee = wholeNumber(i.fields.getTextInputValue('fee'));
  if (!Number.isFinite(price) || price < 50 || !Number.isFinite(fee) || fee < FEE.min) {
    return void (await i.reply({ content: C.badPrice, flags: MessageFlags.Ephemeral }));
  }

  const order = await sendQuote(i.client, orderId, price, fee, i.user.id);
  if (!order) return void (await i.reply({ content: C.alreadyHandled, flags: MessageFlags.Ephemeral }));

  const done = {
    text: `✅ Quote sent: ${fmt(price)} R$ + ${fmt(Number(order.fee_robux))} R$ fee (adjusted) · by ${i.user.username}`,
    accent: COLORS.success,
  };
  if (i.isFromMessage()) await i.update(v2msg(ownerQuoteCard(order, price, Number(order.fee_robux), done)));
  else await i.reply({ content: '✅ Quote sent.', flags: MessageFlags.Ephemeral });
}

async function onQuoteDeclineButton(i: ButtonInteraction, orderId: number) {
  if (!isAdmin(i)) return void (await i.reply({ content: C.ownerOnly, flags: MessageFlags.Ephemeral }));
  await i.showModal(
    new ModalBuilder()
      .setCustomId(`q-decline-form:${orderId}`)
      .setTitle(`Decline order #${pad(orderId)}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason (the customer will see this)')
            .setPlaceholder('e.g. This is outside what we can deliver right now.')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(300)
            .setRequired(true)
        )
      )
  );
}

async function onQuoteDeclineSubmit(i: ModalSubmitInteraction, orderId: number) {
  if (!isAdmin(i)) return void (await i.reply({ content: C.ownerOnly, flags: MessageFlags.Ephemeral }));
  const reason = i.fields.getTextInputValue('reason').trim().slice(0, 300);

  const { data: order } = await supabase
    .from('orders')
    .update({ status: 'CANCELLED', cancel_reason: `declined: ${reason}` })
    .eq('id', orderId)
    .in('status', ['AWAITING_QUOTE', 'ESCALATED'])
    .select()
    .maybeSingle();
  if (!order) return void (await i.reply({ content: C.alreadyHandled, flags: MessageFlags.Ephemeral }));

  await log(orderId, i.user.id, 'ORDER_DECLINED', { reason });

  const notice = v2msg(
    card({
      accent: COLORS.danger,
      title: `Order #${pad(orderId)} update`,
      body:
        `<@${order.customer_id}> Unfortunately we can't take on this order right now.\n\n**Reason:** ${reason}\n\n` +
        "This ticket will close in 60 seconds. You're welcome to open a new order anytime.",
      footer: TEXT.footer,
    })
  );
  await sendTo(i.client, order.ticket_channel_id, notice);
  const user = await i.client.users.fetch(order.customer_id).catch(() => null);
  await user?.send(notice as never).catch(() => null);

  setTimeout(async () => {
    const ch = order.ticket_channel_id ? await i.client.channels.fetch(order.ticket_channel_id).catch(() => null) : null;
    await ch?.delete().catch(() => null);
  }, 60_000);

  const done = { text: `❌ Declined · by ${i.user.username}`, accent: COLORS.danger };
  const card1 = ownerQuoteCard(order, Number(order.price_robux ?? 0), Number(order.fee_robux ?? 0), done);
  if (i.isFromMessage()) await i.update(v2msg(card1));
  else await i.reply({ content: '❌ Order declined.', flags: MessageFlags.Ephemeral });
}

// ---------- Router ----------
export async function handleCockpitInteraction(i: Interaction): Promise<boolean> {
  try {
    if (i.isButton()) {
      const [kind, a] = i.customId.split(':');
      if (kind === 'q-send') { await onQuoteSend(i, Number(a)); return true; }
      if (kind === 'q-price') { await onQuotePriceButton(i, Number(a)); return true; }
      if (kind === 'q-decline') { await onQuoteDeclineButton(i, Number(a)); return true; }
    }
    if (i.isModalSubmit()) {
      const [kind, a] = i.customId.split(':');
      if (kind === 'q-price-form') { await onQuotePriceSubmit(i, Number(a)); return true; }
      if (kind === 'q-decline-form') { await onQuoteDeclineSubmit(i, Number(a)); return true; }
    }
  } catch (err) {
    console.error('❌ Cockpit error:', err);
    if (i.isRepliable()) {
      const msg = { content: TEXT.genericError, flags: MessageFlags.Ephemeral } as const;
      if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
    return true;
  }
  return false;
}