import { ChatInputCommandInteraction, Client, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { supabase } from './db';
import { TEXT } from './config';
import { COLORS, card, v2 } from './ui';
import { onIdentityLinked } from './identity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Order = Record<string, any>;

const pad = (id: number) => String(id).padStart(4, '0');
const fmt = (n: number) => n.toLocaleString('en-US');

// The task board registers itself here (R4b): it posts the task once the fee is paid
type FeeHook = (client: Client, order: Order) => Promise<void>;
let feeHook: FeeHook | null = null;
export const onFeePaid = (fn: FeeHook) => {
  feeHook = fn;
};

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

// ---------- The fee is paid: the task goes live ----------
async function settleFee(
  client: Client,
  order: Order,
  payment: Order,
  opts: { wallet?: { robloxId: number; amount: number; balance: number }; actorId?: string }
): Promise<boolean> {
  // 1) claim the order first, so it can never be processed twice
  const { data: claimed } = await supabase
    .from('orders')
    .update({ status: 'OPEN', paid_at: new Date().toISOString() })
    .eq('id', order.id)
    .eq('status', 'PAYMENT_PENDING')
    .select()
    .maybeSingle();
  if (!claimed) return false;

  // 2) take the Robux out of the wallet (not for manual confirmations)
  if (opts.wallet) {
    const { data: ok } = await supabase.rpc('spend_wallet', { p_user: opts.wallet.robloxId, p_amount: opts.wallet.amount });
    if (!ok) {
      await supabase.from('orders').update({ status: 'PAYMENT_PENDING', paid_at: null }).eq('id', order.id);
      return false;
    }
  }

  await supabase.from('payments').update({ status: 'CONFIRMED', confirmed_by: opts.actorId ?? 'auto-robux' }).eq('id', payment.id);
  await log(order.id, opts.actorId ?? null, 'FEE_PAID', { robux: payment.amount_robux, manual: Boolean(opts.actorId) });

  const fee = Number(payment.amount_robux);
  const leftover = opts.wallet ? opts.wallet.balance - opts.wallet.amount : 0;
  const fields: [string, string][] = [
    ['Platform fee', `${fmt(fee)} R$ ✅`],
    ['Deal price', `${fmt(Number(claimed.price_robux ?? 0))} R$ · paid to your developer later`],
  ];
  if (leftover > 0) fields.push(['Extra credit', `${fmt(leftover)} R$ stays on your account`]);

  await sendTo(
    client,
    order.ticket_channel_id,
    v2(
      card({
        accent: COLORS.success,
        title: '✅ Fee confirmed',
        subtitle: `Order #${pad(order.id)}`,
        body: `<@${order.customer_id}> Thank you! Your task is now **live on our developer board**. As soon as a developer accepts it, you get a private deal channel with them.`,
        fields,
        footer: TEXT.footer,
      })
    )
  );

  await sendTo(client, process.env.OWNER_PAYMENT_CHANNEL_ID || process.env.OWNER_CHANNEL_ID, {
    content: `🟩 **Fee confirmed:** order #${pad(order.id)} · ${fmt(fee)} R$ · <@${order.customer_id}>${opts.actorId ? ' (manual)' : ''}`,
  });

  if (feeHook) feeHook(client, claimed).catch((e) => console.error('❌ task board:', e));
  return true;
}

async function trySettle(client: Client, order: Order, payment: Order, notify: boolean): Promise<boolean> {
  if (order.status !== 'PAYMENT_PENDING') return false;

  const { data: cust } = await supabase.from('customers').select('roblox_id').eq('discord_id', order.customer_id).maybeSingle();
  if (!cust?.roblox_id) return false;

  const { data: wallet } = await supabase.from('robux_wallets').select('balance').eq('roblox_user_id', cust.roblox_id).maybeSingle();
  const balance = Number(wallet?.balance ?? 0);
  const need = Number(payment.amount_robux);
  if (!need) return false;

  if (balance < need) {
    if (notify && balance > 0) {
      await sendTo(
        client,
        order.ticket_channel_id,
        v2(
          card({
            accent: COLORS.warn,
            title: '🟩 Robux received',
            subtitle: `Order #${pad(order.id)}`,
            body: `You have **${fmt(balance)} R$** credited. **${fmt(need - balance)} R$** to go.`,
            footer: TEXT.footer,
          })
        )
      );
    }
    return false;
  }
  return settleFee(client, order, payment, { wallet: { robloxId: cust.roblox_id, amount: need, balance } });
}

async function handleReceipt(client: Client, robloxUserId: number) {
  const { data: cust } = await supabase.from('customers').select('discord_id').eq('roblox_id', robloxUserId).maybeSingle();
  if (!cust) {
    console.warn(`⚠️ Robux from Roblox user ${robloxUserId}, who is not linked to any Discord account (credit is kept).`);
    return;
  }
  const { data: orders } = await supabase.from('orders').select('*').eq('customer_id', cust.discord_id).eq('status', 'PAYMENT_PENDING');
  for (const order of orders ?? []) {
    const { data: pays } = await supabase
      .from('payments')
      .select('*')
      .eq('order_id', order.id)
      .eq('method', 'robux')
      .eq('status', 'PENDING')
      .order('id', { ascending: false })
      .limit(1);
    if (pays && pays[0]) await trySettle(client, order, pays[0], true);
  }
}

async function sweepPending(client: Client) {
  const { data: pays } = await supabase.from('payments').select('*').eq('method', 'robux').eq('status', 'PENDING');
  for (const p of pays ?? []) {
    const { data: order } = await supabase.from('orders').select('*').eq('id', p.order_id).maybeSingle();
    if (order) await trySettle(client, order, p, false);
  }
}

// Customers who just linked inside the game: nickname, role, next step
async function notifyLinked(client: Client) {
  const { data: tokens } = await supabase.from('link_tokens').select('*').eq('used', true).eq('notified', false).limit(10);
  for (const t of tokens ?? []) {
    await supabase.from('link_tokens').update({ notified: true }).eq('token', t.token);
    await onIdentityLinked(client, t).catch((e) => console.error('❌ identity:', e));
  }
}

export function startRobuxProcessor(client: Client) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await notifyLinked(client);

      const { data } = await supabase
        .from('robux_receipts')
        .select('receipt_id, roblox_user_id, robux')
        .eq('processed', false)
        .order('created_at')
        .limit(25);

      for (const r of data ?? []) {
        const { data: balance, error } = await supabase.rpc('credit_receipt', { p_receipt: r.receipt_id });
        if (error || balance === null) continue;
        console.log(`🟩 Received ${r.robux} R$ from Roblox user ${r.roblox_user_id} (wallet: ${balance})`);
        await handleReceipt(client, Number(r.roblox_user_id));
      }

      await sweepPending(client); // safety net: settles anything that is already covered
    } catch (err) {
      console.error('❌ Robux processor:', err);
    } finally {
      running = false;
    }
  };

  tick();
  setInterval(tick, 15_000);
}

// ---------- /confirm_fee (owner): for a fee you received another way ----------
export const paymentCommands = [
  new SlashCommandBuilder()
    .setName('confirm_fee')
    .setDescription('Owner: confirm a platform fee that was paid another way')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption((o) => o.setName('order_id').setDescription('Order number, e.g. 42').setRequired(true)),
];

export async function handlePaymentCommand(i: ChatInputCommandInteraction): Promise<boolean> {
  if (i.commandName !== 'confirm_fee') return false;
  try {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await i.reply({ content: '🔒 Only the owner can use this.', flags: MessageFlags.Ephemeral });
      return true;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const orderId = i.options.getInteger('order_id', true);

    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
    if (!order) return void (await i.editReply(`❌ Order #${pad(orderId)} was not found.`)), true;
    if (order.status !== 'PAYMENT_PENDING') {
      return void (await i.editReply(`⚠️ Order #${pad(orderId)} is in status **${order.status}**, so its fee can't be confirmed.`)), true;
    }

    const { data: pays } = await supabase
      .from('payments')
      .select('*')
      .eq('order_id', orderId)
      .eq('status', 'PENDING')
      .order('id', { ascending: false })
      .limit(1);
    let payment = pays?.[0];
    if (!payment) {
      const { data: created } = await supabase
        .from('payments')
        .insert({ order_id: orderId, method: 'robux', amount_robux: order.fee_robux ?? 0, status: 'PENDING' })
        .select()
        .single();
      payment = created;
    }

    const ok = await settleFee(i.client, order, payment, { actorId: i.user.id });
    await i.editReply(ok ? `✅ Fee confirmed. Order **#${pad(orderId)}** is now **OPEN**.` : '⚠️ It was already handled.');
  } catch (err) {
    console.error('❌ /confirm_fee:', err);
    if (i.deferred || i.replied) await i.editReply(TEXT.genericError).catch(() => {});
    else await i.reply({ content: TEXT.genericError, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  return true;
}