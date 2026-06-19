require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');

const token = process.env.DISCORD_TOKEN;
const audioPath = process.env.AUDIO_PATH || path.join(__dirname, 'audio', 'clip.mp3');
// Optional: only react when one of these users joins a channel
// Set `TARGET_USERS` as a comma-separated list of numeric IDs or usernames
// Examples: TARGET_USERS=123456789012345678,otherUser,alice#1234
// Support multiple env var options for backward compatibility
const targetUsersRaw = (process.env.TARGET_USERS || '')
  || (process.env.TARGET_USER_ID ? process.env.TARGET_USER_ID : '')
  || (process.env.TARGET_USERNAME ? process.env.TARGET_USERNAME : '');
const targetList = targetUsersRaw
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const matchesTarget = (member) => {
  if (!member) return false;
  // if no targets configured, match everyone (backwards compatible)
  if (targetList.length === 0) return true;
  const username = member.user.username;
  const tag = `${username}#${member.user.discriminator}`;
  return targetList.some(t => t === member.id || t === username || t === tag);
};

if (!token) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

// Prevent spam per guild
const playingPerGuild = new Set();
// If we need to destroy connection after playback when channel becomes empty
const pendingDestroyPerGuild = new Set();
// Rejoin throttle to avoid loops when bot is kicked repeatedly
const rejoinCooldownMs = 10000; // 10s
const lastRejoin = new Map();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    

    // Helper to play audio in a channel
    const playInChannel = async (channel) => {
      console.log('playInChannel called with channel:', channel ? channel.id : null, 'guildId:', guildId);
      if (!channel) return;
      if (playingPerGuild.has(guildId)) {
        console.log('Already playing in guild', guildId);
        return;
      } // already playing
      if (!fs.existsSync(audioPath)) {
        console.error('Audio file not found:', audioPath);
        return;
      }

      // If there's an existing connection in a different channel, destroy it
      const existing = getVoiceConnection(guildId);
      if (existing && existing.joinConfig.channelId !== channel.id) existing.destroy();

      console.log(`Joining voice channel ${channel.id} in guild ${guildId}`);
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId,
        adapterCreator: channel.guild.voiceAdapterCreator
      });

      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      try {
        const resource = createAudioResource(fs.createReadStream(audioPath));
        player.play(resource);
        connection.subscribe(player);
        console.log('Started playback and subscribed to connection');
      } catch (err) {
        console.error('Error creating/playing resource:', err);
        const conn = getVoiceConnection(guildId);
        if (conn) conn.destroy();
        return;
      }

      playingPerGuild.add(guildId);

      player.on(AudioPlayerStatus.Idle, () => {
        console.log('Player idle for guild', guildId);
        playingPerGuild.delete(guildId);
        // If channel is empty and pending destroy was requested, destroy now
        if (pendingDestroyPerGuild.has(guildId)) {
          pendingDestroyPerGuild.delete(guildId);
          const conn = getVoiceConnection(guildId);
          if (conn) conn.destroy();
          return;
        }
        // Otherwise, leave shortly after idle
        setTimeout(() => {
          const conn = getVoiceConnection(guildId);
          if (conn) conn.destroy();
        }, 1000);
      });

      player.on('error', (err) => {
        console.error('Player error:', err);
        playingPerGuild.delete(guildId);
        const conn = getVoiceConnection(guildId);
        if (conn) conn.destroy();
      });
    };

    // determine the affected member (oldState/newState both exist)
    const member = (newState && newState.member) || (oldState && oldState.member);
    if (!member) return;
    // ignore bots
    if (member.user.bot) return;

    const guild = (newState && newState.guild) || (oldState && oldState.guild);
    if (!guild) return;
    const guildId = guild.id;

    const joinedChannelId = newState ? newState.channelId : null;
    const leftChannelId = oldState ? oldState.channelId : null;

    // Helper to get up-to-date channel object from guild cache (fetch if needed)
    const getChannel = async (channelId) => {
      if (!channelId) return null;
      let ch = guild.channels.cache.get(channelId);
      if (ch) return ch;
      try {
        ch = await guild.channels.fetch(channelId);
        return ch;
      } catch (e) {
        return null;
      }
    };

    // Debug info
    console.log('voiceStateUpdate:', { guildId, leftChannelId, joinedChannelId, user: member.user.tag });

    // If a non-bot joined or moved into a channel, play there (only for target if configured)
    if (joinedChannelId && joinedChannelId !== leftChannelId) {
      if (!matchesTarget(member)) {
        console.log(`Ignoring join by non-target user ${member.user.tag} (${member.id})`);
      } else {
        const channel = await getChannel(joinedChannelId);
        console.log('fetched joined channel:', channel ? channel.id : null);
        await playInChannel(channel);
      }
    }

    // If the bot itself was disconnected/removed from a channel, try to rejoin
    if (oldState.member && oldState.member.id === client.user.id && !newState.channel) {
      const formerChannelId = oldState.channelId;
      const formerChannel = await getChannel(formerChannelId);
      if (formerChannel) {
        // If target is set, only rejoin if the target user is still present
        let shouldRejoin = true;
        if (targetUserId || targetUsername) {
          shouldRejoin = formerChannel.members.some(m => matchesTarget(m));
          console.log('target present in former channel:', shouldRejoin);
        } else {
          shouldRejoin = formerChannel.members.filter(m => !m.user.bot).size > 0;
        }

        if (shouldRejoin) {
          const last = lastRejoin.get(guildId) || 0;
          if (Date.now() - last > rejoinCooldownMs) {
            lastRejoin.set(guildId, Date.now());
            // small delay before rejoining
            setTimeout(async () => {
              try {
                const ch = await getChannel(formerChannelId);
                console.log('fetched former channel for rejoin:', ch ? ch.id : null);
                await playInChannel(ch);
              } catch (e) {
                console.error('Error trying to rejoin channel:', e);
              }
            }, 1000);
          }
        } else {
          console.log('Not rejoining because target/user not present');
        }
      }
    }

    // If someone left a channel, check if any non-bot users remain; if none, destroy connection
    if (leftChannelId) {
      const leftChannel = await getChannel(leftChannelId);
      if (leftChannel) {
        const humansLeft = leftChannel.members.filter(m => !m.user.bot).size;
        console.log(`leftChannel ${leftChannelId} members: total=${leftChannel.members.size} humans=${humansLeft}`);
        if (humansLeft === 0) {
          const conn = getVoiceConnection(guildId);
          console.log('connection state for guild', guildId, !!conn, conn ? conn.joinConfig.channelId : null, 'playing?', playingPerGuild.has(guildId));
          if (conn && conn.joinConfig.channelId === leftChannel.id) {
            // Immediately destroy connection when channel is empty
            console.log(`Channel ${leftChannelId} empty — destroying connection for guild ${guildId}`);
            // cleanup any pending flags
            pendingDestroyPerGuild.delete(guildId);
            playingPerGuild.delete(guildId);
            conn.destroy();
          }
        }
      }
    }
  } catch (err) {
    console.error('voiceStateUpdate handler error:', err);
  }
});

client.login(token);
