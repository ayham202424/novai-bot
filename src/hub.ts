import { ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, Client, MessageFlags, SlashCommandBuilder, TextChannel } from 'discord.js';
import { supabase } from './db';
import { CATEGORIES, SETTINGS, TEXT, TIERS, type TierKey } from './config';
import { COLORS, card, progressBar, v2, v2Ephemeral } from './ui';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Order = Record<string, any>;
type Queue = { position: number | null; total: number };

const pad = (id: number) => String(id).padStart(4, '0');
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const fmt = (n: number) => n.toLocaleString('en-US');
const ts = (iso: string, style: 'R' | 'D' | 'f' = 'R') => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;
const TERMINAL = '(COMPLETED,CANCELLED,EXPIRED)';
const STEPS = ['Brief', 'Quote', 'Fee', 'Match', 'Build', 'Delivery'];
const CLOSABLE = ['DRAFT', 'INTERVIEW', 'AWAITING_CONFIRMATION'];
const HUMAN_OK = ['DRAFT', 'INTERVIEW', 'AWAITING_CONFIRMATION', 'AWAITING_QUOTE', 'PAYMENT_PENDING'];

function stepIndex(o: Order): number {
  switch (o.status) {
    case 'DRAFT':
    case 'INTERVIEW':
    case 'AWAITING_CONFIRMATION': return 0;
    case 'AWAITING_QUOTE': return 1;
    case 'PAYMENT_PENDING':
    case 'PAYMENT_VERIFICATION_REQUIRED': return 2;
    case 'OPEN':
    case 'ASSIGNED': return 3;
    case 'IN_QUEUE':
    case 'IN_PROGRESS':
    case 'REVISION':
    case 'DISPUTED': return 4;
    case 'IN_REVIEW':
    case 'READY_FOR_DELIVERY':
    case 'DELIVERED': return 5;
    case 'COMPLETED': return 6;
    case 'ESCALATED': return o.price_robux ? 1 : 0;
    default: return 0;
  }
}

function stepper(o: Order) {
  const cur = stepIndex(o);
  return STEPS.map((name, i) => `${i < cur ? '✅' : i === cur ? '🔵' : '⚪'} ${i === cur ? `**${name}**` : name}`).join('  ·  ');
}

function nowText(o: Order, q: Queue): string {
  switch (o.status) {
    case 'DRAFT':
      if ((o.brief?.step ?? 1) === 0) {
        return '🔗 **First, link your Roblox account.** It takes about 20 seconds and protects you and your developer.';
      }
      return `📝 **Let's set up your project.** Answer the quick questions below, it takes about two minutes.\n-# ⏱️ This ticket closes automatically after ${SETTINGS.draftTimeoutMinutes} minutes without activity, until you confirm your specification.`;
    case 'INTERVIEW': return '⏳ **Creating your specification…**';
    case 'AWAITING_CONFIRMATION': return '📋 **Your specification is ready.** Please review it and confirm.';
    case 'AWAITING_QUOTE': return '💬 **Our team is preparing your quote.** You will get it right here.';
    case 'PAYMENT_PENDING':
      return '🧾 **Your receipt is ready.** Pay the platform fee in **Novai Studio** and your task goes live.';
    case 'PAYMENT_VERIFICATION_REQUIRED': return '🔍 **We are verifying your payment.**';
    case 'OPEN':
      return (
        '📋 **Your task is live on the developer board.** The first developer who accepts it gets it, and you will be notified right here.' +
        (o.priority_until && new Date(o.priority_until) > new Date() ? `\n-# ⭐ Top developers see it first until ${ts(o.priority_until)}` : '')
      );
    case 'ASSIGNED': return `🤝 **<@${o.dev_id}> accepted your task** and is getting things ready.`;
    case 'IN_QUEUE': return q.position ? `🕒 **You are in the queue** at position **#${q.position}** of ${q.total}.` : '🕒 **You are in the queue.**';
    case 'IN_PROGRESS': {
      const pct = Number(o.progress ?? 0);
      return `🛠️ **In development** with <@${o.dev_id}>\n${progressBar(pct)}  ${pct}%${o.progress_note ? ` · ${clip(o.progress_note, 120)}` : ''}`;
    }
    case 'REVISION': return `🔁 **A revision is in progress** with <@${o.dev_id}>.`;
    case 'IN_REVIEW': return '🔎 **Your delivery is ready for review.**';
    case 'READY_FOR_DELIVERY': return '📦 **Your order is ready.** Delivery is on its way.';
    case 'DELIVERED': return '🎉 **Delivered!** Please check everything and complete your order.';
    case 'DISPUTED': return '⚖️ **Support is looking into this order.** You will hear from us soon.';
    case 'ESCALATED': return '🙋 **A team member has been notified** and will join soon.';
    default: return String(o.status);
  }
}

function fieldsFor(o: Order): [string, string][] {
  const tier = TIERS[o.tier as TierKey];
  const role = CATEGORIES.find((c) => c.value === o.category);
  const fields: [string, string][] = [['Package', `${tier.emoji} ${tier.name}`]];
  if (role) fields.push(['Role', `${role.emoji} ${role.label}`]);
  if (o.title) fields.push(['Project', clip(o.title, 100)]);
  if (o.price_robux) fields.push(['Deal price', `${fmt(Number(o.price_robux))} R$`]);
  if (o.fee_robux) fields.push(['Platform fee', `${fmt(Number(o.fee_robux))} R$`]);
  if (o.dev_id) fields.push(['Developer', `<@${o.dev_id}>`]);
  if (o.deal_channel_id) fields.push(['Deal channel', `<#${o.deal_channel_id}>`]);
  if (o.due_at) fields.push(['Due', ts(o.due_at, 'R')]);
  return fields;
}

const hashOf = (o: Order, q: Queue) =>
  JSON.stringify([
    o.status, o.progress, o.progress_note, o.price_robux, o.fee_robux, o.title,
    o.dev_id, o.deal_channel_id, o.due_at, o.priority_until, o.brief?.step, q.position, q.total,
  ]);

export function buildHub(o: Order, q: Queue, mention?: string) {
  const tier = TIERS[o.tier as TierKey];
  const buttons: ButtonBuilder[] = [];
  
  if (HUMAN_OK.includes(o.status)) {
    buttons.push(new ButtonBuilder().setCustomId(`human:${o.id}`).setLabel('Talk to a human').setEmoji('🙋').setStyle(ButtonStyle.Secondary));
  }
  if (CLOSABLE.includes(o.status)) {
    buttons.push(new ButtonBuilder().setCustomId(`close:${o.id}`).setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Secondary));
  }

  // Strictly cap buttons to a maximum of 5 (1 Action Row) to comply with Discord component limits
  const safeButtons = buttons.slice(0, 5);

  return card({
    accent: o.status === 'ESCALATED' || o.status === 'DISPUTED' ? COLORS.warn : tier.color,
    title: `⚡ Order #${pad(o.id)}`,
    subtitle: `${tier.name} · updates automatically`,
    body: `${mention ? `${mention}\n` : ''}${stepper(o)}\n\n${nowText(o, q)}`,
    fields: fieldsFor(o),
    buttons: safeButtons.length ? safeButtons : undefined,
    footer: TEXT.footer,
  });
}

export async function postHub(channel: TextChannel, order: Order, mention?: string) {
  const q: Queue = { position: null, total: 0 };
  const sent = await channel.send(v2(buildHub(order, q, mention)));
  await supabase.from('orders').update({ hub_message_id: sent.id, hub_hash: hashOf(order, q) }).eq('id', order.id);
}

// ---------- Legacy queue helper (orders created before the marketplace) ----------
async function loadQueue() {
  const { data } = await supabase.from('orders').select('id, tier, paid_at').eq('status', 'IN_QUEUE');
  const rank: Record<string, number> = { apex: 0, pro: 1, essential: 2 };
  const sorted = (data ?? []).sort(
    (a, b) => (rank[a.tier] ?? 9) - (rank[b.tier] ?? 9) || new Date(a.paid_at).getTime() - new Date(b.paid_at).getTime()
  );
  const pos = new Map<number, number>();
  sorted.forEach((o, idx) => pos.set(o.id, idx + 1));
  return { pos, total: sorted.length };
}

// ---------- Keeps every hub up to date (edits a message only when something changed) ----------
export function startHubUpdater(client: Client) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { data: orders } = await supabase
        .from('orders')
        .select('*')
        .not('hub_message_id', 'is', null)
        .not('ticket_channel_id', 'is', null)
        .not('status', 'in', TERMINAL)
        .limit(100);
      if (!orders?.length) return;
      const queue = await loadQueue();

      for (const o of orders) {
        const q: Queue = { position: queue.pos.get(o.id) ?? null, total: queue.total };
        const hash = hashOf(o, q);
        if (hash === o.hub_hash) continue;

        const ch = await client.channels.fetch(o.ticket_channel_id).catch(() => null);
        if (!ch || !ch.isTextBased() || !('messages' in ch)) continue;
        const msg = await ch.messages.fetch(o.hub_message_id).catch(() => null);

        if (!msg) {
          const sent = await ch.send(v2(buildHub(o, q))).catch(() => null);
          if (sent) await supabase.from('orders').update({ hub_message_id: sent.id, hub_hash: hash }).eq('id', o.id);
          continue;
        }
        try {
          await msg.edit(v2(buildHub(o, q)));
          await supabase.from('orders').update({ hub_hash: hash }).eq('id', o.id);
        } catch (e) {
          console.error('❌ hub edit:', e instanceof Error ? e.message : e);
        }
      }
    } catch (err) {
      console.error('❌ hub updater:', err);
    } finally {
      running = false;
    }
  };

  tick();
  setInterval(tick, 12_000);
}

// ---------- /status ----------
export const statusCommands = [new SlashCommandBuilder().setName('status').setDescription('See where your order stands')];

export async function handleStatusCommand(i: ChatInputCommandInteraction): Promise<boolean> {
  if (i.commandName !== 'status') return false;
  try {
    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_id', i.user.id)
      .not('status', 'in', TERMINAL)
      .order('id', { ascending: false })
      .limit(3);

    if (!orders?.length) {
      await i.reply({
        content: 'You have no active orders. Start one in the order channel, we would love to build with you!',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const queue = await loadQueue();
    const cards = orders.map((o) => {
      const tier = TIERS[o.tier as TierKey];
      const q: Queue = { position: queue.pos.get(o.id) ?? null, total: queue.total };
      const fields = fieldsFor(o);
      if (o.ticket_channel_id) fields.push(['Ticket', `<#${o.ticket_channel_id}>`]);
      return card({
        accent: tier.color,
        title: `⚡ Order #${pad(o.id)}`,
        subtitle: tier.name,
        body: `${stepper(o)}\n\n${nowText(o, q)}`,
        fields,
        footer: TEXT.footer,
      });
    });
    await i.reply(v2Ephemeral(...cards));
  } catch (err) {
    console.error('❌ /status:', err);
    if (!i.replied) await i.reply({ content: TEXT.genericError, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  return true;
}