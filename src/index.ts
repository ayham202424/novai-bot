import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { supabase } from './db';
import { TEXT } from './config';
import { runAiDiagnostics } from './ai';
import { buildDashboard, v2 } from './ui';
import { handleTicketInteraction, startTicketCleanup } from './tickets';
import { handleCockpitInteraction } from './cockpit';
import { handlePaymentCommand, paymentCommands, startRobuxProcessor } from './robux';
import { handleIdentityInteraction } from './identity';
import { handleStatusCommand, startHubUpdater, statusCommands } from './hub';
import { devCommands, handleDevCommand, handleDevInteraction } from './devs';
import { setupCommands, handleSetupCommand, handleSetupInteraction } from './setup';
import { handleTaskInteraction, startTaskBoard } from './tasks';
import { registerGuard } from './guard';
import { installCrashGuards, runSafely } from './safe';

const TOKEN = process.env.DISCORD_TOKEN!;
const GUILD_ID = process.env.GUILD_ID!;

// Message intents are needed to record deal chats and to log edited and deleted messages
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

installCrashGuards(client); // the bot can no longer crash from a surprise error

// ---------- Slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if Novai is online'),
  new SlashCommandBuilder()
    .setName('setup_dashboard')
    .setDescription('Post the Novai dashboard in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('health')
    .setDescription('Owner: check bot, database and queue health')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('ai_status')
    .setDescription('Owner: test the AI providers and show the exact errors')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ...statusCommands,
  ...paymentCommands,
  ...setupCommands,
  ...devCommands,
];

async function heartbeat() {
  try {
    const { error } = await supabase
      .from('bot_state')
      .upsert({ key: 'heartbeat', value: { at: new Date().toISOString() } });
    if (error) console.error('❌ Database error:', error.message);
    else console.log('💚 Database connected');
  } catch (err) {
    console.error('❌ Heartbeat failed:', err);
  }
}

// ---------- Bot startup ----------
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Novai is online as ${c.user.tag}`);
  c.user.setActivity(TEXT.status);

  // Each start-up step is protected on its own: if one fails, the others still run
  const step = async (name: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      console.error(`❌ Start-up step failed (${name}):`, err);
    }
  };

  await step('commands', async () => {
    const guild = await c.guilds.fetch(GUILD_ID);
    await guild.commands.set(commands.map((cmd) => cmd.toJSON()));
  });
  await step('heartbeat', heartbeat);
  setInterval(heartbeat, 6 * 60 * 60 * 1000);
  await step('tickets', () => startTicketCleanup(c));
  await step('robux', () => startRobuxProcessor(c));
  await step('hub', () => startHubUpdater(c));
  await step('tasks', () => startTaskBoard(c));
});

registerGuard(client);

// ---------- Interactions ----------
client.on(Events.InteractionCreate, (interaction) => {
  // runSafely = 3-second safety net + error catcher around everything below
  void runSafely(interaction, () => handleInteraction(interaction));
});

async function handleInteraction(interaction: Interaction) {
  if (interaction.isChatInputCommand()) {
    if (await handleStatusCommand(interaction)) return;  // /status
    if (await handlePaymentCommand(interaction)) return; // /confirm_fee
    if (await handleSetupCommand(interaction)) return;   // /setup_server
    if (await handleDevCommand(interaction)) return;     // /dev

    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: TEXT.pingReply(client.ws.ping), flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'ai_status') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const report = await runAiDiagnostics();
      await interaction.editReply('```\n' + report.slice(0, 1800) + '\n```');
    }

    if (interaction.commandName === 'health') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const t0 = Date.now();
      const { count, error } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .in('status', ['OPEN', 'ASSIGNED', 'IN_PROGRESS']);
      const dbMs = Date.now() - t0;
      await interaction.editReply(
        [
          '**Novai Health**',
          `🤖 Bot latency: ${client.ws.ping} ms`,
          error ? `🗄️ Database: ❌ ${error.message}` : `🗄️ Database: ✅ ${dbMs} ms`,
          `📦 Active orders: ${count ?? 0}`,
          `⏱️ Uptime: ${Math.floor(process.uptime() / 60)} min`,
        ].join('\n')
      );
    }

    if (interaction.commandName === 'setup_dashboard') {
      if (!interaction.channel || !('send' in interaction.channel)) return;
      await interaction.channel.send(v2(buildDashboard()));
      await interaction.reply({ content: TEXT.dashboardPosted, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (await handleSetupInteraction(interaction)) return;
  if (await handleDevInteraction(interaction)) return;
  if (await handleTaskInteraction(interaction)) return;
  if (await handleIdentityInteraction(interaction)) return;
  if (await handleCockpitInteraction(interaction)) return;

  await handleTicketInteraction(interaction);
}

client.login(TOKEN).catch((err) => {
  console.error('❌ Could not log in to Discord (check DISCORD_TOKEN):', err);
  process.exit(1);
});