import { AttachmentBuilder, Client, Events, Message, PartialMessage, PermissionFlagsBits } from 'discord.js';
import { supabase } from './db';
import { getCfg } from './cfg';
import { COLORS, card, v2 } from './ui';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Order = Record<string, any>;

const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const quote = (s: string) =>
  clip(s, 900)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n') || '> (no text)';

// ---------- Which channel belongs to which order ----------
const dealOrder = new Map<string, number | null>();

async function dealOrderId(channelId: string): Promise<number | null> {
  if (dealOrder.has(channelId)) return dealOrder.get(channelId)!;
  const { data } = await supabase.from('orders').select('id').eq('deal_channel_id', channelId).maybeSingle();
  const id = data?.id ?? null;
  dealOrder.set(channelId, id);
  return id;
}
export const forgetDeal = (channelId: string) => dealOrder.delete(channelId);

async function isDealChannel(channelId: string, parentId: string | null | undefined) {
  const cfg = await getCfg();
  return Boolean(parentId && parentId === cfg.categories.deals) ? dealOrderId(channelId) : null;
}

// ---------- Logging (never pings anybody) ----------
async function logTo(client: Client, key: string, c: ReturnType<typeof card>) {
  const cfg = await getCfg();
  const id = cfg.channels[key];
  if (!id) return;
  const ch = await client.channels.fetch(id).catch(() => null);
  if (ch && ch.isTextBased() && 'send' in ch) {
    await ch.send({ ...v2(c), allowedMentions: { parse: [] } } as never).catch(() => null);
  }
}

// ---------- Transcript of a deal channel ----------
export async function archiveDeal(client: Client, order: Order, reason: string) {
  const cfg = await getCfg();
  const channelId = order.deal_channel_id;
  const logId = cfg.channels['deal-logs'];
  if (!channelId || !logId) return;

  const { data: rows } = await supabase
    .from('deal_messages')
    .select('*')
    .eq('channel_id', channelId)
    .order('created_at')
    .limit(5000);

  const names = new Map<string, string>();
  for (const id of new Set((rows ?? []).map((r) => r.author_id as string))) {
    const u = await client.users.fetch(id).catch(() => null);
    names.set(id, u ? `${u.username} (${id})` : id);
  }

  const stamp = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    `NOVAI DEAL TRANSCRIPT · Order #${String(order.id).padStart(4, '0')}`,
    `Reason: ${reason}`,
    `Customer: ${order.customer_id} · Developer: ${order.dev_id ?? '-'}`,
    `Title: ${order.title ?? '-'}`,
    '='.repeat(60),
    '',
  ];
  for (const r of rows ?? []) {
    const files = (r.attachments ?? []).map((a: { name: string; url: string }) => `${a.name} <${a.url}>`).join(', ');
    lines.push(
      `[${stamp(r.created_at)}] ${names.get(r.author_id)}: ${r.content || '(no text)'}` +
        (files ? `  [files: ${files}]` : '') +
        (r.edited ? '  [EDITED]' : '') +
        (r.deleted ? '  [DELETED]' : '')
    );
    for (const h of r.history ?? []) lines.push(`      ↳ earlier version: ${h.content}`);
  }

  const ch = await client.channels.fetch(logId).catch(() => null);
  if (ch && ch.isTextBased() && 'send' in ch) {
    await ch
      .send({
        content: `📁 **Deal transcript · Order #${String(order.id).padStart(4, '0')}** · ${reason} · ${(rows ?? []).length} messages`,
        files: [new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: `deal-${String(order.id).padStart(4, '0')}.txt` })],
        allowedMentions: { parse: [] },
      })
      .catch(() => null);
  }
}

// ---------- Scam filter ----------
type Finding = { level: 'high' | 'medium'; label: string };

const CREDS_ASK =
  /\b(send|give|share|tell|need|want|show|what(?:'s| is)|can i (?:have|get))\b[^.\n]{0,40}\b(password|passcode|cookie|roblosecurity|2fa|auth(?:entication)? code|verification code|login code|security code|recovery code)\b/i;
const COOKIE_LITERAL = /_\|WARNING:-DO-NOT-SHARE-THIS|\.ROBLOSECURITY/i;
const LOGGERS = /(grabify|iplogger|2no\.co|yip\.su|blasze|leancoding|stopify|ps3cf|gyazo\.nl|discord-?gift|dlscord|discorcl|rnblox|r0blox)/i;
const SHORTENERS = /(^|\.)(bit\.ly|tinyurl\.com|cutt\.ly|rb\.gy|t\.ly|shorturl\.at|is\.gd|goo\.gl)$/i;
const PAY_OUT =
  /\b(paypal|cash\s?app|venmo|zelle|bitcoin|btc|ethereum|usdt|crypto|gift\s?cards?|nitro|western\s?union|bank\s?transfer|wire\s?transfer|pay\s?me\s?(outside|directly|in\s?dm))\b/i;
const OFFSITE =
  /\b(dm\s?me|add\s?me|message\s?me\s?on|telegram|whats\s?app|snapchat|instagram|skype|contact\s?me\s?(on|at)|talk\s?(on|in)\s?(dms?|private))\b/i;
const INVITE = /(discord\.gg\/|discord(app)?\.com\/invite\/)/i;

function inspect(text: string): Finding | null {
  const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  const fakeRoblox = hosts.some((h) => /roblox|rbx/.test(h) && !/(^|\.)(roblox\.com|rbxcdn\.com|roblox\.cn)$/.test(h));
  const fakeDiscord = hosts.some((h) => /discord/.test(h) && !/(^|\.)(discord\.com|discord\.gg|discordapp\.com|discordapp\.net|discord\.media)$/.test(h));

  if (CREDS_ASK.test(text)) return { level: 'high', label: 'a request for passwords or login codes' };
  if (COOKIE_LITERAL.test(text)) return { level: 'high', label: 'a Roblox login cookie' };
  if (hosts.some((h) => LOGGERS.test(h)) || fakeRoblox || fakeDiscord) return { level: 'high', label: 'a phishing or logger link' };
  if (PAY_OUT.test(text)) return { level: 'medium', label: 'a payment outside Novai' };
  if (INVITE.test(text)) return { level: 'medium', label: 'a Discord invite to another server' };
  if (OFFSITE.test(text)) return { level: 'medium', label: 'a request to talk outside this channel' };
  if (hosts.some((h) => SHORTENERS.test(h))) return { level: 'medium', label: 'a shortened link' };
  return null;
}

const lastPing = new Map<string, number>();

async function react(client: Client, m: Message, orderId: number | null, f: Finding) {
  const cfg = await getCfg();
  const high = f.level === 'high';
  if (high) await m.delete().catch(() => null); // the text is already saved

  const body = high
    ? `<@${m.author.id}> That message was removed because it looked like **${f.label}**. Never share or ask for passwords, cookies, codes or unknown links.`
    : `<@${m.author.id}> This looks like **${f.label}**. Everything about this order, including payment, stays in this channel and on the deal card. Never pay or share logins anywhere else.`;

  await m.channel
    .send({
      ...v2(card({ accent: high ? COLORS.danger : COLORS.warn, title: high ? '🚨 Message removed' : '⚠️ Safety notice', body, footer: 'Support has been notified.' })),
      allowedMentions: { users: [m.author.id] },
    } as never)
    .catch(() => null);

  // ping Support (at most every 3 minutes per channel)
  const now = Date.now();
  if (cfg.roles.support && now - (lastPing.get(m.channelId) ?? 0) > 180_000) {
    lastPing.set(m.channelId, now);
    await m.channel
      .send({
        content: `<@&${cfg.roles.support}> 🚨 Possible scam attempt by <@${m.author.id}> (${f.label}). Please take a look.`,
        allowedMentions: { roles: [cfg.roles.support] },
      })
      .catch(() => null);
  }

  await logTo(
    client,
    'mod-logs',
    card({
      accent: high ? COLORS.danger : COLORS.warn,
      title: high ? '🚨 Scam filter · message removed' : '⚠️ Scam filter · warning',
      fields: [
        ['User', `<@${m.author.id}> (${m.author.username})`],
        ['Channel', `<#${m.channelId}>`],
        ['Order', orderId ? `#${String(orderId).padStart(4, '0')}` : '—'],
        ['Reason', f.label],
      ],
      body: quote(m.content),
    })
  );
}

const isStaff = (m: Message) => m.member?.permissions.has(PermissionFlagsBits.ModerateMembers) ?? false;

// ---------- Event hooks ----------
export function registerGuard(client: Client) {
  // every message in a deal channel is recorded and scanned
  client.on(Events.MessageCreate, async (m) => {
    try {
      if (!m.inGuild() || m.author.bot) return;
      const orderId = await isDealChannel(m.channelId, m.channel.parentId);
      if (orderId === null || orderId === undefined) return;

      await supabase.from('deal_messages').upsert(
        {
          message_id: m.id,
          channel_id: m.channelId,
          order_id: orderId,
          author_id: m.author.id,
          content: m.content,
          attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url, size: a.size })),
          created_at: new Date(m.createdTimestamp).toISOString(),
        },
        { onConflict: 'message_id' }
      );
      if (isStaff(m)) return;
      const finding = inspect(m.content);
      if (finding) await react(client, m, orderId, finding);
    } catch (e) {
      console.error('❌ guard create:', e);
    }
  });

  // edited messages: before and after
  client.on(Events.MessageUpdate, async (oldM: Message | PartialMessage, newM: Message | PartialMessage) => {
    try {
      const msg = newM.partial ? await newM.fetch().catch(() => null) : newM;
      if (!msg || !msg.inGuild() || msg.author?.bot) return;
      const after = msg.content ?? '';
      const orderId = await isDealChannel(msg.channelId, msg.channel.parentId);

      let before: string | null = oldM.partial ? null : oldM.content;
      if (orderId) {
        const { data: row } = await supabase.from('deal_messages').select('content, history').eq('message_id', msg.id).maybeSingle();
        if (row) {
          before = row.content ?? before;
          if (before === after) return;
          const history = [...(row.history ?? []), { content: before, at: new Date().toISOString() }];
          await supabase.from('deal_messages').update({ content: after, edited: true, history }).eq('message_id', msg.id);
        }
      }
      if (before === null || before === after) return;

      const cfg = await getCfg();
      if (msg.channel.parentId === cfg.categories.logs) return;
      await logTo(
        client,
        'msg-logs',
        card({
          accent: COLORS.warn,
          title: '✏️ Message edited',
          fields: [
            ['Author', `<@${msg.author?.id}>`],
            ['Channel', `<#${msg.channelId}>`],
            ['Order', orderId ? `#${String(orderId).padStart(4, '0')}` : '—'],
            ['Link', `[jump](${msg.url})`],
          ],
          body: `**Before**\n${quote(before)}\n\n**After**\n${quote(after)}`,
        })
      );
      if (orderId && !isStaff(msg as Message)) {
        const f = inspect(after);
        if (f) await react(client, msg as Message, orderId, f);
      }
    } catch (e) {
      console.error('❌ guard update:', e);
    }
  });

  // deleted messages: the text comes from our database
  client.on(Events.MessageDelete, async (m) => {
    try {
      if (!m.guildId) return;
      const cfg = await getCfg();
      const channel = m.channel;
      const parentId = 'parentId' in channel ? channel.parentId : null;
      if (parentId === cfg.categories.logs) return;

      const orderId = await isDealChannel(m.channelId, parentId);
      let content: string | null = m.partial ? null : m.content;
      let authorId: string | null = m.author?.id ?? null;
      let files = m.partial ? [] : [...m.attachments.values()].map((a) => a.url);

      if (orderId) {
        const { data: row } = await supabase.from('deal_messages').select('*').eq('message_id', m.id).maybeSingle();
        if (row) {
          content = row.content ?? content;
          authorId = row.author_id;
          files = (row.attachments ?? []).map((a: { url: string }) => a.url);
          await supabase.from('deal_messages').update({ deleted: true }).eq('message_id', m.id);
        }
      }
      if (m.author?.bot) return;
      if (content === null && !authorId) return;

      await logTo(
        client,
        'msg-logs',
        card({
          accent: COLORS.danger,
          title: '🗑️ Message deleted',
          fields: [
            ['Author', authorId ? `<@${authorId}>` : 'unknown'],
            ['Channel', `<#${m.channelId}>`],
            ['Order', orderId ? `#${String(orderId).padStart(4, '0')}` : '—'],
          ],
          body: quote(content ?? '(content unavailable, message was not cached)') + (files.length ? `\n**Files**\n${files.slice(0, 5).join('\n')}` : ''),
        })
      );

      // everyone in the deal channel sees that something was deleted
      if (orderId && 'send' in channel && authorId && !(await isBotRemoval(m.id))) {
        await channel
          .send({
            ...v2(card({ accent: COLORS.warn, title: '🗑️ A message was deleted', body: `A message by <@${authorId}> was deleted. It is saved in the deal log and Support can read it.`, footer: 'Deal chats are recorded.' })),
            allowedMentions: { parse: [] },
          } as never)
          .catch(() => null);
      }
    } catch (e) {
      console.error('❌ guard delete:', e);
    }
  });
}

// the scam filter already posted its own notice when it removed a message
async function isBotRemoval(messageId: string) {
  const { data } = await supabase.from('deal_messages').select('deleted').eq('message_id', messageId).maybeSingle();
  return Boolean(data?.deleted && false);
}