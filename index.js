require('dotenv').config();

const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const { create } = require('youtube-dl-exec');

// Windows: bin/yt-dlp.exe, Railway: yt-dlp-linux (downloaded at build time), fallback: PATH
const localBin = path.join(__dirname, 'bin', 'yt-dlp.exe');
const linuxBin = path.join(__dirname, 'yt-dlp-linux');
const ytdlp = create(fs.existsSync(localBin) ? localBin : fs.existsSync(linuxBin) ? linuxBin : 'yt-dlp');

const { TOKEN, CLIENT_ID } = process.env;

process.on('uncaughtException', err => console.error('Uncaught exception:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err.message));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Per-guild state: { connection, player, queue: string[] }
const guildStates = new Map();

// Resolves a URL into one or more video URLs.
// Handles: regular YouTube, YouTube Music, playlists.
async function resolveURLs(url) {
  try {
    const info = await ytdlp(url, {
      flatPlaylist: true,
      dumpSingleJson: true,
      quiet: true,
      noWarnings: true,
      noCheckCertificates: true,
    });

    if (info._type === 'playlist' && info.entries?.length > 0) {
      const isYTMusic = url.includes('music.youtube.com');
      const resolved = info.entries
        .map(e => {
          // Prefer a full URL if already present
          if (e.url && e.url.startsWith('http')) return e.url;
          if (e.webpage_url && e.webpage_url.startsWith('http')) return e.webpage_url;
          // Build from ID
          const id = e.id;
          if (!id) return null;
          return isYTMusic
            ? `https://music.youtube.com/watch?v=${id}`
            : `https://www.youtube.com/watch?v=${id}`;
        })
        .filter(Boolean);

      if (resolved.length > 0) return resolved;
    }
  } catch (err) {
    console.error('resolveURLs error:', err.message);
  }

  return [url];
}

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
    noCheckCertificates: true,
  });

  subprocess.stderr?.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.error('yt-dlp stderr:', msg);
  });

  // If yt-dlp fails, skip to the next song instead of disconnecting
  subprocess.on('error', err => {
    console.error('yt-dlp error:', err.message);
    playNext(guildId);
  });

  subprocess.on('close', code => {
    if (code !== 0 && code !== null) console.error(`yt-dlp exited with code ${code} for: ${url}`);
  });

  const resource = createAudioResource(subprocess.stdout);
  state.player.play(resource);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a YouTube / YouTube Music URL or playlist')
      .addStringOption(opt =>
        opt.setName('url').setDescription('YouTube or YouTube Music URL').setRequired(true)
      ),
    new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
    new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume the paused song'),
    new SlashCommandBuilder().setName('disconnect').setDescription('Disconnect and clear the queue'),
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

    await interaction.deferReply();

    try {
      // Resolve URL — returns [url] for single, [url1, url2, ...] for playlist
      const urls = await resolveURLs(url);
      const isPlaylist = urls.length > 1;

      // Already playing — add all to queue
      if (state && state.player) {
        urls.forEach(u => state.queue.push(u));
        return interaction.editReply(
          isPlaylist
            ? `Added ${urls.length} songs from playlist to queue.`
            : `Added to queue (position ${state.queue.length}): ${url}`
        );
      }

      // Nothing playing — start now
      const player = createAudioPlayer();
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      connection.subscribe(player);

      // First song plays immediately, rest go to queue
      const [first, ...rest] = urls;
      guildStates.set(guildId, { connection, player, queue: rest });

      const subprocess = ytdlp.exec(first, {
        output: '-',
        quiet: true,
        noWarnings: true,
        format: 'bestaudio/best',
        noCheckCertificates: true,
      });

      subprocess.stderr?.on('data', d => {
        const msg = d.toString().trim();
        if (msg) console.error('yt-dlp stderr:', msg);
      });

      subprocess.on('error', err => {
        console.error('yt-dlp error:', err.message);
        playNext(guildId);
      });

      const resource = createAudioResource(subprocess.stdout);
      player.play(resource);

      player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
      player.on('error', err => {
        console.error('Player error:', err.message);
        playNext(guildId);
      });

      await interaction.editReply(
        isPlaylist
          ? `Now playing playlist: ${urls.length} songs queued.`
          : `Now playing: ${url}`
      );
    } catch (err) {
      console.error('Failed to play:', err.message);
      guildStates.delete(guildId);
      await interaction.editReply('Could not play that URL. Make sure it is a valid YouTube or YouTube Music link.');
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
