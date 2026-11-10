// =====================================================================
//  safe.ts  -  keeps Novai alive and makes buttons answer in time
// =====================================================================
import { Client, Interaction, MessageFlags, MessageFlagsBitField } from 'discord.js';

// ---------- 1. The bot can never crash from a surprise error ----------
export function installCrashGuards(client: Client) {
  process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled rejection (the bot keeps running):', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught exception (the bot keeps running):', err);
  });
  client.on('error', (err) => console.error('⚠️ Discord client error:', err));
  client.on('shardError', (err) => console.error('⚠️ Discord connection error:', err));
  client.on('warn', (msg) => console.warn('⚠️ Discord warning:', msg));
}

// ---------- 2. Helper: "give me this, but not later than X ms" ----------
// Used for popups (modals), which must open within 3 seconds.
export async function fastLoad<T>(work: PromiseLike<T>, ms = 600): Promise<T | null> {
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  } catch {
    return null;
  }
}

// ---------- 3. The 3-second safety net ----------
// Discord only gives the bot 3 seconds to answer a button/command.
// If your code has not answered after 1.5 seconds (slow database, slow
// internet...), this answers for it ("thinking...") so Discord never shows
// "This application did not respond". Your code then finishes normally.
const AUTO_ACK_MS = 1500;
const GENERIC = '⚠️ Something went wrong on our side. Please try again in a moment.';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function stripEphemeral(options: Any) {
  if (typeof options === 'string' || options == null) return options;
  const copy = { ...options };
  if (copy.flags !== undefined) {
    const f = new MessageFlagsBitField(copy.flags);
    f.remove(MessageFlags.Ephemeral);
    if (f.bitfield === 0) delete copy.flags;
    else copy.flags = f.bitfield;
  }
  delete copy.ephemeral;
  return copy;
}

export async function runSafely(interaction: Interaction, handler: () => Promise<unknown>) {
  const x = interaction as Any;
  const repliable = interaction.isRepliable();

  let acked = false;
  let autoKind: 'update' | 'reply' | null = null;
  let codeDeferredReply = false;
  let timer: NodeJS.Timeout | undefined;

  // How old is the click already when it reaches the bot? (slow internet / PC = bad)
  const rawAge = Date.now() - interaction.createdTimestamp;
  const age = Number.isFinite(rawAge) ? Math.min(Math.max(rawAge, 0), 2500) : 0;
  if (age > 1000) console.warn(`🐢 A click reached the bot ${age} ms late (slow internet or PC on the bot's computer).`);

  if (repliable) {
    const orig = {
      reply: x.reply.bind(x),
      update: x.update?.bind(x),
      deferReply: x.deferReply.bind(x),
      deferUpdate: x.deferUpdate?.bind(x),
      showModal: x.showModal?.bind(x),
      editReply: x.editReply.bind(x),
      followUp: x.followUp.bind(x),
    };
    const done = () => {
      acked = true;
      if (timer) clearTimeout(timer);
    };

    x.reply = (o: Any) => {
      if (autoKind === 'reply') return orig.editReply(stripEphemeral(o));
      if (autoKind === 'update') return orig.followUp(o);
      done();
      return orig.reply(o);
    };
    x.update = (o: Any) => {
      if (autoKind) return orig.editReply(stripEphemeral(o));
      done();
      return orig.update(o);
    };
    x.deferReply = (o: Any) => {
      if (autoKind) return Promise.resolve(x);
      codeDeferredReply = true;
      done();
      return orig.deferReply(o);
    };
    if (orig.deferUpdate) {
      x.deferUpdate = (o: Any) => {
        if (autoKind) return Promise.resolve(x);
        done();
        return orig.deferUpdate(o);
      };
    }
    if (orig.showModal) {
      x.showModal = (o: Any) => {
        done();
        return orig.showModal(o);
      };
    }

    timer = setTimeout(async () => {
      if (acked) return;
      acked = true;
      try {
        if (interaction.isMessageComponent() || (interaction.isModalSubmit() && interaction.isFromMessage())) {
          autoKind = 'update';
          await orig.deferUpdate();
        } else {
          autoKind = 'reply';
          await orig.deferReply({ flags: MessageFlags.Ephemeral });
        }
        console.warn(`⏱️ Slow interaction (${x.customId ?? x.commandName}); answered automatically.`);
      } catch (err) {
        console.error('⚠️ Auto-acknowledge failed:', (err as Error).message);
      }
    }, Math.max(200, AUTO_ACK_MS - age));
  }

  try {
    await handler();
  } catch (err) {
    console.error('❌ Interaction error:', err);
    if (repliable) {
      try {
        if (x.deferred || x.replied) await x.followUp({ content: GENERIC, flags: MessageFlags.Ephemeral });
        else await x.reply({ content: GENERIC, flags: MessageFlags.Ephemeral });
      } catch {
        /* the interaction expired - nothing more we can do */
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Nobody answered at all (for example an old button): never leave the user hanging
  if (repliable) {
    try {
      if (!acked && !x.deferred && !x.replied) {
        await x.reply({ content: 'This button is no longer active. Please try again.', flags: MessageFlags.Ephemeral });
      } else if ((autoKind === 'reply' || codeDeferredReply) && !x.replied) {
        await x.editReply(GENERIC); // never leave a "thinking..." message hanging
      }
    } catch {
      /* ignore */
    }
  }
}