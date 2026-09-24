---
<img src="/Images/mcafk.png" alt="Project Logo" width="400" />

---

![GitHub stars](https://img.shields.io/github/stars/yazdaninfo/mcafk?style=social)
![GitHub forks](https://img.shields.io/github/forks/yazdaninfo/mcafk?style=social)
![GitHub issues](https://img.shields.io/github/issues/yazdaninfo/mcafk?style=social)
![Node JS](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)
![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)

---

## 🤖 McAfk — Mineflayer Bot Manager

A Node.js Mineflayer manager that connects offline-mode players to Minecraft servers and lets you operate them from Telegram **or an authenticated web dashboard**. The web panel provides live status, position/health/food, chat, movement controls, camera look, hotbar/inventory, reconnect/disconnect, screenshots and bot lifecycle management.

Mineflayer is the underlying high-level Minecraft client; this project is an operations layer around its bot, world, physics, inventory and chat APIs.

---
## 📱 **Telegram Interface**

### Main Menu
Send `/start` to see this:

![Main Menu](/Images/telegram-menu.png)

### Adding a Bot
Press **Add Bot** and enter details:

![Add Bot Flow](/Images/add-bot-demo.png)

### Chat Forwarding
Minecraft chat appears in your Telegram group:

![Chat Forwarding](/Images/chat-forward.png)

---


## Features

- **Connect fake players** to any Minecraft server that is cracked and have via backwards (offline/cracked auth)
- **Multi-bot management** — add, disconnect, reconnect, and remove bots at any time
- **Anti-AFK** 🏃 — jump in place, step one block forward and back, or both, on any interval from 15 s to 30 m. Toggled per bot from Telegram.
- **Saved auto-login** 🔐 — store your `/login <password>` per bot; it's replayed automatically on every reconnect, but only when the server actually asks for it
- **Run server commands from Telegram** — type `/tpa Player123` in Telegram and your bot runs it in-game
- **ViaVersion / ViaBackwards / ViaRewind support** — connect with any client version to any server version
- **Auto-reconnect** with exponential backoff (5 s → 10 s → 20 s → 40 s → 60 s)
- **Chat forwarding** — pipe Minecraft server chat to Telegram group chats in real time, batched so busy servers don't hit Telegram's rate limit
- **Inline keyboard UI** — everything controlled through Telegram buttons; no slash commands needed in private chat
- **Authenticated web control panel** 🌐 — open `/` on `WEB_PORT`, enter `WEB_TOKEN`, and control every bot from a browser
- **Embedded 3D Minecraft viewer** 🎮 — open the game view inside the dashboard, watch the live bot world, and use keyboard/buttons for movement, jump, sneak, sprint, attack and item use
- **REST API** — `/api/bots` exposes status and controlled actions for custom frontends or automation
- **Detailed status** — uptime, server address, version, anti-AFK mode, login state, last error per bot
- **Survives restarts** — bots, anti-AFK settings and login commands are saved to disk; disconnected bots come back as disconnected, not silently forgotten

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 |
| or bun  | latest |
| npm | ≥ 9 |

---

## Setup

### Option A: Local Setup

### 1. download the files 
you can go to the releases page and download the source code and unzip it or clone the repo
```shell
git clone https://github.com/yazdaninfo/mcafk
```
then create a `.env` file in the project folder (see step 4) with your bot token.

### 2. Install dependencies

```bash
npm install
```

### 3. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** you receive

### 4. Set the bot token

Create a `.env` file next to `index.js`:

```
TELEGRAM_BOT_TOKEN=your_token_here
```

The bot reads this file automatically at startup — no extra package needed. A real
environment variable of the same name takes priority, which is handy for services:

```bash
export TELEGRAM_BOT_TOKEN=your_token_here
```

> ⚠️ `.env` is gitignored. Never commit your token — Telegram revokes any token it finds published.

### 5. Run

```bash
npm start
# or
node index.js
```

You should see:
```
🚀 Minecraft Bot Manager starting…
✅  Running as @YourBotName
```

---

### Web dashboard

The same process serves a Persian RTL dashboard by default on port `3000` (or Railway's `PORT`). Set a strong token before starting:

```bash
WEB_PORT=3000
WEB_TOKEN=replace-with-a-long-random-secret
npm start
```

Then open `http://localhost:3000/` and enter `WEB_TOKEN`. The API requires `Authorization: Bearer <WEB_TOKEN>` on every `/api/*` request. Keep the panel behind HTTPS/VPN/reverse-proxy authentication when exposing it to the public internet; never leave it on an untrusted network without a strong token.

Available web controls include:

- add/remove/reconnect/disconnect bots
- live connection, coordinates, dimension, health, hunger and uptime
- chat/commands, held movement controls, keyboard W/A/S/D/Space/Shift, jump/sneak/sprint, stop, attack, item use and look direction
- embedded prismarine-viewer 3D world, hotbar slot, inventory, screenshot, anti-AFK, auto-eat and saved login actions via REST

### Option B: Deploy to Railway 🚂

Deploy this bot to Railway for 24/7 uptime without running it on your local machine.

#### 1. Create accounts
- Sign up for [Railway](https://railway.app/) (free $5 credit/month)
- Create your Telegram bot via [@BotFather](https://t.me/BotFather) if you haven't already

#### 2. Deploy from GitHub

**Method 1: Deploy from your fork**
1. Fork this repository to your GitHub account
2. Go to [Railway Dashboard](https://railway.app/dashboard)
3. Click **New Project** → **Deploy from GitHub repo**
4. Select your forked repository
5. Railway will auto-detect the project

**Method 2: Deploy with Railway button**
Click this button to deploy instantly:

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/minecraft-afk-bot)

#### 3. Set environment variables

In Railway dashboard:
1. Click on your project
2. Go to **Variables** tab
3. Add this variable:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   ```
4. Click **Save**

#### 4. Deploy

Railway will automatically:
- Install dependencies
- Start your bot with `node index.js`
- Keep it running 24/7
- Auto-restart on crashes

#### 5. Monitor

View logs in Railway dashboard:
- Click your project → **Deployments** → **View Logs**
- You should see: `✅ Running as @YourBotName`

#### Railway Configuration

The project includes these Railway config files:

- `railway.toml` - Deployment settings
- `.railwayignore` - Files to exclude from deployment
- `Procfile` - Start command

**Important Notes:**
- Railway free tier gives $5/month credit (~500 hours)
- Environment variables are kept secure and not exposed in logs
- Auto-deploys on git push (if connected to GitHub)
- ⚠️ **`userdata.json` does NOT survive a redeploy** unless you mount a volume and
  point `DATA_DIR` at it. Without that, the saved bot list is empty after every deploy.

**Troubleshooting:**
- If bot doesn't start, check logs for token errors
- Ensure `TELEGRAM_BOT_TOKEN` variable is set correctly
- Check Railway credit balance in your account settings

---

### Option C: Deploy to Northflank 🐳

Northflank's free tier keeps a worker running with no sleep timer, and allows a
service with **no ports** — which is what this project needs (it is not a web
server; it holds an outbound connection to Telegram and Minecraft).

#### 1. Push the code to GitHub

```bash
git init
git add .
git commit -m "Minecraft AFK bot"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `.env` and `userdata.json`, so no secrets are pushed.

#### 2. Create a combined service

In the Northflank dashboard: **Create new → Service → Combined** (build + deploy
in one).

| Step | Value |
|---|---|
| Repository | your repo, branch `main` |
| Build type | **Dockerfile** (`/Dockerfile`, context `/`) |
| Networking | **no ports** — do not add one |
| Resources | smallest plan is enough (~256 MB) |

#### 3. Environment variables

Add one runtime variable:

```
TELEGRAM_BOT_TOKEN = 123456:ABC...
```

`DATA_DIR=/data` is already baked into the Dockerfile.

#### 4. Attach a volume (required for persistence)

Under **Advanced → persistent volume** (at creation), or **Volumes → Add volume**
afterwards:

| Field | Value |
|---|---|
| Mount path | `/data` |
| Size | 1 GB |

Without this the container still boots, but the bot list resets on every deploy.

#### 5. Verify

Open **Logs** on the service. A healthy start prints:

```
State file: /data/userdata.json
🚀 Minecraft Bot Manager starting…
✅ Running as @YourBotName
```

`Unauthorized` there means the token variable is wrong.

**Note on antibots:** Northflank runs in a datacenter IP range, which many
Minecraft antibot plugins refuse by default. If the bot gets
`denied from entering the server`, that is the host's IP being filtered, not a
bug — see the antibot cooldown handling in `antibot.js`.

---

## Usage

### Private chat — managing bots

Send `/start` to your bot to open the main menu.

| Button | Action |
|---|---|
| ➕ Add Bot | Prompts you for connection details, then connects |
| 📋 Bots | Lists **your** bots with status |
| 📡 Forwarding | Explains the chat-forwarding feature |
| ℹ️ Help | Full usage guide |

You only ever see and control bots you registered (or that are owned by your `@username`) — other people's bots are invisible to you.

**Adding a bot** — after pressing Add Bot, send one of:

```
name  ip  port  [version]
name  ip:port   [version]
```

Examples:
```
Steve play.example.com 25565 1.20.4
Alex  mc.example.com 25565 1.8.9
```

**Supported versions** (anything mineflayer supports):
`1.21.4` `1.20.4` `1.19.4` `1.16.5` `1.12.2` `1.8.9` `1.7.10`

Up to **10 bots per user**.

### Anti-AFK 🏃

Most servers kick players who stand still. Open a bot's manage screen and press **🏃 Anti-AFK**:

| Mode | What the player does |
|---|---|
| ⛔ Off | Nothing — stands completely still |
| ⬆️ Jump only | Hops in place |
| ↔️ Walk 1 block | Steps one block forward, then one block back — ends up exactly where it started |
| 🤸 Jump + Walk | Both together |

Then pick how often: **15s · 30s · 1m · 2m · 5m · 10m**, or **✏️ Custom interval** for anything between 5 s and 30 m.
Each pulse also turns the player to a new random direction so the movement isn't perfectly repetitive.

**▶️ Do it now** fires one pulse immediately, so you can watch it in-game and confirm it works.

From the keyboard instead:

```
/afk                      open the menu for your active bot
/afk jump 30s             hop every 30 seconds
/afk walk 2m              shuffle one block every 2 minutes
/afk Steve both 45s       name the bot explicitly
/afk off                  stop
```

Intervals accept `30s`, `90s`, `2m`, `10m` — a bare number means seconds.

The setting is saved per bot and comes back automatically after a reconnect or a restart of the whole manager.

### Auto-login 🔐

Cracked servers running AuthMe/nLogin ask for a password every time you join. Save the command once and the bot handles it forever:

1. On the bot's manage screen press **🔐 Set auto-login**
2. Send the exact command your server needs:
   ```
   /login 1597311
   ```
   (or `/register mypass mypass`)
3. Delete your message afterwards — it contains your password

From then on, whenever that bot connects or reconnects, the command is sent **only when the server actually asks for a login**. If the server never prompts, it's sent once after 4 seconds as a fallback. If the server doesn't confirm, it retries up to 3 times.

The password is masked (`/login 1••••••`) everywhere it's shown back to you.

| Button | Action |
|---|---|
| ✏️ Change command | Replace the saved command |
| 🔓 Disable / 🔐 Enable | Keep the command but stop/start sending it |
| 🗑️ Clear | Forget it entirely |
| ▶️ Send now | Fire it immediately and watch the server's reply |

From the keyboard:

```
/setlogin /login 1597311
/setlogin Steve /login 1597311
/setlogin                    show the current setting
```

### Hotbar / item switching 🎒

On a bot's manage screen press **🎒 Hotbar** to see its 9 hotbar slots and which
item is in each one. Tap a slot number to make the bot hold that item — handy
for switching between a pickaxe, axe, sword, food, and so on from Telegram.

The selected slot is marked with a ✅. The bot must be online for the change to
apply.

### Neocraft server flow 🏰

On a bot's manage screen press **🏰 Neocraft** to set up a two-step auto-join
flow for the Neocraft server: on every (re)connect the bot logs in, then
switches you into survival.

It asks for two commands:

1. **Login command** — e.g. `/login 1597311`
2. **2nd command** — e.g. `/survival` (to enter the survival section)

Timing: the login command is sent ~2s after joining — or right after an antibot
challenge clears, so it isn't swallowed by a verification lobby — and the 2nd
command ~5–6s after that. Settings are saved and replayed automatically on every
reconnect.

### Running server commands from Telegram

Your bot is a real player on the server, so it can run any command a player can — `/tpa`, `/home`, `/warp`, `/msg`, and so on.

**1. Choose which bot runs your commands** (skip this if you only have one — it's picked automatically):

```
/use Steve
```

Or send `/use` with no name to get a button picker. You can also press **⌨️ Console** on a bot's manage screen.

**2. Type the command like you would in-game:**

```
/tpa Appabol123
/tpaccept
/home
/warp spawn
```

The bot sends it to the server and mirrors the server's reply back to you for 20 seconds:

```
📤 Command sent as Steve:
/tpa Appabol123

[Steve @ mc.example.com:25565] Request sent to Appabol123.
```

**Teleporting to your bot** is the common use case — send `/tpa YourName` from the bot, then accept the request in-game. Or run `/tpahere YourName` if your server supports it.

**Sending plain chat** (no leading slash reaches the server):

```
/say hello everyone
```

**Command name clashes** — `/start`, `/help`, `/use`, `/say`, `/cmd`, `/console`, `/bots`, `/afk`, `/setlogin`, `/forward`, `/unforward` and `/forwards` are handled by the Telegram bot itself. If your server has a command with one of those names, wrap it in `/cmd`:

```
/cmd /help
/cmd /list
```

`/cmd` also accepts an explicit bot name as the first word, which is handy when you run several:

```
/cmd Steve /home
```

| Command | Description |
|---|---|
| `/bots` | List your bots |
| `/use [name]` | Set which bot runs commands in this chat |
| `/cmd [name] <command>` | Send a command explicitly (use for reserved names) |
| `/say <text>` | Send plain chat as the bot |
| `/afk [name] <off\|jump\|walk\|both> [interval]` | Configure anti-AFK |
| `/setlogin [name] <command>` | Save the auto-login command |
| `/console [name]` | Open a bot's console |
| *anything else starting with `/`* | Relayed straight to the server |

> Only the chat that added a bot, or the Telegram user who owns it, can see or send it commands.

### Group chat — forwarding Minecraft chat

1. Add your bot to a Telegram group
2. In the group, send:
   ```
   /forward @yourusername
   ```
3. Every bot you own will now forward server chat to that group

**Forwarding commands** (use in the group):

| Command | Description |
|---|---|
| `/forward @username` | Subscribe this group to that user's bots' chat |
| `/unforward @username` | Unsubscribe |
| `/forwards` | List active subscriptions in this chat |

Forwarded messages look like:
```
[Steve @ mc.example.com:25565] Player123: hello everyone
[Steve @ mc.example.com:25565] Player123 joined the game
```

Lines are collected for a couple of seconds and sent as one Telegram message, so a busy server can't trip Telegram's rate limit.

---

## Auto-Reconnect

When a bot loses connection for any reason (kick, timeout, server restart), it automatically retries:

| Attempt | Wait |
|---|---|
| 1 | 5 s |
| 2 | 10 s |
| 3 | 20 s |
| 4 | 40 s |
| 5+ | 60 s |

The counter resets on a successful connection. Pressing **Disconnect** or **Remove** in the bot manager cancels any pending reconnect immediately.

On every successful reconnect the bot's **saved login command** is replayed and its **anti-AFK** loop restarts — you don't have to touch anything.

After 10 failed attempts it stops and tells you; press **🟢 Reconnect** to start over.

---

## Restarts and persistence

State lives in `userdata.json` next to `index.js`: bots, their server/version, anti-AFK mode and interval, saved login command, forwarding subscriptions.

On startup, bots that were online are reconnected, and bots you had **disconnected** on purpose come back listed as offline — with their settings intact — instead of quietly reconnecting or disappearing.

`SIGINT`/`SIGTERM` (Ctrl-C, `systemctl stop`) disconnects every bot cleanly and flushes state to disk first.

> ⚠️ `userdata.json` contains your saved login passwords in plain text. It's gitignored — keep the file readable only by you.

---

## Testing

```bash
npm test
```

Runs four suites against stubbed `grammy` and `mineflayer`, so nothing touches Telegram or a real server:

| Suite | Covers |
|---|---|
| `test/smoke.js` | access control, validation, all three anti-AFK modes and intervals, auto-login (prompt / fallback / confirm / toggle), command relay, chat batching, cleanup |
| `test/restart.js` | restoring paused vs. live bots and their settings from `userdata.json` |
| `test/afk-timer.js` | the anti-AFK timer actually repeating, stopping while offline, and resuming after reconnect |
| `test/shutdown.js` | `SIGINT` quits every connection, stops polling, and flushes state without losing bots |

`npm test` overwrites `userdata.json` — back it up if you have bots configured.

---

## Via Plugin Support

Server-side Via plugins handle all protocol translation automatically. You just need to specify the correct **client** version when adding a bot:

| Plugin | Use case | Example |
|---|---|---|
| **ViaVersion** | Connect a newer client to an older server | `version 1.20.4` on a 1.8 server |
| **ViaBackwards** | Connect an older client to a newer server | `version 1.8.9` on a 1.20 server |
| **ViaRewind** | Connect a 1.7.x client to modern servers | `version 1.7.10` |

No special configuration is needed on the bot side.

---

## Architecture

```
index.js
├── State
│   ├── mcBots      Map<name, BotInfo>     — all registered bots
│   ├── chatStates  Map<chatId, State>     — conversation flow per chat (10 min TTL)
│   ├── forwardMap  Map<username, Set<chatId>>  — forwarding subscriptions
│   ├── activeBot   Map<chatId, name>      — which bot runs commands per chat
│   └── outbox      Map<chatId, lines[]>   — batched server chat waiting to be sent
├── spawnBot()      — creates mineflayer bot, wires events, handles reconnect
├── scheduleAfk()   — repeating anti-AFK pulse (jump / walk one block / both)
├── sendLogin()     — replays the saved login command when the server prompts
├── readChat()      — flattens ChatMessage / JSON / {text,extra[]} into plain text
├── Telegram UI     — /start, /help, /bots, /forward… + inline callbacks
├── Command relay   — /use, /cmd, /say, /afk, /setlogin, /console + bare /… passthrough
└── Chat forwarding — strips § color codes, batches, sends to subscribed groups
```

Every per-bot callback goes through one `canControl()` gate, so a bot can only be
seen, driven, reconfigured or removed by the chat that registered it or its `@username` owner.

**Dependencies:**

| Package | Purpose |
|---|---|
| [`grammy`](https://grammy.dev) v1 | Telegram Bot API client |
| [`mineflayer`](https://mineflayer.com) v4 | Minecraft bot client |

---

## Warning 
**for educational purposes only**

**don't use this on servers you don't own**

**risk of ban in services if break the TOS check before using**

---

## License

MIT — see [LICENSE](LICENSE).
