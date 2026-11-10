import { ButtonBuilder, ButtonInteraction, ButtonStyle, Client, MessageFlags, TextChannel } from 'discord.js';
import { supabase } from './db';
import { aiSummary } from './ai';
import { TEXT, TIERS, type TierKey } from './config';
import { briefToQa } from './briefdata';
import { checkScope } from './scope';
import { COLORS, card, v2 } from './ui';
import { postQuoteCard } from './cockpit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Order = Record<string, any>;

const pad = (id: number) => String(id).padStart(4, '0');
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const NOT_YOURS = 'This is only available to the ticket owner, or the order has already moved on.';

async function log(orderId: number, actor: string | null, type: string, details: Record<string, unknown> = {}) {
  const { error } = await supabase
    .from('order_events')
    .insert({ order_id: orderId, actor_id: actor, event_type: type, details });
  if (error) console.error('❌ log:', error.message);
}

const btn = (customId: string, label: string, style: ButtonStyle, emoji: string) =>
  new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setEmoji(emoji);

export function specCard(order: Order, mode: 'review' | 'confirmed') {
  const tier = TIERS[order.tier as TierKey];
  const iv = order.interview ?? {};
  const warn =
    iv.tier_fit === 'too_big'
      ? `\n\n⚠️ This looks bigger than a typical **${tier.name}** order. Our team may suggest a higher package in your quote.`
      : '';
  const intro = mode === 'review' ? 'Please check the summary. If everything is right, confirm it and we prepare your quote.\n\n' : '';

  return card({
    accent: mode === 'confirmed' ? COLORS.success : tier.color,
    title: '📋 Your specification',
    subtitle: `Order #${pad(order.id)} · ${tier.name}`,
    body: intro + clip(order.specs_summary, 2600) + warn,
    buttons:
      mode === 'review'
        ? [
            btn(`confirm:${order.id}`, 'Confirm specification', ButtonStyle.Success, '✅'),
            btn(`editbrief:${order.id}`, 'Edit brief', ButtonStyle.Secondary, '✏️'),
            btn(`human:${order.id}`, 'Talk to a human', ButtonStyle.Secondary, '🙋'),
          ]
        : undefined,
    footer: mode === 'confirmed' ? '✅ Confirmed. Our team is preparing your quote.' : TEXT.footer,
  });
}

// ---------- Writes the specification from the brief (one AI call, with a safe fallback) ----------
export async function generateSpec(channel: TextChannel, order: Order): Promise<void> {
  await channel.sendTyping().catch(() => {});
  const qa = briefToQa(order);
  const ai = await aiSummary(order as never, qa);

  const fallback = [
    `- **${clip(order.title, 120)}**`,
    ...qa.map((x) => `- ${x.q}: ${x.a}`),
    `- ${clip(order.instructions, 500)}`,
  ].join('\n');
  const summary = ai?.summary ?? fallback;
  const deliverables = ai?.deliverables ?? [];
  const scope = checkScope(order.brief ?? {});
  const specs =
    summary +
    (deliverables.length ? '\n\n**Deliverables**\n' + deliverables.map((d) => `- ${d}`).join('\n') : '') +
    (scope.notes.length ? '\n\n**⚠️ Scope check**\n' + scope.notes.map((n) => `- ${n}`).join('\n') : '');
    
  const { data: updated, error } = await supabase
    .from('orders')
    .update({
      status: 'AWAITING_CONFIRMATION',
      specs_summary: specs,
      complexity_score: ai?.complexity ?? null,
      interview: { risks: ai?.risks ?? [], tier_fit: ai?.tier_fit ?? 'unknown', ai: Boolean(ai) },
    })
    .eq('id', order.id)
    .select()
    .single();
  if (error || !updated) throw new Error(error?.message ?? 'could not save the specification');

  await log(order.id, null, 'SPECS_GENERATED', { ai: Boolean(ai), complexity: ai?.complexity ?? null });
  await channel.send({ ...v2(specCard(updated, 'review')), flags: MessageFlags.IsComponentsV2 });
}

// ---------- Customer confirms ----------
export async function onConfirmSpecs(i: ButtonInteraction, orderId: number) {
  const { data: order } = await supabase
    .from('orders')
    .update({ status: 'AWAITING_QUOTE' })
    .eq('id', orderId)
    .eq('customer_id', i.user.id)
    .eq('status', 'AWAITING_CONFIRMATION')
    .select()
    .maybeSingle();
  if (!order) {
    await i.reply({ content: NOT_YOURS, flags: MessageFlags.Ephemeral });
    return;
  }

  await i.update({
    ...v2(specCard(order, 'confirmed')),
    flags: MessageFlags.IsComponentsV2,
  });
  await log(orderId, i.user.id, 'SPECS_CONFIRMED');
  await postQuoteCard(i.client, order); // the owner gets the price suggestion
}

// ---------- Customer asks for a human ----------
async function notifyOwner(client: Client, content: string) {
  const id = process.env.OWNER_CHANNEL_ID;
  if (!id) return;
  const ch = await client.channels.fetch(id).catch(() => null);
  if (ch && ch.isTextBased() && 'send' in ch) await ch.send({ content }).catch((e: Error) => console.error('❌ notifyOwner:', e.message));
}

export async function onAskHuman(i: ButtonInteraction, orderId: number) {
  const { data: before } = await supabase.from('orders').select('status').eq('id', orderId).maybeSingle();
  const { data: order } = await supabase
    .from('orders')
    .update({ status: 'ESCALATED' })
    .eq('id', orderId)
    .eq('customer_id', i.user.id)
    .in('status', ['DRAFT', 'INTERVIEW', 'AWAITING_CONFIRMATION', 'AWAITING_QUOTE', 'PAYMENT_PENDING'])
    .select()
    .maybeSingle();
  if (!order) {
    await i.reply({ content: NOT_YOURS, flags: MessageFlags.Ephemeral });
    return;
  }

  await log(orderId, i.user.id, 'ESCALATED', { previous_status: before?.status ?? null });
  await i.reply({
    ...v2(
      card({
        accent: COLORS.warn,
        title: '🙋 A human is on the way',
        body: `<@${order.customer_id}> A team member has been notified and will join this ticket soon. Please stay tuned!`,
        footer: TEXT.footer,
      })
    ),
    flags: MessageFlags.IsComponentsV2,
  });
  await notifyOwner(i.client, `🚨 **Order #${pad(orderId)}** needs a human: <@${order.customer_id}> asked for help → <#${order.ticket_channel_id}>`);
}