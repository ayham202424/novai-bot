import { fastLoad } from './safe';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  Interaction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  OverwriteResolvable,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { supabase } from './db';
import { CATEGORIES, DEV_ROLES, DEV_RULES, PRIORITY, TASKS, TEXT, TIERS, type TierKey } from './config';
import { getCfg } from './cfg';
import { COLORS, card, v2, v2Ephemeral } from './ui';
import { onFeePaid } from './robux';
import { archiveDeal, forgetDeal } from './guard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Order = Record<string, any>;
const P = PermissionFlagsBits;

const pad = (id: number) => String(id).padStart(4, '0');
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const fmt = (n: number) => n.toLocaleString('en-US');
const ts = (iso: string | number, style = 'R') => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;
const roleOf = (key: string) => CATEGORIES.find((c) => c.value === key);
const skillNames = (keys: string[]) =>
  (keys ?? []).map((k) => { const r = DEV_ROLES.find((x) => x.key === k); return r ? `${r.emoji} ${r.name}` : k; }).join(', ');

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

async function log(orderId: number, actor: string | null, type: string, details: Record<string, unknown> = {}) {
  const { error } = await supabase.from('order_events').insert({ order_id: orderId, actor_id: actor, event_type: type, details });
  if (error) console.error('❌ log:', error.message);
}

async function logChannel(client: Client, key: string, c: ReturnType<typeof card>) {
  const cfg = await getCfg();
  await sendTo(client, cfg.channels[key], { ...v2(c), allowedMentions: { parse: [] } });
}

async function dm(client: Client, userId: string, c: ReturnType<typeof card>) {
  const user = await client.users.fetch(userId).catch(() => null);
  await user?.send(v2(c) as never).catch(() => null);
}

const fetchOrder = async (id: number): Promise<Order | null> =>
  (await supabase.from('orders').select('*').eq('id', id).maybeSingle()).data;

// Apex tasks go to top-rated devs first, Pro tasks to experienced devs first
function windowOk(dev: Order, tier: string) {
  if (tier === 'apex') return Number(dev.rating_count) >= PRIORITY.apex.minRatings && Number(dev.rating_avg) >= PRIORITY.apex.minRating;
  if (tier === 'pro') return Number(dev.completed_count) >= PRIORITY.pro.minCompleted;
  return true;
}

async function customerLine(customerId: string) {
  const { data: c } = await supabase.from('customers').select('roblox_id, roblox_name').eq('discord_id', customerId).maybeSingle();
  const { count } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .eq('status', 'COMPLETED');
  const name = c?.roblox_name ? `[${c.roblox_name}](https://www.roblox.com/users/${c.roblox_id}/profile)` : 'unknown';
  return `${name} · ${count ?? 0} completed orders`;
}

const btn = (id: string, label: string, style: ButtonStyle, emoji?: string, disabled = false) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  if (emoji) b.setEmoji(emoji);
  return b;
};

// =====================================================================
// 1) THE TASK BOARD
// =====================================================================
function taskCard(order: Order, o: { info: string; ping?: string; reservedUntil?: string | null; takenBy?: string }) {
  const tier = TIERS[order.tier as TierKey];
  const role = roleOf(order.category);
  const body = [
    ...(o.ping ? [o.ping, ''] : []),
    `**${clip(order.title, 150)}**`,
    '',
    clip(order.specs_summary, 1300),
    ...(order.brief?.references ? ['', `**References**  ${clip(order.brief.references, 250)}`] : []),
    ...(o.reservedUntil ? ['', `⭐ Reserved for top developers until ${ts(o.reservedUntil)}`] : []),
  ].join('\n');

  return card({
    accent: o.takenBy ? COLORS.success : tier.color,
    title: `📋 ${role?.emoji ?? ''} New task · ${role?.label ?? 'Task'}`,
    subtitle: `Task #${pad(order.id)} · ${tier.name}`,
    body,
    fields: [
      ['Deal price', `**${fmt(Number(order.price_robux ?? 0))} R$**`],
      ['Expected time', tier.days],
      ['Customer', o.info],
    ],
    buttons: o.takenBy ? undefined : [btn(`task:accept:${order.id}`, 'Accept task', ButtonStyle.Success, '✅')],
    footer: o.takenBy ? `✅ Taken by <@${o.takenBy}>` : 'The first eligible developer who presses Accept gets this task.',
  });
}

export async function postTask(client: Client, order: Order, opts: { skipWindow?: boolean } = {}) {
  const cfg = await getCfg();
  const channelId = cfg.channels[`task-${order.category}`];
  if (!channelId) {
    console.warn(`⚠️ No task channel for role "${order.category}". Run /setup_server.`);
    return;
  }

  const excluded = new Set<string>(order.excluded_devs ?? []);
  const { data: devs } = await supabase
    .from('devs')
    .select('discord_id, rating_avg, rating_count, completed_count')
    .eq('status', 'active')
    .contains('skills', [order.category]);
  const pool = (devs ?? []).filter((d) => !excluded.has(d.discord_id) && d.discord_id !== order.customer_id);

  // priority window (only if somebody qualifies, otherwise nobody would see the task early)
  const minutes = (PRIORITY[order.tier as TierKey] as { minutes: number }).minutes;
  let until: string | null = null;
  let elite: string[] = [];
  if (!opts.skipWindow && minutes > 0) {
    elite = pool.filter((d) => windowOk(d, order.tier)).map((d) => d.discord_id as string);
    if (elite.length) until = new Date(Date.now() + minutes * 60_000).toISOString();
  }

  const roleId = cfg.roles[order.category];
  const ping = until ? elite.slice(0, 20).map((id) => `<@${id}>`).join(' ') : roleId ? `<@&${roleId}>` : '';
  const info = await customerLine(order.customer_id);

  // repost: remove the old card first
  if (order.task_message_id && order.task_channel_id) {
    const oldCh = await client.channels.fetch(order.task_channel_id).catch(() => null);
    if (oldCh && oldCh.isTextBased() && 'messages' in oldCh) {
      const old = await oldCh.messages.fetch(order.task_message_id).catch(() => null);
      await old?.delete().catch(() => null);
    }
  }

  const sent = await sendTo(client, channelId, {
    ...v2(taskCard(order, { info, ping, reservedUntil: until })),
    allowedMentions: { users: elite.slice(0, 20), roles: roleId && !until ? [roleId] : [] },
  });
  if (!sent) return;

  await supabase
    .from('orders')
    .update({ task_channel_id: channelId, task_message_id: sent.id, priority_until: until, window_notified: !until })
    .eq('id', order.id);
  await log(order.id, null, 'TASK_POSTED', { role: order.category, window: Boolean(until), devs: pool.length });
  await logChannel(client, 'order-logs', card({ accent: COLORS.brand, title: '📋 Task posted', body: `Order #${pad(order.id)} · ${roleOf(order.category)?.label} · ${pool.length} developer(s) can take it${until ? ' · priority window active' : ''}` }));

  if (pool.length === 0) {
    await sendTo(client, cfg.channels.escalations, {
      content: `${cfg.roles.support ? `<@&${cfg.roles.support}> ` : ''}⚠️ Task **#${pad(order.id)}** needs a **${roleOf(order.category)?.label}** but no developer with this role is available.`,
      allowedMentions: { roles: cfg.roles.support ? [cfg.roles.support] : [] },
    });
  }
}

// =====================================================================
// 2) ACCEPTING A TASK
// =====================================================================
async function createDealChannel(client: Client, order: Order, devId: string): Promise<TextChannel> {
  const cfg = await getCfg();
  if (!cfg.categories.deals) throw new Error('Run /setup_server first (deals category missing)');
  const guild = await client.guilds.fetch(process.env.GUILD_ID!);
  const allow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: client.user!.id, allow: [...allow, P.ManageChannels, P.ManageMessages] },
    { id: devId, allow },
  ];
  if (cfg.roles.support) overwrites.push({ id: cfg.roles.support, allow: [...allow, P.ManageMessages] });

  return guild.channels.create({
    name: `deal-${pad(order.id)}`,
    type: ChannelType.GuildText,
    parent: cfg.categories.deals,
    topic: `Deal · Order #${pad(order.id)} · ${clip(order.title, 80)}`,
    permissionOverwrites: overwrites,
  });
}

async function onAccept(i: ButtonInteraction, orderId: number) {
  // Discord drops the click if it is not acknowledged within 3 seconds.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const no = (text: string) => i.editReply(text);

  const [{ data: dev }, order] = await Promise.all([
    supabase.from('devs').select('*').eq('discord_id', i.user.id).maybeSingle(),
    fetchOrder(orderId),
  ]);
  if (!dev || dev.status !== 'active') return void (await no('Only active Novai developers can accept tasks.'));
  if (!order) return void (await no(TEXT.genericError));
  if (order.status !== 'OPEN') return void (await no('Too late, this task was already taken or is no longer available.'));
  if (!(dev.skills ?? []).includes(order.category)) {
    return void (await no(`This task needs a **${roleOf(order.category)?.label}**. You do not have that role.`));
  }
  if (order.customer_id === i.user.id) return void (await no('You cannot accept your own order.'));
  if ((order.excluded_devs ?? []).includes(i.user.id)) return void (await no('You cannot take this task again.'));

  const [{ data: cust }, { count }] = await Promise.all([
    supabase.from('customers').select('roblox_id').eq('discord_id', order.customer_id).maybeSingle(),
    supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('dev_id', i.user.id)
      .in('status', ['ASSIGNED', 'IN_PROGRESS', 'REVISION', 'IN_REVIEW']),
  ]);
  if (cust?.roblox_id && Number(cust.roblox_id) === Number(dev.roblox_id)) {
    return void (await no('This order belongs to your own Roblox account, so you cannot take it.'));
  }
  if ((count ?? 0) >= TASKS.maxActivePerDev) {
    return void (await no(`You already have ${TASKS.maxActivePerDev} active tasks. Finish one first.`));
  }

  if (order.priority_until && new Date(order.priority_until) > new Date() && !windowOk(dev, order.tier)) {
    return void (await no(`This task is reserved for top developers until ${ts(order.priority_until)}. It opens for everyone after that.`));
  }

  // atomic claim: only one developer can win
  const deadline = new Date(Date.now() + TASKS.setupMinutes * 60_000).toISOString();
  const { data: claimed } = await supabase
    .from('orders')
    .update({ status: 'ASSIGNED', dev_id: i.user.id, assigned_at: new Date().toISOString(), setup_deadline: deadline })
    .eq('id', orderId)
    .eq('status', 'OPEN')
    .is('dev_id', null)
    .select()
    .maybeSingle();
  if (!claimed) return void (await i.editReply('Someone was faster. This task was just taken.'));

  let channel: TextChannel;
  try {
    channel = await createDealChannel(i.client, claimed, i.user.id);
  } catch (err) {
    console.error('❌ deal channel:', err);
    await supabase.from('orders').update({ status: 'OPEN', dev_id: null, assigned_at: null, setup_deadline: null }).eq('id', orderId);
    return void (await i.editReply('⚠️ I could not create your deal channel. Please try again, or tell the owner (check the bot permissions).'));
  }

  const plan = { step: 1 };
  await supabase.from('orders').update({ deal_channel_id: channel.id, dev_plan: plan }).eq('id', orderId);
  forgetDeal(channel.id);
  const fresh = { ...claimed, deal_channel_id: channel.id, dev_plan: plan };

  await channel.send(v2(setupCard(fresh)));
  await i.message.edit(v2(taskCard(fresh, { info: await customerLine(order.customer_id), takenBy: i.user.id }))).catch(() => null);
  await log(orderId, i.user.id, 'TASK_ACCEPTED', {});
  await logChannel(i.client, 'order-logs', card({ accent: COLORS.success, title: '🤝 Task accepted', body: `Order #${pad(orderId)} · <@${i.user.id}>` }));
  await i.editReply(`✅ **You got it!** Finish the setup in <#${channel.id}> within ${TASKS.setupMinutes} minutes.`);
}

// =====================================================================
// 3) DEVELOPER SETUP (plan, safety questions, rules)
// =====================================================================
const QUIZ = [
  {
    id: 'q1', rule: 2,
    q: 'The customer says "DMs are easier, let us talk there". You…',
    options: [['channel', 'Say no. Everything stays in the deal channel'], ['dm', 'Agree, DMs are fine'], ['call', 'Move to a call on another app']],
    correct: 'channel',
  },
  {
    id: 'q2', rule: 3,
    q: 'The customer offers extra Robux outside the deal card. You…',
    options: [['no', 'Decline and use only the deal card'], ['yes', 'Accept, it is extra money'], ['later', 'Ask Support afterwards']],
    correct: 'no',
  },
  {
    id: 'q3', rule: 1,
    q: 'After you accepted, the customer wants a big extra feature. You…',
    options: [['new', 'Tell them to create a new order'], ['free', 'Do it for free to keep them happy'], ['price', 'Agree on a new price in the chat']],
    correct: 'new',
  },
  {
    id: 'q4', rule: 6,
    q: 'You are going to miss the deadline. You…',
    options: [['extend', 'Ask for more time before the deadline'], ['wait', 'Wait and say nothing'], ['vanish', 'Stop replying']],
    correct: 'extend',
  },
];

const numbered = (items: string[]) => items.map((t, n) => `**${n + 1}.** ${t}`).join('\n');

function setupCard(order: Order) {
  const plan = order.dev_plan ?? {};
  const step = plan.step ?? 1;
  const id = order.id;
  const left = order.setup_deadline ? ` · finish ${ts(order.setup_deadline)}` : '';
  const giveBack = btn(`setup:decline:${id}`, 'Give task back', ButtonStyle.Secondary, '↩️');
  const tier = TIERS[order.tier as TierKey];
  const summary = `**${clip(order.title, 120)}**\n${clip(order.specs_summary, 700)}`;

  if (step === 1) {
    return card({
      accent: tier.color,
      title: '🤝 Set up your deal · 1 of 3',
      subtitle: `Order #${pad(id)} · ${tier.name}${left}`,
      body: `<@${order.dev_id}> **You got the task!** Tell the customer when and how you will deliver.\n\n${summary}`,
      buttons: [btn(`setup:plan:${id}`, 'Plan & timing', ButtonStyle.Primary, '🗓️'), giveBack],
      footer: `If setup is not finished in ${TASKS.setupMinutes} minutes, the task goes back to the board.`,
    });
  }

  if (step === 2) {
    const selects = QUIZ.map((q) =>
      new StringSelectMenuBuilder()
        .setCustomId(`setup:q:${id}:${q.id}`)
        .setPlaceholder(q.q)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          q.options.map(([value, label]) =>
            new StringSelectMenuOptionBuilder().setValue(value).setLabel(label).setDefault(plan.quiz?.[q.id] === value)
          )
        )
    );
    const done = QUIZ.every((q) => plan.quiz?.[q.id]);
    return card({
      accent: tier.color,
      title: '🛡️ Safety check · 2 of 3',
      subtitle: `Order #${pad(id)}${left}`,
      body: 'Four quick questions keep you and the customer safe. Pick the answer you would really give.',
      selects,
      buttons: [btn(`setup:quizok:${id}`, 'Continue', ButtonStyle.Primary, '▶️', !done), giveBack],
    });
  }

  return card({
    accent: tier.color,
    title: '📘 Developer rules · 3 of 3',
    subtitle: `Order #${pad(id)}${left}`,
    body:
      `${numbered(DEV_RULES)}\n\n**Your plan**  ${plan.days} day(s)\n${clip(plan.plan, 300)}`,
    buttons: [btn(`setup:ack:${id}`, 'I accept all rules', ButtonStyle.Success, '✅'), giveBack],
    footer: 'You confirm by typing ACCEPT. Your acceptance is saved with the order.',
  });
}

async function loadSetup(i: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, orderId: number) {
  const order = await fetchOrder(orderId);
  if (!order || order.dev_id !== i.user.id || order.status !== 'ASSIGNED') {
    await i.reply({ content: 'This setup is not yours, or it is already finished.', flags: MessageFlags.Ephemeral });
    return null;
  }
  return order;
}

async function onPlanButton(i: ButtonInteraction, orderId: number) {
  // Popups must open within 3 seconds: wait only briefly. The submit step checks everything again.
  const order = await fastLoad(fetchOrder(orderId));
  if (order && (order.dev_id !== i.user.id || order.status !== 'ASSIGNED')) {
    return void (await i.reply({ content: 'This setup is not yours, or it is already finished.', flags: MessageFlags.Ephemeral }));
  }
  const plan = order?.dev_plan ?? {};
  const field = (id: string, label: string, ph: string, style: TextInputStyle, max: number, required: boolean, value?: string) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(ph).setStyle(style).setMaxLength(max).setRequired(required);
    if (value) t.setValue(clip(value, max));
    return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
  };
  await i.showModal(
    new ModalBuilder()
      .setCustomId(`setup:planform:${orderId}`)
      .setTitle('Plan & timing')
      .addComponents(
        field('days', 'Days you need (1–30)', 'e.g. 4', TextInputStyle.Short, 3, true, plan.days ? String(plan.days) : undefined),
        field('plan', 'What will you deliver and how?', 'Your steps and what the customer gets', TextInputStyle.Paragraph, 600, true, plan.plan),
        field('preview', 'Which preview will you show first?', 'Screenshots, a video or a watermarked sample', TextInputStyle.Paragraph, 300, true, plan.preview),
        field('questions', 'Questions for the customer (optional)', 'Anything you need to know to start', TextInputStyle.Paragraph, 400, false, plan.questions)
      )
  );
}

async function onPlanSubmit(i: ModalSubmitInteraction, orderId: number) {
  const order = await loadSetup(i, orderId);
  if (!order) return;
  const days = Math.round(Number(i.fields.getTextInputValue('days').replace(/[^0-9.]/g, '')));
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    return void (await i.reply({ content: 'Please enter a number of days between 1 and 30.', flags: MessageFlags.Ephemeral }));
  }
  const plan = {
    ...(order.dev_plan ?? {}),
    days,
    plan: i.fields.getTextInputValue('plan').trim(),
    preview: i.fields.getTextInputValue('preview').trim(),
    questions: i.fields.getTextInputValue('questions').trim(),
    step: 2,
  };
  await supabase.from('orders').update({ dev_plan: plan }).eq('id', orderId);
  const next = { ...order, dev_plan: plan };
  if (i.isFromMessage()) await i.update(v2(setupCard(next)));
}

async function onQuizSelect(i: StringSelectMenuInteraction, orderId: number, qid: string) {
  const order = await loadSetup(i, orderId);
  if (!order) return;
  const q = QUIZ.find((x) => x.id === qid);
  if (!q || !q.options.some(([v]) => v === i.values[0])) return;
  const plan = { ...(order.dev_plan ?? {}), quiz: { ...(order.dev_plan?.quiz ?? {}), [qid]: i.values[0] } };
  await supabase.from('orders').update({ dev_plan: plan }).eq('id', orderId);
  await i.update(v2(setupCard({ ...order, dev_plan: plan })));
}

async function onQuizContinue(i: ButtonInteraction, orderId: number) {
  const order = await loadSetup(i, orderId);
  if (!order) return;
  const answers = order.dev_plan?.quiz ?? {};
  const wrong = QUIZ.filter((q) => answers[q.id] !== q.correct);
  if (wrong.length) {
    const lines = wrong.map((q) => `**Rule ${q.rule}:** ${DEV_RULES[q.rule - 1]}`).join('\n');
    return void (await i.reply({ content: `Not quite. Please read these rules again and change your answer:\n${lines}`, flags: MessageFlags.Ephemeral }));
  }
  const plan = { ...(order.dev_plan ?? {}), step: 3 };
  await supabase.from('orders').update({ dev_plan: plan }).eq('id', orderId);
  await i.update(v2(setupCard({ ...order, dev_plan: plan })));
}

async function onAckButton(i: ButtonInteraction, orderId: number) {
  const order = await fastLoad(fetchOrder(orderId));
  if (order && (order.dev_id !== i.user.id || order.status !== 'ASSIGNED')) {
    return void (await i.reply({ content: 'This setup is not yours, or it is already finished.', flags: MessageFlags.Ephemeral }));
  }
  await i.showModal(
    new ModalBuilder()
      .setCustomId(`setup:ackform:${orderId}`)
      .setTitle('Accept the developer rules')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('ack')
            .setLabel(`Type ACCEPT to confirm all ${DEV_RULES.length} rules`)
            .setPlaceholder('ACCEPT')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(10)
            .setRequired(true)
        )
      )
  );
}

// ---------- Deal hub (the card at the top of the deal channel) ----------
async function buildDealHub(order: Order) {
  const [{ data: dev }, { data: cust }, { count: custDone }] = await Promise.all([
    supabase.from('devs').select('*').eq('discord_id', order.dev_id).maybeSingle(),
    supabase.from('customers').select('roblox_id, roblox_name').eq('discord_id', order.customer_id).maybeSingle(),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('customer_id', order.customer_id).eq('status', 'COMPLETED'),
  ]);
  const tier = TIERS[order.tier as TierKey];
  const plan = order.dev_plan ?? {};
  const rating = dev?.rating_count ? `⭐ ${Number(dev.rating_avg).toFixed(2)} (${dev.rating_count})` : 'new on Novai';

  return card({
    accent: tier.color,
    title: `🤝 Deal · Order #${pad(order.id)}`,
    subtitle: `${tier.name} · ${roleOf(order.category)?.label}`,
    body:
      `<@${order.customer_id}> ⇄ <@${order.dev_id}>\n\n**${clip(order.title, 150)}**\n${clip(order.specs_summary, 900)}`,
    fields: [
      ['Customer', `[${cust?.roblox_name ?? 'unknown'}](https://www.roblox.com/users/${cust?.roblox_id}/profile) · ${custDone ?? 0} completed orders`],
      ['Developer', `[${dev?.roblox_name}](https://www.roblox.com/users/${dev?.roblox_id}/profile) · ${rating} · ${dev?.completed_count ?? 0} completed · ${skillNames(dev?.skills)}`],
      ['Deal price', `**${fmt(Number(order.price_robux ?? 0))} R$**  ·  final, no renegotiation`],
      ['Due', `${ts(order.due_at)} (${plan.days} day${plan.days === 1 ? '' : 's'})`],
      ['Plan', clip(plan.plan, 350)],
      ['First preview', clip(plan.preview, 250)],
      ...(plan.questions ? ([['Developer asks', clip(plan.questions, 300)]] as [string, string][]) : []),
    ],
    buttons: [
      btn(`deal:support:${order.id}`, 'Support', ButtonStyle.Danger, '🛟'),
      btn(`deal:change:${order.id}`, 'Change developer', ButtonStyle.Secondary, '🔄'),
    ],
    footer: '🔴 This chat is recorded for dispute resolution. Edited and deleted messages are logged. Keep everything in this channel.',
  });
}

async function onAckSubmit(i: ModalSubmitInteraction, orderId: number) {
  const order = await loadSetup(i, orderId);
  if (!order) return;
  if (i.fields.getTextInputValue('ack').trim().toUpperCase() !== 'ACCEPT') {
    return void (await i.reply({ content: 'Please type ACCEPT exactly to confirm the rules.', flags: MessageFlags.Ephemeral }));
  }

  const plan = { ...(order.dev_plan ?? {}), step: 4, acceptedAt: new Date().toISOString() };
  const due = new Date(Date.now() + Number(plan.days) * 86_400_000).toISOString();
  const { data: updated } = await supabase
    .from('orders')
    .update({ status: 'IN_PROGRESS', dev_days: plan.days, due_at: due, dev_plan: plan, setup_deadline: null, progress: 0 })
    .eq('id', orderId)
    .eq('status', 'ASSIGNED')
    .select()
    .maybeSingle();
  if (!updated) return void (await i.reply({ content: 'This was already handled.', flags: MessageFlags.Ephemeral }));

  await log(orderId, i.user.id, 'RULES_ACCEPTED', { rules: DEV_RULES.length, quizPassed: true, days: plan.days, plan: clip(plan.plan, 300) });

  const ch = (await i.client.channels.fetch(order.deal_channel_id).catch(() => null)) as TextChannel | null;
  if (!ch) return void (await i.reply({ content: TEXT.genericError, flags: MessageFlags.Ephemeral }));

  // only now the customer joins
  await ch.permissionOverwrites.edit(order.customer_id, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true,
  });

  if (i.isFromMessage()) {
    await i.update(v2(card({ accent: COLORS.success, title: '✅ Setup complete', body: 'The customer has been added to this channel. Good luck!' })));
  }
  const hub = await ch.send(v2(await buildDealHub(updated)));
  await supabase.from('orders').update({ deal_hub_message_id: hub.id }).eq('id', orderId);
  await hub.pin().catch(() => null);

  await sendTo(
    i.client,
    order.ticket_channel_id,
    v2(
      card({
        accent: COLORS.success,
        title: '🤝 Your developer is ready',
        subtitle: `Order #${pad(orderId)}`,
        body: `<@${order.customer_id}> <@${order.dev_id}> accepted your task and agreed to our rules. Your private deal channel is here: <#${ch.id}>. You see your developer's profile and plan there.`,
      })
    )
  );
  await logChannel(i.client, 'order-logs', card({ accent: COLORS.success, title: '✅ Setup complete', body: `Order #${pad(orderId)} · <@${order.dev_id}> · due ${ts(due)}` }));
}

// =====================================================================
// 4) RELEASING A TASK (declined, too slow, customer changed developer)
// =====================================================================
type ReleaseReason = 'timeout' | 'declined' | 'customer_changed';

async function releaseTask(client: Client, order: Order, reason: ReleaseReason, note = '') {
  const devId: string | null = order.dev_id;
  const excluded = [...new Set<string>([...(order.excluded_devs ?? []), ...(devId ? [devId] : [])])];
  const changes = Number(order.dev_plan?.changes ?? 0) + (reason === 'customer_changed' ? 1 : 0);

  const { data: updated } = await supabase
    .from('orders')
    .update({
      status: 'OPEN', dev_id: null, excluded_devs: excluded, assigned_at: null, setup_deadline: null,
      deal_channel_id: null, deal_hub_message_id: null, dev_days: null, due_at: null,
      progress: 0, progress_note: null, priority_until: null, window_notified: true,
      dev_plan: { changes },
    })
    .eq('id', order.id)
    .in('status', ['ASSIGNED', 'IN_PROGRESS', 'REVISION'])
    .select()
    .maybeSingle();
  if (!updated) return;

  if (order.deal_channel_id) {
    await archiveDeal(client, order, reason);
    const ch = await client.channels.fetch(order.deal_channel_id).catch(() => null);
    await ch?.delete().catch(() => null);
    forgetDeal(order.deal_channel_id);
  }

  await log(order.id, devId, `TASK_RELEASED_${reason.toUpperCase()}`, { note: clip(note, 300) });
  const label = { timeout: 'setup not finished in time', declined: 'developer gave the task back', customer_changed: 'customer changed the developer' }[reason];
  await logChannel(client, 'dev-logs', card({ accent: COLORS.warn, title: '↩️ Task released', body: `Order #${pad(order.id)} · ${devId ? `<@${devId}>` : ''}\n${label}${note ? `\n> ${clip(note, 300)}` : ''}` }));

  if (devId) {
    const text = {
      timeout: `You did not finish the setup for task #${pad(order.id)} in time, so it went back to the board. You cannot take this task again.`,
      declined: `You gave task #${pad(order.id)} back. No problem, it is open for others again.`,
      customer_changed: `The customer decided to work with another developer on order #${pad(order.id)}. The deal channel was closed.`,
    }[reason];
    await dm(client, devId, card({ accent: COLORS.warn, title: 'Task update', body: text }));
  }

  await sendTo(
    client,
    order.ticket_channel_id,
    v2(
      card({
        accent: COLORS.warn,
        title: '🔄 Your task is back on the board',
        subtitle: `Order #${pad(order.id)}`,
        body:
          reason === 'customer_changed'
            ? `<@${order.customer_id}> We reposted your task. Your previous developer will not see it again. A new developer can accept it now.`
            : `<@${order.customer_id}> Your developer was not available, so we reposted your task. Nothing to pay again, the fee stays valid.`,
      })
    )
  );

  await postTask(client, updated, { skipWindow: true });
}

async function onDecline(i: ButtonInteraction, orderId: number) {
  const order = await loadSetup(i, orderId);
  if (!order) return;
  await i.reply({ content: '↩️ You gave the task back.', flags: MessageFlags.Ephemeral });
  await releaseTask(i.client, order, 'declined');
}

// =====================================================================
// 5) DEAL CHANNEL BUTTONS: support, change developer
// =====================================================================
const supportCooldown = new Map<number, number>();

async function onSupport(i: ButtonInteraction, orderId: number) {
  const order = await fetchOrder(orderId);
  if (!order || ![order.customer_id, order.dev_id].includes(i.user.id)) {
    return void (await i.reply({ content: 'Only the two people of this deal can use this.', flags: MessageFlags.Ephemeral }));
  }
  if (Date.now() - (supportCooldown.get(orderId) ?? 0) < 300_000) {
    return void (await i.reply({ content: 'Support was already notified a moment ago. Someone will be with you soon.', flags: MessageFlags.Ephemeral }));
  }
  supportCooldown.set(orderId, Date.now());

  const cfg = await getCfg();
  const ping = cfg.roles.support ? `<@&${cfg.roles.support}> ` : '';
  await i.reply({
    ...v2(card({ accent: COLORS.danger, title: '🛟 Support requested', body: `${ping}<@${i.user.id}> asked for help with order #${pad(orderId)}. A team member will join this channel soon.`, footer: 'Please describe the problem here in the meantime.' })),
    allowedMentions: { roles: cfg.roles.support ? [cfg.roles.support] : [] },
  } as never);
  await sendTo(i.client, cfg.channels.escalations, {
    content: `${ping}🆘 Support requested in <#${order.deal_channel_id}> (order #${pad(orderId)}) by <@${i.user.id}>.`,
    allowedMentions: { roles: cfg.roles.support ? [cfg.roles.support] : [], parse: [] },
  });
  await log(orderId, i.user.id, 'SUPPORT_REQUESTED', {});
}

async function onChangeButton(i: ButtonInteraction, orderId: number) {
  // Popups must open within 3 seconds; onChangeSubmit checks everything again.
  const order = await fastLoad(fetchOrder(orderId));
  if (order && order.customer_id !== i.user.id) {
    return void (await i.reply({ content: 'Only the customer can change the developer.', flags: MessageFlags.Ephemeral }));
  }
  if (order && !['IN_PROGRESS', 'REVISION'].includes(order.status)) {
    return void (await i.reply({ content: 'The developer can only be changed while the work is running.', flags: MessageFlags.Ephemeral }));
  }
  if (order && Number(order.dev_plan?.changes ?? 0) >= TASKS.maxChanges) {
    return void (await i.reply({ content: 'You already changed the developer the maximum number of times. Please press **Support**.', flags: MessageFlags.Ephemeral }));
  }
  await i.showModal(
    new ModalBuilder()
      .setCustomId(`deal:changeform:${orderId}`)
      .setTitle('Change developer')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('reason').setLabel('Why do you want a new developer?').setStyle(TextInputStyle.Paragraph).setMaxLength(400).setRequired(true)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('confirm').setLabel('Type CHANGE to confirm').setPlaceholder('CHANGE').setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true)
        )
      )
  );
}

async function onChangeSubmit(i: ModalSubmitInteraction, orderId: number) {
  const order = await fetchOrder(orderId);
  if (!order || order.customer_id !== i.user.id || !['IN_PROGRESS', 'REVISION'].includes(order.status)) {
    return void (await i.reply({ content: 'This can not be changed anymore.', flags: MessageFlags.Ephemeral }));
  }
  if (i.fields.getTextInputValue('confirm').trim().toUpperCase() !== 'CHANGE') {
    return void (await i.reply({ content: 'Please type CHANGE exactly to confirm.', flags: MessageFlags.Ephemeral }));
  }
  const reason = i.fields.getTextInputValue('reason').trim();
  await i.reply({ content: '🔄 Changing your developer. This channel closes now, the details follow in your ticket.', flags: MessageFlags.Ephemeral });
  await releaseTask(i.client, order, 'customer_changed', reason);
}

// =====================================================================
// 6) BACKGROUND JOBS
// =====================================================================
const warned = new Set<string>();

export function startTaskBoard(client: Client) {
  onFeePaid((c, order) => postTask(c, order)); // the fee is paid → the task goes live

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const cfg = await getCfg();
      const now = new Date().toISOString();

      // tasks that never made it to the board (channel was missing, bot was offline…)
      const { data: missing } = await supabase.from('orders').select('*').eq('status', 'OPEN').is('task_message_id', null).limit(5);
      for (const o of missing ?? []) {
        if (!cfg.channels[`task-${o.category}`]) {
          if (!warned.has(o.category)) { warned.add(o.category); console.warn(`⚠️ No task channel for "${o.category}". Run /setup_server.`); }
          continue;
        }
        await postTask(client, o);
      }

      // priority window is over → everyone is pinged
      const { data: windows } = await supabase
        .from('orders').select('*').eq('status', 'OPEN').not('priority_until', 'is', null).lte('priority_until', now).eq('window_notified', false);
      for (const o of windows ?? []) {
        await supabase.from('orders').update({ window_notified: true }).eq('id', o.id);
        const roleId = cfg.roles[o.category];
        const ch = o.task_channel_id ? await client.channels.fetch(o.task_channel_id).catch(() => null) : null;
        if (ch && ch.isTextBased() && 'messages' in ch && o.task_message_id) {
          const msg = await ch.messages.fetch(o.task_message_id).catch(() => null);
          await msg?.edit(v2(taskCard(o, { info: await customerLine(o.customer_id) }))).catch(() => null);
        }
        await sendTo(client, o.task_channel_id, {
          content: `${roleId ? `<@&${roleId}> ` : ''}Task **#${pad(o.id)}** is now open for **everyone**.`,
          allowedMentions: { roles: roleId ? [roleId] : [] },
        });
      }

      // developers who did not finish the setup lose the task
      const { data: slow } = await supabase.from('orders').select('*').eq('status', 'ASSIGNED').lt('setup_deadline', now);
      for (const o of slow ?? []) await releaseTask(client, o, 'timeout');

      // nobody took a task for a long time → Support is told once
      const cutoff = new Date(Date.now() - TASKS.openAlertHours * 3_600_000).toISOString();
      const { data: stale } = await supabase.from('orders').select('*').eq('status', 'OPEN').lt('paid_at', cutoff);
      for (const o of (stale ?? []).filter((x) => !x.dev_plan?.open_alerted)) {
        await supabase.from('orders').update({ dev_plan: { ...(o.dev_plan ?? {}), open_alerted: true } }).eq('id', o.id);
        await sendTo(client, cfg.channels.escalations, {
          content: `${cfg.roles.support ? `<@&${cfg.roles.support}> ` : ''}⏰ Task **#${pad(o.id)}** has been open for ${TASKS.openAlertHours}+ hours without a developer. Please help find one or contact the customer.`,
          allowedMentions: { roles: cfg.roles.support ? [cfg.roles.support] : [] },
        });
      }
    } catch (err) {
      console.error('❌ task board:', err);
    } finally {
      running = false;
    }
  };

  tick();
  setInterval(tick, 20_000);
}

// =====================================================================
// ROUTER
// =====================================================================
export async function handleTaskInteraction(i: Interaction): Promise<boolean> {
  try {
    if (i.isButton()) {
      const [scope, kind, id] = i.customId.split(':');
      const orderId = Number(id);
      if (scope === 'task' && kind === 'accept') { await onAccept(i, orderId); return true; }
      if (scope === 'setup') {
        if (kind === 'plan') await onPlanButton(i, orderId);
        else if (kind === 'quizok') await onQuizContinue(i, orderId);
        else if (kind === 'ack') await onAckButton(i, orderId);
        else if (kind === 'decline') await onDecline(i, orderId);
        else return false;
        return true;
      }
      if (scope === 'deal') {
        if (kind === 'support') await onSupport(i, orderId);
        else if (kind === 'change') await onChangeButton(i, orderId);
        else return false;
        return true;
      }
    }
    if (i.isStringSelectMenu() && i.customId.startsWith('setup:q:')) {
      const [, , id, qid] = i.customId.split(':');
      await onQuizSelect(i, Number(id), qid);
      return true;
    }
    if (i.isModalSubmit()) {
      const [scope, kind, id] = i.customId.split(':');
      const orderId = Number(id);
      if (scope === 'setup' && kind === 'planform') { await onPlanSubmit(i, orderId); return true; }
      if (scope === 'setup' && kind === 'ackform') { await onAckSubmit(i, orderId); return true; }
      if (scope === 'deal' && kind === 'changeform') { await onChangeSubmit(i, orderId); return true; }
    }
  } catch (err) {
    console.error('❌ Task interaction:', err);
    if (i.isRepliable()) {
      const msg = { content: TEXT.genericError, flags: MessageFlags.Ephemeral } as const;
      if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
    return true;
  }
  return false;
}