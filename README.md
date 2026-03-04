# 🃏 CardBot — Starter Pack

A Discord card-collecting bot inspired by Karuta/SoFi/Shoob.
Every 2 minutes a card drops with a captcha — first to type `claim <captcha>` wins it.

---

## 🚀 Setup

### 1. Prerequisites
- Node.js v16.9.0 or higher
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))

### 2. Install
```bash
npm install
```

### 3. Configure
```bash
cp .env.example .env
```
Open `.env` and paste your bot token:
```
BOT_TOKEN=your_token_here
```

### 4. Run
```bash
npm start
```
Or with auto-restart on file change:
```bash
npm run dev
```

---

## ⚙️ First Time in Discord

1. Invite your bot to your server with `Send Messages`, `Embed Links`, `Read Message History` permissions
2. In the channel you want cards to drop, type:
```
!setchannel
```
Cards will now drop every **2 minutes** automatically.

---

## 📋 Commands

| Command | Description |
|---|---|
| `claim <captcha>` | Claim an active card drop |
| `!collection` | View your card collection |
| `!collection @user` | View someone else's collection |
| `!profile` | View your rarity stats |
| `!drop` | Force a manual drop *(Mod only)* |
| `!setchannel` | Set auto-drop channel *(Admin only)* |
| `!help` | Show command list |

---

## 🃏 Rarities

| Rarity | Color | Drop Rate |
|---|---|---|
| ⚪ Common | Grey | 50% |
| 🟢 Uncommon | Green | 28% |
| 🔵 Rare | Blue | 13% |
| 🟣 Epic | Purple | 6% |
| 🌟 Legendary | Gold | 3% |

---

## 🖼️ Adding Your Own Cards

Edit the `CARDS` array in `index.js`:

```js
const CARDS = [
  { name: 'Your Character', image: 'https://your-image-url.png', rarity: 'Rare' },
  // ...
];
```

- `name` — Display name on the card
- `image` — Direct URL to the card image (400x560px recommended)
- `rarity` — Must match one of: `Common`, `Uncommon`, `Rare`, `Epic`, `Legendary`

---

## 📁 File Structure

```
cardbot/
├── index.js          ← Main bot logic
├── package.json
├── .env              ← Your bot token (DO NOT share)
├── .env.example
├── .gitignore
└── data/
    └── users.json    ← Auto-created, stores all user collections
```

---

## 🛠️ Planned Features (for you to build next)
- [ ] Card trading between users
- [ ] Wishlist system
- [ ] Card upgrades / star system
- [ ] Leaderboard
- [ ] Daily reward command
- [ ] Server-specific card pools
