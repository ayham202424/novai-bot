import {
  ButtonInteraction,
  ChannelType,
  Client,
  Interaction,
  MessageFlags,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { supabase } from './db';
import { SETTINGS, TEXT, TIERS, type TierKey } from './config';
import { handleBriefInteraction, onEditBrief, wizardMessage } from './brief';
import { postHub } from './hub';
import { onAskHuman, onConfirmSpecs } from './interview';

// Orders that are not paid yet count towards the "1 open ticket" limit
const OPEN_BEFORE_PAYMENT = [
  'DRAFT', 'INTERVIEW', 'AWAITING_CONFIRMATION', 'AWAITING_QUOTE',
  'PAYMENT_PENDING', 'PAYMENT_VERIFICATION_REQUIRED',
];
// Customers may only close tickets in these early stages
const CUSTOMER_CAN_CLOSE = ['DRAFT', 'INTERVIEW', 'AWAITING_CONFIRMATION'];

const pad = (id: number) => String(id).padStart(4, '0');

async function logEvent(
  orderId: number,
  actorId: string | null,
  type: string,
  details: Record<string, unknown> = {}
) {
  const { error } = await supabase
    .from('order_events')
    .insert({ order_id: orderId, actor_id: actorId, event_type: type, details });
  if (error) console.error('❌ logEvent:', error.message);
}

// ---------- Customer clicked a package button ----------
// Stops double-clicks from creating two tickets at the same time
const opening = new Set<string>();
async function openTicket(i: ButtonInteraction, tierKey: TierKey) {
  if (opening.has(i.user.id)) {
    return void (await i.reply({ content: '⏳ Your ticket is already being created, one moment…', flags: MessageFlags.Ephemeral }));
  }
  opening.add(i.user.id);
  try {
    await openTicketInner(i, tierKey);
  } finally {
    opening.delete(i.user.id);
  }
}

async function openTicketInner(i: ButtonInteraction, tierKey: TierKey) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = i.guild;
  if (!guild) return void (await i.editReply(TEXT.genericError));
  const user = i.user;
  const tier = TIERS[tierKey];
  const isAdmin = i.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;

  // Account age check (admins skip it, so you can test)
  const ageDays = (Date.now() - user.createdTimestamp) / 86_400_000;
  if (!isAdmin && ageDays < SETTINGS.minAccountAgeDays) {
    await i.editReply(TEXT.accountTooNew(SETTINGS.minAccountAgeDays));
    return;
  }

  // Create / update customer row
  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .upsert({ discord_id: user.id, discord_name: user.username }, { onConflict: 'discord_id' })
    .select()
    .single();
  if (custErr || !customer) {
    console.error('❌ customer upsert:', custErr?.message);
    await i.editReply(TEXT.genericError);
    return;
  }

  if (customer.is_blacklisted) {
    await i.editReply(TEXT.blacklisted);
    return;
  }

  // Ticket limit (admins skip it, so you can test)
  if (!isAdmin) {
    const { data: open } = await supabase
      .from('orders')
      .select('id, ticket_channel_id')
      .eq('customer_id', user.id)
      .in('status', OPEN_BEFORE_PAYMENT);

    for (const o of open ?? []) {
      const ch = o.ticket_channel_id ? await guild.channels.fetch(o.ticket_channel_id).catch(() => null) : null;
      if (ch) {
        await i.editReply(TEXT.alreadyOpen(ch.id));
        return;
      }
      await supabase.from('orders').update({ status: 'EXPIRED', cancel_reason: 'channel_missing' }).eq('id', o.id);
    }
  }

  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert({ customer_id: user.id, tier: tierKey, status: 'DRAFT', brief: { step: customer.roblox_id ? 1 : 0 } })
    .select()
    .single();
  if (orderErr || !order) {
    console.error('❌ order insert:', orderErr?.message);
    await i.editReply(TEXT.genericError);
    return;
  }

  // Private ticket channel
  const botId = i.client.user.id;
  const allow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];

  let channel: TextChannel;
  try {
    channel = await guild.channels.create({
      name: `ticket-${pad(order.id)}`,
      type: ChannelType.GuildText,
      parent: process.env.TICKET_CATEGORY_ID || undefined,
      topic: `Order #${pad(order.id)} • ${tier.name} • ${user.username}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow },
        { id: botId, allow: [...allow, PermissionFlagsBits.ManageChannels] },
      ],
    });
  } catch (err) {
    console.error('❌ Could not create ticket channel:', err);
    await supabase.from('orders').update({ status: 'CANCELLED', cancel_reason: 'channel_creation_failed' }).eq('id', order.id);
    await i.editReply(TEXT.channelFailed);
    return;
  }

  await supabase.from('orders').update({ ticket_channel_id: channel.id }).eq('id', order.id);
  await logEvent(order.id, user.id, 'TICKET_OPENED', { tier: tierKey });

  const fresh = { ...order, ticket_channel_id: channel.id };
  
  try {
    await postHub(channel, fresh, `<@${user.id}>`);
    const wizard = await channel.send(wizardMessage(fresh));
    await supabase.from('orders').update({ brief: { ...(order.brief ?? {}), wid: wizard.id } }).eq('id', order.id);
  } catch (err) {
    console.error('❌ Failed to post hub or wizard message:', err);
  }

  await i.editReply(TEXT.ticketReady(channel.id));
}

// ---------- Close ticket ----------
async function onClose(i: ButtonInteraction, orderId: number) {
  // Acknowledge interaction immediately to prevent 10062 Unknown interaction timeout
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const { data: order } = await supabase
    .from('orders')
    .select('id, customer_id, status')
    .eq('id', orderId)
    .maybeSingle();

  if (!order) {
    await i.editReply({ content: TEXT.genericError });
    return;
  }

  const isAdmin = i.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  const isOwner = order.customer_id === i.user.id;

  if (!isAdmin && !isOwner) {
    await i.editReply({ content: TEXT.notOwner });
    return;
  }
  if (!isAdmin && !CUSTOMER_CAN_CLOSE.includes(order.status)) {
    await i.editReply({ content: TEXT.cannotClose });
    return;
  }

  await i.editReply(TEXT.closing(SETTINGS.closeDelaySeconds));
  await supabase
    .from('orders')
    .update({ status: 'CANCELLED', cancel_reason: isOwner ? 'closed_by_customer' : 'closed_by_staff' })
    .eq('id', orderId);
  await logEvent(orderId, i.user.id, 'TICKET_CLOSED', { by: isOwner ? 'customer' : 'staff' });

  setTimeout(() => {
    i.channel?.delete().catch((e) => console.error('❌ delete channel:', e));
  }, SETTINGS.closeDelaySeconds * 1000);
}

// ---------- Router ----------
export async function handleTicketInteraction(i: Interaction): Promise<void> {
  try {
    if (i.isButton()) {
      const [kind, a] = i.customId.split(':');
      if (kind === 'tier' && a in TIERS) return await openTicket(i, a as TierKey);
      if (kind === 'close') return await onClose(i, Number(a));
      if (kind === 'confirm') return await onConfirmSpecs(i, Number(a));
      if (kind === 'human') return await onAskHuman(i, Number(a));
      if (kind === 'editbrief') return await onEditBrief(i, Number(a));
    }
    if (await handleBriefInteraction(i)) return;
  } catch (err) {
    console.error('❌ Ticket error:', err);
    if (i.isRepliable()) {
      const msg = { content: TEXT.genericError, flags: MessageFlags.Ephemeral } as const;
      if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
  }
}

// ---------- Smart timeout: closes tickets nobody is working on ----------
export function startTicketCleanup(client: Client) {
  const run = async () => {
    const cutoff = new Date(Date.now() - SETTINGS.draftTimeoutMinutes * 60_000).toISOString();
    const { data, error } = await supabase
      .from('orders')
      .select('id, ticket_channel_id, customer_id')
      .in('status', ['DRAFT', 'INTERVIEW', 'AWAITING_CONFIRMATION'])
      .lt('updated_at', cutoff);

    if (error) {
      console.error('❌ cleanup:', error.message);
      return;
    }

    for (const o of data ?? []) {
      await supabase.from('orders').update({ status: 'EXPIRED', cancel_reason: 'timeout' }).eq('id', o.id);
      await logEvent(o.id, null, 'TICKET_EXPIRED', { minutes: SETTINGS.draftTimeoutMinutes });

      if (o.ticket_channel_id) {
        const ch = await client.channels.fetch(o.ticket_channel_id).catch(() => null);
        await ch?.delete().catch(() => null);
      }
      const user = await client.users.fetch(o.customer_id).catch(() => null);
      await user?.send(TEXT.expiredDm(SETTINGS.draftTimeoutMinutes)).catch(() => null);
    }
  };

  const safeRun = () => run().catch((e) => console.error('❌ ticket cleanup:', e));
  safeRun();
  setInterval(safeRun, 5 * 60_000);
}