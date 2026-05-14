require('dotenv').config();

const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const { create } = require('youtube-dl-exec');

// On Windows use our local yt-dlp.exe, on Linux (Railway) use system yt-dlp
const localBin = path.join(__dirname, 'bin', 'yt-dlp.exe');
const ytdlp = create(fs.existsSync(localBin) ? localBin : 'yt-dlp');

const { TOKEN, CLIENT_ID } = process.env;

// Prevent yt-dlp errors from crashing the whole bot
process.on('uncaughtException', err => console.error('Uncaught exception:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err.message));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Per-guild state: { connection, player, queue: string[] }
const guildStates = new Map();

function playNext(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  if (state.queue.length === 0) {
    state.connection.destroy();
    guildStates.delete(guildId);
    return;
  }

  const url = state.queue.shift();

  const subprocess = ytdlp.exec(url, {
    output: '-',
    quiet: true,
    noWarnings: true,
    format: 'bestaudio/best',
  });

  subprocess.on('error', err => console.error('yt-dlp process error:', err.message));

  const resource = createAudioResource(subprocess.stdout);
  state.player.play(resource);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a YouTube URL or add it to the queue')
      .addStringOption(opt =>
        opt.setName('url').setDescription('YouTube URL').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('Skip the current song'),
    new SlashCommandBuilder()
      .setName('pause')
      .setDescription('Pause the current song'),
    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume the paused song'),
    new SlashCommandBuilder()
      .setName('disconnect')
      .setDescription('Disconnect the bot and clear the queue'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  for (const guild of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), { body: commands });
    console.log(`Commands registered in: ${guild.name}`);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId } = interaction;
  const state = guildStates.get(guildId);

  // --- /play ---
  if (commandName === 'play') {
    const url = interaction.options.getString('url');
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply({ content: 'You must be in a voice channel first.', ephemeral: true });
    }

    // Already playing — add to queue
    if (state && state.player) {
      state.queue.push(url);
      return interaction.reply(`Added to queue (position ${state.queue.length}): ${url}`);
    }

    await interaction.deferReply();

    try {
      const player = createAudioPlayer();
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      connection.subscribe(player);
      guildStates.set(guildId, { connection, player, queue: [] });

      const subprocess = ytdlp.exec(url, {
        output: '-',
        quiet: true,
        noWarnings: true,
        format: 'bestaudio/best',
      });

      subprocess.on('error', err => console.error('yt-dlp process error:', err.message));

      const resource = createAudioResource(subprocess.stdout);
      player.play(resource);

      player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
      player.on('error', err => {
        console.error('Player error:', err.message);
        playNext(guildId);
      });

      await interaction.editReply(`Now playing: ${url}`);
    } catch (err) {
      console.error('Failed to play:', err.message);
      guildStates.delete(guildId);
      await interaction.editReply('Could not play that URL. Make sure it is a valid YouTube link.');
    }
  }

  // --- /skip ---
  else if (commandName === 'skip') {
    if (!state) {
      return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
    }
    state.player.stop();
    interaction.reply(state.queue.length > 0 ? 'Skipped. Playing next song.' : 'Skipped. No more songs in queue.');
  }

  // --- /pause ---
  else if (commandName === 'pause') {
    if (!state || state.player.state.status !== AudioPlayerStatus.Playing) {
      return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
    }
    state.player.pause();
    interaction.reply('Paused.');
  }

  // --- /resume ---
  else if (commandName === 'resume') {
    if (!state || state.player.state.status !== AudioPlayerStatus.Paused) {
      return interaction.reply({ content: 'Nothing is paused right now.', ephemeral: true });
    }
    state.player.unpause();
    interaction.reply('Resumed.');
  }

  // --- /disconnect ---
  else if (commandName === 'disconnect') {
    if (!state) {
      return interaction.reply({ content: 'I am not in a voice channel.', ephemeral: true });
    }
    state.connection.destroy();
    guildStates.delete(guildId);
    interaction.reply('Disconnected and queue cleared.');
  }
});

client.login(TOKEN);
