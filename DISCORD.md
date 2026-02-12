# Discord Setup

Get Kira running on Discord.

## 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g., "Kira")
3. Go to **Bot** tab → **Reset Token** → copy the token

## 2. Enable Privileged Intents

Still in the **Bot** tab, scroll to **Privileged Gateway Intents** and enable:

- **Message Content Intent** - Required to read message text
- **Server Members Intent** - Optional, for user filtering

## 3. Configure egirl

Add your token to `.env`:

```bash
DISCORD_TOKEN=your_bot_token_here
```

Configure channels in `egirl.toml`:

```toml
[channels.discord]
allowed_channels = ["dm"]      # "dm" for DMs, or channel IDs like "123456789"
allowed_users = []             # Empty = allow all, or ["user_id_1", "user_id_2"]
```

### Finding IDs

Enable Developer Mode in Discord (Settings → App Settings → Advanced → Developer Mode), then right-click channels/users to copy IDs.

## 4. Invite Bot to Server

If you want the bot in a server (not just DMs):

1. Go to **OAuth2** → **URL Generator**
2. Scopes: `bot`
3. Bot Permissions:
   - Send Messages
   - Read Message History
   - Add Reactions (optional)
4. Copy the generated URL and open it
5. Select your server and authorize

## 5. Run

```bash
bun run start discord
```

Kira will respond to:
- Direct messages
- @mentions in allowed channels

Press `Ctrl+C` to stop.

## Troubleshooting

### "Used disallowed intents"

You forgot to enable privileged intents. Go back to step 2.

### Bot doesn't respond

- Check `allowed_channels` includes "dm" or the channel ID
- Check `allowed_users` is empty or includes your user ID
- Make sure the bot has permissions to read/send in the channel

### "Discord not configured"

Add `DISCORD_TOKEN` to `.env` and add `[channels.discord]` section to `egirl.toml`.
