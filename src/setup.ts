import {
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Guild,
  Interaction,
  MessageFlags,
  OverwriteResolvable,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { CUSTOMER_RULES, DEV_ROLES, DEV_RULES, SERVER_RULES, TEXT } from './config';
import { getCfg, saveCfg, type Cfg } from './cfg';
import { COLORS, buildDashboard, card, v2, v2Ephemeral } from './ui';
import { buildDevPanel } from './devs';

const P = PermissionFlagsBits;
const READ = [P.ViewChannel, P.ReadMessageHistory];
const CHAT = [...READ, P.SendMessages, P.AttachFiles, P.EmbedLinks, P.AddReactions, P.UseApplicationCommands];
const NO_WRITE = [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads];
const BOT = [...CHAT, P.ManageMessages, P.ManageChannels];

type Vis = 'public-read' | 'public-chat' | 'devs-chat' | 'devs-read' | 'staff' | 'staff-read' | 'owner' | `skill:${string}`;
type Panel = 'rules' | 'how' | 'devrules' | 'devapply' | 'order' | 'taskinfo';
type ChannelSpec = { key: string; name: string; vis: Vis; topic?: string; panel?: Panel; adopt?: string };
type CategorySpec = { key: string; name: string; vis: Vis; adopt?: string; channels: ChannelSpec[] };

// ---------- The whole server layout ----------
const LAYOUT: CategorySpec[] = [
  {
    key: 'start', name: '📌 START HERE', vis: 'public-read',
    channels: [
      { key: 'rules', name: '📜-rules', vis: 'public-read', topic: 'Server rules and customer rules', panel: 'rules' },
      { key: 'announcements', name: '📣-announcements', vis: 'public-read', topic: 'News and updates' },
      { key: 'how', name: '❓-how-it-works', vis: 'public-read', topic: 'How ordering works', panel: 'how' },
      { key: 'reviews', name: '⭐-reviews', vis: 'public-read', topic: 'What customers say' },
    ],
  },
  {
    key: 'order', name: '🛒 ORDER', vis: 'public-read',
    channels: [
      { key: 'order-here', name: '🛒-order-here', vis: 'public-read', topic: 'Start your order here', panel: 'order' },
      { key: 'queue', name: '📊-queue-board', vis: 'public-read', topic: 'Live order status' },
      { key: 'support', name: '🛟-support', vis: 'public-read', topic: 'Need help? Open a support ticket' },
    ],
  },
  {
    key: 'devs', name: '💻 DEVELOPERS', vis: 'public-read',
    channels: [
      { key: 'dev-apply', name: '📝-become-a-dev', vis: 'public-read', topic: 'Apply to join the developer team', panel: 'devapply' },
      { key: 'dev-rules', name: '📘-dev-rules', vis: 'devs-read', topic: 'The rules every developer follows', panel: 'devrules' },
      { key: 'dev-lounge', name: '💬-dev-lounge', vis: 'devs-chat', topic: 'Chat with the other developers' },
      { key: 'dev-help', name: '🧭-dev-help', vis: 'devs-chat', topic: 'Questions about tasks and tools' },
    ],
  },
  {
    key: 'tasks', name: '📋 TASK BOARD', vis: 'devs-read',
    channels: [
      { key: 'task-info', name: '📋-task-info', vis: 'devs-read', topic: 'How the task board works', panel: 'taskinfo' },
      ...DEV_ROLES.map((r) => ({
        key: `task-${r.key}`, name: `📋-task-${r.key}`, vis: `skill:${r.key}` as Vis, topic: `Open ${r.name} tasks. Only ${r.name}s can see this channel.`,
      })),
    ],
  },
  { key: 'deals', name: '🤝 DEALS', vis: 'staff', channels: [] },
  { key: 'tickets', name: '🎫 ORDER TICKETS', vis: 'staff', adopt: process.env.TICKET_CATEGORY_ID, channels: [] },
  { key: 'devfiles', name: '📁 DEV FILES', vis: 'staff', channels: [] },
  {
    key: 'staff', name: '🛡️ STAFF', vis: 'staff',
    channels: [
      { key: 'staff-chat', name: '🧰-staff-chat', vis: 'staff', topic: 'Support team chat' },
      { key: 'escalations', name: '🆘-escalations', vis: 'staff', topic: 'Urgent help requests land here' },
      { key: 'disputes', name: '⚖️-disputes', vis: 'staff', topic: 'Open disputes between customers and developers' },
    ],
  },
  {
    key: 'owner', name: '🔒 OWNER', vis: 'owner',
    channels: [
      { key: 'owner-cockpit', name: '🕹️-owner-cockpit', vis: 'owner', adopt: process.env.OWNER_CHANNEL_ID },
      { key: 'owner-payments', name: '💰-owner-payment-alerts', vis: 'owner', adopt: process.env.OWNER_PAYMENT_CHANNEL_ID },
      { key: 'bot-logs', name: '🧾-bot-logs', vis: 'owner' },
    ],
  },
  {
    key: 'logs', name: '📜 LOGS', vis: 'staff-read',
    channels: [
      { key: 'msg-logs', name: '🗑️-msg-logs', vis: 'staff-read', topic: 'Deleted and edited messages' },
      { key: 'member-logs', name: '👥-member-logs', vis: 'staff-read', topic: 'Joins, leaves, nicknames and roles' },
      { key: 'mod-logs', name: '🛡️-mod-logs', vis: 'staff-read', topic: 'Security actions and moderation' },
      { key: 'order-logs', name: '📦-order-logs', vis: 'staff-read', topic: 'Everything that happens to orders' },
      { key: 'dev-logs', name: '💻-dev-logs', vis: 'staff-read', topic: 'Applications, decisions and strikes' },
      { key: 'deal-logs', name: '🤝-deal-logs', vis: 'staff-read', topic: 'Deal transcripts' },
    ],
  },
];

const roleSpecs = () => [
  { key: 'support', name: 'Novai Support', color: 0xf39c12, hoist: true, mentionable: true, permissions: [P.ModerateMembers, P.ManageMessages, P.ViewAuditLog] },
  { key: 'dev', name: 'Novai Dev', color: 0x2ecc71, hoist: true, mentionable: false, permissions: [] as bigint[] },
  ...DEV_ROLES.map((r) => ({ key: r.key, name: r.name, color: 0x5865f2, hoist: false, mentionable: true, permissions: [] as bigint[] })),
  { key: 'customer', name: 'Verified Customer', color: 0x3498db, hoist: false, mentionable: false, permissions: [] as bigint[] },
];

// ---------- Permissions per visibility ----------
function overwritesFor(guild: Guild, botId: string, cfg: Cfg, vis: Vis): OverwriteResolvable[] {
  const everyone = guild.roles.everyone.id;
  const out: OverwriteResolvable[] = [{ id: botId, allow: BOT }];
  const staff = (perms: bigint[]) => { if (cfg.roles.support) out.push({ id: cfg.roles.support, allow: perms }); };
  const hidden = () => out.push({ id: everyone, deny: [P.ViewChannel] });

  if (vis === 'public-read') out.push({ id: everyone, allow: READ, deny: NO_WRITE });
  else if (vis === 'public-chat') out.push({ id: everyone, allow: CHAT });
  else if (vis === 'devs-chat') { hidden(); if (cfg.roles.dev) out.push({ id: cfg.roles.dev, allow: CHAT }); staff(CHAT); }
  else if (vis === 'devs-read') { hidden(); if (cfg.roles.dev) out.push({ id: cfg.roles.dev, allow: READ, deny: NO_WRITE }); staff(CHAT); }
  else if (vis === 'staff') { hidden(); staff(CHAT); }
  else if (vis === 'staff-read') { hidden(); staff(READ); }
  else if (vis === 'owner') hidden();
  else if (vis.startsWith('skill:')) {
    hidden();
    const role = cfg.roles[vis.slice(6)];
    if (role) out.push({ id: role, allow: READ, deny: NO_WRITE });
    staff(CHAT);
  }
  return out;
}

// ---------- Panel texts ----------
const numbered = (items: string[]) => items.map((t, i) => `**${i + 1}.** ${t}`).join('\n');

function panelPayload(panel: Panel) {
  switch (panel) {
    case 'rules':
      return v2(
        card({ accent: COLORS.brand, title: '📜 Server rules', body: numbered(SERVER_RULES) }),
        card({ accent: COLORS.success, title: '🛒 Customer rules', body: numbered(CUSTOMER_RULES), footer: TEXT.footer })
      );
    case 'devrules':
      return v2(card({ accent: COLORS.warn, title: '📘 Developer rules', subtitle: 'You accept these when you take a task', body: numbered(DEV_RULES), footer: TEXT.footer }));
    case 'how':
      return v2(
        card({
          accent: COLORS.brand,
          title: '❓ How Novai works',
          body: [
            '**1 · Brief**  Choose a package and answer a few quick questions.',
            '**2 · Identity**  Link your Roblox account with one click.',
            '**3 · Quote**  You get a clear price and a small platform fee.',
            '**4 · Fee**  Pay the fee in Novai Studio. Then your task goes live.',
            '**5 · Match**  A verified developer accepts it and you talk in a private deal channel.',
            '**6 · Delivery**  Review the result, confirm it and rate your developer.',
          ].join('\n'),
          footer: 'Ready? Head to the order channel.',
        })
      );
    case 'taskinfo':
      return v2(
        card({
          accent: COLORS.brand,
          title: '📋 How the task board works',
          body: [
            'Every role has its own task channel. You only see the tasks for your roles.',
            'When a task is posted, your role is pinged. **The first developer who presses Accept gets the task.**',
            'After accepting you answer a few questions and agree to the dev rules. Then a private deal channel opens with the customer.',
            'Apex tasks are shown to top-rated developers first, then to everyone.',
          ].join('\n\n'),
          footer: TEXT.footer,
        })
      );
    case 'devapply':
      return v2(buildDevPanel());
    case 'order':
      return v2(buildDashboard());
  }
}

// ---------- Run ----------
let running = false;

type Counts = { roles: number; categories: number; channels: number; panels: number; problems: string[] };

async function runSetup(guild: Guild, client: Client, step: (text: string) => Promise<void>): Promise<Counts> {
  const cfg = await getCfg(true);
  const counts: Counts = { roles: 0, categories: 0, channels: 0, panels: 0, problems: [] };
  const botId = client.user!.id;
  await guild.roles.fetch();
  await guild.channels.fetch();

  // 1) roles
  await step('Creating roles…');
  for (const spec of roleSpecs()) {
    const existing = guild.roles.cache.get(cfg.roles[spec.key]) ?? guild.roles.cache.find((r) => r.name === spec.name);
    if (existing) {
      cfg.roles[spec.key] = existing.id;
      continue;
    }
    try {
      const role = await guild.roles.create({
        name: spec.name, color: spec.color, hoist: spec.hoist, mentionable: spec.mentionable,
        permissions: spec.permissions, reason: 'Novai server setup',
      });
      cfg.roles[spec.key] = role.id;
      counts.roles++;
    } catch (e) {
      counts.problems.push(`Role "${spec.name}": ${e instanceof Error ? e.message : e}`);
    }
  }

  // 2) categories and channels
  for (const cat of LAYOUT) {
    await step(`Building ${cat.name}…`);
    let category = guild.channels.cache.get(cfg.categories[cat.key] ?? '') ?? (cat.adopt ? guild.channels.cache.get(cat.adopt) : undefined)
      ?? guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === cat.name);

    try {
      if (!category) {
        category = await guild.channels.create({
          name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: overwritesFor(guild, botId, cfg, cat.vis),
        });
        counts.categories++;
      } else if (!cat.adopt) {
        await (category as import('discord.js').CategoryChannel).permissionOverwrites.set(overwritesFor(guild, botId, cfg, cat.vis));
      }
      cfg.categories[cat.key] = category.id;
    } catch (e) {
      counts.problems.push(`Category "${cat.name}": ${e instanceof Error ? e.message : e}`);
      continue;
    }

    for (const spec of cat.channels) {
      try {
        if (spec.adopt && guild.channels.cache.get(spec.adopt)) {
          cfg.channels[spec.key] = spec.adopt; // keep the channel you already use
          continue;
        }
        let channel = guild.channels.cache.get(cfg.channels[spec.key] ?? '') ??
          guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === spec.name && c.parentId === category!.id);
        const overwrites = overwritesFor(guild, botId, cfg, spec.vis);

        if (!channel) {
          channel = await guild.channels.create({
            name: spec.name, type: ChannelType.GuildText, parent: category.id, topic: spec.topic, permissionOverwrites: overwrites,
          });
          counts.channels++;
        } else if (channel.type === ChannelType.GuildText) {
          await channel.permissionOverwrites.set(overwrites);
          if (spec.topic && channel.topic !== spec.topic) await channel.setTopic(spec.topic);
        }
        cfg.channels[spec.key] = channel.id;
      } catch (e) {
        counts.problems.push(`Channel "${spec.name}": ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 3) panels (posted once, edited on every later run)
  await step('Posting panels…');
  for (const cat of LAYOUT) {
    for (const spec of cat.channels) {
      if (!spec.panel || !cfg.channels[spec.key]) continue;
      const ch = await guild.channels.fetch(cfg.channels[spec.key]).catch(() => null);
      if (!ch || !ch.isTextBased() || !('send' in ch)) continue;
      const payload = panelPayload(spec.panel);
      const old = cfg.posted[spec.panel] ? await ch.messages.fetch(cfg.posted[spec.panel]).catch(() => null) : null;
      if (old) {
        await old.edit(payload as never).catch((e) => counts.problems.push(`Panel ${spec.panel}: ${e.message}`));
      } else {
        const sent = await ch.send(payload as never).catch((e) => { counts.problems.push(`Panel ${spec.panel}: ${e.message}`); return null; });
        if (sent) cfg.posted[spec.panel] = sent.id;
      }
      counts.panels++;
    }
  }

  await saveCfg(cfg);
  return counts;
}

// ---------- Command ----------
export const setupCommands = [
  new SlashCommandBuilder()
    .setName('setup_server')
    .setDescription('Owner: build or update the Novai roles, channels and panels')
    .setDefaultMemberPermissions(P.Administrator),
];

export async function handleSetupCommand(i: ChatInputCommandInteraction): Promise<boolean> {
  if (i.commandName !== 'setup_server') return false;
  const channels = LAYOUT.reduce((n, c) => n + c.channels.length, 0);
  await i.reply(
    v2Ephemeral(
      card({
        accent: COLORS.brand,
        title: '🏗️ Server setup',
        body:
          `This creates or updates **${roleSpecs().length} roles**, **${LAYOUT.length} categories** and **${channels} channels** with the right permissions, ` +
          'and posts the rules, the order dashboard and the developer application panel.\n\n' +
          '**Nothing is deleted.** Things that already exist (same name) are reused, and your owner channels and ticket category are kept.',
        buttons: [
          new ButtonBuilder().setCustomId('setup:run').setLabel('Build everything').setEmoji('🏗️').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ],
        footer: 'Takes about a minute.',
      })
    )
  );
  return true;
}

export async function handleSetupInteraction(i: Interaction): Promise<boolean> {
  // Deal setup uses setup:plan:123. Only the server builder uses these two ids.
  if (!i.isButton() || (i.customId !== 'setup:run' && i.customId !== 'setup:cancel')) return false;
  if (!i.memberPermissions?.has(P.Administrator)) {
    await i.reply({ content: '🔒 Only the owner can do this.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (i.customId === 'setup:cancel') {
    await i.update(v2(card({ title: 'Setup cancelled', body: 'Nothing was changed.' })));
    return true;
  }
  if (running) {
    await i.reply({ content: 'Setup is already running.', flags: MessageFlags.Ephemeral });
    return true;
  }

  running = true;
  const working = (text: string) => v2(card({ accent: COLORS.warn, title: '⏳ Building your server…', body: text }));
  await i.update(working('Starting…'));
  try {
    const counts = await runSetup(i.guild!, i.client, async (text) => {
      await i.editReply(working(text)).catch(() => null);
    });
    await i.editReply(
      v2(
        card({
          accent: counts.problems.length ? COLORS.warn : COLORS.success,
          title: counts.problems.length ? '⚠️ Setup finished with problems' : '✅ Server is ready',
          fields: [
            ['Created', `${counts.roles} roles · ${counts.categories} categories · ${counts.channels} channels`],
            ['Panels', `${counts.panels} posted or updated`],
          ],
          body: counts.problems.length
            ? `**Problems**\n${counts.problems.slice(0, 8).map((p) => `- ${p}`).join('\n')}\n\nMost often the Novai role is missing a permission or sits too low in the role list. Fix it and run /setup_server again.`
            : 'Next steps:\n- Give your support team the **Novai Support** role.\n- Invite your first developers to the **#become-a-dev** channel.\n- Old categories like AGENTS are no longer needed.',
          footer: TEXT.footer,
        })
      )
    );
  } catch (err) {
    console.error('❌ setup:', err);
    await i.editReply(v2(card({ accent: COLORS.danger, title: '❌ Setup failed', body: err instanceof Error ? err.message : String(err) }))).catch(() => null);
  } finally {
    running = false;
  }
  return true;
}