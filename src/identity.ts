import { fastLoad } from './safe';
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
import { randomBytes } from 'node:crypto';
import { supabase } from './db';
import { ROBUX, TEXT } from './config';
import { getCfg } from './cfg';
import { COLORS, card, linkButton, v2, v2Ephemeral } from './ui';
import { linkUrl, robloxHeadshot, robloxLookup, robloxProfile } from './roblox';
import { wizardMessage } from './brief';

const pad = (id: number) => String(id).padStart(4, '0');

const T = {
  usernameInvalid: '⚠️ That does not look like a Roblox username (3–20 letters, numbers or underscores). Please press the button and try again.',
  userNotFound: '⚠️ I could not find that Roblox user. Please check the spelling and try again.',
  robloxDown: '⚠️ Roblox did not answer right now. Please try again in a moment.',
  tooNew: (days: number) => `🛡️ To protect everyone from fraud, your Roblox account must be at least **${days} days** old.`,
  alreadyLinked: '⚠️ This Roblox account is already linked to another Discord account. Please contact the staff.',
};

const usernameModal = (orderId: number) =>
  new ModalBuilder()
    .setCustomId(`idn:name:${orderId}`)
    .setTitle('Your Roblox account')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('username')
          .setLabel('Roblox username')
          .setPlaceholder('Your username, not your display name')
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(20)
          .setRequired(true)
      )
    );

// The briefing continues with step 1 as soon as the account is linked
async function advanceWizard(client: Client, orderId: number) {
  const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (!order || order.status !== 'DRAFT') return;
  const brief = { ...(order.brief ?? {}) };
  if ((brief.step ?? 0) !== 0) return;
  brief.step = 1;
  await supabase.from('orders').update({ brief }).eq('id', orderId);

  const payload = wizardMessage({ ...order, brief });
  const ch = order.ticket_channel_id ? await client.channels.fetch(order.ticket_channel_id).catch(() => null) : null;
  if (!ch || !ch.isTextBased() || !('send' in ch) || !('messages' in ch)) return;
  const msg = brief.wid ? await ch.messages.fetch(brief.wid).catch(() => null) : null;
  if (msg) await msg.edit(payload as never).catch(() => ch.send(payload as never));
  else await ch.send(payload as never);
}

// Nickname, customer role, log, next wizard step
export async function completeIdentity(client: Client, discordId: string, orderId: number | null) {
  const { data: cust } = await supabase.from('customers').select('roblox_name, roblox_id').eq('discord_id', discordId).maybeSingle();
  if (!cust?.roblox_id) return;

  const notes: string[] = [];
  const cfg = await getCfg();
  const guild = await client.guilds.fetch(process.env.GUILD_ID!).catch(() => null);
  const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
  if (member) {
    if (member.nickname !== cust.roblox_name) {
      await member.setNickname(cust.roblox_name, 'Novai identity link').catch(() => notes.push('nickname could not be changed'));
    }
    if (cfg.roles.customer) {
      await member.roles.add(cfg.roles.customer, 'Novai identity link').catch(() => notes.push('customer role could not be added'));
    }
  }

  const logId = cfg.channels['member-logs'];
  const ch = logId ? await client.channels.fetch(logId).catch(() => null) : null;
  if (ch && ch.isTextBased() && 'send' in ch) {
    await ch
      .send(
        v2(
          card({
            accent: COLORS.success,
            title: '🔗 Roblox account linked',
            body: `<@${discordId}> → **${cust.roblox_name}** ([profile](https://www.roblox.com/users/${cust.roblox_id}/profile))${notes.length ? `\n⚠️ ${notes.join(', ')}` : ''}`,
          })
        ) as never
      )
      .catch(() => null);
  }

  if (orderId) await advanceWizard(client, orderId);
}

// Called by the robux processor when the game confirmed a link
export async function onIdentityLinked(client: Client, token: { discord_id: string; order_id: number | null }) {
  await completeIdentity(client, token.discord_id, token.order_id);
}

// ---------- Customer flow ----------
async function loadDraft(i: ButtonInteraction | ModalSubmitInteraction, orderId: number) {
  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .eq('customer_id', i.user.id)
    .eq('status', 'DRAFT')
    .maybeSingle();
  if (!order) {
    await i.reply({ content: TEXT.alreadySubmitted, flags: MessageFlags.Ephemeral });
    return null;
  }
  return order;
}

async function onStart(i: ButtonInteraction, orderId: number) {
  // Open the popup instantly (it must open within 3 seconds). The draft is re-checked when it is submitted.
  await i.showModal(usernameModal(orderId));
}

async function onNameSubmit(i: ModalSubmitInteraction, orderId: number) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const username = i.fields.getTextInputValue('username').trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    await i.editReply(T.usernameInvalid);
    return;
  }
  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .eq('customer_id', i.user.id)
    .eq('status', 'DRAFT')
    .maybeSingle();
  if (!order) {
    await i.editReply(TEXT.alreadySubmitted);
    return;
  }

  try {
    const found = await robloxLookup(username);
    if (!found) {
      await i.editReply(T.userNotFound);
      return;
    }
    const [profile, avatar] = await Promise.all([robloxProfile(found.id), robloxHeadshot(found.id)]);

    const isAdmin = i.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
    const ageDays = Math.floor((Date.now() - new Date(profile.created).getTime()) / 86_400_000);
    if (!isAdmin && ageDays < ROBUX.minRobloxAgeDays) {
      await i.editReply(T.tooNew(ROBUX.minRobloxAgeDays));
      return;
    }

    const { data: taken } = await supabase
      .from('customers')
      .select('discord_id')
      .eq('roblox_id', found.id)
      .neq('discord_id', i.user.id)
      .limit(1);
    if (taken && taken.length > 0) {
      await i.editReply(T.alreadyLinked);
      return;
    }

    // Already linked to exactly this account: nothing to prove again
    const { data: mine } = await supabase.from('customers').select('roblox_id').eq('discord_id', i.user.id).maybeSingle();
    if (mine?.roblox_id && Number(mine.roblox_id) === found.id) {
      await completeIdentity(i.client, i.user.id, orderId);
      await i.editReply('✅ You are already linked. Your briefing continues in the ticket 👇');
      return;
    }

    const token = randomBytes(18).toString('base64url');
    const { error } = await supabase.from('link_tokens').insert({
      token,
      discord_id: i.user.id,
      discord_name: i.user.globalName ?? i.user.username,
      order_id: orderId,
      expected_roblox_id: found.id,
      expected_roblox_name: profile.name,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    if (error) {
      console.error('❌ link token:', error.message);
      await i.editReply(TEXT.genericError);
      return;
    }

    await i.deleteReply();
    await i.followUp(
      v2Ephemeral(
        card({
          accent: COLORS.brand,
          title: '🔎 Is this you?',
          subtitle: `Order #${pad(orderId)}`,
          thumbnail: avatar ?? undefined,
          body:
            `**${profile.displayName}** (@${profile.name})\nRoblox account age: **${ageDays} days**\n\n` +
            'Press **Open Novai Studio**. The game checks that you are really logged in as this account and confirms the link with one click. ' +
            'Your briefing then continues automatically. Wrong person? Press **Wrong account**.',
          footer: 'The link works for 30 minutes and only for this Roblox account.',
          buttons: [
            linkButton('Open Novai Studio', linkUrl(token), '🎮'),
            new ButtonBuilder().setCustomId(`idn:redo:${orderId}`).setLabel('Wrong account').setStyle(ButtonStyle.Secondary),
          ],
        })
      )
    );
  } catch (err) {
    console.error('❌ identity:', err);
    await i.editReply(T.robloxDown);
  }
}

export async function handleIdentityInteraction(i: Interaction): Promise<boolean> {
  try {
    if (i.isButton() && i.customId.startsWith('idn:')) {
      const [, kind, id] = i.customId.split(':');
      if (kind === 'start' || kind === 'redo') {
        await onStart(i, Number(id));
        return true;
      }
    }
    if (i.isModalSubmit() && i.customId.startsWith('idn:name:')) {
      await onNameSubmit(i, Number(i.customId.split(':')[2]));
      return true;
    }
  } catch (err) {
    console.error('❌ Identity interaction:', err);
    if (i.isRepliable()) {
      const msg = { content: TEXT.genericError, flags: MessageFlags.Ephemeral } as const;
      if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
      else await i.reply(msg).catch(() => {});
    }
    return true;
  }
  return false;
}