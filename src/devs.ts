import { fastLoad } from './safe';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Guild,
  Interaction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  OverwriteResolvable,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { supabase } from './db';
import { DEV_ROLES, DEV_SETTINGS, TEXT } from './config';
import { getCfg } from './cfg';
import { COLORS, card, v2, v2Ephemeral } from './ui';
import { robloxHeadshot, robloxLookup, robloxProfile, slug } from './roblox';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dev = Record<string, any>;
const P = PermissionFlagsBits;

const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const skillNames = (keys: string[]) =>
  (keys ?? []).map((k) => { const r = DEV_ROLES.find((x) => x.key === k); return r ? `${r.emoji} ${r.name}` : k; }).join(', ');
const days = (iso: string | number) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

const isAdmin = (i: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction) =>
  i.memberPermissions?.has(P.Administrator) ?? false;
const isStaff = (i: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction) =>
  (i.memberPermissions?.has(P.ModerateMembers) || i.memberPermissions?.has(P.Administrator)) ?? false;

async function dm(client: Client, userId: string, payload: object): Promise<boolean> {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return false;
  return user.send(payload as never).then(() => true).catch(() => false);
}

async function logTo(client: Client, key: string, payload: object) {
  const cfg = await getCfg();
  const id = cfg.channels[key];
  if (!id) return;
  const ch = await client.channels.fetch(id).catch(() => null);
  if (ch && ch.isTextBased() && 'send' in ch) await ch.send(payload as never).catch(() => null);
}

async function guildOf(client: Client): Promise<Guild | null> {
  return client.guilds.fetch(process.env.GUILD_ID!).catch(() => null);
}

// ---------- The public panel (posted by /setup_server) ----------
export function buildDevPanel() {
  return card({
    accent: COLORS.success,
    title: '🧑 Become a Novai developer',
    body:
      'Work on real customer projects, pick the tasks you like and get paid for your craft. ' +
      'We review every application personally.',
    fields: [
      ['Roles', DEV_ROLES.map((r) => `${r.emoji} ${r.name}`).join('  ·  ')],
      ['How it works', 'Apply → we review your work → you get access to the task board.'],
    ],
    buttons: [new ButtonBuilder().setCustomId('dev:apply').setLabel('Apply now').setEmoji('📝').setStyle(ButtonStyle.Success)],
    footer: 'Please share real, verifiable work. Fake portfolios are rejected for good.',
  });
}

// ---------- Application flow ----------
function skillsCard(selected: string[]) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('dev:skills')
    .setPlaceholder(`Choose up to ${DEV_SETTINGS.maxSkills} roles`)
    .setMinValues(1)
    .setMaxValues(DEV_SETTINGS.maxSkills)
    .addOptions(
      DEV_ROLES.map((r) =>
        new StringSelectMenuOptionBuilder().setValue(r.key).setLabel(r.name).setEmoji(r.emoji).setDefault(selected.includes(r.key))
      )
    );
  const next = new ButtonBuilder()
    .setCustomId(`dev:form:${selected.join(',') || 'none'}`)
    .setLabel('Continue')
    .setEmoji('▶️')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(selected.length === 0);
  return card({
    accent: COLORS.brand,
    title: '📝 Developer application',
    subtitle: 'Step 1 of 2 · Your roles',
    body: 'Which roles do you want to work in? Pick the ones you can show real work for.',
    selects: [select],
    buttons: [next],
    footer: TEXT.footer,
  });
}

// Returns a message if this person may NOT apply right now, otherwise null
function applyBlock(dev: { status: string; reapply_after?: string | null } | null | undefined): string | null {
  if (!dev) return null;
  if (dev.status === 'active') return 'You are already a Novai developer. See you on the task board! 🙌';
  if (dev.status === 'pending') return 'Your application is already being reviewed. We will message you here once we decided.';
  if (dev.status === 'rejected' && dev.reapply_after && new Date(dev.reapply_after) > new Date()) {
    return `You can apply again <t:${Math.floor(new Date(dev.reapply_after).getTime() / 1000)}:R>.`;
  }
  if (['suspended', 'removed'].includes(dev.status)) {
    return 'Your developer access is closed. Please contact Support if you think this is a mistake.';
  }
  return null;
}

async function onApplyStart(i: ButtonInteraction) {
  // Wait only briefly for the database; the final check happens again when the form is sent
  const fast = await fastLoad(supabase.from('devs').select('status, reapply_after').eq('discord_id', i.user.id).maybeSingle(), 1200);
  const blocked = applyBlock(fast?.data);
  if (blocked) return void (await i.reply({ content: blocked, flags: MessageFlags.Ephemeral }));
  await i.reply(v2Ephemeral(skillsCard([])));
}

async function onSkills(i: StringSelectMenuInteraction) {
  await i.update(v2(skillsCard(i.values.filter((v) => DEV_ROLES.some((r) => r.key === v)))));
}

async function onFormButton(i: ButtonInteraction, csv: string) {
  const skills = csv.split(',').filter((s) => DEV_ROLES.some((r) => r.key === s));
  if (!skills.length) return void (await i.reply({ content: 'Please choose at least one role first.', flags: MessageFlags.Ephemeral }));

  const input = (id: string, label: string, placeholder: string, style: TextInputStyle, max: number, required = true, min?: number) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(style).setMaxLength(max).setRequired(required);
    if (min) t.setMinLength(min);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
  };

  await i.showModal(
    new ModalBuilder()
      .setCustomId(`dev:submit:${skills.join(',')}`)
      .setTitle('Developer application')
      .addComponents(
        input('roblox', 'Roblox username', 'Your username, not your display name', TextInputStyle.Short, 20, true, 3),
        input('portfolio', 'Past work (links)', 'Links to your best work: Roblox games, videos, portfolio, Twitter…', TextInputStyle.Paragraph, 600, true, 10),
        input('experience', 'Experience & specialties', 'Years of experience, tools you use, what you are best at', TextInputStyle.Paragraph, 500, true, 20),
        input('about', 'About you (optional)', 'Timezone, languages, anything we should know', TextInputStyle.Paragraph, 400, false),
        input('capacity', 'Availability & turnaround', 'e.g. 15h per week, usually 2–4 days per task', TextInputStyle.Short, 100, true, 3)
      )
  );
}

function checksFor(discordAge: number, robloxAge: number, portfolio: string): string[] {
  const d = discordAge >= 30 ? `✅ Discord account ${discordAge} days old`
    : discordAge >= DEV_SETTINGS.minDiscordAgeDays ? `⚠️ Discord account only ${discordAge} days old`
    : `🚩 Discord account only ${discordAge} days old`;
  const r = robloxAge >= 90 ? `✅ Roblox account ${robloxAge} days old`
    : robloxAge >= DEV_SETTINGS.minRobloxAgeDays ? `⚠️ Roblox account only ${robloxAge} days old`
    : `🚩 Roblox account only ${robloxAge} days old`;
  const p = /https?:\/\//i.test(portfolio) ? '✅ Portfolio contains links' : '⚠️ Portfolio has no links to check';
  return [d, r, p];
}

function applicationCard(dev: Dev, state: 'pending' | 'accepted' | 'rejected', by?: string, note?: string) {
  const a = dev.application ?? {};
  const lines = [
    `**Roblox**  [${dev.roblox_name}](https://www.roblox.com/users/${dev.roblox_id}/profile) · account age ${a.robloxAge} days`,
    `**Roles**  ${skillNames(dev.skills)}`,
    `**Availability**  ${a.capacity}`,
    `\n**Portfolio**\n${a.portfolio}`,
    `\n**Experience**\n${a.experience}`,
  ];
  if (a.about) lines.push(`\n**About**\n${a.about}`);
  lines.push(`\n**Checks**\n${(a.checks ?? []).join('\n')}`);

  const buttons = state === 'pending'
    ? [
        new ButtonBuilder().setCustomId(`dev:accept:${dev.discord_id}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`dev:reject:${dev.discord_id}`).setLabel('Reject').setEmoji('❌').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`dev:ask:${dev.discord_id}`).setLabel('Ask a question').setEmoji('💬').setStyle(ButtonStyle.Secondary),
      ]
    : undefined;

  return card({
    accent: state === 'accepted' ? COLORS.success : state === 'rejected' ? COLORS.danger : COLORS.brand,
    title: '🧑 Developer application',
    subtitle: `<@${dev.discord_id}> · ${dev.discord_name}`,
    thumbnail: a.avatar ?? undefined,
    body: lines.join('\n'),
    buttons,
    footer: state === 'accepted' ? `✅ Accepted by ${by}${note ? ` · ${note}` : ''}` : state === 'rejected' ? `❌ Rejected by ${by}` : TEXT.footer,
  });
}

// Stops double-clicks from creating two applications at the same time
const applying = new Set<string>();
async function onSubmit(i: ModalSubmitInteraction, csv: string) {
  if (applying.has(i.user.id)) {
    return void (await i.reply({ content: '⏳ Your application is already being sent, one moment…', flags: MessageFlags.Ephemeral }));
  }
  applying.add(i.user.id);
  try {
    await onSubmitInner(i, csv);
  } finally {
    applying.delete(i.user.id);
  }
}

async function onSubmitInner(i: ModalSubmitInteraction, csv: string) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const skills = csv.split(',').filter((s) => DEV_ROLES.some((r) => r.key === s)).slice(0, DEV_SETTINGS.maxSkills);
  const robloxInput = i.fields.getTextInputValue('roblox').trim();
  const portfolio = i.fields.getTextInputValue('portfolio').trim();
  const experience = i.fields.getTextInputValue('experience').trim();
  const about = i.fields.getTextInputValue('about').trim();
  const capacity = i.fields.getTextInputValue('capacity').trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(robloxInput)) return void (await i.editReply('⚠️ That does not look like a Roblox username. Please apply again.'));

  const { data: existing } = await supabase.from('devs').select('status, reapply_after').eq('discord_id', i.user.id).maybeSingle();
  const blocked = applyBlock(existing);
  if (blocked) return void (await i.editReply(blocked));

  const cfg = await getCfg();
  if (!cfg.categories.devfiles || !cfg.roles.support) {
    console.warn('⚠️ Applications need /setup_server first.');
    return void (await i.editReply('Applications are not open yet. Please try again later.'));
  }

  try {
    const found = await robloxLookup(robloxInput);
    if (!found) return void (await i.editReply('⚠️ I could not find that Roblox user. Please check the spelling and apply again.'));

    const { data: dup } = await supabase.from('devs').select('discord_id').eq('roblox_id', found.id).neq('discord_id', i.user.id).limit(1);
    if (dup && dup.length) return void (await i.editReply('⚠️ This Roblox account is already used by another application. Please contact Support.'));

    const [profile, avatar] = await Promise.all([robloxProfile(found.id), robloxHeadshot(found.id)]);
    const robloxAge = days(profile.created);
    const discordAge = days(i.user.createdTimestamp);

    const guild = i.guild!;
    const overwrites: OverwriteResolvable[] = [
      { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
      { id: i.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.ManageChannels] },
      { id: cfg.roles.support, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
    ];
    const channel = await guild.channels.create({
      name: `app-${slug(i.user.username)}`,
      type: ChannelType.GuildText,
      parent: cfg.categories.devfiles,
      topic: `Application · ${i.user.username} · Roblox ${profile.name}`,
      permissionOverwrites: overwrites,
    });

    const application = {
      portfolio, experience, about, capacity, robloxAge, discordAge, avatar,
      checks: checksFor(discordAge, robloxAge, portfolio),
      appliedAt: new Date().toISOString(),
    };
    const { data: dev, error } = await supabase
      .from('devs')
      .upsert(
        {
          discord_id: i.user.id,
          discord_name: i.user.username,
          roblox_id: found.id,
          roblox_name: profile.name,
          skills,
          status: 'pending',
          application,
          channel_id: channel.id,
          reapply_after: null,
          decided_by: null,
          decided_at: null,
        },
        { onConflict: 'discord_id' }
      )
      .select()
      .single();
    if (error || !dev) {
      await channel.delete().catch(() => null);
      console.error('❌ dev insert:', error?.message);
      return void (await i.editReply(TEXT.genericError));
    }

    await channel.send(v2(applicationCard(dev, 'pending')));
    await logTo(i.client, 'dev-logs', v2(card({ accent: COLORS.brand, title: '📝 New developer application', body: `<@${i.user.id}> applied as ${skillNames(skills)}.\nFile: <#${channel.id}>` })));

    await i.deleteReply();
    await i.followUp(
      v2Ephemeral(
        card({
          accent: COLORS.success,
          title: '✅ Application received',
          body: 'Thank you! We review every application personally. You will get a message from this bot as soon as we decided.\n\nPlease keep your DMs open for server members.',
          footer: TEXT.footer,
        })
      )
    );
  } catch (err) {
    console.error('❌ dev apply:', err);
    await i.editReply('⚠️ Something went wrong while sending your application (Roblox or Discord is slow). Please try again in a moment.').catch(() => null);  }
}

// ---------- Review: accept / reject / ask ----------
const messageModal = (id: string, title: string, label: string, required: boolean, placeholder: string) =>
  new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('message').setLabel(label).setPlaceholder(placeholder).setStyle(TextInputStyle.Paragraph).setMaxLength(800).setRequired(required)
      )
    );

async function changeRoles(guild: Guild | null, userId: string, skills: string[], add: boolean): Promise<string | null> {
  if (!guild) return 'Server not found.';
  const cfg = await getCfg();
  const ids = [cfg.roles.dev, ...skills.map((s) => cfg.roles[s])].filter(Boolean);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return 'The user is no longer in the server.';
  try {
    if (add) await member.roles.add(ids);
    else await member.roles.remove(ids);
    return null;
  } catch {
    return 'Could not change roles. Is the Novai role above the developer roles?';
  }
}

async function onAcceptSubmit(i: ModalSubmitInteraction, devId: string) {
  if (!isAdmin(i)) return void (await i.reply({ content: '🔒 Only the owner can accept developers.', flags: MessageFlags.Ephemeral }));
  const message = i.fields.getTextInputValue('message').trim();

  const { data: dev } = await supabase
    .from('devs')
    .update({ status: 'active', accepted_at: new Date().toISOString(), decided_by: i.user.id, decided_at: new Date().toISOString() })
    .eq('discord_id', devId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (!dev) return void (await i.reply({ content: 'This application was already handled.', flags: MessageFlags.Ephemeral }));

  const notes: string[] = [];
  const roleProblem = await changeRoles(i.guild, devId, dev.skills, true);
  if (roleProblem) notes.push(roleProblem);

  const member = await i.guild?.members.fetch(devId).catch(() => null);
  if (member) await member.setNickname(dev.roblox_name).catch(() => notes.push('Nickname could not be changed.'));

  const ch = dev.channel_id ? await i.client.channels.fetch(dev.channel_id).catch(() => null) : null;
  if (ch && 'setName' in ch) {
    await ch.setName(`dev-${slug(dev.roblox_name)}`).catch(() => null);
    if ('setTopic' in ch) await ch.setTopic(`Dev file · ${dev.discord_name} · Roblox ${dev.roblox_name}`).catch(() => null);
  }

  const sent = await dm(
    i.client,
    devId,
    v2(
      card({
        accent: COLORS.success,
        title: '🎉 Welcome to the Novai developer team!',
        body:
          (message ? `**Message from the team**\n${message}\n\n` : '') +
          'You now have access to the **task board**. Read the dev rules first, then pick tasks that fit your roles. ' +
          'Use /mywork to see your tasks.',
        footer: TEXT.footer,
      })
    )
  );
  if (!sent) notes.push('DM could not be delivered.');

  await i.update(v2(applicationCard(dev, 'accepted', i.user.username, notes.join(' '))));
  await logTo(i.client, 'dev-logs', v2(card({ accent: COLORS.success, title: '✅ Developer accepted', body: `<@${devId}> · ${skillNames(dev.skills)}\nBy ${i.user.username}${notes.length ? `\n⚠️ ${notes.join(' ')}` : ''}` })));
}

async function onRejectSubmit(i: ModalSubmitInteraction, devId: string) {
  if (!isAdmin(i)) return void (await i.reply({ content: '🔒 Only the owner can reject developers.', flags: MessageFlags.Ephemeral }));
  const message = i.fields.getTextInputValue('message').trim();
  const again = new Date(Date.now() + DEV_SETTINGS.reapplyDays * 86_400_000);

  const { data: dev } = await supabase
    .from('devs')
    .update({ status: 'rejected', reapply_after: again.toISOString(), decided_by: i.user.id, decided_at: new Date().toISOString() })
    .eq('discord_id', devId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (!dev) return void (await i.reply({ content: 'This application was already handled.', flags: MessageFlags.Ephemeral }));

  await dm(
    i.client,
    devId,
    v2(
      card({
        accent: COLORS.danger,
        title: 'Your developer application',
        body: `Thank you for applying. Unfortunately we can't accept you right now.\n\n**Message from the team**\n${message}\n\nYou can apply again <t:${Math.floor(again.getTime() / 1000)}:R>.`,
        footer: TEXT.footer,
      })
    )
  );
  await i.update(v2(applicationCard(dev, 'rejected', i.user.username)));
  await logTo(i.client, 'dev-logs', v2(card({ accent: COLORS.danger, title: '❌ Developer rejected', body: `<@${devId}> by ${i.user.username}\n> ${clip(message, 300)}` })));
}

async function onAskSubmit(i: ModalSubmitInteraction, devId: string) {
  if (!isStaff(i)) return void (await i.reply({ content: '🔒 Staff only.', flags: MessageFlags.Ephemeral }));
  const message = i.fields.getTextInputValue('message').trim();
  const { data: dev } = await supabase.from('devs').select('channel_id').eq('discord_id', devId).maybeSingle();

  const sent = await dm(
    i.client,
    devId,
    v2(
      card({
        accent: COLORS.brand,
        title: '💬 A question about your application',
        body: `${message}\n\nPress the button below to answer.`,
        buttons: [new ButtonBuilder().setCustomId(`dev:reply:${devId}`).setLabel('Answer').setEmoji('✍️').setStyle(ButtonStyle.Primary)],
        footer: TEXT.footer,
      })
    )
  );
  const ch = dev?.channel_id ? await i.client.channels.fetch(dev.channel_id).catch(() => null) : null;
  if (ch && ch.isTextBased() && 'send' in ch) {
    await ch.send(v2(card({ accent: COLORS.warn, title: '❓ Question sent', body: `By ${i.user.username}${sent ? '' : ' (DM could not be delivered)'}\n> ${clip(message, 800)}` })));
  }
  await i.reply({ content: sent ? '💬 Question sent.' : '⚠️ The DM could not be delivered (their DMs are closed).', flags: MessageFlags.Ephemeral });
}

async function onReplySubmit(i: ModalSubmitInteraction, devId: string) {
  if (i.user.id !== devId) return void (await i.reply({ content: 'This is not your application.', flags: MessageFlags.Ephemeral }));
  const message = i.fields.getTextInputValue('message').trim();
  const { data: dev } = await supabase.from('devs').select('channel_id').eq('discord_id', devId).maybeSingle();
  const ch = dev?.channel_id ? await i.client.channels.fetch(dev.channel_id).catch(() => null) : null;
  if (ch && ch.isTextBased() && 'send' in ch) {
    await ch.send(v2(card({ accent: COLORS.brand, title: '✍️ Applicant answered', body: `<@${devId}>\n> ${clip(message, 800)}` })));
  }
  await i.reply({ content: '✅ Thank you, your answer was sent to the team.', flags: MessageFlags.Ephemeral });
}

// ---------- Staff commands ----------
export const devCommands = [
  new SlashCommandBuilder()
    .setName('dev')
    .setDescription('Staff: developer tools')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addSubcommand((s) =>
      s.setName('info').setDescription('Show a developer file').addUserOption((o) => o.setName('user').setDescription('The developer').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('suspend')
        .setDescription('Suspend a developer (removes the roles)')
        .addUserOption((o) => o.setName('user').setDescription('The developer').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason (logged)').setRequired(true).setMaxLength(300))
    )
    .addSubcommand((s) =>
      s.setName('reinstate').setDescription('Give a suspended developer access again').addUserOption((o) => o.setName('user').setDescription('The developer').setRequired(true))
    ),
];

export async function handleDevCommand(i: ChatInputCommandInteraction): Promise<boolean> {
  if (i.commandName !== 'dev') return false;
  try {
    if (!isStaff(i)) {
      await i.reply({ content: '🔒 Staff only.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const sub = i.options.getSubcommand();
    const user = i.options.getUser('user', true);
    const { data: dev } = await supabase.from('devs').select('*').eq('discord_id', user.id).maybeSingle();
    if (!dev) {
      await i.reply({ content: `No developer file for <@${user.id}>.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'info') {
      await i.reply(
        v2Ephemeral(
          card({
            accent: COLORS.brand,
            title: `📁 ${dev.roblox_name ?? dev.discord_name}`,
            subtitle: `<@${dev.discord_id}> · status: ${dev.status}`,
            thumbnail: dev.application?.avatar ?? undefined,
            fields: [
              ['Roblox', `[${dev.roblox_name}](https://www.roblox.com/users/${dev.roblox_id}/profile)`],
              ['Roles', skillNames(dev.skills) || '—'],
              ['Rating', dev.rating_count ? `⭐ ${Number(dev.rating_avg).toFixed(2)} (${dev.rating_count})` : 'no ratings yet'],
              ['Completed orders', String(dev.completed_count)],
              ['Strikes', String(dev.strikes)],
              ['File', dev.channel_id ? `<#${dev.channel_id}>` : '—'],
            ],
            footer: TEXT.footer,
          })
        )
      );
      return true;
    }

    if (sub === 'suspend') {
      const reason = i.options.getString('reason', true);
      await supabase.from('devs').update({ status: 'suspended', staff_notes: reason }).eq('discord_id', user.id);
      const problem = await changeRoles(i.guild, user.id, dev.skills, false);
      await dm(i.client, user.id, v2(card({ accent: COLORS.danger, title: 'Developer access suspended', body: `Your Novai developer access was suspended.\n**Reason:** ${reason}\nPlease contact Support.` })));
      await logTo(i.client, 'dev-logs', v2(card({ accent: COLORS.danger, title: '⛔ Developer suspended', body: `<@${user.id}> by ${i.user.username}\n> ${reason}` })));
      await i.reply({ content: problem ? `⛔ Suspended, but: ${problem}` : '⛔ Suspended and roles removed.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (sub === 'reinstate') {
      await supabase.from('devs').update({ status: 'active' }).eq('discord_id', user.id);
      const problem = await changeRoles(i.guild, user.id, dev.skills, true);
      await logTo(i.client, 'dev-logs', v2(card({ accent: COLORS.success, title: '♻️ Developer reinstated', body: `<@${user.id}> by ${i.user.username}` })));
      await i.reply({ content: problem ? `✅ Reinstated, but: ${problem}` : '✅ Reinstated and roles restored.', flags: MessageFlags.Ephemeral });
      return true;
    }
  } catch (err) {
    console.error('❌ /dev:', err);
    if (!i.replied) await i.reply({ content: TEXT.genericError, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  return true;
}

// ---------- Router ----------
export async function handleDevInteraction(i: Interaction): Promise<boolean> {
  try {
    if (i.isStringSelectMenu() && i.customId === 'dev:skills') {
      await onSkills(i);
      return true;
    }
    if (i.isButton() && i.customId.startsWith('dev:')) {
      const [, kind, arg] = i.customId.split(':');
      if (kind === 'apply') { await onApplyStart(i); return true; }
      if (kind === 'form') { await onFormButton(i, arg); return true; }

      if (['accept', 'reject', 'ask'].includes(kind)) {
        if (kind === 'ask' ? !isStaff(i) : !isAdmin(i)) {
          await i.reply({ content: kind === 'ask' ? '🔒 Staff only.' : '🔒 Only the owner can decide.', flags: MessageFlags.Ephemeral });
          return true;
        }
        if (kind === 'accept') await i.showModal(messageModal(`dev:accept-form:${arg}`, 'Accept developer', 'Message to the developer (optional)', false, 'Welcome note, tips, what you liked about their work…'));
        if (kind === 'reject') await i.showModal(messageModal(`dev:reject-form:${arg}`, 'Reject developer', 'Message to the developer (required)', true, 'Be kind and specific, they will read this.'));
        if (kind === 'ask') await i.showModal(messageModal(`dev:ask-form:${arg}`, 'Ask a question', 'Your question', true, 'What would you like to know?'));
        return true;
      }
      if (kind === 'reply') {
        if (i.user.id !== arg) {
          await i.reply({ content: 'This is not your application.', flags: MessageFlags.Ephemeral });
          return true;
        }
        await i.showModal(messageModal(`dev:reply-form:${arg}`, 'Your answer', 'Your answer', true, 'Write your answer here.'));
        return true;
      }
    }
    if (i.isModalSubmit() && i.customId.startsWith('dev:')) {
      const [, kind, arg] = i.customId.split(':');
      if (kind === 'submit') await onSubmit(i, arg);
      else if (kind === 'accept-form') await onAcceptSubmit(i, arg);
      else if (kind === 'reject-form') await onRejectSubmit(i, arg);
      else if (kind === 'ask-form') await onAskSubmit(i, arg);
      else if (kind === 'reply-form') await onReplySubmit(i, arg);
      else return false;
      return true;
    }
  } catch (err) {
    console.error('❌ Dev interaction:', err);
    if (i.isRepliable()) {
      const msg = { content: TEXT.genericError, flags: MessageFlags.Ephemeral } as const;
      if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
    return true;
  }
  return false;
}