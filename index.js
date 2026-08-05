require('dotenv').config();
const ENABLE_WEB_DASHBOARD = false;

// No-op stand-ins so Discord command handlers (!auction bid, trade confirm, etc.)
// don't crash calling these when the web dashboard is disabled.
let pushCoinUpdate = () => {};
let pushToUser = () => {};
let broadcastAll = () => {};
let pushCollectionUpdate = () => {};
let broadcastLeaderboardUpdate = () => {};
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createCanvas, loadImage, registerFont } = require('canvas');
const fs = require('fs');
const https = require('https');
const http  = require('http');

try {
  registerFont('./Roboto-Bold.ttf', { family: 'Arial' });
} catch (err) {
  console.error('⚠️ Could not load Roboto-Bold.ttf — falling back to default font:', err.message);
}


function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchImageBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.on('error', (err) => console.error('Discord client error:', err));
client.on('shardError', (err) => console.error('Shard error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// ─── Config ───────────────────────────────────────────────────────────────────
const PREFIX          = '!';
const DROP_COOLDOWN   = 2 * 60 * 1000;
const ACTIVITY_WINDOW = 2 * 60 * 1000;

const DATA_DIR        = process.env.DATA_DIR || './data';
const IMAGES_DIR = `${__dirname}/images`;
const DB_FILE         = `${DATA_DIR}/users.json`;
const META_FILE       = `${DATA_DIR}/meta.json`;
const RACE_LB_FILE    = `${DATA_DIR}/race_lb.json`;
const CLAIMS_LB_FILE  = `${DATA_DIR}/claims_lb.json`;
const LOCKS_FILE      = `${DATA_DIR}/locks.json`;
const MARKET_FILE     = `${DATA_DIR}/market.json`;
const SETTINGS_FILE   = `${DATA_DIR}/settings.json`;
const AUCTION_FILE    = `${DATA_DIR}/auctions.json`;
const TRADES_FILE     = `${DATA_DIR}/trades.json`;
const AUTOSELL_FILE   = `${DATA_DIR}/autosell.json`;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });


const CURRENCY_NAME   = 'Coins';
const CURRENCY_EMOJI  = '<:coins:1477684491320426601>';
const SERVER_NAME     = 'GAG2';
const WATERMARK       = 'LA';

let auctionChannels = {};
let payoutChannels = {};

let sellbatchV10Protection = true;

// ─── Auction soft-close config ────────────────────────────────────────────────
const AUCTION_EXTEND_THRESHOLD_1 = 2 * 60 * 1000;  // last 2 min → add 90s
const AUCTION_EXTEND_AMOUNT_1    = 90 * 1000;
const AUCTION_EXTEND_THRESHOLD_2 = 30 * 1000;       // last 30s → add 45s
const AUCTION_EXTEND_AMOUNT_2    = 45 * 1000;
const AUCTION_MAX_EXTENSION      = 10 * 60 * 1000;  // cap: 10 min total added

// ─── Auctions ─────────────────────────────────────────────────────────────────
function loadAuctions() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AUCTION_FILE)) fs.writeFileSync(AUCTION_FILE, '[]');
  return JSON.parse(fs.readFileSync(AUCTION_FILE));
}
function saveAuctions(a) { fs.writeFileSync(AUCTION_FILE, JSON.stringify(a, null, 2)); }

const LISTINGS_FILE = `${DATA_DIR}/market_listings.json`;
function loadListings() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LISTINGS_FILE)) fs.writeFileSync(LISTINGS_FILE, '[]');
    return JSON.parse(fs.readFileSync(LISTINGS_FILE));
  } catch { return []; }
}

function loadAutosellRules() {
  if (!fs.existsSync(AUTOSELL_FILE)) fs.writeFileSync(AUTOSELL_FILE, '{}');
  return JSON.parse(fs.readFileSync(AUTOSELL_FILE));
}
function saveAutosellRules(r) { fs.writeFileSync(AUTOSELL_FILE, JSON.stringify(r, null, 2)); }
function getUserAutosellRules(userId) {
  return loadAutosellRules()[userId] || [];
}
function applyAutosellRules(user, userId, newPlants) {
  const rules = getUserAutosellRules(userId);
  if (!rules.length) return 0;
  let totalEarned = 0;
  const candidates = [];
  const usedIndexes = new Set();

  for (let i = user.collection.length - 1; i >= 0; i--) {
    const p = user.collection[i];
    if (usedIndexes.has(i)) continue;
    if (newPlants && !newPlants.some(np => np.name === p.name && np.version === p.version)) continue;
    if (isLocked(userId, p)) continue;
    for (const rule of rules) {
      if (rule.rarity && p.rarity.toLowerCase() !== rule.rarity.toLowerCase()) continue;
      if (rule.mutation === 'none' && p.mutation) continue;
      if (rule.mutation && rule.mutation !== 'none' && (!p.mutation || p.mutation.name.toLowerCase() !== rule.mutation.toLowerCase())) continue;
      if (rule.plant && p.name.toLowerCase() !== rule.plant.toLowerCase()) continue;
      if (rule.version_op && rule.version_n !== undefined) {
        const v = p.version || 0;
        const n = rule.version_n;
        const op = rule.version_op;
        const passes = (op==='>'&&v>n)||(op==='>='&&v>=n)||(op==='<'&&v<n)||(op==='<='&&v<=n)||((op==='='||op==='==')&&v===n);
        if (!passes) continue;
      }
      usedIndexes.add(i);
      candidates.push(i);
      totalEarned += getLiveSellValue(p);
      break;
    }
  }

  candidates.sort((a, b) => b - a);
  for (const idx of candidates) user.collection.splice(idx, 1);
  user.currency += totalEarned;
  return totalEarned;
}

function loadTrades() {
  if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, '{}');
  return JSON.parse(fs.readFileSync(TRADES_FILE));
}
function saveTrades(t) { fs.writeFileSync(TRADES_FILE, JSON.stringify(t, null, 2)); }
let webTrades = loadTrades();
// Clean up stale active trades on startup
for (const [id, trade] of Object.entries(webTrades)) {
  if (trade.status === 'active') trade.status = 'expired';
}
saveTrades(webTrades);
function getAuction(id) { return loadAuctions().find(a => a.id === id) || null; }

let raceTimer = 30; // seconds

// ─── Race reaction emojis ─────────────────────────────────────────────────────
const RACE_REACT_CORRECT = '✅';
const RACE_REACT_RECORD  = '⭐';

// ─── Claim cooldowns per rarity (ms) ─────────────────────────────────────────
const CLAIM_COOLDOWNS = {
  Common:    60 * 1000,
  Uncommon:  60 * 1000,
  Rare:      60 * 1000,
  Epic:      60 * 1000,
  Legendary: 60 * 1000,
  Mythic:    60 * 1000,
  Super:     60 * 1000,
  Secret:    60 * 1000,
};

const CRATE_COOLDOWNS = {
  bronze:  30 * 1000,
  silver:  35 * 1000,
  gold:    40 * 1000,
  diamond: 50 * 1000,
  ruby:    60 * 1000,
};

const CRATE_PITY_THRESHOLD = {
  bronze: 8,
  silver: 7,
  gold: 6,
  diamond: 5,
  ruby: 4,
};

const COOLDOWN_EXEMPT_IDS = [
  '734159803995259042',
  '1263885067227496472',
];

const BOT_ADMIN_IDS = [
  '734159803995259042',
  '239725298403246081', // add whoever you trust here
];

function isBotAdmin(userId) {
  return BOT_ADMIN_IDS.includes(userId);
}

const TEST_IDS = new Set([
  '',
]);

// ─── Decay Config ─────────────────────────────────────────────────────────────
const DECAY_WARN_MS    = 2 * 24 * 60 * 60 * 1000; // 2 days → DM warning
const DECAY_START_MS   = 3 * 24 * 60 * 60 * 1000; // 3 days → decay begins
const DECAY_INTERVAL   = 60 * 60 * 1000;            // remove 1 plant per hour
const DECAY_SAFE_VER   = 10;                         // v1–v10 are immune

// ─── Activity Tracking ────────────────────────────────────────────────────────
const channelActivity  = {};
const lastDropTime     = {};
let   dropChannels     = {};
let   relaxedDropChannels = {};
let   vPingChannels    = {};

// ─── Settings persistence ─────────────────────────────────────────────────────
function loadSettings() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');
  return JSON.parse(fs.readFileSync(SETTINGS_FILE));
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }
;(function initSettings() {
  const s = loadSettings();
  if (s.dropChannels)        dropChannels        = s.dropChannels;
  if (s.relaxedDropChannels) relaxedDropChannels = s.relaxedDropChannels;
  if (s.vPingChannels)       vPingChannels       = s.vPingChannels;
  if (s.auctionChannels) auctionChannels = s.auctionChannels;
  if (s.payoutChannels) payoutChannels = s.payoutChannels;
})();


// ─── XP Config ────────────────────────────────────────────────────────────────
const XP_REWARDS = {
  claim:      50,
  daily:      80,
  weekly:     200,
  race_finish:30,
  race_win:   100,
  crate_open: 40,
};
function xpForLevel(level) {
  let total = 0;
  for (let i = 1; i < level; i++) total += i * 120;
  return total;
}
function getLevelFromXP(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}
function xpToNextLevel(xp) {
  const level = getLevelFromXP(xp);
  const needed = xpForLevel(level + 1) - xpForLevel(level);
  const progress = xp - xpForLevel(level);
  return { level, needed, progress, pct: Math.floor((progress / needed) * 100) };
}

// ─── Ranks ────────────────────────────────────────────────────────────────────
const RANKS = [
  { minLevel: 1,   name: 'Unranked',  emoji: '🫥' },
  { minLevel: 5,   name: 'Fresh',     emoji: '🔘' },
  { minLevel: 10,  name: 'Familiar',  emoji: '👤' },
  { minLevel: 20,  name: 'Notable',   emoji: '🎖️' },
  { minLevel: 35,  name: 'Established', emoji: '💠' },
  { minLevel: 50,  name: 'Heavy Hitter', emoji: '🏆' },
  { minLevel: 75,  name: 'Feared',    emoji: '🌟' },
  { minLevel: 100, name: 'Untouchable', emoji: '♾️' },
];
function getRank(level) {
  let rank = RANKS[0];
  for (const r of RANKS) { if (level >= r.minLevel) rank = r; }
  return rank;
}

// ─── Garden Elo / Weighted Rank System ───────────────────────────────────────
// Inspired by osu!'s weighted pp system: each plant contributes
// sellValue * (0.95 ^ index) where plants are sorted by sell value desc.
// This means 100 common plants can't beat 1 legendary — diminishing returns.
// A rarity bonus multiplier further rewards high-rarity plants.

const RARITY_WEIGHT_BONUS = {
  Common:    1.00,
  Uncommon:  1.00,
  Rare:      1.00,
  Epic:      1.00,
  Legendary: 1.00,  // let base price + version do the work
  Mythic:    1.00,
  Secret:    1.00,  // was 3.50 — this was the whole problem
};

// A single plant can already be worth a LOT before it ever reaches this scoring
// function — e.g. a v1 Secret is 875,000, and a v1 Secret with a dropOnly bonus
// AND an Eclipsed mutation stacks up past 5,000,000. Since the very first item
// in the weighted sum always counts at full value (0.95^0 = 1), one lucky pull
// like that could nearly max out the entire tier ladder by itself.
// PLANT_SCORE_CAP lets values up to that point count fully (so normal Rare/Epic/
// Legendary/Mythic progression feels exactly the same as before), but anything
// above it grows via sqrt instead of linearly — so no single plant, however
// insane its rarity/version/mutation combo, can carry someone to the endgame
// tiers alone. Reaching Grandmaster/Secret now takes accumulating MANY high-value
// plants (grinding AND trading), not one drop. Tune these two constants to
// taste — raising the cap lets big single hits matter more, raising the dampen
// factor softens the falloff above the cap.
const PLANT_SCORE_CAP = 150000;
const PLANT_SCORE_DAMPEN = 30;
function dampenPlantScore(value) {
  if (value <= PLANT_SCORE_CAP) return value;
  return PLANT_SCORE_CAP + Math.sqrt(value - PLANT_SCORE_CAP) * PLANT_SCORE_DAMPEN;
}

function calcWeightedGardenScore(collection) {
  if (!collection.length) return 0;
  // Sort by effective value descending
  const sorted = [...collection]
    .map(p => {
      const base = getLiveSellValue(p);
      const bonus = RARITY_WEIGHT_BONUS[p.rarity] || 1.0;
      return dampenPlantScore(base * bonus);
    })
    .sort((a, b) => b - a);

  let score = 0;
  for (let i = 0; i < sorted.length; i++) {
    score += sorted[i] * Math.pow(0.95, i);
  }
  return Math.round(score);
}

// Garden Elo tiers — Grandmaster is the top VISIBLE tier. Secret is a true hidden
// tier: it exists in this list (so getGardenTier/getNextGardenTier work correctly
// once someone reaches it) but is deliberately excluded from any tier list shown
// to players (see the GARDEN_TIERS.filter(...) in the !info help text) so nobody
// knows it exists until someone actually hits 2,000,000 score.
const GARDEN_TIERS = [
  { name: 'Bronze',      emoji: '<:bronze:1534337657914527915>',      minScore: 25000,   color: 0xCD7F32, ansi: 'orange'  },
  { name: 'Silver',      emoji: '<:silver:1534338165555335218>',      minScore: 50000,   color: 0xC0C0C0, ansi: 'white'   },
  { name: 'Gold',        emoji: '<:gold:1534338263169499166>',        minScore: 80000,   color: 0xFFD700, ansi: 'yellow'  },
  { name: 'Platinum',    emoji: '<:platinum:1534338501938647190>',    minScore: 100000,  color: 0x00BFFF, ansi: 'cyan'    },
  { name: 'Diamond',     emoji: '<:diamond:1534338799486763109>',     minScore: 250000,  color: 0xB9F2FF, ansi: 'cyan'    },
  { name: 'Master',      emoji: '<:master:1534339117494702162>',      minScore: 500000,  color: 0x9B59B6, ansi: 'magenta' },
  { name: 'Grandmaster', emoji: '<:grandmaster:1534339387335376907>', minScore: 1000000, color: 0xFF00FF, ansi: 'magenta' }, // top visible rank
  { name: 'Secret',      emoji: '<:secret:1534340531910344804>',      minScore: 2000000, color: 0x000000, ansi: 'black'   }, // hidden — do not show in tier lists
];

function getGardenTier(score) {
  let tier = GARDEN_TIERS[0];
  for (const t of GARDEN_TIERS) { if (score >= t.minScore) tier = t; }
  return tier;
}

function getNextGardenTier(score) {
  for (const t of GARDEN_TIERS) { if (score < t.minScore) return t; }
  return null;
}

// ─── Mutations ────────────────────────────────────────────────────────────────
const MUTATIONS = [
  { name: 'Eclipsed',  emoji: '<:eclipsed:1477666927135428650>', multiplier: 5.0, weight: 1,  color: 0x2a0a3d },
  { name: 'Ignited',   emoji: '<:ignited:1534229469185839204>', multiplier: 4.2, weight: 2,  color: 0xFF4500 },
  { name: 'Bloodlit',  emoji: '<:bloodlit:1534227550920900831>', multiplier: 4.0, weight: 2,  color: 0x8B0000 },
  { name: 'Glow',      emoji: '<:glow:1477666867890884628>', multiplier: 3.5, weight: 3,  color: 0xADFF2F },
  { name: 'Starstruck',emoji: '<:starstruck:1534230447247327303>', multiplier: 3.0, weight: 4,  color: 0xFFFF00 },
  { name: 'Electric',  emoji: '<a:lightning:1534229071385333770>', multiplier: 2.0, weight: 6,  color: 0xFFDD00 }, 
  { name: 'Frozen',    emoji: '<:frozen:1477666846382620683>', multiplier: 1.4, weight: 12, color: 0xADD8E6 },
  { name: 'Aurora',    emoji: '<:aurora:1534229653211054262>', multiplier: 1.15, weight: 15, color: 0x66CCFF },
];

// ─── Weather System ────────────────────────────────────────────────────────
const WEATHER_TYPES = [
  { name: 'Eclipsed',   emoji: '<:eclipsed:1477666927135428650>', color: 0x2a0a3d, weight: 1,
    desc: 'A total eclipse blankets the garden in darkness — mutated cards are wildly overcharged (5.0x).' },
  { name: 'Ignited',    emoji: '<:ignited:1534229469185839204>', color: 0xFF4500, weight: 2,
    desc: 'Wildfire heat rolls across the fields — mutated cards burn hotter than usual (4.2x).' },
  { name: 'Bloodlit',   emoji: '<:bloodlit:1534227550920900831>', color: 0x8B0000, weight: 2,
    desc: 'A crimson haze settles over everything — mutated cards pulse with dark energy (4.0x).' },
  { name: 'Glow',       emoji: '<:glow:1477666867890884628>', color: 0xADFF2F, weight: 3,
    desc: 'The garden hums with a soft radiance — mutated cards shine brighter than normal (3.5x).' },
  { name: 'Starstruck', emoji: '<:starstruck:1534230447247327303>', color: 0xFFFF00, weight: 4,
    desc: 'Falling stars streak overhead — mutated cards sparkle with cosmic power (3.0x).' },
  { name: 'Electric',   emoji: '<a:lightning:1534229071385333770>', color: 0xFFDD00, weight: 6,
    desc: 'Static crackles through the air — mutated cards carry a jolt of extra charge (2.0x).' },
  { name: 'Frozen',     emoji: '<:frozen:1477666846382620683>', color: 0xADD8E6, weight: 12,
    desc: 'A cold snap has frozen the garden overnight — mutated cards get a light chill boost (1.4x).' },
  { name: 'Aurora',     emoji: '<:aurora:1534229653211054262>', color: 0x66CCFF, weight: 15,
    desc: 'A faint celestial glow washes over everything — mutated cards get a small boost (1.15x).' },
];
const WEATHER_INTERVAL_MS = 60 * 60 * 1000; // how often a new weather event can start
const WEATHER_DURATION_MS = 30 * 60 * 1000; // how long each weather event lasts
let currentWeather = null; // { name, emoji, color, desc, startedAt, endsAt }
function pickWeather() {
  const total = WEATHER_TYPES.reduce((s, w) => s + w.weight, 0);
  let roll = Math.random() * total;
  for (const w of WEATHER_TYPES) { roll -= w.weight; if (roll <= 0) return w; }
  return WEATHER_TYPES[0];
}
function getActiveWeather() {
  if (currentWeather && Date.now() < currentWeather.endsAt) return currentWeather;
  return null;
}

const MUTATION_NONE_WEIGHT = 955; // adjust so weights sum to 1000
function rollMutation(weatherName) {
  // No active weather = no mutations at all, full stop.
  if (!weatherName) return null;
  // While a weather event is active, ONLY the mutation matching that weather
  // can spawn (or no mutation at all) — every other mutation is completely
  // excluded from the roll, not just de-weighted.
  const match = MUTATIONS.find(m => m.name === weatherName);
  if (!match) return null;
  const total = MUTATION_NONE_WEIGHT + match.weight;
  const roll = Math.random() * total;
  if (roll < MUTATION_NONE_WEIGHT) return null;
  return match;
}

// ─── Rarities ─────────────────────────────────────────────────────────────────
const RARITY_EMOJIS = {
  Common:    '<:common:1534321914049466488>',
  Uncommon:  '<:uncommon:1534331462227202118>',
  Rare:      '<:rare:1534330477450891467>',
  Epic:      '<:epic:1534331279015940146>',
  Legendary: '<:legendary:1534332213443952732>',
  Mythic:    '<:mythic:1534326656204931082>',
  Super:     '<:super:1534330521755320512>',
  Secret:    '<:secret:1534330406227152896>',
};
const RARITIES = [
  { name: 'Common',    color: 0x9E9E9E, weight: 480000, emoji: RARITY_EMOJIS.Common,    sellPrice: 10     },
  { name: 'Uncommon',  color: 0x4CAF50, weight: 270000, emoji: RARITY_EMOJIS.Uncommon,  sellPrice: 25     },
  { name: 'Rare',      color: 0x2196F3, weight: 129000, emoji: RARITY_EMOJIS.Rare,      sellPrice: 75     },
  { name: 'Epic',      color: 0x9C27B0, weight: 58000,  emoji: RARITY_EMOJIS.Epic,      sellPrice: 2000   },
  { name: 'Legendary', color: 0xFFD700, weight: 27500,  emoji: RARITY_EMOJIS.Legendary, sellPrice: 10000  },
  { name: 'Mythic',    color: 0xEA2222, weight: 4000,    emoji: RARITY_EMOJIS.Mythic,    sellPrice: 25000  },
  { name: 'Super',     color: 0x00E5FF, weight: 1400,    emoji: RARITY_EMOJIS.Super,     sellPrice: 60000  },
  { name: 'Secret',    color: 0x000000, weight: 100,     emoji: RARITY_EMOJIS.Secret,    sellPrice: 250000 },
];

// ─── Base plant sell prices (version-weighted) ────────────────────────────────
const VERSION_MULTIPLIERS = { 
  1: 3.50,   
  2: 2.20, 
  3: 1.70, 
  4: 1.40, 
  5: 1.20, 
  6: 1.05 
};

function getVersionMultiplier(version) { return VERSION_MULTIPLIERS[version] || 1.00; }

// ─── Market / Demand system ───────────────────────────────────────────────────
function loadMarket() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MARKET_FILE)) fs.writeFileSync(MARKET_FILE, '{}');
  return JSON.parse(fs.readFileSync(MARKET_FILE));
}
function saveMarket(m) { fs.writeFileSync(MARKET_FILE, JSON.stringify(m, null, 2)); }
function recordTrade(plantName) {
  const market = loadMarket();
  if (!market[plantName]) market[plantName] = { trades: 0, lastDecay: Date.now() };
  market[plantName].trades += 1;
  saveMarket(market);
}
function getMarketMultiplier(plantName) {
  const market = loadMarket();
  const entry  = market[plantName];
  if (!entry) return 1.0;
  const hoursSince = (Date.now() - entry.lastDecay) / 3600000;
  const decayed    = entry.trades * Math.pow(0.5, hoursSince / 24);
  const mult = 0.5 + (1.5 * Math.min(decayed, 20) / 20);
  return Math.max(0.5, Math.min(2.0, mult));
}
function calcSellValue(plant, rarity, mutation, version) {
  const base      = rarity.sellPrice;
  const dropBonus = plant.dropOnly ? (rarity.name === 'Secret' ? 1.15 : 1.80) : 1.0;
  const verMult   = getVersionMultiplier(version);
  const mutMult   = mutation ? mutation.multiplier : 1.0;
  return Math.max(1, Math.round(base * dropBonus * verMult * mutMult));
}

// ─── Achievements ─────────────────────────────────────────────────────────────
const ACHIEVEMENTS = {
  first_claim:    { name: 'First Bloom',       emoji: '🌸', description: 'Claim your first plant',      title: 'Bloomer',       check: u => u.claimed >= 1 },
  collector_10:   { name: 'Budding Collector', emoji: '🌻', description: 'Own 10 plants',               title: 'Collector',     check: u => u.collection.length >= 10 },
  collector_50:   { name: 'Green Thumb',       emoji: '👍', description: 'Own 50 plants',               title: 'Green Thumb',   check: u => u.collection.length >= 50 },
  collector_100:  { name: 'The Hoarder',       emoji: '📦', description: 'Own 100 plants',              title: 'Hoarder',       check: u => u.collection.length >= 100 },
  rare_finder:    { name: 'Rare Find',         emoji: '🔵', description: 'Claim a Rare or higher',      title: 'Rare Finder',   check: u => u.collection.some(p => ['Rare','Epic','Legendary','Mythic','Super','Secret'].includes(p.rarity)) },
  legendary_find: { name: 'Legendary Bloom',   emoji: '🌟', description: 'Claim a Legendary or higher', title: 'Legendary',     check: u => u.collection.some(p => ['Legendary','Mythic','Super','Secret'].includes(p.rarity)) },
  secret_find:    { name: 'The Secret Garden', emoji: '💎', description: 'Claim a Secret plant',        title: 'Secret Keeper', check: u => u.collection.some(p => p.rarity === 'Secret') },
  mutant:         { name: 'Mutant Hunter',     emoji: '⭐', description: 'Claim a mutated plant',       title: 'Mutant Hunter', check: u => u.collection.some(p => p.mutation) },
  rich:           { name: 'Coin Baron',        emoji: '💰', description: 'Reach 10,000 coins',          title: 'Baron',         check: u => u.currency >= 10000 },
  racer:          { name: 'Speed Demon',       emoji: '🏁', description: 'Win a race',                  title: 'Speed Demon',   check: u => (u.raceWins || 0) >= 1 },
  level_10:       { name: 'Level 10',          emoji: '⬆️', description: 'Reach Level 10',              title: 'Lvl.10',        check: u => getLevelFromXP(u.xp || 0) >= 10 },
  level_50:       { name: 'Level 50',          emoji: '🔝', description: 'Reach Level 50',              title: 'Veteran',       check: u => getLevelFromXP(u.xp || 0) >= 50 },
  crate_opener:   { name: 'Crate Opener',      emoji: '📫', description: 'Open 10 crates',              title: 'Opener',        check: u => (u.cratesOpened || 0) >= 10 },
};

// ─── Shop Titles ──────────────────────────────────────────────────────────────
const SHOP_TITLES = {
  wanderer:  { name: 'Wanderer',  price: 2000,   emoji: '🗺️' },
  guardian:  { name: 'Guardian',  price: 5000,   emoji: '🛡️' },
  phantom:   { name: 'Phantom',   price: 15000,  emoji: '👻' },
  sovereign: { name: 'Sovereign', price: 50000,  emoji: '👑' },
  celestial: { name: 'Celestial', price: 200000, emoji: '🌙' },
};

// ─── Charms ───────────────────────────────────────────────────────────────────
const CHARMS = {
  bronze_charm: { name: 'Bronze Charm', emoji: '🥉', price: 20000,   description: 'Rare+ weights **×1.05** (Legendary **×1.15**)',                multipliers: { Rare: 1.05, Epic: 1.05, Legendary: 1.15, Mythic: 1.05, Secret: 1.05 } },
  silver_charm: { name: 'Silver Charm', emoji: '🥈', price: 40000,  description: 'Rare+ weights **×1.15** (Legendary **×1.25**)',                multipliers: { Rare: 1.15, Epic: 1.15, Legendary: 1.25, Mythic: 1.15, Secret: 1.15 } },
  gold_charm:   { name: 'Gold Charm',   emoji: '🥇', price: 150000, description: 'Epic+ weights **×1.40**',                multipliers: { Epic: 1.40, Legendary: 1.40, Mythic: 1.40, Secret: 1.40 } },
  void_charm:   { name: 'Void Charm',   emoji: '🌀', price: 2000000, description: 'Legendary+ **×1.75**, Secret **×2.00**', multipliers: { Legendary: 1.75, Mythic: 1.75, Secret: 2.0 } },
};

// ─── Crates ───────────────────────────────────────────────────────────────────
const CRATES = {
  bronze:  { name: 'Basic Seed Pouch',   emoji: '<:bronze_crate:1478192003274510508>', color: 0xCD7F32, price: 750,   minLevel: 5,  plants: 10,
    weights: { Common: 747120, Uncommon: 190000, Rare:  55000, Epic:   6495, Legendary:   1137, Mythic:   195, Super:     54, Secret:      0 } },

  silver:  { name: 'Premium Seed Pouch', emoji: '<:silver_crate:1478191961931517982>', color: 0xC0C0C0, price: 2500,  minLevel: 10, plants: 10,
    weights: { Common: 645500, Uncommon: 200000, Rare: 120000, Epic:  27125, Legendary:   6200, Mythic:   930, Super:    258, Secret:      0 } },

  gold:    { name: 'Deluxe Seed Sack',   emoji: '<:gold_crate:1478191922718703726>',   color: 0xFFD700, price: 5500,  minLevel: 15, plants: 10,
    weights: { Common: 585000, Uncommon: 200000, Rare: 150000, Epic:  48980, Legendary:  11756, Mythic:  3135, Super:    980, Secret:    157 } },

  diamond: { name: 'Mythic Seed Vault',  emoji: '<:diamond:1478191131841007829>',      color: 0x00BFFF, price: 14000, minLevel: 30, plants: 10,
    weights: { Common: 280000, Uncommon: 285000, Rare: 305000, Epic:  82328, Legendary:  32931, Mythic: 10977, Super:   3659, Secret:    439 } },

  ruby:    { name: 'Super Seed Crate',   emoji: '<:ruby:1477667927854682254>',         color: 0xFF1744, price: 32000, minLevel: 40, plants: 10,
    weights: { Common:  50000, Uncommon:  80000, Rare: 627000, Epic: 135313, Legendary:  67656, Mythic: 27063, Super:  11276, Secret:   1624 } },
};

// ─── Plants ───────────────────────────────────────────────────────────────────
const PLANTS = [
  // ── Common ─────────────────────────────────────────────────────────────
  { name: 'Carrot',     file: './images/Carrot.png',     display: 'Carrot.png',     rarity: 'Common' },
  { name: 'Strawberry', file: './images/Strawberry.png',  display: 'Strawberry.png',  rarity: 'Common' },
  { name: 'Blueberry',  file: './images/Blueberry.png', display: 'Blueberry.png', rarity: 'Common' },

  // ── Uncommon ───────────────────────────────────────────────────────────
  { name: 'Tulip',   file: './images/Tulip.png',  display: 'Tulip.png',  rarity: 'Uncommon' },
  { name: 'Tomato',  file: './images/Tomato.png', display: 'Tomato.png', rarity: 'Uncommon' },
  { name: 'Apple',   file: './images/Apple.png',  display: 'Apple.png',  rarity: 'Uncommon' },

  // ── Rare ───────────────────────────────────────────────────────────────
  { name: 'Bamboo',    file: './images/Bamboo.png',    display: 'Bamboo.png',    rarity: 'Rare' },
  { name: 'Corn',      file: './images/Corn.png',      display: 'Corn.png',      rarity: 'Rare' },
  { name: 'Cactus',    file: './images/Cactus.png',    display: 'Cactus.png',    rarity: 'Rare' },
  { name: 'Pineapple', file: './images/Pineapple.png', display: 'Pineapple.png', rarity: 'Rare' },

  // ── Epic ───────────────────────────────────────────────────────────────
  { name: 'Mushroom',   file: './images/Mushroom.png', display: 'Mushroom.png', rarity: 'Epic' },
  { name: 'Green Bean', file: './images/GreenBean.png',   display: 'GreenBean.png',   rarity: 'Epic' },
  { name: 'Banana',     file: './images/Banana.png',   display: 'Banana.png',   rarity: 'Epic' },
  { name: 'Grape',      file: './images/Grape.png',    display: 'Grape.png',    rarity: 'Epic' },
  { name: 'Coconut',    file: './images/Coconut.png',  display: 'Coconut.png',  rarity: 'Epic' },
  { name: 'Mango',      file: './images/Mango.png',    display: 'Mango.png',    rarity: 'Epic' },

  // ── Legendary ──────────────────────────────────────────────────────────
  // NOTE: Cherry omitted — no image file present. Rocket Pop excluded (not obtainable in GAG2).
  { name: 'Dragon Fruit', file: './images/DragonFruit.png', display: 'DragonFruit.png', rarity: 'Legendary' },
  { name: 'Acorn',        file: './images/Acorn.png',       display: 'Acorn.png',       rarity: 'Legendary' },
  { name: 'Sunflower',    file: './images/Sunflower.png',   display: 'Sunflower.png',   rarity: 'Legendary' },
  { name: 'Fire Fern',    file: './images/FireFern.png',       display: 'FireFern.png',       rarity: 'Legendary' },

  // ── Mythic ─────────────────────────────────────────────────────────────
  // NOTE: Briar Rose excluded (not obtainable in GAG2, no image present).
  { name: 'Venus Fly Trap', file: './images/VenusFlyTrap.png',  display: 'VenusFlyTrap.png',  rarity: 'Mythic' },
  { name: 'Pomegranate',    file: './images/Pomegranate.png', display: 'Pomegranate.png', rarity: 'Mythic' },
  { name: 'Poison Apple',   file: './images/PoisonApple.png', display: 'PoisonApple.png', rarity: 'Mythic' },
  { name: 'Venom Spitter',  file: './images/VenomSpitter.png',  display: 'VenomSpitter.png',  rarity: 'Mythic' },

  // ── Super ──────────────────────────────────────────────────────────────
  { name: 'Moon Bloom',      file: './images/MoonBloom.png',   display: 'MoonBloom.png',   rarity: 'Super' },
  { name: 'Hypno Bloom',     file: './images/HypnoBloom.png',  display: 'HypnoBloom.png',  rarity: 'Super' },
  { name: "Dragon's Breath", file: './images/DragonsBreath.png', display: 'DragonsBreath.png', rarity: 'Super' },
  { name: 'Sun Bloom',       file: './images/SunBloom.png',    display: 'SunBloom.png',    rarity: 'Super' },
  { name: 'Star Fruit',      file: './images/StarFruit.png',      display: 'StarFruit.png',      rarity: 'Super' },

  // ── Secret ─────────────────────────────────────────────────────────────
  // TODO: replace with your actual GAG2 secret plant name + image once decided
  { name: 'Eclipse Bloom', file: './images/EclipseBloom.png', display: 'EclipseBloom.png', rarity: 'Secret', dropOnly: true },
];


const processedMessages = new Set(); const claimingDaily = new Set(); const claimingWeekly = new Set();

// ─── Per-user async queue ─────────────────────────────────────────────────────
const userQueues = {};

function queueForUser(userId, fn) {
  if (!userQueues[userId]) userQueues[userId] = Promise.resolve();
  const result = userQueues[userId].then(() => fn());
  userQueues[userId] = result.catch(() => {});
  return result;
}

// ─── State ────────────────────────────────────────────────────────────────────
let activeDrops  = {};
let activeRaces  = {};
let pendingSells = {};
let pendingWipes = {};
let pendingCrates ={};
let devRarity = null; const versionLocks = new Set();

// ─── DB / Meta ────────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE))  fs.writeFileSync(DB_FILE, '{}');
  return JSON.parse(fs.readFileSync(DB_FILE));
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function loadMeta() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify({ plantVersions: {}, totalDrops: 0 }));
  return JSON.parse(fs.readFileSync(META_FILE));
}
function saveMeta(m) { fs.writeFileSync(META_FILE, JSON.stringify(m, null, 2)); }

function loadLocks(userId) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCKS_FILE)) fs.writeFileSync(LOCKS_FILE, '{}');
  const all = JSON.parse(fs.readFileSync(LOCKS_FILE));
  return all[userId] || [];
}
function saveLocks(userId, locks) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCKS_FILE)) fs.writeFileSync(LOCKS_FILE, '{}');
  const all = JSON.parse(fs.readFileSync(LOCKS_FILE));
  all[userId] = locks;
  fs.writeFileSync(LOCKS_FILE, JSON.stringify(all, null, 2));
}
function isLocked(userId, plant) {
  const locks = loadLocks(userId);
  return locks.some(l => {
    if (l.name && l.name.toLowerCase() !== plant.name.toLowerCase()) return false;
    if (l.version && l.version !== plant.version) return false;
    if (l.mutation && (!plant.mutation || plant.mutation.name.toLowerCase() !== l.mutation.toLowerCase())) return false;
    if (l.rarity && plant.rarity.toLowerCase() !== l.rarity.toLowerCase()) return false;
    return true;
  });
}

function loadClaimsLB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CLAIMS_LB_FILE)) fs.writeFileSync(CLAIMS_LB_FILE, '[]');
  return JSON.parse(fs.readFileSync(CLAIMS_LB_FILE));
}
function saveClaimsLB(lb) { fs.writeFileSync(CLAIMS_LB_FILE, JSON.stringify(lb, null, 2)); }

function recordClaim(userId, username) {
  const lb  = loadClaimsLB();
  const now = Date.now();
  let entry = lb.find(e => e.userId === userId);
  if (!entry) {
    entry = { userId, username, claims: [] };
    lb.push(entry);
  }
  entry.username = username;
  entry.claims.push(now);
  // Sprint Boost: count twice toward the leaderboard
  const db = loadDB();
  const user = db[userId];
  if (user?.sprintBoost && user.sprintBoost.expiresAt > now) {
    entry.claims.push(now);
  }
  // clean up old claims beyond 1 week
  entry.claims = entry.claims.filter(t => now - t <= 7 * 24 * 60 * 60 * 1000);
  saveClaimsLB(lb);
}

function getClaimsSince(claims, sinceTimestamp) {
  return claims.filter(t => t >= sinceTimestamp).length;
}

function getClaimsInWindow(claims, ms) {
  const now = Date.now();
  return claims.filter(t => now - t <= ms).length;
}

function generateClaimsLBImage(entries, title, subtitle) {
  const W = 520, ROW_H = 56, HEADER_H = 80, FOOTER_H = 32;
  const H = HEADER_H + entries.length * ROW_H + FOOTER_H;
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');

  // Background — deep forest green to black
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#030d06'); bgGrad.addColorStop(1, '#010501');
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);

  // Subtle dot grid
  for (let x = 0; x < W; x += 24) {
    for (let y = 0; y < H; y += 24) {
      ctx.fillStyle = 'rgba(100,220,100,0.025)';
      ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Header background
  const hGrad = ctx.createLinearGradient(0, 0, W, HEADER_H);
  hGrad.addColorStop(0, '#042010'); hGrad.addColorStop(1, '#010a04');
  ctx.fillStyle = hGrad; ctx.fillRect(0, 0, W, HEADER_H);

  // Top accent — animated-looking multi-stop green
  const accent = ctx.createLinearGradient(0, 0, W, 0);
  accent.addColorStop(0,    '#00ff87');
  accent.addColorStop(0.3,  '#00c853');
  accent.addColorStop(0.6,  '#69f0ae');
  accent.addColorStop(1,    '#00ff87');
  ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 4);

  // Glow under accent
  const accentGlow = ctx.createLinearGradient(0, 4, 0, 28);
  accentGlow.addColorStop(0, 'rgba(0,200,80,0.18)'); accentGlow.addColorStop(1, 'rgba(0,200,80,0)');
  ctx.fillStyle = accentGlow; ctx.fillRect(0, 4, W, 24);

  // Header left bar
  ctx.save(); ctx.shadowColor = '#00ff87'; ctx.shadowBlur = 14;
  ctx.fillStyle = '#00ff87'; ctx.fillRect(0, 12, 4, HEADER_H - 24); ctx.restore();

  // Title
  ctx.font = 'bold 24px Arial'; ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(title, 20, HEADER_H / 2 - 10);

  // Subtitle
  ctx.font = '13px Arial'; ctx.fillStyle = 'rgba(100,220,130,0.6)';
  ctx.fillText(subtitle, 20, HEADER_H / 2 + 14);

  // Entry count badge top right
  const badgeTxt = `${entries.length} players`;
  ctx.font = 'bold 12px Arial';
  const badgeW = ctx.measureText(badgeTxt).width + 18;
  ctx.fillStyle = 'rgba(0,200,80,0.15)';
  ctx.beginPath(); ctx.roundRect(W - badgeW - 12, HEADER_H/2 - 14, badgeW, 28, 6); ctx.fill();
  ctx.strokeStyle = 'rgba(0,200,80,0.4)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(W - badgeW - 12, HEADER_H/2 - 14, badgeW, 28, 6); ctx.stroke();
  ctx.fillStyle = '#69f0ae'; ctx.textAlign = 'center';
  ctx.fillText(badgeTxt, W - badgeW/2 - 12, HEADER_H/2);

  const rankColors = ['#FFD700', '#C0C0C0', '#CD7F32'];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const y = HEADER_H + i * ROW_H;
    const mid = y + ROW_H / 2;

    // Row bg alternating
    ctx.fillStyle = i % 2 === 0 ? 'rgba(0,255,100,0.03)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, y, W, ROW_H);

    // Top 3 glow rows
    if (i < 3) {
      const glowCols = ['rgba(255,215,0,0.07)','rgba(192,192,192,0.05)','rgba(205,127,50,0.05)'];
      ctx.fillStyle = glowCols[i]; ctx.fillRect(0, y, W, ROW_H);
      ctx.save();
      ctx.shadowColor = rankColors[i]; ctx.shadowBlur = 12;
      ctx.fillStyle = rankColors[i]; ctx.fillRect(0, y, 4, ROW_H); ctx.restore();
    } else {
      // Subtle green left bar for others
      ctx.fillStyle = 'rgba(0,200,80,0.15)'; ctx.fillRect(0, y, 3, ROW_H);
    }

    // Rank number/medal
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (i < 3) {
      ctx.save(); ctx.font = '22px Arial';
      ctx.fillStyle = rankColors[i]; ctx.shadowColor = rankColors[i]; ctx.shadowBlur = 10;
      ctx.fillText(['🥇','🥈','🥉'][i], 30, mid); ctx.restore();
    } else {
      ctx.font = 'bold 15px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText(`${i+1}`, 30, mid);
    }

    // Username
    ctx.textAlign = 'left';
    ctx.font = i < 3 ? 'bold 17px Arial' : '15px Arial';
    if (e.rainbowTag) {
      drawRainbowText(ctx, e.username, 58, mid);
    } else {
      ctx.fillStyle = i < 3 ? '#ffffff' : 'rgba(255,255,255,0.78)';
      ctx.fillText(e.username, 58, mid);
    }

    // Count pill — right side
    const countTxt = `${e.count} claims`;
    ctx.font = 'bold 13px Arial';
    const pillW = ctx.measureText(countTxt).width + 20;
    const pillX = W - pillW - 16, pillY = mid - 13;
    const pillColor = i === 0 ? 'rgba(0,255,135,0.18)' : 'rgba(0,180,80,0.10)';
    ctx.fillStyle = pillColor;
    ctx.beginPath(); ctx.roundRect(pillX, pillY, pillW, 26, 6); ctx.fill();
    ctx.strokeStyle = i === 0 ? 'rgba(0,255,135,0.5)' : 'rgba(0,180,80,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(pillX, pillY, pillW, 26, 6); ctx.stroke();
    ctx.fillStyle = i === 0 ? '#00ff87' : '#69f0ae';
    ctx.textAlign = 'center';
    if (i === 0) { ctx.save(); ctx.shadowColor = '#00ff87'; ctx.shadowBlur = 8; }
    ctx.fillText(countTxt, pillX + pillW / 2, mid);
    if (i === 0) ctx.restore();

    // Bar under username showing relative rank
    const barX = 58, barW = W - 58 - pillW - 32, barH = 3, barY = mid + 14;
    const relPct = entries[0].count > 0 ? e.count / entries[0].count : 0;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 2); ctx.fill();
    const barGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    barGrad.addColorStop(0, '#00c853'); barGrad.addColorStop(1, '#69f0ae');
    ctx.fillStyle = barGrad;
    ctx.beginPath(); ctx.roundRect(barX, barY, Math.max(barW * relPct, 4), barH, 2); ctx.fill();

    // Row divider
    ctx.strokeStyle = 'rgba(0,255,100,0.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(16, y + ROW_H); ctx.lineTo(W - 16, y + ROW_H); ctx.stroke();
  }

  // Footer
  ctx.strokeStyle = 'rgba(0,255,100,0.08)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H - FOOTER_H); ctx.lineTo(W, H - FOOTER_H); ctx.stroke();
  ctx.font = '11px Arial'; ctx.fillStyle = 'rgba(100,220,130,0.3)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`${SERVER_NAME}  ·  ${subtitle}`, W / 2, H - FOOTER_H / 2);
  drawWatermark(ctx, W, H);

  return canvas.toBuffer('image/png');
}

function loadRaceLB() {
  if (!fs.existsSync(RACE_LB_FILE)) fs.writeFileSync(RACE_LB_FILE, '[]');
  return JSON.parse(fs.readFileSync(RACE_LB_FILE));
}
function saveRaceLB(lb) { fs.writeFileSync(RACE_LB_FILE, JSON.stringify(lb, null, 2)); }

function getUser(db, userId) {
  if (!db[userId]) db[userId] = {};
  const u = db[userId];
  if (!u.collection)     u.collection     = [];
  if (!u.claimed)        u.claimed        = 0;
  if (!u.currency)       u.currency       = 500;
  if (!u.charms)         u.charms         = [];
  if (!u.equippedCharms) u.equippedCharms = [];
  if (!u.bestRaceTime)   u.bestRaceTime   = null;
  if (!u.raceWins)       u.raceWins       = 0;
  if (!u.lastDaily)      u.lastDaily      = null;
  if (!u.lastWeekly)     u.lastWeekly     = null;
  if (!u.xp)             u.xp             = 0;
  if (!u.achievements)   u.achievements   = [];
  if (!u.titles)         u.titles         = [];
  if (!u.activeTitle)    u.activeTitle    = null;
  if (!u.cratesOpened)   u.cratesOpened   = 0;
  if (!u.claimStreak)    u.claimStreak    = 0;
  if (!u.lastClaimDrop)  u.lastClaimDrop  = null;
  if (!u.claimCooldowns) u.claimCooldowns = {};
  if (!u.lastActivity)   u.lastActivity   = Date.now();
  if (u.decayWarned === undefined) u.decayWarned = false;
  if (!u.cratePity)      u.cratePity      = {};
  return u;
}

// Touch lastActivity whenever a user does ANYTHING with the bot
function touchActivity(db, userId, member) {
  const u = getUser(db, userId);
  u.lastActivity = Date.now();
  u.decayWarned  = false;
  if (member) {
    u.username  = member.username;
    u.avatarUrl = member.displayAvatarURL({ extension: 'png', size: 128 });
  }
}

async function resolveTarget(message, argIdOrMention) {
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned;
  if (argIdOrMention && /^\d{17,20}$/.test(argIdOrMention)) {
    try { return await client.users.fetch(argIdOrMention); } catch {}
  }
  return null;
}

// ─── XP helper ────────────────────────────────────────────────────────────────
function addXP(db, userId, amount) {
  const u = getUser(db, userId);
  const before = getLevelFromXP(u.xp);
  const boosted = u.xpBoost && u.xpBoost.expiresAt > Date.now();
  u.xp += boosted ? amount * 2 : amount;
  const after = getLevelFromXP(u.xp);
  return after > before ? after : null;
}

// ─── Achievement checker ──────────────────────────────────────────────────────
function checkAchievements(user) {
  const newOnes = [];
  for (const [key, ach] of Object.entries(ACHIEVEMENTS)) {
    if (!user.achievements.includes(key) && ach.check(user)) {
      user.achievements.push(key);
      if (!user.titles.includes(key)) user.titles.push(key);
      newOnes.push(key);
    }
  }
  return newOnes;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function randomCaptcha(len = 6) {
  const chars = 'ABCDEFGHJKLMNPRSTUVWY';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function pickRarity(customWeights) {
  const weights = customWeights || Object.fromEntries(RARITIES.map(r => [r.name, r.weight]));
  const total   = Object.values(weights).reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (const r of RARITIES) { roll -= (weights[r.name] || 0); if (roll <= 0) return r; }
  return RARITIES[0];
}
function pickRarityWithCharms(db, userId, customWeights) {
  const base    = customWeights || Object.fromEntries(RARITIES.map(r => [r.name, r.weight]));
  const user    = getUser(db, userId);
  const weights = { ...base };
  for (const k of (user.equippedCharms || [])) {
    const c = CHARMS[k]; if (!c) continue;
    for (const [rn, mult] of Object.entries(c.multipliers)) {
      if (weights[rn] !== undefined) weights[rn] = Math.round(weights[rn] * mult);
    }
  }
  return pickRarity(weights);
}
function pickPlant(rarityName, allowDropOnly = false) {
  const pool = PLANTS.filter(p => p.rarity === rarityName && (allowDropOnly || !p.dropOnly));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : PLANTS[0];
}
function getRarityConfig(name) { return RARITIES.find(r => r.name === name) || RARITIES[0]; }
function fmt(amount) { return `${CURRENCY_EMOJI} **${Number(amount).toLocaleString()} ${CURRENCY_NAME}**`; }
function msToStr(ms) { return ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(2)}s`; }
function medal(i) { return ['🥇','🥈','🥉','4️⃣','5️⃣'][i] || `${i+1}.`; }

async function ephemeralReply(message, text) {
  message.delete().catch(() => {});
  const errMsg = await message.channel.send(`<@${message.author.id}> ${text}`);
  setTimeout(() => errMsg.delete().catch(() => {}), 4000);
}

function ansiColor(text, color) {
  const codes = { red:31, green:32, yellow:33, blue:34, magenta:35, cyan:36, white:37, gray:90, orange:33 };
  return `\u001b[${codes[color]||37}m${text}\u001b[0m`;
}
function ansiBlock(s) { return `\`\`\`ansi\n${s}\n\`\`\``; }
function rarityAnsiColor(name) {
  return { Common:'gray', Uncommon:'green', Rare:'cyan', Epic:'magenta', Legendary:'yellow', Mythic:'red', Super:'blue', Secret:'white' }[name] || 'white';
}
function mutationAnsiColor(name) {
  return { Eclipsed:'magenta', Ignited:'orange', Bloodlit:'red', Glow:'green', Starstruck:'yellow', Electric:'cyan', Frozen:'blue', Aurora:'white' }[name] || 'white';
}
function rarityAnsiEmoji(name) {
  return RARITY_EMOJIS[name] || '▫';
}

function getActiveTitle(user) {
  if (!user.activeTitle) return null;
  const ach = ACHIEVEMENTS[user.activeTitle];
  if (ach) return `${ach.emoji} ${ach.title}`;
  const st = SHOP_TITLES[user.activeTitle];
  if (st) return `${st.emoji} ${st.name}`;
  return null;
}

// ─── Version system ───────────────────────────────────────────────────────────
function getAvailableVersionFromMeta(plantName, db, meta) {
  if (!meta.plantVersions) meta.plantVersions = {};

  const high = meta.plantVersions[plantName] || 0;

  // "owned" is computed fresh every time from what actually currently exists —
  // collections, auctions, listings. This is the ONLY source of truth for which
  // versions are taken. (Previously meta.plantClaimed permanently remembered every
  // version ever handed out and never cleared it, even after a card was sold,
  // discarded, or otherwise removed — which meant discarded low versions could
  // never be re-dropped and the pool just kept growing new max versions forever.)
  const owned = new Set();
  for (const userData of Object.values(db)) {
    for (const p of (userData.collection || [])) {
      if (p.name === plantName && p.version) owned.add(p.version);
    }
  }
  for (const auction of loadAuctions()) {
    if (auction.plant.name === plantName && auction.plant.version) owned.add(auction.plant.version);
  }
  for (const listing of loadListings()) {
    if (listing.plant.name === plantName && listing.plant.version) owned.add(listing.plant.version);
  }

  const free = [];
  for (let v = 1; v <= high; v++) { if (!owned.has(v) && !versionLocks.has(`${plantName}:${v}`)) free.push(v); }

  let ver;
  if (free.length > 0) {
    // Prioritize the lowest available version — if a low version was freed up
    // (discarded/sold/etc.) it should be the next one to drop, not a random pick.
    free.sort((a, b) => a - b);
    ver = free[0];
  } else {
    ver = high + 1;
    meta.plantVersions[plantName] = ver;
    meta.totalDrops = (meta.totalDrops || 0) + 1;
  }
  const lockKey = `${plantName}:${ver}`; versionLocks.add(lockKey); setTimeout(() => versionLocks.delete(lockKey), 10000);
  return ver;
}

function getAvailableVersion(plantName, db) {
  const meta = loadMeta();
  const ver  = getAvailableVersionFromMeta(plantName, db, meta);
  saveMeta(meta);
  return ver;
}

function recordVersionHighWater(plantName, version) {
  const meta = loadMeta();
  if (!meta.plantVersions) meta.plantVersions = {};
  if ((meta.plantVersions[plantName] || 0) < version) {
    meta.plantVersions[plantName] = version;
    meta.totalDrops = (meta.totalDrops || 0) + 1;
    saveMeta(meta);
  }
}

// ─── Inventory value calculator (legacy, used for display only) ───────────────
function getLiveSellValue(storedPlant) {
  const plantDef = PLANTS.find(p => p.name === storedPlant.name) || { name: storedPlant.name, dropOnly: false };
  const rarity   = getRarityConfig(storedPlant.rarity);
  const mutDef   = storedPlant.mutation
    ? MUTATIONS.find(m => m.name === storedPlant.mutation.name) || storedPlant.mutation
    : null;
  return calcSellValue(plantDef, rarity, mutDef, storedPlant.version || 1);
}

function calcInventoryValue(collection) {
  return collection.reduce((sum, p) => sum + getLiveSellValue(p), 0);
}

// ─── Mutation display ─────────────────────────────────────────────────────────
function mutationDisplay(rarity, mutation, claimLine) {
  const rCol   = rarityAnsiColor(rarity.name);
  const mCol   = mutation ? mutationAnsiColor(mutation.name) : null;
  // No emoji here — custom emoji tags don't render inside ```ansi``` code blocks,
  // they just show up as broken raw text (e.g. "<:legendary:123...>"). The rarity
  // emoji is already shown correctly in the embed title, so it doesn't need to be
  // repeated (and broken) here.
  let line = ansiColor(rarity.name.toUpperCase(), rCol);
  if (mutation) line += ansiColor(`  ·  ${mutation.name.toUpperCase()}`, mCol);
  if (claimLine) line += `\n${ansiColor(claimLine, 'gray')}`;
  return ansiBlock(line);
}

// ─── Combined plant + captcha image ──────────────────────────────────────────
async function generateDropImage(plant, captcha, rarityColor, weather) {
  const W = 400, H = 400, CAPTCHA_H = 52;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, W, H);
  try {
    const img = await loadImage(plant.file);
    const scale = Math.max(W / img.width, H / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } catch {
    ctx.fillStyle = '#1a2332'; ctx.fillRect(0, 0, W, H);
    ctx.font = '22px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(plant.name, W / 2, H / 2);
  }

  const barY = H - CAPTCHA_H;
  const fade = ctx.createLinearGradient(0, barY - 20, 0, barY + 4);
  fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,0.82)');
  ctx.fillStyle = fade; ctx.fillRect(0, barY - 20, W, 24);
  const rr = (rarityColor >> 16) & 0xFF, rg = (rarityColor >> 8) & 0xFF, rb = rarityColor & 0xFF;
  ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillRect(0, barY, W, CAPTCHA_H);
  ctx.fillStyle = `rgba(${rr},${rg},${rb},0.18)`; ctx.fillRect(0, barY, W, CAPTCHA_H);
  ctx.strokeStyle = `rgba(${rr},${rg},${rb},0.9)`; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, barY + 0.75); ctx.lineTo(W, barY + 0.75); ctx.stroke();
  for (let i = 0; i < 4; i++) {
    ctx.strokeStyle = `rgba(255,255,255,${0.03 + Math.random() * 0.04})`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.random() * W, barY + Math.random() * CAPTCHA_H); ctx.lineTo(Math.random() * W, barY + Math.random() * CAPTCHA_H); ctx.stroke();
  }
  const colors = getRarityColorPalette(rarityColor);
  const letters = captcha.split('');
  const CHAR_W = 48, startX = (W - letters.length * CHAR_W) / 2 + CHAR_W * 0.35, midY = barY + CAPTCHA_H / 2;
  letters.forEach((char, i) => {
    ctx.save(); ctx.font = 'bold 30px Arial'; ctx.fillStyle = colors[i % colors.length];
    ctx.shadowColor = 'rgba(0,0,0,1)'; ctx.shadowBlur = 7; ctx.textBaseline = 'middle';
    ctx.translate(startX + i * CHAR_W, midY + Math.floor(Math.random() * 5) - 2);
    ctx.rotate((Math.random() - 0.5) * 0.2); ctx.fillText(char, 0, 0); ctx.restore();
  });
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`; ctx.beginPath();
    ctx.arc(Math.random() * W, barY + Math.random() * CAPTCHA_H, Math.random() * 2, 0, Math.PI * 2); ctx.fill();
  }
  return canvas.toBuffer('image/png');
}

function generateWeatherImage(weather) {
  const W = 500, H = 220;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const r = (weather.color >> 16) & 0xFF, g = (weather.color >> 8) & 0xFF, b = weather.color & 0xFF;
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, `rgba(${r},${g},${b},0.55)`);
  bgGrad.addColorStop(1, '#05060a');
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);
  // Weather-flavored particles
  if (weather.name === 'Bloodlit') {
    for (let i = 0; i < 60; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${0.1 + Math.random() * 0.2})`;
      const x = Math.random() * W, y = Math.random() * H;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 6, y + 16); ctx.stroke();
    }
  } else if (weather.name === 'Frozen') {
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.25})`;
      ctx.beginPath(); ctx.arc(Math.random() * W, Math.random() * H, Math.random() * 2 + 1, 0, Math.PI * 2); ctx.fill();
    }
  } else if (weather.name === 'Ignited') {
    for (let i = 0; i < 10; i++) {
      ctx.strokeStyle = `rgba(255,150,0,${0.1 + Math.random() * 0.15})`;
      ctx.lineWidth = 2;
      const x = Math.random() * W;
      ctx.beginPath(); ctx.moveTo(x, H); ctx.quadraticCurveTo(x + 20, H / 2, x, 0); ctx.stroke();
    }
  } else if (weather.name === 'Electric') {
    for (let i = 0; i < 12; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${0.1 + Math.random() * 0.15})`;
      ctx.lineWidth = 2;
      const y = Math.random() * H;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(W * 0.3, y - 15, W * 0.6, y + 15, W, y); ctx.stroke();
    }
  } else if (weather.name === 'Aurora') {
    for (let i = 0; i < 3; i++) {
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, 'rgba(0,255,200,0)');
      grad.addColorStop(0.5, `rgba(${r},${g},${b},0.35)`);
      grad.addColorStop(1, 'rgba(0,255,200,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 30 + i * 50, W, 24);
    }
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.save();
  ctx.shadowColor = `rgba(${r},${g},${b},0.9)`; ctx.shadowBlur = 18;
  ctx.font = 'bold 34px Arial'; ctx.fillStyle = '#ffffff';
  ctx.fillText(weather.name.toUpperCase(), W / 2, H / 2 - 10);
  ctx.restore();
  ctx.font = '14px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('WEATHER EVENT', W / 2, H / 2 + 24);
  drawWatermark(ctx, W, H);
  return canvas.toBuffer('image/png');
}
async function sendWeatherEvent(channel, forcedWeather = null) {
  const weather = forcedWeather || pickWeather();
  const now = Date.now();
  currentWeather = { ...weather, startedAt: now, endsAt: now + WEATHER_DURATION_MS };
  const imgBuffer = generateWeatherImage(weather);
  const attachment = new AttachmentBuilder(imgBuffer, { name: 'weather.png' });
  const embed = new EmbedBuilder()
    .setTitle(`${weather.emoji} WEATHER EVENT — ${weather.name}`)
    .setDescription(`${weather.desc}\n\n*Drops for the next hour will show this weather is active.*`)
    .setImage('attachment://weather.png')
    .setColor(weather.color)
    .setFooter({ text: `Lasts 30 minutes · ${SERVER_NAME}` })
    .setTimestamp();
  await channel.send({ embeds: [embed], files: [attachment] }).catch(console.error);
}
function startWeatherLoop() {
  setInterval(async () => {
    const allDropChIds = new Set([
      ...Object.values(dropChannels),
      ...Object.values(relaxedDropChannels),
    ]);
    for (const chId of allDropChIds) {
      const ch = client.channels.cache.get(chId);
      if (ch) await sendWeatherEvent(ch).catch(console.error);
    }
  }, WEATHER_INTERVAL_MS);
}


// ─── Activity-based Drop System ───────────────────────────────────────────────
async function tryActivityDrop(channel) {
  const now = Date.now(), chId = channel.id;
  if ((now - (channelActivity[chId] || 0) <= ACTIVITY_WINDOW) && (now - (lastDropTime[chId] || 0) >= DROP_COOLDOWN) && !activeDrops[chId]) {
    lastDropTime[chId] = now;
    await sendDrop(channel).catch(console.error);
  }
}

// ─── Drop ─────────────────────────────────────────────────────────────────────
async function sendDrop(channel, opts = {}) {
  if (typeof opts === 'string') opts = { rarityName: opts };
  const forcedRarity   = opts.rarityName   || devRarity || null;
  const forcedPlant    = opts.plantName    || null;
  const forcedMutation = opts.mutationName || null;
  let rarity = forcedRarity ? (RARITIES.find(r => r.name.toLowerCase() === forcedRarity.toLowerCase()) || pickRarity()) : pickRarity();
  let plant;
  if (forcedPlant) {
    plant = PLANTS.find(p => p.name.toLowerCase() === forcedPlant.toLowerCase());
    if (!plant) { await channel.send(`❌ Plant **${forcedPlant}** not found.`); return; }
    rarity = getRarityConfig(plant.rarity);
  } else {
    plant = pickPlant(rarity.name, true);
  }
  const activeWeather = getActiveWeather();
  let mutation;
  if (forcedMutation) {
    if (forcedMutation === 'none') mutation = null;
    else { mutation = MUTATIONS.find(m => m.name.toLowerCase() === forcedMutation.toLowerCase()) || null; if (!mutation) { await channel.send(`❌ Mutation **${forcedMutation}** not found.`); return; } }
  } else { mutation = rollMutation(activeWeather ? activeWeather.name : null); }
  const captcha  = randomCaptcha(6);
  const dropTime = Date.now();
  const imgBuffer  = await generateDropImage(plant, captcha, rarity.color, activeWeather);
  const attachment = new AttachmentBuilder(imgBuffer, { name: 'drop.png' });
  const mutSuffix = mutation ? `  ${mutation.emoji} **${mutation.name}**` : '';
  const titleEmoji = activeWeather ? activeWeather.emoji : rarity.emoji;
  const embed = new EmbedBuilder()
    .setTitle(`${titleEmoji} **${plant.name}**${mutSuffix}`)
    .setDescription(mutationDisplay(rarity, mutation, 'Type claim <captcha> to claim!'))
    .setImage('attachment://drop.png')
    .setColor(mutation ? mutation.color : rarity.color)
    .setTimestamp();
  const rarityRoles = {
  Legendary: '1479162308587426004',
  Mythic: '1479162306943520930',
  Secret: '1479162311276232951'
};
const pingContent = rarityRoles[rarity.name] ? `<@&${rarityRoles[rarity.name]}>` : undefined;
const msg = await channel.send({ content: pingContent, embeds: [embed], files: [attachment] });
  activeDrops[channel.id] = { plant, rarity, captcha, mutation, messageId: msg.id, dropTime, claimers: [] };
  setTimeout(() => {
    if (activeDrops[channel.id]?.messageId === msg.id) {
      delete activeDrops[channel.id];
      msg.edit({ content: '❌ Expired — not claimed.', embeds: [], files: [], attachments: [] }).catch(() => {});
    }
  }, 60_000);
}

function startDropLoop() {
  setInterval(async () => {
    const allDropChIds = new Set([
      ...Object.values(dropChannels),
      ...Object.values(relaxedDropChannels),
    ]);
    for (const chId of allDropChIds) {
      const ch = client.channels.cache.get(chId);
      if (ch) await tryActivityDrop(ch).catch(console.error);
    }
  }, 30_000);
}

// ─── Payout Config ────────────────────────────────────────────────────────────
const DAILY_PAYOUTS  = [200000, 135000, 75000];
const WEEKLY_PAYOUTS = [900000, 600000, 350000];

const PAYOUT_FILE = `${DATA_DIR}/payouts.json`;
function loadPayoutState() {
  try {
    if (!fs.existsSync(PAYOUT_FILE)) {
      const initial = { lastDaily: Date.now(), lastWeekly: Date.now() };
      fs.writeFileSync(PAYOUT_FILE, JSON.stringify(initial));
      return initial;
    } 
    return JSON.parse(fs.readFileSync(PAYOUT_FILE));
  } catch {
    const initial = { lastDaily: Date.now(), lastWeekly: Date.now() };
    return initial;
  }
}
function savePayoutState(s) { fs.writeFileSync(PAYOUT_FILE, JSON.stringify(s, null, 2)); }

// ─── Stockholm Midnight Helper ────────────────────────────────────────────────
function getNextMidnight() {
  const now    = new Date();
  const fmtOpts = { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };

  // Current Stockholm offset vs UTC (handles CET/CEST automatically)
  const utcStr = now.toLocaleString('en-GB', { timeZone: 'UTC' });
  const stkStr = now.toLocaleString('en-GB', { timeZone: 'Europe/Stockholm' });
  const offsetMs = new Date(stkStr.replace(',','')) - new Date(utcStr.replace(',',''));

  // Today's date components in Stockholm time
  const parts  = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get    = (t) => parts.find(p => p.type === t).value;

  // "Midnight Stockholm tonight" expressed as a UTC timestamp
  // midnight Stockholm = 00:00 Stockholm = (00:00 UTC minus Stockholm-offset)
  const midnightUTC = Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`) - offsetMs;

  // If tonight's midnight already passed, return tomorrow's
  return midnightUTC > Date.now() ? midnightUTC : midnightUTC + 24 * 60 * 60 * 1000;
}

// ─── Payout Channel Config ────────────────────────────────────────────────────
const PAYOUT_CHANNEL_FILE = `${DATA_DIR}/payout-channels.json`;
function loadPayoutChannels() {
  try {
    if (!fs.existsSync(PAYOUT_CHANNEL_FILE)) return {};
    return JSON.parse(fs.readFileSync(PAYOUT_CHANNEL_FILE));
  } catch { return {}; }
}
function savePayoutChannels(data) { fs.writeFileSync(PAYOUT_CHANNEL_FILE, JSON.stringify(data, null, 2)); }

function startPayoutLoop() {
  const DAY  = 24 * 60 * 60 * 1000;
  const WEEK = 7  * 24 * 60 * 60 * 1000;

  // Initialise timestamps on first boot if missing
  client.once('ready', async () => {
    await new Promise(r => setTimeout(r, 5000));
    const state = loadPayoutState();
    if (!state.dailyEndsAt)  { state.dailyEndsAt  = getNextMidnight(); savePayoutState(state); }
    if (!state.weeklyEndsAt) { state.weeklyEndsAt = getNextMidnight() + 6 * DAY; savePayoutState(state); }
  });

  setInterval(async () => {
    const state = loadPayoutState();
    const now   = Date.now();

    // ── Daily payout ──────────────────────────────────────────────────────
    if (now >= state.dailyEndsAt) {
  state.dailyEndsAt = state.dailyEndsAt + 24 * 60 * 60 * 1000;
  // If still in the past (bot was offline a long time), fast-forward
  while (state.dailyEndsAt <= now) state.dailyEndsAt += 24 * 60 * 60 * 1000;
  savePayoutState(state);

      const lb = loadClaimsLB();
      const top = lb
        .filter(e => !TEST_IDS.has(e.userId))
        .map(e => ({ userId: e.userId, username: e.username, count: getClaimsInWindow(e.claims, DAY) }))
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);

      const db     = loadDB();
      const medals = ['🥇', '🥈', '🥉'];
      const lines  = [];

      for (let i = 0; i < top.length; i++) {
        const entry  = top[i];
        const payout = DAILY_PAYOUTS[i];
        getUser(db, entry.userId).currency += payout;
        lines.push(
          `${medals[i]} **#${i + 1}** — <@${entry.userId}> ` +
          `· **${entry.count} claims** · +${CURRENCY_EMOJI} **${payout.toLocaleString()}**`
        );
      }
      if (top.length) saveDB(db);

      const embed = new EmbedBuilder()
        .setTitle('🌱 Daily Cycle Complete!')
        .setDescription(
          top.length
            ? `The **daily cycle** has ended. Coins have been paid out:\n\n${lines.join('\n')}`
            : `The **daily cycle** ended with no claims — no payouts this round.`
        )
        .setColor(0x00C853)
        .setFooter({ text: `Next reset: midnight Stockholm time · ${SERVER_NAME}` })
        .setTimestamp();

      for (const chId of Object.values(payoutChannels)) {
        const ch = client.channels.cache.get(chId);
        if (ch) await ch.send({ embeds: [embed] }).catch(console.error);
      }
    }

    // ── Weekly payout ─────────────────────────────────────────────────────
    if (now >= state.weeklyEndsAt) {
      state.weeklyEndsAt += WEEK;
      savePayoutState(state);

      const lb = loadClaimsLB();
      const top = lb
        .filter(e => !TEST_IDS.has(e.userId))
        .map(e => ({ userId: e.userId, username: e.username, count: getClaimsInWindow(e.claims, WEEK) }))
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);

      const db     = loadDB();
      const medals = ['🥇', '🥈', '🥉'];
      const lines  = [];

      for (let i = 0; i < top.length; i++) {
        const entry  = top[i];
        const payout = WEEKLY_PAYOUTS[i];
        getUser(db, entry.userId).currency += payout;
        lines.push(
          `${medals[i]} **#${i + 1}** — <@${entry.userId}> ` +
          `· **${entry.count} claims** · +${CURRENCY_EMOJI} **${payout.toLocaleString()}**`
        );
      }
      if (top.length) saveDB(db);

      const embed = new EmbedBuilder()
        .setTitle('🌿 Weekly Cycle Complete!')
        .setDescription(
          top.length
            ? `The **weekly cycle** has ended. Coins have been paid out:\n\n${lines.join('\n')}`
            : `The **weekly cycle** ended with no claims — no payouts this round.`
        )
        .setColor(0x4CAF50)
        .setFooter({ text: `${SERVER_NAME}` })
        .setTimestamp();

      for (const chId of Object.values(payoutChannels)) {
        const ch = client.channels.cache.get(chId);
        if (ch) await ch.send({ embeds: [embed] }).catch(console.error);
      }
    }

  }, 60 * 1000); // check every minute
}

// ─── Decay Loop ───────────────────────────────────────────────────────────────
function startDecayLoop() {
  setInterval(async () => {
    const db  = loadDB();
    const now = Date.now();
    let changed = false;

    for (const [userId, userData] of Object.entries(db)) {
      const u = getUser(db, userId);
      if (!u.collection.length) continue;

      const idle = now - (u.lastActivity || now);

      // 2 days idle → send DM warning once
      if (idle >= DECAY_WARN_MS && !u.decayWarned) {
        u.decayWarned = true;
        changed = true;
        try {
          const discordUser = await client.users.fetch(userId);
          await discordUser.send({
            embeds: [new EmbedBuilder()
              .setTitle('⚠️ Your Garden is Withering!')
              .setDescription(
                `You haven't visited **${SERVER_NAME}** in 2 days.\n\n` +
                `If you don't return within **24 hours**, your plants will begin to **decay** — ` +
                `one random plant (excluding v1–v10) will be removed from your garden **every hour**.\n\n` +
                `Head back to keep your collection safe! 🌱`
              )
              .setColor(0xFF6600)
              .setFooter({ text: 'v1–v10 plants are always safe from decay.' })]
          });
        } catch { /* DMs closed, skip */ }
      }

      // 3+ days idle → decay one plant per hour
      if (idle >= DECAY_START_MS) {
        const lastDecay = u.lastDecayTick || (now - DECAY_START_MS);
        const hoursPassed = Math.floor((now - lastDecay) / DECAY_INTERVAL);
        if (hoursPassed >= 1) {
          // Build pool of decayable plants (v > DECAY_SAFE_VER or no version)
          const pool = u.collection
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => !p.version || p.version > DECAY_SAFE_VER);

          const toRemoveDecay = [];
          for (let h = 0; h < hoursPassed && pool.length > 0; h++) {
            const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
            toRemoveDecay.push(pick.i);
          }
          toRemoveDecay.sort((a, b) => b - a);
          for (const idx of toRemoveDecay) u.collection.splice(idx, 1);
          u.lastDecayTick = lastDecay + hoursPassed * DECAY_INTERVAL;
          changed = true;
        }
      }
    }

    if (changed) saveDB(db);
  }, 15 * 60 * 1000); // check every 15 minutes
}

const PITY_RARITIES = ['Legendary', 'Mythic', 'Super', 'Secret'];

function openCrate(crateKey, db, userId) {
  const crate      = CRATES[crateKey];
  const user       = getUser(db, userId);
  const threshold  = CRATE_PITY_THRESHOLD[crateKey] || 999;
  const dryStreak  = user.cratePity[crateKey] || 0;
  const pityActive = dryStreak >= threshold;

  // Weather only boosts mutation odds on ONE random slot per crate —
  // applying it to every plant would break crate ROI.
  const activeWeather = getActiveWeather();
  const weatherSlot    = activeWeather ? Math.floor(Math.random() * crate.plants) : -1;

  const results = Array.from({ length: crate.plants }, (_, i) => {
    const weatherName = (i === weatherSlot) ? activeWeather.name : null;

    if (pityActive && i === crate.plants - 1) {
      const pityWeights = {};
      for (const r of PITY_RARITIES) pityWeights[r] = crate.weights[r] || 1;
      const rarity   = pickRarity(pityWeights);
      const plant    = pickPlant(rarity.name);
      const mutation = rollMutation(weatherName);
      return { ...plant, rarityConfig: rarity, mutation };
    }
    const rarity   = pickRarityWithCharms(db, userId, crate.weights);
    const plant    = pickPlant(rarity.name);
    const mutation = rollMutation(weatherName);
    return { ...plant, rarityConfig: rarity, mutation };
  });

  const hitLegendaryPlus = results.some(r => PITY_RARITIES.includes(r.rarityConfig.name));
  user.cratePity[crateKey] = hitLegendaryPlus ? 0 : dryStreak + 1;

  return results;
}
function shadeColor(hexColor, percent) {
  let r = (hexColor >> 16) & 0xFF;
  let g = (hexColor >> 8) & 0xFF;
  let b = hexColor & 0xFF;
  r = Math.min(255, Math.max(0, Math.round(r + (percent < 0 ? r : 255 - r) * percent)));
  g = Math.min(255, Math.max(0, Math.round(g + (percent < 0 ? g : 255 - g) * percent)));
  b = Math.min(255, Math.max(0, Math.round(b + (percent < 0 ? b : 255 - b) * percent)));
  return `rgb(${r},${g},${b})`;
}

function getRarityColorPalette(rarityColor) {
  return [
    shadeColor(rarityColor, 0.35),
    shadeColor(rarityColor, 0.0),
    shadeColor(rarityColor, -0.25),
    shadeColor(rarityColor, 0.55),
    shadeColor(rarityColor, -0.4),
    shadeColor(rarityColor, 0.15),
  ];
}

// ─── Shared canvas helpers ────────────────────────────────────────────────────
function drawWatermark(ctx, W, H) {
  ctx.save(); ctx.font = 'bold 11px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText(WATERMARK, W - 8, H - 4); ctx.restore();
}

function drawRowGlow(ctx, y, rowH, W, rank) {
  const glowColors = ['rgba(255,215,0,0.10)','rgba(192,192,192,0.07)','rgba(205,127,50,0.07)'];
  if (rank >= 3) return;
  const grad = ctx.createLinearGradient(0, y, 0, y + rowH);
  grad.addColorStop(0, glowColors[rank].replace('0.1','0.0').replace('0.07','0.0'));
  grad.addColorStop(0.3, glowColors[rank]); grad.addColorStop(0.7, glowColors[rank]);
  grad.addColorStop(1, glowColors[rank].replace('0.1','0.0').replace('0.07','0.0'));
  ctx.fillStyle = grad; ctx.fillRect(0, y, W, rowH);
  const rankHex = ['#FFD700','#C0C0C0','#CD7F32'][rank];
  ctx.save(); ctx.shadowColor = rankHex; ctx.shadowBlur = 12;
  ctx.fillStyle = rankHex; ctx.fillRect(0, y, 4, rowH); ctx.restore();
}

function drawRainbowText(ctx, text, x, y) {
  const colors = ['#ff0000','#ff6600','#ffcc00','#00cc44','#0099ff','#9933ff'];
  const totalW = ctx.measureText(text).width;
  const grad = ctx.createLinearGradient(x, y, x + totalW, y);
  colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
  ctx.save();
  ctx.fillStyle = grad;
  ctx.shadowColor = 'rgba(180,100,255,0.4)';
  ctx.shadowBlur = 6;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawLBFooter(ctx, W, H, PADDING, label) {
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H - PADDING); ctx.lineTo(W, H - PADDING); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.font = '12px Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`${SERVER_NAME}  ·  ${label}`, W / 2, H - PADDING / 2);
  drawWatermark(ctx, W, H);
}

// ─── Inventory Rank Leaderboard Image ─────────────────────────────────────────
async function generateInvLBImage(entries) {
  const W = 600, ROW_H = 64, HEADER_H = 0, FOOTER_H = 36;
  const H = HEADER_H + entries.length * ROW_H + FOOTER_H;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

 // Background
  ctx.fillStyle = '#08080f'; ctx.fillRect(0, 0, W, H);

  // Accent line
  const accentGrad = ctx.createLinearGradient(0, 0, W, 0);
  accentGrad.addColorStop(0, '#FF00FF'); accentGrad.addColorStop(0.33, '#FFD700');
  accentGrad.addColorStop(0.66, '#00BFFF'); accentGrad.addColorStop(1, '#FF00FF');
  ctx.fillStyle = accentGrad; ctx.fillRect(0, 0, W, 3);

  for (let i = 0; i < entries.length; i++) {
    const e   = entries[i];
    const y   = HEADER_H + i * ROW_H;
    const mid = y + ROW_H / 2;
    const tierHex = '#' + e.tier.color.toString(16).padStart(6, '0');

    // Alternating row bg
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.1)';
    ctx.fillRect(0, y, W, ROW_H);

    // Top 3 glow
    if (i < 3) {
      const glowCols = ['rgba(255,215,0,0.08)','rgba(192,192,192,0.06)','rgba(205,127,50,0.06)'];
      ctx.fillStyle = glowCols[i]; ctx.fillRect(0, y, W, ROW_H);
    }

    // Tier-colored left bar
    ctx.save();
    const barCol = i < 3 ? ['#FFD700','#C0C0C0','#CD7F32'][i] : tierHex;
    ctx.shadowColor = barCol; ctx.shadowBlur = 14;
    ctx.fillStyle = barCol;
    ctx.fillRect(0, y, 4, ROW_H);
    ctx.restore();

    // Rank number circle
    const rankX = 44, rankR = 16;
    ctx.save();
    ctx.beginPath(); ctx.arc(rankX, mid, rankR, 0, Math.PI * 2);
    ctx.fillStyle = i < 3
      ? ['rgba(255,215,0,0.15)','rgba(192,192,192,0.12)','rgba(205,127,50,0.12)'][i]
      : 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.strokeStyle = i < 3 ? ['#FFD700','#C0C0C0','#CD7F32'][i] : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = i < 3 ? 2 : 1;
    ctx.stroke();
    ctx.font = i < 3 ? 'bold 15px Arial' : 'bold 13px Arial';
    ctx.fillStyle = i < 3 ? ['#FFD700','#C0C0C0','#CD7F32'][i] : 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`${i + 1}`, rankX, mid);
    ctx.restore();

    // Avatar circle
    const avatarX = 92, avatarR = 22;
    ctx.save();
    ctx.beginPath(); ctx.arc(avatarX, mid, avatarR, 0, Math.PI * 2); ctx.clip();
    let avatarDrawn = false;
    if (e.avatarURL) {
      try {
        const buf = await fetchImageBuffer(e.avatarURL);
        const img = await loadImage(buf);
        ctx.drawImage(img, avatarX - avatarR, mid - avatarR, avatarR * 2, avatarR * 2);
        avatarDrawn = true;
      } catch {}
    }
    if (!avatarDrawn) {
      // Fallback: colored circle with initial
      ctx.fillStyle = tierHex;
      ctx.fillRect(avatarX - avatarR, mid - avatarR, avatarR * 2, avatarR * 2);
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 18px Arial';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((e.username[0] || '?').toUpperCase(), avatarX, mid);
    }
    ctx.restore();

    // Avatar ring
    ctx.save();
    ctx.beginPath(); ctx.arc(avatarX, mid, avatarR + 2, 0, Math.PI * 2);
    ctx.strokeStyle = i < 3 ? ['#FFD700','#C0C0C0','#CD7F32'][i] : tierHex;
    ctx.lineWidth = i < 3 ? 2.5 : 1.5;
    if (i < 3) { ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 10; }
    ctx.stroke();
    ctx.restore();

    // Username
    ctx.font = i < 3 ? 'bold 17px Arial' : '16px Arial';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    if (e.rainbowTag) {
      drawRainbowText(ctx, e.username, 130, mid - 8);
    } else {
      ctx.fillStyle = i < 3 ? '#ffffff' : 'rgba(255,255,255,0.8)';
      ctx.fillText(e.username, 130, mid - 8);
    }

    // Tier name
    ctx.font = '12px Arial'; ctx.fillStyle = tierHex;
    ctx.fillText(e.tier.name.toUpperCase(), 130, mid + 10);

    // Score
    ctx.textAlign = 'right';
    ctx.font = 'bold 18px Arial';
    ctx.fillStyle = i === 0 ? tierHex : 'rgba(255,255,255,0.75)';
    ctx.save();
    if (i === 0) { ctx.shadowColor = tierHex; ctx.shadowBlur = 12; }
    ctx.fillText(e.score.toLocaleString(), W - 16, mid - 8);
    ctx.restore();

    ctx.font = '11px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillText(`${e.plantCount} plants`, W - 16, mid + 10);
    ctx.textAlign = 'left';

    // Divider
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(16, y + ROW_H); ctx.lineTo(W - 16, y + ROW_H); ctx.stroke();
  }

  // Footer
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H - FOOTER_H); ctx.lineTo(W, H - FOOTER_H); ctx.stroke();
  ctx.font = '12px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`${SERVER_NAME}  ·  Garden Leaderboard  ·  Top ${entries.length}`, W / 2, H - FOOTER_H / 2);
  drawWatermark(ctx, W, H);

  return canvas.toBuffer('image/png');
}

// ─── Level Leaderboard Image ──────────────────────────────────────────────────
async function generateLevelLBImage(entries) {
  const W = 520, ROW_H = 52, HEADER_H = 64, PADDING = 24;
  const H = HEADER_H + entries.length * ROW_H + PADDING;
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0f1a'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
  for (let i = 0; i <= entries.length; i++) { const y = HEADER_H + i * ROW_H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const grad = ctx.createLinearGradient(0, 0, W, 0); grad.addColorStop(0, '#1a237e'); grad.addColorStop(1, '#0b0f1a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, HEADER_H);
  ctx.fillStyle = '#5C6BC0'; ctx.fillRect(0, 0, 4, HEADER_H);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 22px Arial'; ctx.textBaseline = 'middle'; ctx.fillText('⭐  Level Leaderboard', 24, HEADER_H / 2);
  const rankColors = ['#FFD700', '#C0C0C0', '#CD7F32'];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], y = HEADER_H + i * ROW_H, mid = y + ROW_H / 2;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0)'; ctx.fillRect(0, y, W, ROW_H);
    if (i < 3) drawRowGlow(ctx, y, ROW_H, W, i);
    ctx.textAlign = 'center';
    if (i < 3) { ctx.save(); ctx.font = '22px Arial'; ctx.fillStyle = rankColors[i]; ctx.shadowColor = rankColors[i]; ctx.shadowBlur = 8; ctx.fillText(['🥇','🥈','🥉'][i], 30, mid); ctx.restore(); }
    else { ctx.font = 'bold 16px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fillText(`${i+1}`, 30, mid); }
    ctx.font = '18px Arial'; ctx.textAlign = 'left'; ctx.fillText(e.rankEmoji, 54, mid - 1);
    ctx.font = 'bold 16px Arial';
    if (e.rainbowTag) {
      drawRainbowText(ctx, e.username, 80, mid);
    } else {
      ctx.fillStyle = i < 3 ? '#ffffff' : 'rgba(255,255,255,0.85)'; ctx.fillText(e.username, 80, mid);
    }
    ctx.font = 'bold 14px Arial'; ctx.fillStyle = '#7986CB'; ctx.fillText(`Lv. ${e.level}`, W - 170, mid);
    const barX = W - 120, barW = 90, barH = 8, barY = mid - barH / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 4); ctx.fill();
    const barGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    barGrad.addColorStop(0, '#5C6BC0'); barGrad.addColorStop(1, '#9575CD');
    ctx.fillStyle = barGrad; ctx.beginPath(); ctx.roundRect(barX, barY, Math.max(barW * (e.pct/100), 4), barH, 4); ctx.fill();
  }
  ctx.textBaseline = 'middle'; drawLBFooter(ctx, W, H, PADDING, `Top ${entries.length} Players`);
  return canvas.toBuffer('image/png');
}

async function buildLevelLBData(db, page = 1) {
  const PER_PAGE = 10;
  const now = Date.now();
  const sorted   = Object.entries(db).map(([id, u]) => ({ id, xp: u.xp || 0 })).sort((a, b) => b.xp - a.xp);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const slice      = sorted.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const entries    = await Promise.all(slice.map(async (e, i) => {
    const globalRank = (page - 1) * PER_PAGE + i + 1;
    const level = getLevelFromXP(e.xp); const rank = getRank(level); const { pct } = xpToNextLevel(e.xp);
    let username = `User#${e.id.slice(-4)}`;
    try { const u = await client.users.fetch(e.id); username = u.username; } catch {}
    const rainbowTag = !!(db[e.id]?.rainbowTag && db[e.id].rainbowTag.expiresAt > now);
    return { globalRank, username, level, rankEmoji: rank.emoji, rankName: rank.name, xp: e.xp, pct, rainbowTag };
  }));
  return { entries, totalPages };
}

async function generateProfileImage(data) {
  const W = 580, H = 310;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'middle';

  // Background
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, W, H);
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, 'rgba(77,150,255,0.07)');
  bgGrad.addColorStop(1, 'rgba(123,47,190,0.04)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Top accent bar
  const topBar = ctx.createLinearGradient(0, 0, W, 0);
  topBar.addColorStop(0, '#4d96ff');
  topBar.addColorStop(1, '#7B2FBE');
  ctx.fillStyle = topBar;
  ctx.fillRect(0, 0, W, 4);

  // Avatar
  const AV = 88, ACX = 64, ACY = 88;
  ctx.save();
  ctx.beginPath();
  ctx.arc(ACX, ACY, AV / 2 + 3, 0, Math.PI * 2);
  ctx.strokeStyle = '#4d96ff';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ACX, ACY, AV / 2, 0, Math.PI * 2);
  ctx.clip();
  try {
    const buf = await fetchImageBuffer(data.avatarUrl);
    const img = await loadImage(buf);
    ctx.drawImage(img, ACX - AV / 2, ACY - AV / 2, AV, AV);
  } catch {
    ctx.fillStyle = '#2a2a4e';
    ctx.fillRect(ACX - AV / 2, ACY - AV / 2, AV, AV);
  }
  ctx.restore();

  // Username
  const TX = ACX + AV / 2 + 20;
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px Arial';
  ctx.textAlign = 'left';
  ctx.fillText(data.username, TX, 36);

  // Title
  if (data.title) {
    const cleanTitle = data.title.replace(/<:[^:]+:\d+>/g, '').trim();
    ctx.fillStyle = '#a78bfa';
    ctx.font = '13px Arial';
    ctx.fillText(cleanTitle, TX, 58);
  }

  // Rank pill
  const pillY = data.title ? 80 : 66;
  const rankTxt = `${data.rankEmoji}  ${data.rankName}  ·  Lv. ${data.level}`;
  ctx.font = 'bold 13px Arial';
  const pillW = ctx.measureText(rankTxt).width + 24;
  ctx.fillStyle = 'rgba(77,150,255,0.20)';
  ctx.beginPath();
  ctx.roundRect(TX, pillY - 13, pillW, 26, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(77,150,255,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(TX, pillY - 13, pillW, 26, 8);
  ctx.stroke();
  ctx.fillStyle = '#4d96ff';
  ctx.fillText(rankTxt, TX + 12, pillY);

  // Garden tier pill with image icon
  const tierPillY = pillY + 32;
  const tierHex = '#' + data.gardenTier.color.toString(16).padStart(6, '0');
  const tierR = parseInt(tierHex.slice(1, 3), 16);
  const tierG = parseInt(tierHex.slice(3, 5), 16);
  const tierB = parseInt(tierHex.slice(5, 7), 16);

  const tierIconMap = {
    Bronze:      './images/tiers/bronze.webp',
    Silver:      './images/tiers/silver.webp',
    Gold:        './images/tiers/gold.webp',
    Platinum:    './images/tiers/platinum.webp',
    Diamond:     './images/tiers/diamond.webp',
    Master:      './images/tiers/master.webp',
    Grandmaster: './images/tiers/grandmaster.webp',
    Secret:      './images/tiers/secret.webp', // TODO: add this image asset — until then it'll just draw no icon (fails silently)
  };

  const ICON_SIZE = 20, ICON_GAP = 6;
  const gardenTxt = `${data.gardenTier.name}  ·  ${data.gardenScore.toLocaleString()} pts`;
  ctx.font = 'bold 13px Arial';
  const gardenPillW = ctx.measureText(gardenTxt).width + ICON_SIZE + ICON_GAP + 28;

  ctx.fillStyle = `rgba(${tierR},${tierG},${tierB},0.15)`;
  ctx.beginPath();
  ctx.roundRect(TX, tierPillY - 13, gardenPillW, 26, 8);
  ctx.fill();
  ctx.strokeStyle = `rgba(${tierR},${tierG},${tierB},0.45)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(TX, tierPillY - 13, gardenPillW, 26, 8);
  ctx.stroke();

  let iconDrawn = false;
  const tierIconPath = tierIconMap[data.gardenTier.name];
  if (tierIconPath) {
    try {
      const tierImg = await loadImage(tierIconPath);
      ctx.drawImage(tierImg, TX + 8, tierPillY - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
      iconDrawn = true;
    } catch {}
  }
  ctx.fillStyle = tierHex;
  ctx.fillText(gardenTxt, TX + 8 + (iconDrawn ? ICON_SIZE + ICON_GAP : 0), tierPillY);

  // XP bar
  const barX = TX, barW = Math.min(W - TX - 24, 300), barH = 9;
  const barY = tierPillY + 20;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 5);
  ctx.fill();
  const xpGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  xpGrad.addColorStop(0, '#4d96ff');
  xpGrad.addColorStop(1, '#a78bfa');
  ctx.fillStyle = xpGrad;
  ctx.beginPath();
  ctx.roundRect(barX, barY, Math.max(barW * (data.pct / 100), 8), barH, 5);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.font = '12px Arial';
  ctx.fillText(`${data.pct}% to next level`, barX, barY + barH + 13);

  // Divider
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(20, 192);
  ctx.lineTo(W - 20, 192);
  ctx.stroke();

  // Stats
  const stats = [
    { icon: '💰', label: 'Balance', value: data.balance.toLocaleString() },
    { icon: '🌱', label: 'Plants',  value: String(data.plants) },
    { icon: '🏅', label: 'Achiev.', value: `${data.achievements}/${data.totalAchievements}` },
  ];
  const PILL_W = (W - 48) / 3, PILL_H = 58, PILL_Y = 204;
  stats.forEach((s, i) => {
    const px = 16 + i * (PILL_W + 8);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.roundRect(px, PILL_Y, PILL_W, PILL_H, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(px, PILL_Y, PILL_W, PILL_H, 10);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.40)';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(s.label, px + PILL_W / 2, PILL_Y + 16);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Arial';
    ctx.fillText(`${s.icon} ${s.value}`, px + PILL_W / 2, PILL_Y + 40);
    ctx.textAlign = 'left';
  });

  // Equipped charms
  if (data.equippedCharms.length) {
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '12px Arial';
    ctx.fillText('Equipped', W - 16, ACY - 22);
    ctx.font = '24px Arial';
    ctx.fillText(data.equippedCharms.join('  '), W - 16, ACY + 6);
    ctx.textAlign = 'left';
  }

  // Server rank + total XP
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.font = '12px Arial';
  ctx.fillText(`Total XP: ${data.totalXp.toLocaleString()}`, W - 16, 148);
  if (data.serverRank <= 3) {
    const gc = ['#FFD700', '#C0C0C0', '#CD7F32'][data.serverRank - 1];
    ctx.save();
    ctx.shadowColor = gc;
    ctx.shadowBlur = 8;
    ctx.fillStyle = gc;
    ctx.font = 'bold 12px Arial';
    ctx.fillText(`Server Rank: #${data.serverRank} of ${data.serverTotal}`, W - 16, 166);
    ctx.restore();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.font = '12px Arial';
    ctx.fillText(`Server Rank: #${data.serverRank} of ${data.serverTotal}`, W - 16, 166);
  }
  ctx.textAlign = 'left';

  drawWatermark(ctx, W, H);
  return canvas.toBuffer('image/png');
}

// ─── Level Card Image ─────────────────────────────────────────────────────────
async function generateLevelCardImage(data) {
  // ── Layout constants ────────────────────────────────────────────────────────
  const W = 700, H = 260;
  const PAD = 28;             // outer horizontal padding
  const AV  = 110;            // avatar diameter
  const AV_CX = PAD + AV / 2; // avatar centre x
  const AV_CY = H / 2;        // avatar centre y (vertically centred)
  const TX = PAD + AV + 24;   // text column x start
  const RX = W - PAD;         // right-flush x

  // ── Fixed vertical rhythm (no dynamic shifts) ───────────────────────────────
  const Y_TITLE    = 36;   // title line          (skipped if no title)
  const Y_NAME     = data.title ? 62  : 48;   // username
  const Y_PILL     = data.title ? 94  : 80;   // rank pill centre
  const Y_BAR      = data.title ? 124 : 110;  // XP bar top
  const BAR_H      = 14;
  const Y_XP_LABEL = Y_BAR + BAR_H + 18;      // "x / y XP (z%)"
  const Y_STATS    = Y_XP_LABEL + 36;         // stat labels row

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // ── Background ───────────────────────────────────────────────────────────────
  ctx.fillStyle = '#07090f';
  ctx.fillRect(0, 0, W, H);

  // deep diagonal gradient overlay
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, 'rgba(60,40,120,0.55)');
  bgGrad.addColorStop(0.5, 'rgba(20,30,80,0.30)');
  bgGrad.addColorStop(1, 'rgba(10,10,30,0.10)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // subtle noise dots
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.025 + 0.005})`;
    ctx.beginPath();
    ctx.arc(Math.random() * W, Math.random() * H, Math.random() * 1.5 + 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // faint diagonal lines (depth texture)
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.018)';
  ctx.lineWidth = 1;
  for (let x = -H; x < W + H; x += 28) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + H, H); ctx.stroke();
  }
  ctx.restore();

  // ── Top accent bar ────────────────────────────────────────────────────────────
  const accentGrad = ctx.createLinearGradient(0, 0, W, 0);
  accentGrad.addColorStop(0,   '#7C4DFF');
  accentGrad.addColorStop(0.4, '#448AFF');
  accentGrad.addColorStop(0.7, '#00BCD4');
  accentGrad.addColorStop(1,   '#7C4DFF');
  ctx.fillStyle = accentGrad;
  ctx.fillRect(0, 0, W, 5);

  // soft glow under accent bar
  const accentGlow = ctx.createLinearGradient(0, 5, 0, 40);
  accentGlow.addColorStop(0, 'rgba(100,80,255,0.22)');
  accentGlow.addColorStop(1, 'rgba(100,80,255,0)');
  ctx.fillStyle = accentGlow;
  ctx.fillRect(0, 5, W, 35);

  // ── Bottom footer bar ─────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, H - 38, W, 38);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H - 38); ctx.lineTo(W, H - 38); ctx.stroke();

  // ── Avatar ────────────────────────────────────────────────────────────────────
  // outer glow ring
  ctx.save();
  ctx.shadowColor = '#7C4DFF';
  ctx.shadowBlur  = 22;
  ctx.strokeStyle = 'rgba(124,77,255,0.5)';
  ctx.lineWidth   = 3;
  ctx.beginPath(); ctx.arc(AV_CX, AV_CY, AV / 2 + 6, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // coloured ring
  const ringGrad = ctx.createLinearGradient(AV_CX - AV/2, AV_CY - AV/2, AV_CX + AV/2, AV_CY + AV/2);
  ringGrad.addColorStop(0, '#7C4DFF');
  ringGrad.addColorStop(0.5, '#448AFF');
  ringGrad.addColorStop(1, '#00BCD4');
  ctx.save();
  ctx.strokeStyle = ringGrad;
  ctx.lineWidth   = 3.5;
  ctx.beginPath(); ctx.arc(AV_CX, AV_CY, AV / 2 + 2.5, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // avatar image clipped to circle
  ctx.save();
  ctx.beginPath(); ctx.arc(AV_CX, AV_CY, AV / 2, 0, Math.PI * 2); ctx.clip();
  try {
    const buf = await fetchImageBuffer(data.avatarUrl);
    const img = await loadImage(buf);
    ctx.drawImage(img, AV_CX - AV/2, AV_CY - AV/2, AV, AV);
  } catch {
    ctx.fillStyle = '#1e1e3a';
    ctx.fillRect(AV_CX - AV/2, AV_CY - AV/2, AV, AV);
  }
  ctx.restore();

  // ── LEVEL badge — top-right corner ───────────────────────────────────────────
  // Big number with glow
  ctx.save();
  ctx.font         = 'bold 72px Arial';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  ctx.shadowColor  = '#7C4DFF';
  ctx.shadowBlur   = 28;
  ctx.fillStyle    = '#ffffff';
  ctx.fillText(`${data.level}`, RX, 50);
  ctx.restore();

  // "LEVEL" label under the number
  ctx.font         = 'bold 11px Arial';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = 'rgba(255,255,255,0.30)';
  ctx.letterSpacing = '3px';
  ctx.fillText('LEVEL', RX, 90);
  ctx.letterSpacing = '0px';

  // ── Title (if present) ────────────────────────────────────────────────────────
  if (data.title) {
    ctx.font         = '13px Arial';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#a78bfa';
    ctx.fillText(data.title, TX, Y_TITLE);
  }

  // ── Username ──────────────────────────────────────────────────────────────────
  ctx.font         = 'bold 26px Arial';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = '#ffffff';
  ctx.fillText(data.username, TX, Y_NAME);

  // ── Rank pill ─────────────────────────────────────────────────────────────────
  const rankTxt  = `${data.rankEmoji}  ${data.rankName}`;
  ctx.font        = 'bold 13px Arial';
  ctx.textBaseline = 'middle';
  const rankTxtW  = ctx.measureText(rankTxt).width;
  const pillW     = rankTxtW + 28;
  const pillH     = 26;
  const pillX     = TX;
  const pillY     = Y_PILL - pillH / 2;

  // pill background
  ctx.fillStyle = 'rgba(92,107,192,0.22)';
  ctx.beginPath(); ctx.roundRect(pillX, pillY, pillW, pillH, 7); ctx.fill();
  // pill border
  ctx.strokeStyle = 'rgba(124,77,255,0.55)';
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.roundRect(pillX, pillY, pillW, pillH, 7); ctx.stroke();
  // pill text
  ctx.fillStyle    = '#c4b5fd';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(rankTxt, pillX + 14, Y_PILL);

  // ── XP bar ────────────────────────────────────────────────────────────────────
  const barX = TX;
  const barW = W - TX - PAD - 10;
  const barFill = Math.max(barW * (data.pct / 100), 10);

  // track
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.beginPath(); ctx.roundRect(barX, Y_BAR, barW, BAR_H, BAR_H / 2); ctx.fill();

  // fill gradient
  const xpGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  xpGrad.addColorStop(0,   '#7C4DFF');
  xpGrad.addColorStop(0.5, '#448AFF');
  xpGrad.addColorStop(1,   '#00BCD4');
  ctx.fillStyle = xpGrad;
  ctx.beginPath(); ctx.roundRect(barX, Y_BAR, barFill, BAR_H, BAR_H / 2); ctx.fill();

  // glow on fill
  ctx.save();
  ctx.shadowColor = '#7C4DFF';
  ctx.shadowBlur  = 12;
  ctx.fillStyle   = xpGrad;
  ctx.beginPath(); ctx.roundRect(barX, Y_BAR, barFill, BAR_H, BAR_H / 2); ctx.fill();
  ctx.restore();

  // bright leading edge dot
  ctx.save();
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur  = 10;
  ctx.fillStyle   = 'rgba(255,255,255,0.9)';
  ctx.beginPath(); ctx.arc(barX + barFill, Y_BAR + BAR_H / 2, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // XP label
  ctx.font         = '12px Arial';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = 'rgba(255,255,255,0.38)';
  ctx.fillText(
    `${data.progress.toLocaleString()} / ${data.needed.toLocaleString()} XP`,
    barX, Y_XP_LABEL
  );
  // percentage right-aligned to bar end
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(`${data.pct}%`, barX + barW, Y_XP_LABEL);

  // ── Bottom stat row ───────────────────────────────────────────────────────────
  // stat divider above footer
  const STAT_Y_LABEL = H - 28;
  const STAT_Y_VAL   = H - 14; // not used — we keep stats inside the footer bar

  const stats = [
    { label: 'TOTAL XP',     value: data.totalXp.toLocaleString(), glow: false },
    { label: 'SERVER RANK',  value: `#${data.serverRank} of ${data.serverTotal}`, glow: data.serverRank <= 3 },
    { label: 'PROGRESS',     value: `${data.pct}% → Lv.${data.level + 1}`, glow: false },
  ];

  const colW = (W - PAD * 2) / stats.length;
  stats.forEach((s, i) => {
    const cx = PAD + i * colW + colW / 2;
    // label
    ctx.font         = 'bold 9px Arial';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = 'rgba(255,255,255,0.30)';
    ctx.fillText(s.label, cx, H - 26);
    // value
    ctx.font = 'bold 13px Arial';
    if (s.glow && data.serverRank <= 3) {
      const gc = ['#FFD700','#C0C0C0','#CD7F32'][data.serverRank - 1];
      ctx.save();
      ctx.shadowColor = gc; ctx.shadowBlur = 10; ctx.fillStyle = gc;
      ctx.fillText(s.value, cx, H - 12);
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.80)';
      ctx.fillText(s.value, cx, H - 12);
    }
    // vertical divider between cols
    if (i > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(PAD + i * colW, H - 34);
      ctx.lineTo(PAD + i * colW, H - 2);
      ctx.stroke();
    }
  });

  // ── Watermark ─────────────────────────────────────────────────────────────────
  drawWatermark(ctx, W, H);

  return canvas.toBuffer('image/png');
}

// ─── Race Leaderboard Image ───────────────────────────────────────────────────
function generateRaceLBImage(entries) {
  const W = 520, ROW_H = 52, HEADER_H = 64, PADDING = 24;
  const H = HEADER_H + entries.length * ROW_H + PADDING;
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#120a00'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,170,0,0.07)'; ctx.lineWidth = 1;
  for (let i = 0; i <= entries.length; i++) { const y = HEADER_H + i * ROW_H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const grad = ctx.createLinearGradient(0, 0, W, 0); grad.addColorStop(0, '#3d1f00'); grad.addColorStop(1, '#120a00');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, HEADER_H);
  ctx.fillStyle = '#FFAA00'; ctx.fillRect(0, 0, 4, HEADER_H);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 22px Arial'; ctx.textBaseline = 'middle'; ctx.fillText('🏁  Race Leaderboard', 24, HEADER_H/2);
  const rankColors = ['#FFD700','#C0C0C0','#CD7F32'];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], y = HEADER_H + i * ROW_H, mid = y + ROW_H/2;
    ctx.fillStyle = i%2===0 ? 'rgba(255,170,0,0.03)' : 'rgba(0,0,0,0)'; ctx.fillRect(0, y, W, ROW_H);
    if (i < 3) drawRowGlow(ctx, y, ROW_H, W, i);
    ctx.textAlign = 'center';
    if (i < 3) { ctx.save(); ctx.font = '22px Arial'; ctx.fillStyle = rankColors[i]; ctx.shadowColor = rankColors[i]; ctx.shadowBlur = 8; ctx.fillText(['🥇','🥈','🥉'][i], 30, mid); ctx.restore(); }
    else { ctx.font = 'bold 16px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fillText(`${i+1}`, 30, mid); }
    ctx.textAlign = 'left'; ctx.font = 'bold 16px Arial';
    if (e.rainbowTag) {
      drawRainbowText(ctx, e.username, 58, mid);
    } else {
      ctx.fillStyle = i < 3 ? '#ffffff' : 'rgba(255,255,255,0.82)'; ctx.fillText(e.username, 58, mid);
    }
    ctx.font = 'bold 15px Arial'; ctx.fillStyle = i===0 ? '#FFAA00' : 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'right'; ctx.fillText(msToStr(e.bestTime), W-16, mid); ctx.textAlign = 'left';
    const barX = W-170, barW = 100, barH = 5, barY = mid+10;
    const relPct = entries[0].bestTime / e.bestTime;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 3); ctx.fill();
    const bGrad = ctx.createLinearGradient(barX, 0, barX+barW, 0); bGrad.addColorStop(0, '#FFAA00'); bGrad.addColorStop(1, '#ff6b6b');
    ctx.fillStyle = bGrad; ctx.beginPath(); ctx.roundRect(barX, barY, Math.max(barW*relPct, 4), barH, 3); ctx.fill();
  }
  ctx.textBaseline = 'middle'; drawLBFooter(ctx, W, H, PADDING, `Top ${entries.length} Racers`);
  return canvas.toBuffer('image/png');
}

// ─── Money Leaderboard Image ──────────────────────────────────────────────────
function generateMoneyLBImage(entries) {
  const W = 520, ROW_H = 52, HEADER_H = 64, PADDING = 24;
  const H = HEADER_H + entries.length * ROW_H + PADDING;
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#020d05'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(0,200,80,0.06)'; ctx.lineWidth = 1;
  for (let i = 0; i <= entries.length; i++) { const y = HEADER_H + i * ROW_H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const grad = ctx.createLinearGradient(0, 0, W, 0); grad.addColorStop(0, '#002d0f'); grad.addColorStop(1, '#020d05');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, HEADER_H);
  ctx.fillStyle = '#00C853'; ctx.fillRect(0, 0, 4, HEADER_H);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 22px Arial'; ctx.textBaseline = 'middle'; ctx.fillText('💰  Money Leaderboard', 24, HEADER_H/2);
  const rankColors = ['#FFD700','#C0C0C0','#CD7F32'];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], y = HEADER_H + i * ROW_H, mid = y + ROW_H/2;
    ctx.fillStyle = i%2===0 ? 'rgba(0,200,80,0.04)' : 'rgba(0,0,0,0)'; ctx.fillRect(0, y, W, ROW_H);
    if (i < 3) drawRowGlow(ctx, y, ROW_H, W, i);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    if (i < 3) { ctx.save(); ctx.font = '22px Arial'; ctx.fillStyle = rankColors[i]; ctx.shadowColor = rankColors[i]; ctx.shadowBlur = 8; ctx.fillText(['🥇','🥈','🥉'][i], 30, mid); ctx.restore(); }
    else { ctx.font = 'bold 16px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fillText(`${i+1}`, 30, mid); }
    ctx.textAlign = 'left'; ctx.font = 'bold 16px Arial'; ctx.fillStyle = i < 3 ? '#ffffff' : 'rgba(255,255,255,0.82)'; ctx.fillText(e.username, 58, mid);
    ctx.font = 'bold 15px Arial'; ctx.fillStyle = i===0 ? '#00C853' : 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'right'; ctx.fillText(`${e.currency.toLocaleString()} coins`, W-16, mid); ctx.textAlign = 'left';
    const barX = W-170, barW = 100, barH = 5, barY = mid+10;
    const relPct = entries[0].currency > 0 ? e.currency/entries[0].currency : 0;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 3); ctx.fill();
    const bGrad = ctx.createLinearGradient(barX, 0, barX+barW, 0); bGrad.addColorStop(0, '#00C853'); bGrad.addColorStop(1, '#69F0AE');
    ctx.fillStyle = bGrad; ctx.beginPath(); ctx.roundRect(barX, barY, Math.max(barW*relPct, 4), barH, 3); ctx.fill();
  }
  ctx.textBaseline = 'middle'; drawLBFooter(ctx, W, H, PADDING, `Top ${entries.length} Richest`);
  return canvas.toBuffer('image/png');
}

// ─── Inventory Canvas Image ───────────────────────────────────────────────────
async function generateInventoryImage(data) {
  const { username, plants, page, totalPages, totalPlants, filterDesc } = data;
  const W = 560, HEADER_H = 72, FOOTER_H = 40, ROW_H = 80;
  const H = HEADER_H + plants.length * ROW_H + FOOTER_H;
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0a0c12'; ctx.fillRect(0, 0, W, H);
  const bgG = ctx.createLinearGradient(0, 0, W, H);
  bgG.addColorStop(0, 'rgba(20,30,60,0.6)'); bgG.addColorStop(1, 'rgba(5,8,16,0.4)');
  ctx.fillStyle = bgG; ctx.fillRect(0, 0, W, H);
  const topG = ctx.createLinearGradient(0, 0, W, 0); topG.addColorStop(0, '#4d96ff'); topG.addColorStop(1, '#9575CD');
  ctx.fillStyle = topG; ctx.fillRect(0, 0, W, 3);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 22px Arial'; ctx.textAlign = 'center'; ctx.fillText(`${username}'s Inventory`, W / 2, 28);
  ctx.font = '13px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
  const subLine = filterDesc ? `${totalPlants} plants  ·  filtered: ${filterDesc}` : `${totalPlants} plants  ·  Page ${page} of ${totalPages}  ·  !inv [page]`;
  ctx.fillText(subLine, W / 2, 52); ctx.textAlign = 'left';
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, HEADER_H); ctx.lineTo(W, HEADER_H); ctx.stroke();
  for (let i = 0; i < plants.length; i++) {
    const p = plants[i], rCfg = getRarityConfig(p.rarity), y = HEADER_H + i * ROW_H, mid = y + ROW_H / 2;
    const rHex = '#' + rCfg.color.toString(16).padStart(6, '0');
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0)'; ctx.fillRect(0, y, W, ROW_H);
    ctx.save(); ctx.shadowColor = rHex; ctx.shadowBlur = 10; ctx.fillStyle = rHex; ctx.fillRect(0, y + 10, 5, ROW_H - 20); ctx.restore();
    const LPAD = 22;
    ctx.font = 'bold 20px Arial'; ctx.fillStyle = '#ffffff'; ctx.fillText(p.name, LPAD, mid - 14);
    const verStr = `v${p.version || '?'}`;
    ctx.font = 'bold 13px Arial';
    const verW = ctx.measureText(verStr).width + 18, verX = W - 20 - verW, verY = mid - 25;
    ctx.fillStyle = '#000000'; ctx.beginPath(); ctx.roundRect(verX, verY, verW, 24, 5); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(verX, verY, verW, 24, 5); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.fillText(verStr, verX + verW / 2, verY + 12); ctx.textAlign = 'left';
    ctx.font = 'bold 14px Arial'; ctx.fillStyle = rHex; ctx.fillText(p.rarity.toUpperCase(), LPAD, mid + 14);
    if (p.mutation) {
      ctx.font = '14px Arial';
      const mutX = LPAD + ctx.measureText(p.rarity.toUpperCase()).width + 16;
      ctx.font = 'bold 13px Arial';
      const mutLabel = `${p.mutation.emoji} ${p.mutation.name}`, mutW = ctx.measureText(mutLabel).width + 16;
      ctx.fillStyle = 'rgba(255,240,100,0.12)'; ctx.beginPath(); ctx.roundRect(mutX - 8, mid + 4, mutW, 22, 5); ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,100,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(mutX - 8, mid + 4, mutW, 22, 5); ctx.stroke();
      ctx.fillStyle = 'rgba(255,240,120,0.9)'; ctx.fillText(mutLabel, mutX, mid + 15);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + ROW_H); ctx.lineTo(W, y + ROW_H); ctx.stroke();
  }
  const footerY = HEADER_H + plants.length * ROW_H;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, footerY); ctx.lineTo(W, footerY); ctx.stroke();
  ctx.font = '11px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(SERVER_NAME, W / 2, footerY + FOOTER_H / 2);
  drawWatermark(ctx, W, H);
  return canvas.toBuffer('image/png');
}

// ─── Shop pages ───────────────────────────────────────────────────────────────
const SHOP_PAGES = [
  { title: '📦 Crates', fields: () => Object.entries(CRATES).map(([, c]) => ({ name: `${c.emoji} ${c.name} — ${c.price.toLocaleString()} ${CURRENCY_NAME}`, value: `Opens **${c.plants} plants**.\nRequires **Level ${c.minLevel}**.\n\`!buy ${c.name.split(' ')[0].toLowerCase()}\`` })) },
  { title: '🔮 Charms', fields: (user) => Object.entries(CHARMS).map(([key, ch]) => {
    const owned = user.charms.includes(key), equipped = user.equippedCharms.includes(key);
    const status = owned ? (equipped ? ' ✅ *Equipped*' : ' *(Owned)*') : '';
    const legMult = ch.multipliers.Legendary || null;
    const mytMult = ch.multipliers.Mythic    || null;
    const rateLines = [
      legMult ? `${RARITY_EMOJIS.Legendary} Legendary ×${legMult.toFixed(2)}` : null,
      mytMult ? `${RARITY_EMOJIS.Mythic} Mythic ×${mytMult.toFixed(2)}`    : null,
    ].filter(Boolean).join('  ·  ');
    return { name: `${ch.emoji} ${ch.name} — ${ch.price.toLocaleString()} ${CURRENCY_NAME}${status}`, value: `${rateLines}\n\`!buy ${key}\`` };
  }) },
  { title: '🏷️ Titles', fields: (user) => Object.entries(SHOP_TITLES).map(([key, t]) => { const owned = user.titles.includes(key); return { name: `${t.emoji} ${t.name} — ${t.price.toLocaleString()} ${CURRENCY_NAME}${owned ? ' *(Owned)*' : ''}`, value: `\`!buy ${key}\`` }; }) }
];
function buildShopEmbed(pageIndex, user, balance) {
  const page = SHOP_PAGES[pageIndex], total = SHOP_PAGES.length, fields = page.fields(user);
  return new EmbedBuilder().setTitle(`🛒 Plant Shop — ${page.title}`).addFields(...fields).setFooter({ text: `Page ${pageIndex+1} of ${total}  •  ${CURRENCY_EMOJI} Balance: ${balance.toLocaleString()} ${CURRENCY_NAME}  •  Use !shop <1-${total}> to switch pages` }).setColor(0x7289DA);
}

process.on('SIGTERM', () => {
  client.destroy();
  process.exit(0);
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ ${client.user.tag} online`);

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  startDropLoop();
  startDecayLoop();
  startPayoutLoop();
  startWeatherLoop();

  // Resume any auctions that were running before restart
  const auctions = loadAuctions();
  for (const auction of auctions) {
    const remaining = auction.endsAt - Date.now();
    if (remaining <= 0) {
      endAuction(auction.id, null).catch(console.error);
    } else {
      setTimeout(() => endAuction(auction.id, null).catch(console.error), remaining);
    }
  }
});

// ─── Messages ─────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (processedMessages.has(message.id)) return;
processedMessages.add(message.id);
setTimeout(() => processedMessages.delete(message.id), 30000);
  if (message.author.bot) return;

  const registeredChId = dropChannels[message.guild?.id];
  const relaxedChId    = relaxedDropChannels[message.guild?.id];

  if (registeredChId && message.channel.id === registeredChId) {
    channelActivity[message.channel.id] = Date.now();
    // Strict mode — ignore all commands except claim
    const isClaimAttempt = message.content.trim().toLowerCase().startsWith('claim ');
    const isCommand = message.content.trim().startsWith(PREFIX);
    const isMod = message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages);
    if (!isClaimAttempt && isCommand && !isMod) {
      return;
    }
  } else if (relaxedChId && message.channel.id === relaxedChId) {
    channelActivity[message.channel.id] = Date.now();
    // Relaxed mode — drops appear but all commands work normally
  }

  const content = message.content.trim();
  const lower   = content.toLowerCase();

  // Touch activity for any message from a known user
  {
    const db = loadDB();
    if (db[message.author.id]) {
      touchActivity(db, message.author.id, message.author);
      saveDB(db);
    }
  }

  // ── CLAIM ─────────────────────────────────────────────────────────────────
  if (lower.startsWith('claim ') && activeDrops[message.channel.id]) {
    const input = content.slice(6).trim().toUpperCase();
    const drop  = activeDrops[message.channel.id];
    if (input !== drop.captcha) return;
    if (!COOLDOWN_EXEMPT_IDS.includes(message.author.id)) {
      const cdDb = loadDB(), cdUser = getUser(cdDb, message.author.id);
      const cdMs = CLAIM_COOLDOWNS[drop.rarity.name] || 0;
      const remaining = cdMs - (Date.now() - ((cdUser.claimCooldowns || {})[drop.rarity.name] || 0));
      if (remaining > 0) {
        const mins = Math.floor(remaining / 60000), secs = Math.ceil((remaining % 60000) / 1000);
        const errMsg = await message.channel.send(`<@${message.author.id}> ⏳ Cooldown — **${drop.rarity.name}** drop in **${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}**.`);
        setTimeout(() => errMsg.delete().catch(() => {}), 5000); return;
      }
    }
    const elapsed = Date.now() - drop.dropTime;
    drop.claimers.push({ userId: message.author.id, username: message.author.username, time: elapsed });
    if (drop.claimers.length === 1) {
      delete activeDrops[message.channel.id];
      await queueForUser(message.author.id, async () => {
        const db      = loadDB();
        const user    = getUser(db, message.author.id);
        touchActivity(db, message.author.id, message.author);
        const version   = getAvailableVersion(drop.plant.name, db);
        recordVersionHighWater(drop.plant.name, version);
        const rCfg     = drop.rarity, mutation = drop.mutation;
        const sellValue = calcSellValue(drop.plant, rCfg, mutation, version);
        if (!TEST_IDS.has(message.author.id)) {
          user.collection.push({ name: drop.plant.name, image: drop.plant.display, rarity: drop.rarity.name, mutation: mutation ? { name: mutation.name, emoji: mutation.emoji, multiplier: mutation.multiplier } : null, version, sellValue, claimedAt: new Date().toISOString() });
          user.claimed++;
        }

        const isTester = TEST_IDS.has(message.author.id);
        let lvlUp = null, newAch = [];
        if (!user.claimCooldowns) user.claimCooldowns = {};
        if (!isTester) {
          lvlUp  = addXP(db, message.author.id, XP_REWARDS.claim);
          newAch = checkAchievements(user);
          user.claimCooldowns[drop.rarity.name] = Date.now();
          const claimNewPlants = [{ name: drop.plant.name, version }];
          applyAutosellRules(user, message.author.id, claimNewPlants);
          saveDB(db);
          recordClaim(message.author.id, message.author.username);
        }

        const mutLine = mutation ? `  ·  ${mutation.emoji} **${mutation.name}**` : '';
        await message.channel.send({ embeds: [new EmbedBuilder().setDescription(`${rCfg.emoji} **${drop.plant.name}** \`v${version}\` claimed by <@${message.author.id}>!${mutLine}`).setColor(mutation ? mutation.color : rCfg.color)] });

        if (version === 1) {
          const vPingChId = vPingChannels[message.guild?.id];
          if (vPingChId) { const vPingCh = client.channels.cache.get(vPingChId); if (vPingCh) { const vAttach = new AttachmentBuilder(`${IMAGES_DIR}/${drop.plant.display}`, { name: drop.plant.display }); await vPingCh.send({ embeds: [new EmbedBuilder().setDescription(`🔖 **v1 claimed!**\n<@${message.author.id}> grabbed the **first copy** of **${drop.plant.name}**${mutLine}`).setThumbnail(`attachment://${drop.plant.display}`).setColor(mutation ? mutation.color : rCfg.color)], files: [vAttach] }).catch(console.error); } }
        }
        if (lvlUp) await message.channel.send(`<@${message.author.id}> levelled up to **Level ${lvlUp}**! ${getRank(lvlUp).emoji}`);
        if (newAch.length) { const achLines = newAch.map(k => `${ACHIEVEMENTS[k].emoji} **${ACHIEVEMENTS[k].name}** — *${ACHIEVEMENTS[k].description}*`).join('\n'); await message.channel.send({ embeds: [new EmbedBuilder().setTitle('Achievement Unlocked!').setDescription(achLines).setColor(0xFFD700)] }); }
      });
    }
    return;
  }

  // ── RACE ANSWER — just the captcha, no "race " prefix ────────────────────
  if (activeRaces[message.channel.id] && !content.startsWith(PREFIX)) {
    const input = content.trim().toUpperCase();
    const race  = activeRaces[message.channel.id];
    if (input !== race.captcha || race.finishers.some(f => f.userId === message.author.id)) {
      // Not the right captcha or already finished — fall through
    } else {
      const elapsed = Date.now() - race.startTime;
      race.finishers.push({ userId: message.author.id, username: message.author.username, time: elapsed });
      const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
      touchActivity(db, message.author.id, message.author);
      const lb         = loadRaceLB();
      const prevRecord = lb.length > 0 ? lb[0].bestTime : null;
      const isRecord   = prevRecord !== null && elapsed < prevRecord;
      if (user.bestRaceTime === null || elapsed < user.bestRaceTime) user.bestRaceTime = elapsed;
      const isWin = race.finishers.length === 1;
      if (isWin) user.raceWins = (user.raceWins || 0) + 1;
      addXP(db, message.author.id, isWin ? XP_REWARDS.race_win : XP_REWARDS.race_finish);
      checkAchievements(user); saveDB(db);
      if (!TEST_IDS.has(message.author.id)) {
        const ex = lb.find(e => e.userId === message.author.id);
        if (ex) { if (elapsed < ex.bestTime) { ex.bestTime = elapsed; ex.username = message.author.username; } }
        else lb.push({ userId: message.author.id, username: message.author.username, bestTime: elapsed });
        lb.sort((a,b) => a.bestTime - b.bestTime); saveRaceLB(lb);
      }
      await message.react(isRecord ? RACE_REACT_RECORD : RACE_REACT_CORRECT).catch(() => {});
      if (race.finishers.length >= 5) await endRace(message.channel, race);
      return;
    }
  }

  // ── CRATE CAPTCHA ─────────────────────────────────────────────────────────
  if (pendingCrates[message.author.id] && !content.startsWith(PREFIX)) {
    const pending = pendingCrates[message.author.id];
    if (content.trim().toUpperCase() !== pending.captcha) return;

    clearTimeout(pending.expires);
    delete pendingCrates[message.author.id];

    const { crateKey } = pending;
    const crate = CRATES[crateKey];
    const db = loadDB();
    const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
    touchActivity(db, message.author.id, message.author);
    if (!user.crateCooldowns) user.crateCooldowns = {};

    const results = openCrate(crateKey, db, message.author.id);
    const addedPlants = [];
    let autoEarned = 0;
    if (!TEST_IDS.has(message.author.id)) {
      user.currency -= crate.price;
      user.crateCooldowns[crateKey] = Date.now();
      const addedCratePlants = [];
      const captchaCrateMeta = loadMeta();
      for (const p of results) {
        const ver = getAvailableVersionFromMeta(p.name, db, captchaCrateMeta);
        if ((captchaCrateMeta.plantVersions[p.name] || 0) < ver) captchaCrateMeta.plantVersions[p.name] = ver;
        const sv = calcSellValue(p, p.rarityConfig, p.mutation, ver);
        const entry = { name: p.name, image: p.display, rarity: p.rarity, mutation: p.mutation ? { name: p.mutation.name, emoji: p.mutation.emoji, multiplier: p.mutation.multiplier } : null, version: ver, sellValue: sv, claimedAt: new Date().toISOString() };
        if (!user.collection.some(c => c.name === entry.name && c.version === entry.version)) {
          user.collection.push(entry);
          addedCratePlants.push(entry);
        } else {
          console.warn(`[DUPE GUARD] Blocked duplicate in captcha crate: ${entry.name} v${entry.version}`);
        }
        db[message.author.id] = user;
      }
      saveMeta(captchaCrateMeta);
      user.cratesOpened = (user.cratesOpened || 0) + 1;
      addXP(db, message.author.id, XP_REWARDS.crate_open);
      checkAchievements(user);
      applyAutosellRules(user, message.author.id, addedCratePlants);
      saveDB(db);
    }
    const spoilerLines = addedCratePlants.map(p =>
      `||${getRarityConfig(p.rarity).emoji} **${p.name}** \`v${p.version}\` — ${p.rarity}${p.mutation ? ` ${p.mutation.emoji} ${p.mutation.name}` : ''}||`
    );
    return message.channel.send({
      embeds: [new EmbedBuilder()
        .setTitle(`${crate.emoji} ${crate.name} — Click to Reveal`)
        .setDescription(`${TEST_IDS.has(message.author.id) ? '' : `${CURRENCY_EMOJI} **${user.currency.toLocaleString()}**${autoEarned > 0 ? `  ·  ⚡ Autosold **${autoEarned.toLocaleString()} coins**` : ''}\n\n`}*Each plant is hidden — click to reveal...*\n\n${spoilerLines.join('\n')}`)
        .setColor(crate.color)
      ]
    });
  } 

  // ── SELL CONFIRM ──────────────────────────────────────────────────────────
  if (pendingSells[message.author.id]) {
    if (lower === 'yes') {
      const pending = pendingSells[message.author.id];
      delete pendingSells[message.author.id];
      const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
      touchActivity(db, message.author.id, message.author);

      // Sell-all path
      if (pending.sellAllCandidates) {
        const { sellAllCandidates, totalVal } = pending;
        // Remove from highest index down to avoid shift bugs
        for (const { name, version } of sellAllCandidates) {
          const idx = user.collection.findIndex(p => p.name === name && p.version === version);
          if (idx !== -1) user.collection.splice(idx, 1);
        }
        user.currency += totalVal;
        saveDB(db);
        const names = sellAllCandidates.map(c => `**${c.plant.name}** v${c.plant.version || '?'}${c.plant.mutation ? ` [${c.plant.mutation.emoji} ${c.plant.mutation.name}]` : ''}`).join(', ');
        return message.reply(`✅ Sold ${sellAllCandidates.length} copies — ${names} for ${fmt(totalVal)}! Balance: ${fmt(user.currency)}`);
      }

      // Single sell path
      const { plant, plantName, plantVersion } = pending;
      const index = user.collection.findIndex(p => p.name === plantName && p.version === plantVersion);
      if (index === -1) return message.reply(`❌ Could not find **${plantName}** \`v${plantVersion}\` — it may have already been sold or traded.`);
      user.collection.splice(index, 1);
      const price = getLiveSellValue(plant);
      user.currency += price;
      // remove locks for plants no longer owned
      const remaining = loadLocks(message.author.id).filter(l => {
        if (!l.name) return true;
        return user.collection.some(p => p.name.toLowerCase() === l.name.toLowerCase());
      });
      saveLocks(message.author.id, remaining);
      saveDB(db);
      return message.reply(`✅ Sold **${plant.name}** v${plant.version || '?'}${plant.mutation ? ` [${plant.mutation.emoji} ${plant.mutation.name}]` : ''} for ${fmt(price)}! Balance: ${fmt(user.currency)}`);
    }
    if (lower === 'no') { delete pendingSells[message.author.id]; return message.reply('❌ Sale cancelled.'); }
  }

  // ── WIPE CONFIRMATION ──────────────────────────────────────────────────────
  if (pendingWipes[message.author.id]) {
    const wipe = pendingWipes[message.author.id];
    delete pendingWipes[message.author.id];
    if (content.trim() !== wipe.phrase) return message.reply('❌ Phrase did not match. Wipe cancelled.');
    pendingWipes[`${message.author.id}_confirm`] = { phrase: wipe.phrase, ts: Date.now() };
    setTimeout(() => delete pendingWipes[`${message.author.id}_confirm`], 30_000);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle('☢️  FINAL WARNING — TYPE AGAIN TO CONFIRM').setDescription(`You've entered the phrase once.\n\n**Type it one more time to execute the wipe.**\n\`\`\`\n${wipe.phrase}\n\`\`\`\nYou have **30 seconds**. Any other input cancels.`).setColor(0xFF0000)] });
  }
  if (pendingWipes[`${message.author.id}_confirm`]) {
    const wipe = pendingWipes[`${message.author.id}_confirm`];
    delete pendingWipes[`${message.author.id}_confirm`];
    if (content.trim() !== wipe.phrase) return message.reply('❌ Phrase did not match. Wipe cancelled.');
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify({}, null, 2)); fs.writeFileSync(META_FILE, JSON.stringify({ plantVersions: {}, totalDrops: 0 }, null, 2));
      fs.writeFileSync(RACE_LB_FILE, JSON.stringify([], null, 2)); fs.writeFileSync(MARKET_FILE, JSON.stringify({}, null, 2)); fs.writeFileSync(CLAIMS_LB_FILE, JSON.stringify([], null, 2));
      fs.writeFileSync(AUCTION_FILE, JSON.stringify([], null, 2)); fs.writeFileSync(TRADES_FILE, JSON.stringify({}, null, 2)); fs.writeFileSync(LOCKS_FILE, JSON.stringify({}, null, 2)); fs.writeFileSync(LISTINGS_FILE, JSON.stringify([], null, 2)); fs.writeFileSync(AUTOSELL_FILE, JSON.stringify({}, null, 2));
      activeDrops = {}; activeRaces = {}; pendingSells = {}; webTrades = {};
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Wipe Complete').setDescription('All data has been wiped.').setColor(0x00FF00)] });
    } catch (err) { return message.reply(`❌ Wipe failed: ${err.message}`); }
  }

  if (pendingWipes[`sellall_${message.author.id}`]) {
    const wipe = pendingWipes[`sellall_${message.author.id}`];
    delete pendingWipes[`sellall_${message.author.id}`];
    if (content.trim() !== wipe.phrase) return message.reply('❌ Phrase did not match. Sale cancelled.');
    const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
    if (!user.collection.length) return message.reply('You have no plants to sell.');
    const sellable = user.collection.filter(p => !isLocked(message.author.id, p));
    const totalVal = sellable.reduce((sum, p) => sum + getLiveSellValue(p), 0);
    const count = sellable.length;
    user.collection = user.collection.filter(p => isLocked(message.author.id, p));
    user.currency += totalVal;
    saveDB(db);
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle('💰 Entire Inventory Sold')
      .setDescription(`Sold **${count} plants** for ${fmt(totalVal)}.\nNew balance: ${fmt(user.currency)}`)
      .setColor(0x00C853)
    ]});
  }

  if (pendingWipes[`cards_${message.author.id}`]) {
    const wipe = pendingWipes[`cards_${message.author.id}`];
    delete pendingWipes[`cards_${message.author.id}`];
    if (content.trim() !== wipe.phrase) return message.reply('❌ Phrase did not match. Wipe cancelled.');
    const db = loadDB();
    const user = getUser(db, wipe.targetId);
    user.collection = [];
    saveDB(db);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Cards Wiped').setDescription(`All plants have been removed from **${wipe.targetName}**'s collection.`).setColor(0x00FF00)] });
  }

  if (pendingWipes[`user_${message.author.id}`]) {
    const wipe = pendingWipes[`user_${message.author.id}`];
    delete pendingWipes[`user_${message.author.id}`];
    if (content.trim() !== wipe.phrase) return message.reply('❌ Phrase did not match. Wipe cancelled.');
    try {
      const db = loadDB();
      delete db[wipe.targetId]; saveDB(db);
      const raceLB = loadRaceLB().filter(e => e.userId !== wipe.targetId); saveRaceLB(raceLB);
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle('✅ User Wiped').setDescription(`All data for **${wipe.targetName}** has been deleted.`).setColor(0x00FF00)] });
    } catch (err) { return message.reply(`❌ Wipe failed: ${err.message}`); }
  }

  if (!content.startsWith(PREFIX)) return;
  const args = content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd  = args[0].toLowerCase();

  // ── !auction ──────────────────────────────────────────────────────────────
  // Usage: !auction <plant name> [-v version] [-start coins] [-buyout coins] [-hours n]
  if (cmd === 'auction') {
    const rawAuction = args.slice(1).join(' ');

    // Sub-commands: !auction list, !auction cancel <id>, !auction end <id>
    if (args[1] === 'list') {
      const auctions = loadAuctions();
      if (!auctions.length) return message.reply('No active auctions.');
      const lines = auctions.map(a => {
        const remaining = Math.max(0, a.endsAt - Date.now());
        const hrs = Math.floor(remaining / 3600000), mins = Math.floor((remaining % 3600000) / 60000);
        const topBid = a.bids.length ? a.bids[a.bids.length - 1] : null;
        return `**${a.plant.name}** \`v${a.plant.version || '?'}\` — ID: \`${a.id}\` — Top: ${topBid ? fmt(topBid.amount) : 'No bids'} — Ends in: ${hrs}h ${mins}m`;
      });
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle('🔨 Active Auctions').setDescription(lines.join('\n')).setColor(0xFFD700)] });
    }

    if (args[1] === 'cancel') {
      const auctionId = args[2];
      const auctions = loadAuctions();
      const auction  = auctions.find(a => a.id === auctionId);
      if (!auction) return message.reply('Auction not found.');
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        if (auction.sellerId !== message.author.id) return message.reply('You can only cancel your own auctions.');
        if (auction.bids.length) return message.reply('❌ Cannot cancel — this auction already has bids.');
      }
      const db = loadDB();
      const seller = getUser(db, auction.sellerId);
      seller.collection.push({ ...auction.plant, claimedAt: new Date().toISOString() });
      if (auction.bids.length) {
        const topBid = auction.bids[auction.bids.length - 1];
        const bidder = getUser(db, topBid.userId);
        bidder.currency += topBid.amount;
        pushCoinUpdate(topBid.userId, bidder.currency);
      }
      saveDB(db);
      const remaining = auctions.filter(a => a.id !== auctionId);
      saveAuctions(remaining);
      return message.reply(`✅ Auction \`${auctionId}\` cancelled — plant returned to seller${auction.bids.length ? ' and bidders refunded' : ''}.`);
    }

    if (args[1] === 'bid') {
      const auctionId = args[2], bidAmount = parseInt(args[3]);
      if (!auctionId || isNaN(bidAmount)) return message.reply('Usage: `!auction bid <id> <amount>`');
      const auctions = loadAuctions();
      const auction  = auctions.find(a => a.id === auctionId);
      if (!auction) return message.reply('Auction not found.');
      if (Date.now() > auction.endsAt) return message.reply('This auction has ended.');
      if (auction.sellerId === message.author.id) return message.reply("You can't bid on your own auction.");
      const prevTopBid = auction.bids.length ? auction.bids[auction.bids.length - 1] : null;
      const topBidAmount = prevTopBid ? prevTopBid.amount : auction.startPrice;
      const minBid = topBidAmount + auction.minIncrement;
      if (bidAmount < minBid) return message.reply(`❌ Minimum bid is ${fmt(minBid)}.`);
      const db = loadDB(); const user = getUser(db, message.author.id);
      if (user.currency < bidAmount) return message.reply(`❌ You only have ${fmt(user.currency)}.`);

      // Refund the previous top bidder before placing the new bid
      if (prevTopBid && prevTopBid.userId !== message.author.id) {
        const prevBidder = getUser(db, prevTopBid.userId);
        prevBidder.currency += prevTopBid.amount;
        pushCoinUpdate(prevTopBid.userId, prevBidder.currency);
      } else if (prevTopBid && prevTopBid.userId === message.author.id) {
        // Same user raising their own bid — refund their previous bid first
        user.currency += prevTopBid.amount;
      }

      // Deduct new bid amount immediately
      user.currency -= bidAmount;

      auction.bids.push({ userId: message.author.id, username: message.author.username, amount: bidAmount, time: Date.now() });

      // Soft-close: extend if bid lands near the end
      const timeLeft     = auction.endsAt - Date.now();
      const totalAdded   = auction.totalExtended || 0;
      const remaining    = Math.max(0, AUCTION_MAX_EXTENSION - totalAdded);
      let extended = 0;
      if (remaining > 0) {
        if (timeLeft <= AUCTION_EXTEND_THRESHOLD_2) {
          extended = Math.min(AUCTION_EXTEND_AMOUNT_2, remaining);
        } else if (timeLeft <= AUCTION_EXTEND_THRESHOLD_1) {
          extended = Math.min(AUCTION_EXTEND_AMOUNT_1, remaining);
        }
      }
      if (extended > 0) {
        auction.endsAt += extended;
        auction.totalExtended = totalAdded + extended;
      }

      saveAuctions(auctions);
      touchActivity(db, message.author.id, message.author);
      saveDB(db);
      pushCoinUpdate(message.author.id, user.currency);

      const extendedMsg = extended > 0 ? `\n⏱ Auction extended by **${Math.round(extended/1000)}s**!` : '';
      const newTimeLeft = Math.max(0, auction.endsAt - Date.now());
      const m = Math.floor(newTimeLeft / 60000), s = Math.floor((newTimeLeft % 60000) / 1000);
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setDescription(`🔨 **${message.author.username}** bid ${fmt(bidAmount)} on **${auction.plant.name}** \`v${auction.plant.version || '?'}\`${extendedMsg}\n⏰ Ends in **${m}m ${s}s**`)
        .setColor(0xFFD700)
      ]});
    }

    if (args[1] === 'buyout') {
      const auctionId = args[2];
      if (!auctionId) return message.reply('Usage: `!auction buyout <id>`');
      const auctions = loadAuctions();
      const idx = auctions.findIndex(a => a.id === auctionId);
      if (idx === -1) return message.reply('Auction not found.');
      const auction = auctions[idx];
      if (!auction.buyoutPrice) return message.reply('This auction has no buyout price.');
      if (Date.now() > auction.endsAt) return message.reply('This auction has ended.');
      if (auction.sellerId === message.author.id) return message.reply("You can't buy your own auction.");
      const db = loadDB();
      const buyer = getUser(db, message.author.id);
      if (buyer.currency < auction.buyoutPrice) return message.reply(`❌ Need ${fmt(auction.buyoutPrice)}.`);
      const seller = getUser(db, auction.sellerId);
      buyer.currency -= auction.buyoutPrice;
      seller.currency += auction.buyoutPrice;
      buyer.collection.push({ ...auction.plant, claimedAt: new Date().toISOString() });
      touchActivity(db, message.author.id, message.author);
      saveDB(db);
      auctions.splice(idx, 1);
      saveAuctions(auctions);
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('🔨 Auction Bought Out!')
        .setDescription(`**${message.author.username}** bought **${auction.plant.name}** \`v${auction.plant.version || '?'}\` for ${fmt(auction.buyoutPrice)}!`)
        .setColor(0x00C853)
      ]});
    }

    // ── Create auction ────────────────────────────────────────────────────────
    const vMatch      = rawAuction.match(/-v\s*(\d+)/i);
    const startMatch  = rawAuction.match(/-start\s+(\d+)/i);
    const buyoutMatch = rawAuction.match(/-buyout\s+(\d+)/i);
    const hoursMatch  = rawAuction.match(/-hours?\s+(\d+)/i);
    const incrMatch   = rawAuction.match(/-inc(?:rement)?\s+(\d+)/i);

    const plantName   = rawAuction
      .replace(/-v\s*\d+/i,'').replace(/-start\s+\d+/i,'').replace(/-buyout\s+\d+/i,'')
      .replace(/-hours?\s+\d+/i,'').replace(/-inc(?:rement)?\s+\d+/i,'').trim();

    if (!plantName) return message.reply([
      '**Usage:** `!auction <plant name> [options]`',
      '',
      '**Options:**',
      '`-v <version>` — specific version to list',
      '`-start <coins>` — starting bid (default: plant sell value)',
      '`-buyout <coins>` — instant buyout price (optional)',
      '`-hours <n>` — duration in hours (default: 10 minutes)',
      '`-increment <n>` — minimum bid increment (default: 100)',
      '',
      '**Other commands:**',
      '`!auction list` — view active auctions',
      '`!auction bid <id> <amount>` — place a bid',
      '`!auction buyout <id>` — instant buy',
      '`!auction cancel <id>` — cancel your auction (no bids only)',
    ].join('\n'));

    const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });

    const vFilter = vMatch ? parseInt(vMatch[1]) : null;
    let candidates = user.collection.map((p, i) => ({ p, i })).filter(({ p }) => p.name.toLowerCase() === plantName.toLowerCase());
    if (vFilter !== null) candidates = candidates.filter(({ p }) => p.version === vFilter);

    if (!candidates.length) return message.reply(`You don't own **${plantName}**${vFilter !== null ? ` v${vFilter}` : ''}.`);
    if (candidates.length > 1 && vFilter === null) {
      const lines = candidates.map(({ p }) => `\`v${p.version || '?'}\`${p.mutation ? ` ${p.mutation.emoji} ${p.mutation.name}` : ''}`).join('  ·  ');
      return message.reply(`You own **${candidates.length}** copies of **${plantName}**: ${lines}\nUse \`-v <version>\` to specify which one.`);
    }

    const { p: plant, i: plantIndex } = candidates[0];
    if (isLocked(message.author.id, plant)) return message.reply(`🔒 **${plant.name}** \`v${plant.version}\` is locked.`);

    const hours       = Math.min(72, Math.max(1, hoursMatch ? parseInt(hoursMatch[1]) : 0.1667)); // default 10 min
    const startPrice  = startMatch ? parseInt(startMatch[1]) : (plant.sellValue || getRarityConfig(plant.rarity).sellPrice);
    const buyoutPrice = buyoutMatch ? parseInt(buyoutMatch[1]) : null;
    const minIncrement = incrMatch ? parseInt(incrMatch[1]) : Math.max(100, Math.round(startPrice * 0.05));

    if (buyoutPrice && buyoutPrice <= startPrice) return message.reply('❌ Buyout price must be higher than the starting bid.');

    const auctionId = `a_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const endsAt    = Date.now() + hours * 3600000;

    // Remove plant from seller's inventory
    user.collection.splice(plantIndex, 1);
    saveDB(db);

    const auctions = loadAuctions();
    auctions.push({
      id: auctionId,
      sellerId: message.author.id,
      sellerName: message.author.username,
      plant: { ...plant },
      startPrice,
      buyoutPrice,
      minIncrement,
      bids: [],
      endsAt,
      createdAt: Date.now(),
    });
    saveAuctions(auctions);

    // Schedule auto-end
    setTimeout(() => endAuction(auctionId, message.channel), hours * 3600000);

    const rCfg = getRarityConfig(plant.rarity);
    const embed = new EmbedBuilder()
      .setTitle(`🔨 New Auction — ${rCfg.emoji} ${plant.name}`)
      .setDescription([
        `Listed by **${message.author.username}**`,
        `\`v${plant.version || '?'}\`${plant.mutation ? ` ${plant.mutation.emoji} **${plant.mutation.name}**` : ''}`,
        '',
        `**Starting bid:** ${fmt(startPrice)}`,
        buyoutPrice ? `**Buyout:** ${fmt(buyoutPrice)}` : '',
        `**Min increment:** ${fmt(minIncrement)}`,
        `**Duration:** ${hours} hour${hours !== 1 ? 's' : ''}`,
        '',
        `Use \`!auction bid ${auctionId} <amount>\` to bid`,
        buyoutPrice ? `Use \`!auction buyout ${auctionId}\` to buy instantly` : '',
      ].filter(Boolean).join('\n'))
      .setColor(rCfg.color)
      .setFooter({ text: `Auction ID: ${auctionId}` })
      .setTimestamp(endsAt);

    if (auctionChannels[message.guild?.id]) {
      const ch = client.channels.cache.get(auctionChannels[message.guild.id]);
      if (ch) await ch.send({ embeds: [embed] });
    }

    return message.channel.send({ embeds: [embed] });
  }

  // ── !setpayout ────────────────────────────────────────────────────────────
  if (cmd === 'setpayout') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return message.reply('Need **Manage Channels**.');

    if (args[1]?.toLowerCase() === 'stop') {
      delete payoutChannels[message.guild.id];
      const s = loadSettings(); s.payoutChannels = payoutChannels; saveSettings(s);
      return message.reply('✅ Payout announcements disabled.');
    }

    const rawId    = args[1]?.replace(/[<#>]/g, '');
    const targetCh = rawId ? client.channels.cache.get(rawId) : message.channel;
    if (!targetCh) return message.reply('❌ Channel not found.');

    payoutChannels[message.guild.id] = targetCh.id;
    const s = loadSettings(); s.payoutChannels = payoutChannels; saveSettings(s);

    // Initialise reset timestamps anchored to next Stockholm midnight
    const state = loadPayoutState();
    if (!state.dailyEndsAt)  state.dailyEndsAt  = getNextMidnight();
    if (!state.weeklyEndsAt) state.weeklyEndsAt = getNextMidnight() + 6 * 24 * 60 * 60 * 1000;
    savePayoutState(state);

    const dailyTs  = Math.floor(state.dailyEndsAt  / 1000);
    const weeklyTs = Math.floor(state.weeklyEndsAt / 1000);

    const embed = new EmbedBuilder()
      .setTitle('🏆 Claims Leaderboard — Payout Structure')
      .setDescription(
        `Payouts are sent automatically at the end of each cycle.\n` +
        `**Daily** resets at midnight Stockholm time (<t:${dailyTs}:F>).\n` +
        `**Weekly** resets every 7 days (<t:${weeklyTs}:F>).`
      )
      .addFields(
        {
          name: '🌱 Daily — Top 3 Rewards',
          value: [
            `🥇 **1st place** — ${CURRENCY_EMOJI} **${DAILY_PAYOUTS[0].toLocaleString()} ${CURRENCY_NAME}**`,
            `🥈 **2nd place** — ${CURRENCY_EMOJI} **${DAILY_PAYOUTS[1].toLocaleString()} ${CURRENCY_NAME}**`,
            `🥉 **3rd place** — ${CURRENCY_EMOJI} **${DAILY_PAYOUTS[2].toLocaleString()} ${CURRENCY_NAME}**`,
          ].join('\n'),
        },
        {
          name: '🌿 Weekly — Top 3 Rewards',
          value: [
            `🥇 **1st place** — ${CURRENCY_EMOJI} **${WEEKLY_PAYOUTS[0].toLocaleString()} ${CURRENCY_NAME}**`,
            `🥈 **2nd place** — ${CURRENCY_EMOJI} **${WEEKLY_PAYOUTS[1].toLocaleString()} ${CURRENCY_NAME}**`,
            `🥉 **3rd place** — ${CURRENCY_EMOJI} **${WEEKLY_PAYOUTS[2].toLocaleString()} ${CURRENCY_NAME}**`,
          ].join('\n'),
        },
        {
          name: '📋 How it works',
          value:
            `Claim plants to earn points on the daily and weekly leaderboards.\n` +
            `At the end of each cycle the top 3 claimers receive their coins automatically and a winner announcement is posted here.`,
        }
      )
      .setColor(0x00C853)
      .setFooter({ text: `Announcements will appear in this channel · ${SERVER_NAME}` })
      .setTimestamp();

    await targetCh.send({ embeds: [embed] });
    return message.reply(`✅ Payout announcements set → <#${targetCh.id}>.`);
  }

  // ── !setauction ───────────────────────────────────────────────────────────
  if (cmd === 'setauction') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return message.reply('Need **Manage Channels**.');
    if (args[1]?.toLowerCase() === 'stop') {
      delete auctionChannels[message.guild.id];
      const s = loadSettings(); s.auctionChannels = auctionChannels; saveSettings(s);
      return message.reply('✅ Auction channel disabled.');
    }
    const rawId = args[1]?.replace(/[<#>]/g, '');
    const targetCh = rawId ? client.channels.cache.get(rawId) : message.channel;
    if (!targetCh) return message.reply('❌ Channel not found.');
    auctionChannels[message.guild.id] = targetCh.id;
    const s = loadSettings(); s.auctionChannels = auctionChannels; saveSettings(s);
    return message.reply(`✅ Auction announcements → <#${targetCh.id}>.`);
  }

  // ── !say ──────────────────────────────────────────────────────────────────
  if (cmd === 'say') {
    if (!isBotAdmin(message.author.id)) return message.reply('Admins only.');
    const channelId = args[args.length - 1];
    const text = args.slice(1, args.length - 1).join(' ');
    if (!text || !channelId) return message.reply('Usage: `!say <text> <channelId>`');
    const target = client.channels.cache.get(channelId);
    if (!target) return message.reply('❌ Channel not found.');
    await target.send(text);
    message.delete().catch(() => {});
    return;
  }

  // ── !web ──────────────────────────────────────────────────────────────────
if (cmd === 'web') {
  return message.reply('🌿 **Sprout** — https://sproutapp.net/#');
}

  // ── !setdrop ──────────────────────────────────────────────────────────────
  if (cmd === 'setdrop') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return message.reply('Need **Manage Channels**.');
    if (args[1]?.toLowerCase() === 'stop') { delete dropChannels[message.guild.id]; delete channelActivity[message.channel.id]; const s = loadSettings(); s.dropChannels = dropChannels; saveSettings(s); return message.reply(`✅ Drops disabled.`); }
    const rawId = args[1]?.replace(/[<#>]/g, '');
    const targetCh = rawId ? client.channels.cache.get(rawId) : message.channel;
    if (!targetCh) return message.reply(`❌ Channel not found. Use a channel mention, ID, or run the command inside the target channel.`);
    dropChannels[message.guild.id] = targetCh.id;
    const s = loadSettings(); s.dropChannels = dropChannels; saveSettings(s);
    return message.reply(`✅ Activity-based drops enabled in <#${targetCh.id}>!`);
  }

  // ── !setdropchat ──────────────────────────────────────────────────────────
  if (cmd === 'setdropchat') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return message.reply('Need **Manage Channels**.');
    if (args[1]?.toLowerCase() === 'stop') {
      delete relaxedDropChannels[message.guild.id];
      const s = loadSettings(); s.relaxedDropChannels = relaxedDropChannels; saveSettings(s);
      return message.reply('✅ Relaxed drop channel disabled.');
    }
    const rawId = args[1]?.replace(/[<#>]/g, '');
    const targetCh = rawId ? client.channels.cache.get(rawId) : message.channel;
    if (!targetCh) return message.reply('❌ Channel not found.');
    relaxedDropChannels[message.guild.id] = targetCh.id;
    const s = loadSettings(); s.relaxedDropChannels = relaxedDropChannels; saveSettings(s);
    return message.reply(`✅ Relaxed drop channel set to <#${targetCh.id}> — drops will appear but all commands still work.`);
  }

  // ── !setvping ─────────────────────────────────────────────────────────────
  if (cmd === 'setvping') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return message.reply('Need **Manage Channels**.');
    if (args[1]?.toLowerCase() === 'stop') { delete vPingChannels[message.guild.id]; const s = loadSettings(); s.vPingChannels = vPingChannels; saveSettings(s); return message.reply('✅ v1 pings disabled.'); }
    const rawId = args[1]?.replace(/[<#>]/g, ''), targetCh = rawId ? client.channels.cache.get(rawId) : message.channel;
    if (!targetCh) return message.reply(`❌ Channel not found.`);
    vPingChannels[message.guild.id] = targetCh.id;
    const s = loadSettings(); s.vPingChannels = vPingChannels; saveSettings(s);
    return message.reply(`✅ v1 pings → <#${targetCh.id}>.`);
  }

  // ── !lock / !unlock ───────────────────────────────────────────────────────
  if (cmd === 'lock' || cmd === 'unlock') {
    const raw = args.slice(1).join(' ');
    const vMatch = raw.match(/-v\s*(\d+)/i);
    const mMatch = raw.match(/-m\s+([a-z]+)/i);
    const rMatch = raw.match(/-r\s+([a-z]+)/i);
    const plantName = raw.replace(/-v\s*\d+/i,'').replace(/-m\s+\S+/i,'').replace(/-r\s+\S+/i,'').trim();

    if (!plantName && !rMatch && !mMatch) return message.reply(
      `Usage: \`!lock <plant name> [-v version] [-m mutation] [-r rarity]\`\n` +
      `Examples:\n` +
      `\`!lock Carrot\` — lock all carrots\n` +
      `\`!lock Carrot -v 1\` — lock carrot v1 specifically\n` +
      `\`!lock -r legendary\` — lock all legendaries\n` +
      `\`!lock -m starstruck\` — lock all starstruck plants`
    );

    const lockEntry = {};
    if (plantName) lockEntry.name = plantName;
    if (vMatch) lockEntry.version = parseInt(vMatch[1]);
    if (mMatch) lockEntry.mutation = mMatch[1].toLowerCase();
    if (rMatch) lockEntry.rarity = rMatch[1].toLowerCase();

    const locks = loadLocks(message.author.id);

    if (cmd === 'lock') {
      if (plantName) {
        const db = loadDB(); const user = getUser(db, message.author.id);
        const exists = PLANTS.some(p => p.name.toLowerCase() === plantName.toLowerCase());
        if (!exists) return message.reply(`❌ **${plantName}** isn't a plant. Check your spelling!`);
        const owned = user.collection.some(p => p.name.toLowerCase() === plantName.toLowerCase());
        if (!owned) return message.reply(`❌ You don't own any **${plantName}**.`);
      }
      const already = locks.some(l => JSON.stringify(l) === JSON.stringify(lockEntry));
      if (already) return message.reply('That lock already exists.');
      locks.push(lockEntry);
      saveLocks(message.author.id, locks);
      const desc = Object.entries(lockEntry).map(([k,v]) => `${k}: **${v}**`).join('  ·  ');
      return message.reply(`🔒 Locked — ${desc}`);
    } else {
      const before = locks.length;
      const filtered = locks.filter(l => JSON.stringify(l) !== JSON.stringify(lockEntry));
      if (filtered.length === before) return message.reply('No matching lock found.');
      saveLocks(message.author.id, filtered);
      const desc = Object.entries(lockEntry).map(([k,v]) => `${k}: **${v}**`).join('  ·  ');
      return message.reply(`🔓 Unlocked — ${desc}`);
    }
  }

  // ── !locks ────────────────────────────────────────────────────────────────
  if (cmd === 'locks') {
    const locks = loadLocks(message.author.id);
    if (!locks.length) return message.reply('You have no locks set.');
    const lines = locks.map((l, i) => {
      const desc = Object.entries(l).map(([k,v]) => `${k}: **${v}**`).join('  ·  ');
      return `\`${i+1}.\` ${desc}`;
    });
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle('🔒 Your Locks')
      .setDescription(lines.join('\n'))
      .setFooter({ text: '!unlock <same filters> to remove a lock  ·  !cleanlocks to remove ghost locks' })
      .setColor(0x4d96ff)
    ]});
  }

  // ── !cleanlocks ───────────────────────────────────────────────────────────
  if (cmd === 'cleanlocks') {
    const db = loadDB();
    const user = getUser(db, message.author.id);
    const locks = loadLocks(message.author.id);
    const cleaned = locks.filter(l => {
      if (!l.name) return true; // keep rarity/mutation-only locks
      return user.collection.some(p => p.name.toLowerCase() === l.name.toLowerCase());
    });
    const removed = locks.length - cleaned.length;
    saveLocks(message.author.id, cleaned);
    if (!removed) return message.reply('No ghost locks found — all your locks match plants you own.');
    return message.reply(`🧹 Removed **${removed}** ghost lock${removed !== 1 ? 's' : ''} for plants you no longer own.`);
  }

  // ── !togglev10 ────────────────────────────────────────────────────────────
  if (cmd === 'togglev10') { if (!isBotAdmin(message.author.id)) return message.reply('Admins only.');
    sellbatchV10Protection = !sellbatchV10Protection;
    return message.reply(`✅ Sellbatch v1–v10 protection is now **${sellbatchV10Protection ? 'ON' : 'OFF'}**.`);
  }

  // ── !wipecards ────────────────────────────────────────────────────────────
  if (cmd === 'wipecards') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const target = await resolveTarget(message, args[1]);
    if (!target) return message.reply('Usage: `!wipecards @user`');
    const CONFIRM_PHRASE = `WIPECARDS-${target.id.slice(-6).toUpperCase()}`;
    pendingWipes[`cards_${message.author.id}`] = { targetId: target.id, targetName: target.username, phrase: CONFIRM_PHRASE, ts: Date.now() };
    setTimeout(() => delete pendingWipes[`cards_${message.author.id}`], 60_000);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle(`🗑️  Wipe Cards — ${target.username}`).setDescription(`**This will delete all plants from ${target.username}'s collection.**\n\nTo confirm:\n\`\`\`\n${CONFIRM_PHRASE}\n\`\`\`\n60 seconds.`).setColor(0xFF6600)] });
  }


  // ── !wipeall ──────────────────────────────────────────────────────────────
  if (cmd === 'wipeall') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const CONFIRM_PHRASE = `WIPE-${message.guild.id.slice(-6).toUpperCase()}`;
    pendingWipes[message.author.id] = { guildId: message.guild.id, phrase: CONFIRM_PHRASE, ts: Date.now() };
    setTimeout(() => delete pendingWipes[message.author.id], 60_000);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle('☢️  NUCLEAR DATA WIPE').setDescription(`**This cannot be undone.**\n\nTo confirm:\n\`\`\`\n${CONFIRM_PHRASE}\n\`\`\`\n60 seconds.`).setColor(0xFF0000)] });
  }

  // ── !drop ─────────────────────────────────────────────────────────────────
  if (cmd === 'drop') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('Need **Manage Messages**.');
    const dropArgs = args.slice(1).join(' ');
    const rMatch = dropArgs.match(/-r\s+([a-z]+)/i), pMatch = dropArgs.match(/-p\s+"([^"]+)"|(-p\s+([A-Za-z ]+?)(?:\s+-[rpm]|$))/i), mMatch = dropArgs.match(/-m\s+([a-z]+)/i);
    await sendDrop(message.channel, { rarityName: rMatch ? rMatch[1] : null, plantName: pMatch ? (pMatch[1] || pMatch[3]?.trim()) : null, mutationName: mMatch ? mMatch[1] : null });
    return;
  }

  if (cmd === 'weather') {
  const w = getActiveWeather();
  if (!w) return message.reply('☀️ No weather event is currently active.');
  const remaining = w.endsAt - Date.now();
  const mins = Math.ceil(remaining / 60000);
  return message.channel.send({ embeds: [new EmbedBuilder()
    .setTitle(`${w.emoji} Current Weather — ${w.name}`)
    .setDescription(`${w.desc}\n\nEnds in **${mins}m**.`)
    .setColor(w.color)
  ]});
}

  // ── !forceweather ─────────────────────────────────────────────────────────
  if (cmd === 'forceweather' || cmd === 'setweather') {
    if (!isBotAdmin(message.author.id)) return message.reply('Admins only.');
    const arg = args.slice(1).join(' ').trim();

    if (!arg || arg.toLowerCase() === 'random') {
      await sendWeatherEvent(message.channel);
      return;
    }

    if (arg.toLowerCase() === 'clear' || arg.toLowerCase() === 'stop') {
      currentWeather = null;
      return message.reply('✅ Weather cleared.');
    }

    const match = WEATHER_TYPES.find(w => w.name.toLowerCase() === arg.toLowerCase());
    if (!match) {
      return message.reply(`❌ Unknown weather. Options: ${WEATHER_TYPES.map(w => w.name).join(', ')}, \`random\`, \`clear\``);
    }

    await sendWeatherEvent(message.channel, match);
    return;
  }

  // ── !setrarity ────────────────────────────────────────────────────────────
  if (cmd === 'setrarity') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    if (!args[1] || args[1] === 'clear') { devRarity = null; return message.reply('🔧 Dev rarity cleared.'); }
    const match = RARITIES.find(r => r.name.toLowerCase() === args[1].toLowerCase());
    if (!match) return message.reply(`Options: ${RARITIES.map(r=>r.name).join(', ')}`);
    devRarity = match.name; return message.reply(`🔧 Drops locked to **${match.name}** ${match.emoji}`);
  }

  // ── !level / !lvl ─────────────────────────────────────────────────────────
  if (cmd === 'level' || cmd === 'lvl') {
    const target = (await resolveTarget(message, args[1])) || message.author;
    const db = loadDB(); const user = getUser(db, target.id);
    const { level, needed, progress, pct } = xpToNextLevel(user.xp || 0);
    const rank = getRank(level), title = getActiveTitle(user);
    const allUsers = Object.entries(db).filter(([id]) => !TEST_IDS.has(id)).map(([id,u]) => ({ id, xp: u.xp||0 })).sort((a,b) => b.xp-a.xp);
    const serverRank = allUsers.findIndex(e => e.id === target.id) + 1;
    const imgBuf = await generateLevelCardImage({ username: target.username, avatarUrl: target.displayAvatarURL({ extension: 'png', size: 128 }), level, pct, needed, progress, rankEmoji: rank.emoji, rankName: rank.name, title, totalXp: user.xp || 0, serverRank, serverTotal: allUsers.length });
    const att = new AttachmentBuilder(imgBuf, { name: 'level.png' });
    return message.channel.send({ files: [att], embeds: [new EmbedBuilder().setImage('attachment://level.png').setColor(0x5C6BC0)] });
  }

  // ── !levellb / !llb ───────────────────────────────────────────────────────
  if (cmd === 'levellb' || cmd === 'llb') {
    const page = parseInt(args[1]) || 1, db = loadDB();
    const { entries, totalPages } = await buildLevelLBData(db, page);
    if (!entries.length) return message.reply('No data yet!');
    const imgBuffer = await generateLevelLBImage(entries);
    const attachment = new AttachmentBuilder(imgBuffer, { name: 'levellb.png' });
    return message.channel.send({ embeds: [new EmbedBuilder().setImage('attachment://levellb.png').setFooter({ text: `Page ${page} of ${totalPages}  •  !llb <page>` }).setColor(0x5C6BC0)], files: [attachment] });
  }

  // ── !profile / !prof ──────────────────────────────────────────────────────
  if (cmd === 'profile' || cmd === 'prof') {
    let target = message.mentions.users.first();
    if (!target && args[1]) { try { target = await client.users.fetch(args[1]); } catch {} }
    target = target || message.author;
    const db = loadDB(); const user = getUser(db, target.id);
    const { level, pct } = xpToNextLevel(user.xp || 0);
    const rank = getRank(level), title = getActiveTitle(user);
    const allUsers = Object.entries(db).map(([id, u]) => ({ id, xp: u.xp||0 })).sort((a,b)=>b.xp-a.xp);
    const serverRank = allUsers.findIndex(e => e.id === target.id) + 1;
    const gardenScore = calcWeightedGardenScore(user.collection);
    const gardenTier  = getGardenTier(gardenScore);
    const imgBuf = await generateProfileImage({ username: target.username, avatarUrl: target.displayAvatarURL({ extension: 'png', size: 128 }), level, pct, rankEmoji: rank.emoji, rankName: rank.name, title, balance: user.currency, plants: user.collection.length, achievements: user.achievements.length, totalAchievements: Object.keys(ACHIEVEMENTS).length, equippedCharms: user.equippedCharms.map(k => CHARMS[k]?.emoji || '').filter(Boolean), totalXp: user.xp || 0, serverRank, serverTotal: allUsers.length, gardenScore, gardenTier });
    const att = new AttachmentBuilder(imgBuf, { name: 'profile.png' });
    return message.channel.send({ files: [att], embeds: [new EmbedBuilder().setImage('attachment://profile.png').setColor(0x4d96ff)] });
  }

  // ── !invlb ────────────────────────────────────────────────────────────────
  if (cmd === 'invlb' || cmd === 'ilb') {
    const db = loadDB();
    const scored = await Promise.all(
      Object.entries(db).filter(([id]) => !TEST_IDS.has(id)).map(async ([id, u]) => {
        const score = calcWeightedGardenScore(u.collection || []);
        let username = `User#${id.slice(-4)}`;
        let avatarURL = null;
        try { const discordUser = await client.users.fetch(id); username = discordUser.username; avatarURL = discordUser.displayAvatarURL({ extension: 'png', size: 64 }); } catch {}
        return { id, score, username, plantCount: (u.collection || []).length, tier: getGardenTier(score), avatarURL, rainbowTag: !!(u.rainbowTag && u.rainbowTag.expiresAt > Date.now()) };
      })
    );
    const sorted = scored.filter(e => e.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
    if (!sorted.length) return message.reply('No garden data yet!');
    const imgBuf = await generateInvLBImage(sorted);
    const att    = new AttachmentBuilder(imgBuf, { name: 'invlb.png' });
    return message.channel.send({ embeds: [new EmbedBuilder().setImage('attachment://invlb.png').setFooter({ text: `Garden Rankings  ·  !invlb` }).setColor(0x9B59B6)], files: [att] });
  }

  // ── !testrank — admin: preview all 9 garden tiers in one image ────────────
  if (cmd === 'testrank') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    // Build a fake leaderboard with one entry per tier, scores set just above each threshold
    const fakeEntries = GARDEN_TIERS.map((tier, i) => ({
      username:   `[${tier.name} Preview]`,
      score:      tier.minScore === 0 ? 0 : tier.minScore,
      plantCount: 0,
      tier,
    })).reverse(); // show highest tier first
    const imgBuf = await generateInvLBImage(fakeEntries);
    const att    = new AttachmentBuilder(imgBuf, { name: 'testrank.png' });

    // Also send a text summary so it's easy to see thresholds
    const lines = [...GARDEN_TIERS].reverse().map(t =>
      `${t.emoji} **${t.name}** — score ≥ \`${t.minScore.toLocaleString()}\``
    );
    return message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🛠️ Garden Tier Preview')
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Replace tier emojis in GARDEN_TIERS to update icons' })
          .setColor(0x9B59B6),
        new EmbedBuilder().setImage('attachment://testrank.png').setColor(0x9B59B6),
      ],
      files: [att],
    });
  }

  // ── !achievements / !ach ──────────────────────────────────────────────────
  if (cmd === 'achievements' || cmd === 'ach') {
    const target = (await resolveTarget(message, args[1])) || message.author;
    const db = loadDB(); const user = getUser(db, target.id);
    const lines = Object.entries(ACHIEVEMENTS).map(([key, a]) => { const done = user.achievements.includes(key); return `${done ? a.emoji : '⬛'} **${a.name}** — ${a.description}${done ? '' : ' *(locked)*'}`; });
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle(`🏅 ${target.username}'s Achievements (${user.achievements.length}/${Object.keys(ACHIEVEMENTS).length})`).setDescription(lines.join('\n')).setColor(0xFFD700)] });
  }

  // ── !settitle / !title ────────────────────────────────────────────────────
  if (cmd === 'settitle' || cmd === 'title') {
    const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
    if (!args[1] || args[1] === 'none') { user.activeTitle = null; saveDB(db); return message.reply('Title cleared.'); }
    const key = args[1].toLowerCase();
    if (!user.titles.includes(key)) return message.reply(`You don't own that title.`);
    user.activeTitle = key; saveDB(db);
    return message.reply(`✅ Title set to **${getActiveTitle(user)}**`);
  }

  // ── !titles ───────────────────────────────────────────────────────────────
  if (cmd === 'titles') {
    const target = (await resolveTarget(message, args[1])) || message.author;
    const db = loadDB(); const user = getUser(db, target.id);
    if (!user.titles.length) return message.reply(`${target.username} has no titles yet!`);
    const lines = user.titles.map(key => { const ach = ACHIEVEMENTS[key]; const st = SHOP_TITLES[key]; if (ach) return `${ach.emoji} **${ach.title}** *(Achievement)*`; if (st) return `${st.emoji} **${st.name}** *(Purchased)*`; return key; });
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle(`🏷️ ${target.username}'s Titles`).setDescription(lines.join('\n') + '\n\nUse `!title <key>` to equip one.').setColor(0x7289DA)] });
  }

  if (cmd === 'setrace') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('Need **Manage Messages**.');
    const seconds = parseInt(args[1]);
    if (!seconds || seconds < 5 || seconds > 300) return message.reply('Usage: `!setrace <seconds>` (5–300)');
    raceTimer = seconds;
    return message.reply(`✅ Race timer set to **${raceTimer} seconds**.`);
  }

  // ── !race ─────────────────────────────────────────────────────────────────
  if (cmd === 'race') {
    if (activeRaces[message.channel.id]) return message.reply('A race is already active!');
    const captcha = randomCaptcha(6), startTime = Date.now();
    const W = 480, H = 160, rCanvas = createCanvas(W, H), rCtx = rCanvas.getContext('2d');
    rCtx.fillStyle = '#0d0d0d'; rCtx.fillRect(0, 0, W, H);
    const barGrad = rCtx.createLinearGradient(0, 0, W, 0); barGrad.addColorStop(0, '#FFAA00'); barGrad.addColorStop(1, '#ff6b6b');
    rCtx.fillStyle = barGrad; rCtx.fillRect(0, 0, W, 4);
    rCtx.font = '13px Arial'; rCtx.fillStyle = 'rgba(255,255,255,0.35)'; rCtx.textBaseline = 'top';
    rCtx.fillText('type the captcha to win  ·  first 5 finish', 16, 14);
    const colors = ['#ffffff','#ffffff','#ffffff','#ffffff','#ffffff','#ffffff'], letters = captcha.split('');
    const CHAR_W = 68, startX = (W - letters.length * CHAR_W) / 2 + CHAR_W * 0.4, midY = H / 2 + 12;
    letters.forEach((char, i) => { rCtx.save(); rCtx.font = 'bold 64px Arial'; rCtx.fillStyle = colors[i % colors.length]; rCtx.shadowColor = colors[i % colors.length]; rCtx.shadowBlur = 14; rCtx.textBaseline = 'middle'; rCtx.translate(startX + i * CHAR_W, midY + (Math.random() - 0.5) * 6); rCtx.rotate((Math.random() - 0.5) * 0.12); rCtx.fillText(char, 0, 0); rCtx.restore(); });
    for (let i = 0; i < 18; i++) { rCtx.fillStyle = `rgba(255,255,255,${Math.random() * 0.06})`; rCtx.beginPath(); rCtx.arc(Math.random() * W, Math.random() * H, Math.random() * 2, 0, Math.PI * 2); rCtx.fill(); }
    const rImgBuf = rCanvas.toBuffer('image/png'), rAtt = new AttachmentBuilder(rImgBuf, { name: 'race.png' });
    const msg = await message.channel.send({ embeds: [new EmbedBuilder().setImage('attachment://race.png').setColor(0xFFAA00)], files: [rAtt] });
    activeRaces[message.channel.id] = { captcha, messageId: msg.id, startTime, finishers: [] };
    setTimeout(async () => { const r = activeRaces[message.channel.id]; if (r && r.messageId === msg.id) await endRace(message.channel, r); }, raceTimer * 1000);
    return; 
  }

  // ── !racelb / !rlb ────────────────────────────────────────────────────────
  if (cmd === 'racelb' || cmd === 'rlb') {
    const lb = loadRaceLB().slice(0, 10);
    if (!lb.length) return message.reply('No race times yet!');
    const db = loadDB();
    const now = Date.now();
    const imgBuf = generateRaceLBImage(lb.map(e => ({ username: e.username, bestTime: e.bestTime, rainbowTag: !!(db[e.userId]?.rainbowTag && db[e.userId].rainbowTag.expiresAt > now) })));
    const att    = new AttachmentBuilder(imgBuf, { name: 'racelb.png' });
    return message.channel.send({ embeds: [new EmbedBuilder().setImage('attachment://racelb.png').setFooter({ text: `Top ${lb.length} Racers  ·  !rlb` }).setColor(0xFFAA00)], files: [att] });
  }

  if (cmd === 'dailylb' || cmd === 'dlb') {
  const lb = loadClaimsLB();
  const db = loadDB();
  const now = Date.now();
  const payoutState = loadPayoutState();
  const DAY = 24 * 60 * 60 * 1000;
  const dailyStart = payoutState.dailyEndsAt ? payoutState.dailyEndsAt - DAY : Date.now() - DAY;
  const sorted = lb
    .map(e => ({ username: e.username, count: getClaimsSince(e.claims, dailyStart), userId: e.userId, rainbowTag: !!(db[e.userId]?.rainbowTag && db[e.userId].rainbowTag.expiresAt > now) }))
      .filter(e => e.count > 0 && !TEST_IDS.has(e.userId))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    if (!sorted.length) return message.reply('No claims in the last 24 hours!');
    const imgBuf = generateClaimsLBImage(sorted, '🌱 Daily Claims', 'Claims in the last 24 hours  ·  !dailylb');
    const att = new AttachmentBuilder(imgBuf, { name: 'dailylb.png' });
    return message.channel.send({ embeds: [new EmbedBuilder().setImage('attachment://dailylb.png').setColor(0x00C853)], files: [att] });
  }

  if (cmd === 'weeklylb' || cmd === 'wlb') {
    const lb = loadClaimsLB();
    const db = loadDB();
    const now = Date.now();
    const WEEK = 7 * 24 * 60 * 60 * 1000;
  const payoutState = loadPayoutState();
  const weeklyStart = payoutState.weeklyEndsAt ? payoutState.weeklyEndsAt - WEEK : Date.now() - WEEK;
  const sorted = lb
    .map(e => ({ username: e.username, count: getClaimsSince(e.claims, weeklyStart), userId: e.userId, rainbowTag: !!(db[e.userId]?.rainbowTag && db[e.userId].rainbowTag.expiresAt > now) }))
      .filter(e => e.count > 0 && !TEST_IDS.has(e.userId))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    if (!sorted.length) return message.reply('No claims in the last 167 hours!');
    const imgBuf = generateClaimsLBImage(sorted, '🌿 Weekly Claims', 'Claims in the last 167 hours  ·  !weeklylb');
    const att = new AttachmentBuilder(imgBuf, { name: 'weeklylb.png' });
    return message.channel.send({ embeds: [new EmbedBuilder().setImage('attachment://weeklylb.png').setColor(0x4CAF50)], files: [att] });
  }

  // ── !moneylb / !mlb ───────────────────────────────────────────────────────
  if (cmd === 'moneylb' || cmd === 'mlb') {
    const db = loadDB();
    const sorted = Object.entries(db).filter(([id]) => !TEST_IDS.has(id)).map(([id,u]) => ({ id, currency: u.currency||0 })).sort((a,b) => b.currency-a.currency).slice(0, 10);
    const entries = await Promise.all(sorted.map(async (e) => { let username = `User#${e.id.slice(-4)}`; try { const u = await client.users.fetch(e.id); username = u.username; } catch {} return { username, currency: e.currency }; }));
    const imgBuf = generateMoneyLBImage(entries);
    const att    = new AttachmentBuilder(imgBuf, { name: 'moneylb.png' });
    return message.channel.send({ embeds: [new EmbedBuilder().setImage('attachment://moneylb.png').setFooter({ text: `Top ${entries.length} Richest  ·  !mlb` }).setColor(0x00C853)], files: [att] });
  }

  // ── !inventory / !inv ─────────────────────────────────────────────────────
  if (cmd === 'inventory' || cmd === 'inv') {
    const target = (await resolveTarget(message, args[1])) || message.author;
    const db = loadDB(); const user = getUser(db, target.id);
    if (!user.collection.length) return message.reply(`${target.username} has no plants yet.`);
    const rawArgs = args.slice(1).join(' ');
    let versionFilter = null;
    const verMatch = rawArgs.match(/-version\s*([<>=!]+)\s*(\d+)/i);
    if (verMatch) versionFilter = { op: verMatch[1], n: parseInt(verMatch[2]) };
    let mutationFilter = null, rarityFilter = null;
    const mutMatch = rawArgs.match(/-m\s+([a-z]+)/i), rarMatch = rawArgs.match(/-r\s+([a-z]+)/i);
    if (mutMatch) mutationFilter = mutMatch[1].toLowerCase();
    if (rarMatch) rarityFilter = rarMatch[1].toLowerCase();

    // Plant name filter — any word/phrase that matches a known plant name
    const cleanForPlant = rawArgs.replace(/-version\s*[<>=!]+\s*\d+/i,'').replace(/-m\s+\S+/i,'').replace(/-r\s+\S+/i,'').replace(/<@!?\d+>/g,'').replace(/\b\d{17,20}\b/,'').trim();
    const matchedPlant = PLANTS.find(p => cleanForPlant.toLowerCase().includes(p.name.toLowerCase()));
    const plantNameFilter = matchedPlant ? matchedPlant.name : null;

    const cleanArgs = cleanForPlant.replace(plantNameFilter || '', '').trim();
    const pageArg = parseInt(cleanArgs) || 1;
    const RARITY_SORT = ['Secret','Super','Mythic','Legendary','Epic','Rare','Uncommon','Common'];
    let filtered = [...user.collection].sort((a, b) => { const ri = RARITY_SORT.indexOf(a.rarity) - RARITY_SORT.indexOf(b.rarity); if (ri !== 0) return ri; return (a.version || 999) - (b.version || 999); });
    if (versionFilter) { const { op, n } = versionFilter; filtered = filtered.filter(p => { const v = p.version || 0; if (op==='>'||op==='gt') return v>n; if (op==='>='||op==='gte') return v>=n; if (op==='<'||op==='lt') return v<n; if (op==='<='||op==='lte') return v<=n; if (op==='='||op==='==') return v===n; return true; }); }
    if (mutationFilter) { if (mutationFilter === 'none') filtered = filtered.filter(p => !p.mutation); else filtered = filtered.filter(p => p.mutation && p.mutation.name.toLowerCase() === mutationFilter); }
    if (rarityFilter) filtered = filtered.filter(p => p.rarity.toLowerCase().startsWith(rarityFilter));
    if (plantNameFilter) filtered = filtered.filter(p => p.name.toLowerCase() === plantNameFilter.toLowerCase());
    if (!filtered.length) return message.reply('No plants match those filters.');
    const gardenScore = calcWeightedGardenScore(user.collection);
    const gardenTier  = getGardenTier(gardenScore);
    const PER_PAGE = 10, totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
const defaultPage = 1;
const page = Math.max(1, Math.min(pageArg, totalPages));
    const slice = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    const filterParts = [];
    if (versionFilter)  filterParts.push(`v${versionFilter.op}${versionFilter.n}`);
    if (mutationFilter) filterParts.push(`mut:${mutationFilter}`);
    if (rarityFilter)   filterParts.push(`rarity:${rarityFilter}`);
    if (plantNameFilter) filterParts.push(`plant:${plantNameFilter}`);
    const filterStr = filterParts.length ? `  ·  filter: ${filterParts.join(' + ')}` : '';
    const topRarity = getRarityConfig(slice[0].rarity);
    const lines = slice.map((p, i) => {
      const rCfg = getRarityConfig(p.rarity), mutBadge = p.mutation ? ` ${p.mutation.emoji} **${p.mutation.name}**` : '', verStr = p.version === 1 ? '`v1` 🔖' : `\`v${p.version || '?'}\``;
      const num = (page - 1) * PER_PAGE + i + 1;
      const sellVal = p.sellValue || rCfg.sellPrice;
      const lockBadge = isLocked(message.author.id, p) ? ' `[L]`' : '';
return `\`${String(num).padStart(2, ' ')}.\` ${rCfg.emoji} **${p.name}** ${verStr}${mutBadge}${lockBadge} — ${CURRENCY_EMOJI} ${sellVal.toLocaleString()}`;
    });
    const tierHex = '#' + gardenTier.color.toString(16).padStart(6, '0');
    const statsLine = `**${target.username}** · ${user.collection.length} plants · ${gardenTier.emoji} **${gardenTier.name}** · Score: **${gardenScore.toLocaleString()}**`;

    function buildInvEmbed(p) {
      const sl = filtered.slice((p - 1) * PER_PAGE, p * PER_PAGE);
      const tR = getRarityConfig(sl[0].rarity);
      const ls = sl.map((plant, i) => {
        const rCfg = getRarityConfig(plant.rarity), mutBadge = plant.mutation ? ` ${plant.mutation.emoji} **${plant.mutation.name}**` : '', verStr = plant.version === 1 ? '`v1` 🔖' : `\`v${plant.version || '?'}\``;
        const num = (p - 1) * PER_PAGE + i + 1;
        const sellVal = getLiveSellValue(plant);
        const lockBadge = isLocked(message.author.id, plant) ? ' `[L]`' : '';
        return `\`${String(num).padStart(2, ' ')}.\` ${rCfg.emoji} **${plant.name}** ${verStr}${mutBadge}${lockBadge} — ${CURRENCY_EMOJI} ${sellVal.toLocaleString()}`;
      });
      return new EmbedBuilder()
        .setTitle(`🎒 Inventory — Page ${p}/${totalPages}${filterStr}`)
        .setDescription(statsLine + '\n\u200b\n' + ls.join('\n'))
        .setColor(tR.color)
        .setFooter({ text: `Showing ${filtered.length} plants  ·  !inv [page] [-r rarity] [-m mutation] [-version op#]` });
    }

    function buildInvRow(p) {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('inv_prev').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(p <= 1),
        new ButtonBuilder().setCustomId('inv_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(p >= totalPages)
      );
    }

    if (totalPages <= 1) {
      return message.channel.send({ embeds: [buildInvEmbed(page)] });
    }

    const invMsg = await message.channel.send({ embeds: [buildInvEmbed(page)], components: [buildInvRow(page)] });
    let currentInvPage = page;
    const invCollector = invMsg.createMessageComponentCollector({ time: 120_000 });
    invCollector.on('collect', async interaction => {
      if (interaction.user.id !== message.author.id) {
        return interaction.reply({ content: '❌ Only the person who ran this command can flip pages.', ephemeral: true });
      }
      if (interaction.customId === 'inv_prev') currentInvPage = Math.max(1, currentInvPage - 1);
      if (interaction.customId === 'inv_next') currentInvPage = Math.min(totalPages, currentInvPage + 1);
      await interaction.update({ embeds: [buildInvEmbed(currentInvPage)], components: [buildInvRow(currentInvPage)] });
    });
    invCollector.on('end', () => {
      invMsg.edit({ components: [] }).catch(() => {});
    });
    return;
  }

  // ── !view <plant> [-v <version>] ─────────────────────────────────────────
  if (cmd === 'view') {
    const rawView = args.slice(1).join(' '), vvMatch = rawView.match(/-v\s*(\d+)/i), vFilter = vvMatch ? parseInt(vvMatch[1]) : null;
    const plantName = rawView.replace(/-v\s*\d+/i, '').trim();
    if (!plantName) return message.reply('Usage: `!view <plant name> [-v version]`');
    const plant = PLANTS.find(p => p.name.toLowerCase() === plantName.toLowerCase());
    if (!plant) return message.reply(`Plant **${plantName}** not found.`);
    const rCfg = getRarityConfig(plant.rarity), db = loadDB(), user = getUser(db, message.author.id);
    let owned = user.collection.filter(p => p.name === plant.name);
    if (vFilter !== null) owned = owned.filter(p => p.version === vFilter);
    const mktMult = getMarketMultiplier(plant.name);
    const mktStr = mktMult > 1.05 ? `📈 +${Math.round((mktMult-1)*100)}% demand` : mktMult < 0.95 ? `📉 ${Math.round((mktMult-1)*100)}% demand` : `📊 Normal demand`;
    let copiesLines = !owned.length ? (vFilter !== null ? `*You don't own v${vFilter} of this plant.*` : '*None owned.*') : owned.map(p => { const base = `${rCfg.emoji} **${plant.name}** \`v${p.version}\``; return p.mutation ? `${base}  ${p.mutation.emoji} **${p.mutation.name}**` : base; }).join('\n');

    // Find who owns this plant server-wide
    const allOwners = [];
    for (const [uid, userData] of Object.entries(db)) {
      for (const p of (userData.collection || [])) {
        if (p.name !== plant.name) continue;
        if (vFilter !== null && p.version !== vFilter) continue;
        const uname = userData.username || `User#${uid.slice(-4)}`;
        const mutStr = p.mutation ? ` ${p.mutation.emoji} ${p.mutation.name}` : '';
        allOwners.push(`<@${uid}>${mutStr}`);
      }
    }
    const ownedByLine = allOwners.length ? `*Owned by: ${allOwners.join('  ·  ')}*` : '*Not owned by anyone yet.*';

    const viewAttach = new AttachmentBuilder(`${IMAGES_DIR}/${plant.display}`, { name: plant.display });
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle(vFilter !== null ? `${rCfg.emoji} ${plant.name} — v${vFilter}` : `${rCfg.emoji} ${plant.name}`).setDescription(`${mktStr}  ·  You own **${owned.length}** cop${owned.length!==1?'ies':'y'}\n\n${copiesLines}\n\n${ownedByLine}\n\n*\`!sell ${plant.name}\` to sell one*`).setImage(`attachment://${plant.display}`).setColor(rCfg.color).setFooter({ text: `Plant Showcase  •  ${plant.name}` })], files: [viewAttach] });
  }

  // ── !sell / !s — with optional -v <version> flag ──────────────────────────
  if (cmd === 'sell' || cmd === 's') {
    if (args[1]?.toLowerCase() === 'all') {
      const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
      if (!user.collection.length) return message.reply('You have no plants to sell.');
      const sellable = user.collection.filter(p => !isLocked(message.author.id, p));
      const locked = user.collection.length - sellable.length;
      const totalVal = sellable.reduce((sum, p) => sum + (p.sellValue || getRarityConfig(p.rarity).sellPrice), 0);
      const CONFIRM_PHRASE = `SELLALL-${message.author.id.slice(-4).toUpperCase()}`;
      pendingWipes[`sellall_${message.author.id}`] = { phrase: CONFIRM_PHRASE, ts: Date.now() };
      setTimeout(() => delete pendingWipes[`sellall_${message.author.id}`], 60_000);
      if (!sellable.length) return message.reply('All your plants are locked — nothing to sell.');
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('⚠️  Sell Entire Inventory?')
        .setDescription(
          `**This will sell ${sellable.length} plants for ${fmt(totalVal)}.**${locked > 0 ? `\n🔒 ${locked} locked plant${locked !== 1 ? 's' : ''} will be kept.` : ''}\n\n` +
          `This **cannot be undone**.\n\nTo confirm, type:\n\`\`\`\n${CONFIRM_PHRASE}\n\`\`\`\n60 seconds.`
        )
        .setColor(0xFF0000)
      ]});
    }
    const rawSell = args.slice(1).join(' ');
    const vSellMatch = rawSell.match(/-v\s*(\d+)/i);
    const vSellFilter = vSellMatch ? parseInt(vSellMatch[1]) : null;
    let plantName = rawSell.replace(/-v\s*\d+/i, '').trim();
    // Strip trailing "all" keyword before doing the plant name lookup
    const hasSellAll = /\ball\b$/i.test(plantName);
    if (hasSellAll) plantName = plantName.replace(/\s*\ball\b$/i, '').trim();
    if (!plantName) return message.reply('Usage: `!sell <plant name> [-v version]`');
    const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });

    // Collect all matching plants
    let candidates = user.collection
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.name.toLowerCase() === plantName.toLowerCase());

    if (vSellFilter !== null) {
      candidates = candidates.filter(({ p }) => p.version === vSellFilter);
    }

    if (!candidates.length) {
      const allOwned = user.collection.filter(p => p.name.toLowerCase() === plantName.toLowerCase());
      if (allOwned.length > 0 && vSellFilter !== null) return message.reply(`You don't own **${plantName}** v${vSellFilter}. You own: ${allOwned.map(p => `v${p.version}`).join(', ')}`);
      return message.reply(`You don't own **${plantName}**.`);
    }

    // "!sell <plant> all" — sell all copies at once
    if (hasSellAll && vSellFilter === null) {
      candidates = candidates.filter(({ p }) => !isLocked(message.author.id, p));
      if (!candidates.length) return message.reply(`All copies of **${plantName}** are locked.`);
      const rCfg      = getRarityConfig(candidates[0].p.rarity);
      const totalVal  = candidates.reduce((sum, { p }) => sum + getLiveSellValue(p), 0);
      const lines     = candidates.map(({ p }) => {
        const mutStr = p.mutation ? ` ${p.mutation.emoji} ${p.mutation.name}` : '';
        const val    = getLiveSellValue(p);
        return `\`v${p.version || '?'}\`${mutStr}  —  ${CURRENCY_EMOJI} ${val.toLocaleString()}`;
      });
      // Store all indices for the confirm handler
      pendingSells[message.author.id] = { sellAllCandidates: candidates.map(c => ({ plant: c.p, name: c.p.name, version: c.p.version })), totalVal };
      setTimeout(() => delete pendingSells[message.author.id], 30_000);
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle(`💰 Sell All ${plantName}? (${candidates.length} copies)`)
        .setDescription(lines.join('\n') + `\n\n**Total payout: ${CURRENCY_EMOJI} ${totalVal.toLocaleString()}**\n\nType \`yes\` to sell all, \`no\` to cancel. *(30s)*`)
        .setColor(rCfg.color)
      ]});
    }

    // If multiple copies and no version/all specified, show picker prompt
    if (candidates.length > 1 && vSellFilter === null) {
      const rCfg  = getRarityConfig(candidates[0].p.rarity);
      const lines = candidates.map(({ p }) => {
        const mutStr = p.mutation ? ` ${p.mutation.emoji} ${p.mutation.name}` : '';
        const val    = p.sellValue || rCfg.sellPrice;
        return `\`v${p.version || '?'}\`${mutStr}  —  ${CURRENCY_EMOJI} ${val.toLocaleString()}`;
      });
      const totalVal = candidates.reduce((sum, { p }) => sum + (p.sellValue || rCfg.sellPrice), 0);
      return message.reply({ embeds: [new EmbedBuilder()
        .setTitle(`Which **${plantName}** would you like to sell?`)
        .setDescription(
          lines.join('\n') +
          `\n\n` +
          `**Select a copy:**\n` +
          `\`!sell ${plantName} -v <version>\`  — sell a specific copy\n` +
          `\`!sell ${plantName} all\`  — sell all ${candidates.length} copies for ${CURRENCY_EMOJI} ${totalVal.toLocaleString()}`
        )
        .setColor(rCfg.color)
      ]});
    }

    

    // Single match — confirm
    if (isLocked(message.author.id, candidates[0].p)) return message.reply(`🔒 **${candidates[0].p.name}** \`v${candidates[0].p.version}\` is locked. Use \`!unlock\` to remove the lock first.`);
    const { p: plant, i: index } = candidates[0];
    const price = getLiveSellValue(plant);
    const rCfg  = getRarityConfig(plant.rarity);
    pendingSells[message.author.id] = { plant, plantName: plant.name, plantVersion: plant.version };
    setTimeout(() => delete pendingSells[message.author.id], 30_000);
    const mutLine = plant.mutation ? `\nMutation: ${plant.mutation.emoji} **${plant.mutation.name}** *(×${plant.mutation.multiplier} value)*` : '';
    const v1Note  = plant.version === 1 ? '\n🔖 *First copy — high collector value!*' : '';
    const sellEmbed = new EmbedBuilder().setTitle('💰 Confirm Sale').setDescription(`Sell **${plant.name}** \`v${plant.version || '?'}\`?\nRarity: ${rCfg.emoji} **${plant.rarity}**${mutLine}${v1Note}\n\nType \`yes\` or \`no\` *(30s)*`).setColor(rCfg.color);
    if (plant.image && fs.existsSync(`${IMAGES_DIR}/${plant.image}`)) {
      const sellAttach = new AttachmentBuilder(`${IMAGES_DIR}/${plant.image}`, { name: plant.image });
      sellEmbed.setThumbnail(`attachment://${plant.image}`);
      return message.channel.send({ embeds: [sellEmbed], files: [sellAttach] });
    }
    return message.channel.send({ embeds: [sellEmbed] });
  }

  // ── !sellbatch / !sb — sell multiple plants by filter ────────────────────
  // Usage: !sellbatch [-r rarity] [-m mutation|none] [-v op#] [-p plant name] [--confirm]
  // Without --confirm it shows a preview. With --confirm it executes.
  if (cmd === 'sellbatch' || cmd === 'sb') {
    const rawBatch = args.slice(1).join(' ');

    // Parse flags
    const rMatch  = rawBatch.match(/-r\s+([a-z]+)/i);
    const mMatch  = rawBatch.match(/-m\s+([a-z]+(?:\s+[a-z]+)?)/i);
    const vMatch  = rawBatch.match(/-v\s*([<>=!]+)\s*(\d+)/i);
    const pMatch  = rawBatch.match(/-p\s+"([^"]+)"|(?:-p\s+)([\w\s]+?)(?=\s+-|--confirm|$)/i);
    const doConfirm = rawBatch.includes('--confirm');

    const rarityFilter   = rMatch  ? rMatch[1].toLowerCase()  : null;
    const mutationFilter = mMatch  ? mMatch[1].toLowerCase()  : null;
    const vOp            = vMatch  ? vMatch[1]                : null;
    const vNum           = vMatch  ? parseInt(vMatch[2])      : null;
    const plantFilter    = pMatch  ? (pMatch[1] || pMatch[2]).trim().toLowerCase() : null;

    if (!rarityFilter && !mutationFilter && !vOp && !plantFilter) {
      return message.reply([
        '**Usage:** `!sellbatch [filters] [--confirm]`',
        'Filters (combine freely):',
        '`-r <rarity>` — e.g. `-r common`',
        '`-m <mutation>` or `-m none` — e.g. `-m starstruck`',
        '`-v <op><n>` — e.g. `-v >10` `-v >=5` `-v =3`',
        '`-p "<plant name>"` — e.g. `-p "Bell Pepper"`',
        '',
        'Without `--confirm`: shows preview of what would be sold.',
        'Add `--confirm` to actually execute the sale.',
        '',
        '**Examples:**',
        '`!sellbatch -r common` → preview all commons',
        '`!sellbatch -r common --confirm` → sell all commons',
        '`!sellbatch -v >20 -m none --confirm` → sell all v20+ without mutations',
        '`!sellbatch -p carrot -v >5 --confirm` → sell all Carrot v5+',
      ].join('\n'));
    }

    const db   = loadDB();
    const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });

    // Version comparison helper
    const passesVersion = (v) => {
      if (!vOp) return true;
      const ver = v || 0;
      if (vOp === '>'  || vOp === 'gt')  return ver >  vNum;
      if (vOp === '>=' || vOp === 'gte') return ver >= vNum;
      if (vOp === '<'  || vOp === 'lt')  return ver <  vNum;
      if (vOp === '<=' || vOp === 'lte') return ver <= vNum;
      if (vOp === '='  || vOp === '==')  return ver === vNum;
      return true;
    };

    // Build candidates — never sell v1–v10 in a batch (protected)
    const BATCH_SAFE_MIN_VER = 10;
    const candidates = user.collection
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => {
        if (sellbatchV10Protection && (p.version || 0) <= BATCH_SAFE_MIN_VER) return false;
        if (isLocked(message.author.id, p)) return false;
        if (rarityFilter   && p.rarity.toLowerCase()                    !== rarityFilter)   return false;
        if (mutationFilter && mutationFilter !== 'none' && (!p.mutation || p.mutation.name.toLowerCase() !== mutationFilter)) return false;
        if (mutationFilter === 'none' && p.mutation)                                        return false;
        if (plantFilter    && p.name.toLowerCase() !== plantFilter)                         return false;
        if (!passesVersion(p.version))                                                      return false;
        return true;
      });

    if (!candidates.length) {
      return message.reply('No plants match those filters. *(v1–v10 are always protected from batch sells.)*');
    }

    // Tally up
    const totalCoins = candidates.reduce((sum, { p }) => sum + getLiveSellValue(p), 0);

    // Build a summary grouped by rarity
    const byRarity = {};
    for (const { p } of candidates) {
      if (!byRarity[p.rarity]) byRarity[p.rarity] = 0;
      byRarity[p.rarity]++;
    }
    const RARITY_ORDER = ['Secret','Super','Mythic','Legendary','Epic','Rare','Uncommon','Common'];
    const summaryLines = RARITY_ORDER
      .filter(r => byRarity[r])
      .map(r => `${getRarityConfig(r).emoji} **${r}** × ${byRarity[r]}`);

    // Active filter summary
    const filterParts = [];
    if (rarityFilter)                  filterParts.push(`rarity: **${rarityFilter}**`);
    if (mutationFilter)                filterParts.push(`mutation: **${mutationFilter}**`);
    if (vOp)                           filterParts.push(`version **${vOp}${vNum}**`);
    if (plantFilter)                   filterParts.push(`plant: **${plantFilter}**`);
    const filterStr = filterParts.join('  ·  ');

    if (!doConfirm) {
      // Preview mode
      const protectionNote = sellbatchV10Protection
        ? `⚠️ *v1–v10 and locked plants are always excluded.*\n`
        : `🚨 *v1–v10 protection is currently OFF — only locked plants are excluded.*\n`;
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle(`🔍 Batch Sell Preview — ${candidates.length} plants`)
        .setDescription(
          `**Filters:** ${filterStr}\n\n` +
          summaryLines.join('\n') +
          `\n\n**Total payout:** ${fmt(totalCoins)}\n\n` +
          protectionNote +
          `Add \`--confirm\` to your command to execute.`
        )
        .setColor(0xFFAA00)
      ]});
    }

    // Execute — remove from highest index down to avoid index shift bugs
    const indexesToRemove = candidates.map(c => c.i).sort((a, b) => b - a);
    for (const idx of indexesToRemove) user.collection.splice(idx, 1);
    user.currency += totalCoins;
    touchActivity(db, message.author.id, message.author);
    checkAchievements(user);
    saveDB(db);

    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle(`✅ Batch Sold — ${candidates.length} plants`)
      .setDescription(
        `**Filters:** ${filterStr}\n\n` +
        summaryLines.join('\n') +
        `\n\n**Earned:** ${fmt(totalCoins)}\n**New balance:** ${fmt(user.currency)}`
      )
      .setColor(0x00C853)
    ]});
  }

  // ── !autosell — persistent auto-sell rules ───────────────────────────────
  if (cmd === 'autosell' || cmd === 'asr') {
    const sub = args[1]?.toLowerCase();

    if (!sub || sub === 'list') {
      const rules = getUserAutosellRules(message.author.id);
      if (!rules.length) return message.reply('You have no autosell rules. Use `!autosell add` to create one.');
      const lines = rules.map((r, i) => {
        const parts = [];
        if (r.rarity)     parts.push(`rarity: **${r.rarity}**`);
        if (r.mutation)   parts.push(`mutation: **${r.mutation}**`);
        if (r.plant)      parts.push(`plant: **${r.plant}**`);
        if (r.version_op) parts.push(`version **${r.version_op}${r.version_n}**`);
        return `\`${i + 1}.\` ${parts.join('  ·  ')}`;
      });
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('⚡ Your Autosell Rules')
        .setDescription(lines.join('\n'))
        .setFooter({ text: '!autosell remove <number> to delete a rule · locked plants are always safe' })
        .setColor(0x00C853)
      ]});
    }

    if (sub === 'add') {
      const raw = args.slice(2).join(' ');
      const rMatch = raw.match(/-r\s+([a-z]+)/i);
      const mMatch = raw.match(/-m\s+([a-z]+(?:\s+[a-z]+)?)/i);
      const vMatch = raw.match(/-v\s*([<>=!]+)\s*(\d+)/i);
      const pMatch = raw.match(/-p\s+"([^"]+)"|(?:-p\s+)([\w\s]+?)(?=\s+-|$)/i);

      const rule = {};
      if (rMatch) rule.rarity     = rMatch[1].toLowerCase();
      if (mMatch) rule.mutation   = mMatch[1].toLowerCase();
      if (vMatch) { rule.version_op = vMatch[1]; rule.version_n = parseInt(vMatch[2]); }
      if (pMatch) rule.plant      = (pMatch[1] || pMatch[2]).trim().toLowerCase();

      if (!Object.keys(rule).length) return message.reply([
        'Usage: `!autosell add [filters]`',
        '`-r <rarity>` — e.g. `-r common`',
        '`-m <mutation>` or `-m none`',
        '`-v <op><n>` — e.g. `-v >10`',
        '`-p "<plant name>"` — e.g. `-p carrot`',
        '',
        '**Examples:**',
        '`!autosell add -r common` — auto-sell all commons as they arrive',
        '`!autosell add -r uncommon -m none` — sell unmutated uncommons',
        '`!autosell add -p carrot -v >5` — sell Carrot v6+',
      ].join('\n'));

      // Validate rarity
      if (rule.rarity && !RARITIES.find(r => r.name.toLowerCase() === rule.rarity)) {
        return message.reply(`❌ Unknown rarity **${rule.rarity}**. Options: ${RARITIES.map(r => r.name).join(', ')}`);
      }

      const all = loadAutosellRules();
      if (!all[message.author.id]) all[message.author.id] = [];
      if (all[message.author.id].length >= 20) return message.reply('❌ You can have at most 20 autosell rules.');
      all[message.author.id].push(rule);
      saveAutosellRules(all);

      const desc = Object.entries(rule).map(([k, v]) => `${k}: **${v}**`).join('  ·  ');
      return message.reply(`✅ Autosell rule added: ${desc}\nPlants matching this will be sold instantly as you get them.`);
    }

    if (sub === 'remove') {
      const idx = parseInt(args[2]) - 1;
      const all = loadAutosellRules();
      const rules = all[message.author.id] || [];
      if (isNaN(idx) || idx < 0 || idx >= rules.length) return message.reply(`❌ Invalid rule number. Use \`!autosell list\` to see your rules.`);
      const removed = rules.splice(idx, 1)[0];
      all[message.author.id] = rules;
      saveAutosellRules(all);
      const desc = Object.entries(removed).map(([k, v]) => `${k}: **${v}**`).join('  ·  ');
      return message.reply(`🗑️ Removed rule: ${desc}`);
    }

    if (sub === 'clear') {
      const all = loadAutosellRules();
      delete all[message.author.id];
      saveAutosellRules(all);
      return message.reply('✅ All your autosell rules have been cleared.');
    }

    return message.reply('Subcommands: `add` · `list` · `remove <number>` · `clear`');
  }

  // ── !daily ────────────────────────────────────────────────────────────────
  if (cmd === 'daily') { if (claimingDaily.has(message.author.id)) return message.reply('⏳ Already processing, please wait.'); claimingDaily.add(message.author.id);
    const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
    touchActivity(db, message.author.id, message.author);
    const now = Date.now(), DAY = 86400000;
    if (user.lastDaily && now - user.lastDaily < DAY) { claimingDaily.delete(message.author.id); const rem = DAY - (now - user.lastDaily); const h = Math.floor(rem/3600000), m = Math.floor((rem%3600000)/60000); return message.reply(`⏳ Come back in **${h}h ${m}m**.`); }
    const rarity = pickRarityWithCharms(db, message.author.id), plant = pickPlant(rarity.name), mutation = rollMutation(getActiveWeather()?.name || null);
    const version = getAvailableVersion(plant.name, db); recordVersionHighWater(plant.name, version);
    const coins = Math.floor(Math.random()*200)+100, sellVal = calcSellValue(plant, rarity, mutation, version);
    if (!TEST_IDS.has(message.author.id)) {
      if (user.lastDaily && now - user.lastDaily < DAY) return message.reply(`⏳ Already claimed today.`);
      user.collection.push({ name: plant.name, image: plant.display, rarity: rarity.name, mutation: mutation ? { name: mutation.name, emoji: mutation.emoji, multiplier: mutation.multiplier } : null, version, sellValue: sellVal, claimedAt: new Date().toISOString() });
      user.currency += coins; user.lastDaily = now;
      addXP(db, message.author.id, XP_REWARDS.daily); checkAchievements(user); applyAutosellRules(user, message.author.id, [{ name: plant.name, version }]); saveDB(db); claimingDaily.delete(message.author.id);
    }
    const mutLine = mutation ? `\nMutation: ${mutation.emoji} **${mutation.name}**` : '', v1Badge = version === 1 ? ' 🔖 **First Copy!**' : '';
    const dailyAttach = new AttachmentBuilder(`${IMAGES_DIR}/${plant.display}`, { name: plant.display });
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle('🌱 Daily Plant Claimed!').setDescription(`${rarity.emoji} **${plant.name}** *(${rarity.name})*  \`#${version}\`${v1Badge}${mutLine}\n+ ${fmt(coins)}\n\nCome back tomorrow!`).setThumbnail(`attachment://${plant.display}`).setColor(rarity.color)], files: [dailyAttach] });
  }

  // ── !weekly ───────────────────────────────────────────────────────────────
  if (cmd === 'weekly') { if (claimingWeekly.has(message.author.id)) return message.reply('⏳ Already processing, please wait.'); claimingWeekly.add(message.author.id);
    const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
    touchActivity(db, message.author.id, message.author);
    const now = Date.now(), WEEK = 604800000;
    if (user.lastWeekly && now - user.lastWeekly < WEEK) { claimingWeekly.delete(message.author.id); const rem = WEEK - (now - user.lastWeekly); const d = Math.floor(rem/86400000), h = Math.floor((rem%86400000)/3600000); return message.reply(`⏳ Come back in **${d}d ${h}h**.`); }
    const plants = Array.from({length:3}, () => { const r = pickRarityWithCharms(db, message.author.id), p = pickPlant(r.name), mut = rollMutation(getActiveWeather()?.name || null), ver = getAvailableVersion(p.name, db); recordVersionHighWater(p.name, ver); const sv = calcSellValue(p, r, mut, ver); return { name: p.name, rarity: r, mutation: mut, version: ver, display: p.display, sv }; });
    const coins = Math.floor(Math.random()*1000)+500;
    if (!TEST_IDS.has(message.author.id)) {
      if (user.lastWeekly && now - user.lastWeekly < WEEK) return message.reply(`⏳ Already claimed this week.`);
      for (const p of plants) {
        user.collection.push({ name: p.name, image: p.display, rarity: p.rarity.name, mutation: p.mutation ? {name:p.mutation.name,emoji:p.mutation.emoji,multiplier:p.mutation.multiplier} : null, version: p.version, sellValue: p.sv, claimedAt: new Date().toISOString() });
      }
      user.currency += coins; user.lastWeekly = now;
      addXP(db, message.author.id, XP_REWARDS.weekly); checkAchievements(user); applyAutosellRules(user, message.author.id, plants.map(p => ({ name: p.name, version: p.version }))); saveDB(db); claimingWeekly.delete(message.author.id);
    }
    const lines = plants.map(p => `${p.rarity.emoji} **${p.name}** *(${p.rarity.name})* \`#${p.version}\`${p.mutation ? ` ${p.mutation.emoji} ${p.mutation.name}` : ''}${p.version===1?' 🔖':''}`);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle('🌿 Weekly Plants!').setDescription(lines.join('\n') + `\n\n+ ${fmt(coins)}`).setColor(0x4CAF50)] });
  }

  // ── !shop ─────────────────────────────────────────────────────────────────
  if (cmd === 'shop') {
    const page = Math.max(0, Math.min(SHOP_PAGES.length-1, (parseInt(args[1])||1) - 1));
    const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });

    const totalShopPages = SHOP_PAGES.length;

    function buildShopRow(p) {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('shop_prev').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(p <= 0),
        new ButtonBuilder().setCustomId('shop_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(p >= totalShopPages - 1)
      );
    }

    if (totalShopPages <= 1) {
      return message.channel.send({ embeds: [buildShopEmbed(page, user, user.currency)] });
    }

    const shopMsg = await message.channel.send({ embeds: [buildShopEmbed(page, user, user.currency)], components: [buildShopRow(page)] });
    let currentShopPage = page;
    const shopCollector = shopMsg.createMessageComponentCollector({ time: 120_000 });
    shopCollector.on('collect', async interaction => {
      if (interaction.user.id !== message.author.id) {
        return interaction.reply({ content: '❌ Only the person who ran this command can flip pages.', ephemeral: true });
      }
      if (interaction.customId === 'shop_prev') currentShopPage = Math.max(0, currentShopPage - 1);
      if (interaction.customId === 'shop_next') currentShopPage = Math.min(totalShopPages - 1, currentShopPage + 1);
      const freshDb = loadDB(); const freshUser = getUser(freshDb, message.author.id);
      await interaction.update({ embeds: [buildShopEmbed(currentShopPage, freshUser, freshUser.currency)], components: [buildShopRow(currentShopPage)] });
    });
    shopCollector.on('end', () => {
      shopMsg.edit({ components: [] }).catch(() => {});
    });
    return;
  }

  // ── !buy / !b ─────────────────────────────────────────────────────────────────
  if (cmd === 'buy' || cmd === 'b') {
    const itemKey = args[1]?.toLowerCase();
    if (!itemKey) return message.reply('Usage: `!buy <item>`. See `!shop` for items.');
    const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
    touchActivity(db, message.author.id, message.author);
    if (CHARMS[itemKey]) {
      const ch = CHARMS[itemKey];
      if (user.charms.includes(itemKey)) return message.reply(`You already own **${ch.name}**!`);
      if (user.currency < ch.price) return message.reply(`❌ Need ${fmt(ch.price)}.`);
      user.currency -= ch.price; user.charms.push(itemKey); saveDB(db);
      return message.reply(`${ch.emoji} Purchased **${ch.name}**! Use \`!equip ${itemKey}\` to activate.`);
    }
    if (SHOP_TITLES[itemKey]) {
      const t = SHOP_TITLES[itemKey];
      if (user.titles.includes(itemKey)) return message.reply(`You already own the **${t.name}** title!`);
      if (user.currency < t.price) return message.reply(`❌ Need ${fmt(t.price)}.`);
      user.currency -= t.price; user.titles.push(itemKey); saveDB(db);
      return message.reply(`${t.emoji} Purchased title **${t.name}**! Use \`!title ${itemKey}\` to equip it.`);
    }
    let autoEarned = 0;
    const crateKey = Object.keys(CRATES).find(k => CRATES[k].name.split(' ')[0].toLowerCase() === itemKey || k === itemKey);
    if (!crateKey) return message.reply('Unknown item. Check `!shop`.');
    const crate = CRATES[crateKey];
    const userLevel = getLevelFromXP(user.xp || 0);
    if (userLevel < crate.minLevel) {
      return message.reply(`❌ You need to be **Level ${crate.minLevel}** to open ${crate.name}. You're currently Level ${userLevel}.`);
    }
    if (user.currency < crate.price) return message.reply(`❌ Need ${fmt(crate.price)}.`);
    if (!user.crateCooldowns) user.crateCooldowns = {};
    const lastUsed = user.crateCooldowns[crateKey] || 0;
    const cdMs = CRATE_COOLDOWNS[crateKey] || 0;
    const remaining = cdMs - (Date.now() - lastUsed);
    if (remaining > 0) {  
      const unixTimestamp = Math.floor((Date.now() + remaining) / 1000);
      return message.reply(`⏳ **${crate.name}** cooldown ends <t:${unixTimestamp}:R>`);
    }
    return queueForUser(message.author.id, async () => {
      const db = loadDB();
      const user = getUser(db, message.author.id);

      if (user.currency < crate.price)
        return message.channel.send(`❌ Not enough coins — need ${fmt(crate.price)}.`);

      if (!user.crateCooldowns) user.crateCooldowns = {};
      const lastUsedInner = user.crateCooldowns[crateKey] || 0;
      const remainingInner = (CRATE_COOLDOWNS[crateKey] || 0) - (Date.now() - lastUsedInner);
      if (remainingInner > 0) {
        const unixTimestamp = Math.floor((Date.now() + remainingInner) / 1000);
        return message.channel.send(`⏳ **${crate.name}** cooldown ends <t:${unixTimestamp}:R>`);
      }

      const results = openCrate(crateKey, db, message.author.id);
      const addedPlants = [];
      let autoEarned = 0;

      let dupeBlockedCount = 0;
      if (!TEST_IDS.has(message.author.id)) {
        user.currency -= crate.price;
        user.crateCooldowns[crateKey] = Date.now();
        const crateMeta = loadMeta();
        for (const p of results) {
          const ver = getAvailableVersionFromMeta(p.name, db, crateMeta);
          if ((crateMeta.plantVersions[p.name] || 0) < ver) crateMeta.plantVersions[p.name] = ver;
          const sv = calcSellValue(p, p.rarityConfig, p.mutation, ver);
          const entry = { name: p.name, image: p.display, rarity: p.rarity, mutation: p.mutation ? {name:p.mutation.name,emoji:p.mutation.emoji,multiplier:p.mutation.multiplier} : null, version: ver, sellValue: sv, claimedAt: new Date().toISOString() };
          if (!user.collection.some(c => c.name === entry.name && c.version === entry.version)) {
            user.collection.push(entry);
            addedPlants.push(entry);
          } else {
            console.warn(`[DUPE GUARD] Blocked duplicate in !buy: ${entry.name} v${entry.version}`);
            dupeBlockedCount++;
          }
          db[message.author.id] = user;
        }
        if (dupeBlockedCount > 0) {
          const refund = Math.round((crate.price / crate.plants) * dupeBlockedCount);
          user.currency += refund;
        }
        saveMeta(crateMeta);
        user.cratesOpened = (user.cratesOpened||0) + 1;
        addXP(db, message.author.id, XP_REWARDS.crate_open);
        checkAchievements(user);
        autoEarned = applyAutosellRules(user, message.author.id, addedPlants);
        saveDB(db);
      }

      const spoilerLines = addedPlants.map(p =>
        `||${getRarityConfig(p.rarity).emoji} **${p.name}** \`v${p.version}\` — ${p.rarity}${p.mutation ? ` ${p.mutation.emoji} ${p.mutation.name}` : ''}||`
      );
      const crateValue = addedPlants.reduce((sum, p) => sum + (p.sellValue || 0), 0);
      const cratePnl = crateValue - crate.price;
      const pnlStr = cratePnl >= 0 ? `🔼 **+${cratePnl.toLocaleString()}**` : `🔽 **${cratePnl.toLocaleString()}**`;
      const dupeRefundStr = dupeBlockedCount > 0 ? `  ·  ⚠️ ${dupeBlockedCount} slot${dupeBlockedCount!==1?'s':''} refunded (version collision)` : '';
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle(`${crate.emoji} ${crate.name} — Click to Reveal`).setDescription(`${CURRENCY_EMOJI} **${user.currency.toLocaleString()}**  ·  ${pnlStr}${autoEarned > 0 ? `  ·  ⚡ **+${autoEarned.toLocaleString()}** autosold` : ''}${dupeRefundStr}\n\n*Each plant is hidden — click to reveal...*\n\n${spoilerLines.join('\n')}`).setColor(crate.color)] });
    });
  }

  // ── !equip / !unequip ─────────────────────────────────────────────────────
  if (cmd === 'equip' || cmd === 'unequip') {
    const key = args[1]?.toLowerCase();
    if (!key || !CHARMS[key]) return message.reply('Usage: `!equip <charm_key>`');
    const db = loadDB(); const user = getUser(db, message.author.id);
    user.username = message.author.username;
    user.avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 128 });
    if (!user.charms.includes(key)) return message.reply(`You don't own **${CHARMS[key].name}**.`);
    const ch = CHARMS[key];
    if (cmd === 'equip') { if (user.equippedCharms.includes(key)) return message.reply(`${ch.emoji} Already equipped.`); user.equippedCharms = [key]; saveDB(db); return message.reply(`${ch.emoji} **${ch.name}** equipped!`); }
    else { if (!user.equippedCharms.includes(key)) return message.reply(`${ch.emoji} Not equipped.`); user.equippedCharms = user.equippedCharms.filter(k => k !== key); saveDB(db); return message.reply(`${ch.emoji} **${ch.name}** unequipped.`); }
  }

  // ── !coins ────────────────────────────────────────────────────────────────
  if (cmd === 'coins') {
    const target = (await resolveTarget(message, args[1])) || message.author;
    const db = loadDB(); const user = getUser(db, target.id);
    return message.reply(`${target.username}'s balance: ${fmt(user.currency)}`);
  }

  // ── Admin: currency/xp management ────────────────────────────────────────
  if (cmd === 'addcurrency' || cmd === 'givecoin') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const target = await resolveTarget(message, args[1]); const amount = parseInt(args[2]);
    if (!target || isNaN(amount)) return message.reply('Usage: `!addcurrency @user <amount>`');
    const db = loadDB(); const user = getUser(db, target.id); user.currency += amount; saveDB(db); pushCoinUpdate(target.id, user.currency);
    return message.reply(`✅ Gave ${fmt(amount)} to **${target.username}**.`);
  }
  if (cmd === 'addplant') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const target = await resolveTarget(message, args[1]);
    if (!target) return message.reply('Usage: `!addplant @user <plant name> [-v version] [-m mutation] [-r rarity]`');

    const rawAdd = args.slice(2).join(' ');
    const vMatch = rawAdd.match(/-v\s*(\d+)/i);
    const mMatch = rawAdd.match(/-m\s+([a-z]+)/i);
    const rMatch = rawAdd.match(/-r\s+([a-z]+)/i);
    const plantName = rawAdd.replace(/-v\s*\d+/i,'').replace(/-m\s+\S+/i,'').replace(/-r\s+\S+/i,'').trim();

    if (!plantName) return message.reply('Usage: `!addplant @user <plant name> [-v version] [-m mutation] [-r rarity]`');

    const plant = PLANTS.find(p => p.name.toLowerCase() === plantName.toLowerCase());
    if (!plant) return message.reply(`❌ Plant **${plantName}** not found. Check spelling.`);
    if (plant.dropOnly && !isBotAdmin(message.author.id)) return message.reply(`❌ **${plant.name}** can only be obtained through drops.`);

    const db = loadDB();
    const user = getUser(db, target.id);

    // Rarity — use plant's natural rarity unless overridden
    const rarity = rMatch ? getRarityConfig(rMatch[1]) : getRarityConfig(plant.rarity);

    // Mutation
    let mutation = null;
    if (mMatch) {
      mutation = MUTATIONS.find(m => m.name.toLowerCase() === mMatch[1].toLowerCase());
      if (!mutation) return message.reply(`❌ Mutation **${mMatch[1]}** not found. Options: ${MUTATIONS.map(m => m.name).join(', ')}`);
    }

    // Version
    let version;
    if (vMatch) {
      version = parseInt(vMatch[1]);
      // Directly write the version without going through getAvailableVersion,
      // so admin can restore an exact version even if meta thinks it's taken.
      const meta = loadMeta();
      if (!meta.plantVersions) meta.plantVersions = {};
      if ((meta.plantVersions[plant.name] || 0) < version) {
        meta.plantVersions[plant.name] = version;
        meta.totalDrops = (meta.totalDrops || 0) + 1;
      }
      saveMeta(meta);
    } else {
      version = getAvailableVersion(plant.name, db);
      recordVersionHighWater(plant.name, version);
    }

    const sellValue = calcSellValue(plant, rarity, mutation, version);

    user.collection.push({
      name: plant.name,
      image: plant.display,
      rarity: rarity.name,
      mutation: mutation ? { name: mutation.name, emoji: mutation.emoji, multiplier: mutation.multiplier } : null,
      version,
      sellValue,
      claimedAt: new Date().toISOString(),
    });

    saveDB(db);

    const mutLine = mutation ? `  ${mutation.emoji} **${mutation.name}**` : '';
    const v1Badge = version === 1 ? '  🔖 *First copy!*' : '';
    const addPlantAttach = new AttachmentBuilder(`${IMAGES_DIR}/${plant.display}`, { name: plant.display });
    return message.reply({ embeds: [new EmbedBuilder()
      .setTitle('✅ Plant Added')
      .setDescription(`${rarity.emoji} **${plant.name}** \`v${version}\`${mutLine}${v1Badge}\nadded to **${target.username}**'s collection.\nSell value: ${fmt(sellValue)}`)
      .setThumbnail(`attachment://${plant.display}`)
      .setColor(mutation ? mutation.color : rarity.color)
    ], files: [addPlantAttach]});
  }

  // ── !bulkadd — restore many plants to a user at once ─────────────────────
  // Usage: !bulkadd @user
  // Then paste JSON on the next line, e.g.:
  // [{"name":"Glowflower","version":1},{"name":"Firefern","version":3,"mutation":"Starstruck"}]
  if (cmd === 'bulkadd') {
    if (!isBotAdmin(message.author.id)) return message.reply('Admins only.');
    const target = await resolveTarget(message, args[1]);
    if (!target) return message.reply('Usage: `!bulkadd @user` then paste JSON array on same line after the mention.\nExample: `!bulkadd @user [{"name":"Glowflower","version":1},{"name":"Firefern","version":3}]`');

    // JSON starts after the mention/id token
    const jsonStart = content.indexOf('[');
    if (jsonStart === -1) return message.reply('❌ No JSON array found. Include `[{...}]` in the same message.');

    let entries;
    try {
      entries = JSON.parse(content.slice(jsonStart));
    } catch (e) {
      return message.reply(`❌ Invalid JSON: ${e.message}`);
    }
    if (!Array.isArray(entries) || !entries.length) return message.reply('❌ JSON must be a non-empty array.');

    const db   = loadDB();
    const user = getUser(db, target.id);
    const meta = loadMeta();
    if (!meta.plantVersions) meta.plantVersions = {};

    const added = [], skipped = [];

    for (const entry of entries) {
      const plant = PLANTS.find(p => p.name.toLowerCase() === (entry.name || '').toLowerCase());
      if (!plant) { skipped.push(`Unknown plant: ${entry.name}`); continue; }

      const rarity = entry.rarity ? getRarityConfig(entry.rarity) : getRarityConfig(plant.rarity);

      let mutation = null;
      if (entry.mutation) {
        mutation = MUTATIONS.find(m => m.name.toLowerCase() === entry.mutation.toLowerCase());
        if (!mutation) { skipped.push(`Unknown mutation: ${entry.mutation} on ${plant.name}`); continue; }
      }

      let version;
      if (entry.version) {
        version = parseInt(entry.version);
        if ((meta.plantVersions[plant.name] || 0) < version) {
          meta.plantVersions[plant.name] = version;
          meta.totalDrops = (meta.totalDrops || 0) + 1;
        }
      } else {
        version = getAvailableVersionFromMeta(plant.name, db, meta);
      }

      const sellValue = calcSellValue(plant, rarity, mutation, version);
      user.collection.push({
        name: plant.name,
        image: plant.display,
        rarity: rarity.name,
        mutation: mutation ? { name: mutation.name, emoji: mutation.emoji, multiplier: mutation.multiplier } : null,
        version,
        sellValue,
        claimedAt: new Date().toISOString(),
      });
      added.push(`${rarity.emoji} **${plant.name}** \`v${version}\`${mutation ? ` ${mutation.emoji} ${mutation.name}` : ''}`);
    }

    saveMeta(meta);
    saveDB(db);

    const desc = (added.length ? `**Added (${added.length}):**\n${added.join('\n')}` : '') +
                 (skipped.length ? `\n\n**Skipped (${skipped.length}):**\n${skipped.map(s=>`• ${s}`).join('\n')}` : '');
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle(`✅ Bulk Add — ${target.username}`)
      .setDescription(desc.slice(0, 4000))
      .setColor(added.length ? 0x00C853 : 0xFF6600)
    ]});
  }

  if (cmd === 'addxp') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const target = await resolveTarget(message, args[1]); const amount = parseInt(args[2]);
    if (!target || isNaN(amount)) return message.reply('Usage: `!addxp @user <amount>`');
    const db = loadDB(); addXP(db, target.id, amount); saveDB(db);
    return message.reply(`✅ Gave **${amount} XP** to **${target.username}**.`);
  }
  if (cmd === 'removexp') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const target = await resolveTarget(message, args[1]); const amount = parseInt(args[2]);
    if (!target || isNaN(amount)) return message.reply('Usage: `!removexp @user <amount>`');
    const db = loadDB(); const user = getUser(db, target.id); user.xp = Math.max(0, (user.xp || 0) - amount); saveDB(db);
    return message.reply(`✅ Removed **${amount} XP** from **${target.username}**.`);
  }
  if (cmd === 'removecurrency' || cmd === 'removecoin') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const target = await resolveTarget(message, args[1]); const amount = parseInt(args[2]);
    if (!target || isNaN(amount)) return message.reply('Usage: `!removecurrency @user <amount>`');
    const db = loadDB(); const user = getUser(db, target.id); user.currency = Math.max(0, (user.currency || 0) - amount); saveDB(db); pushCoinUpdate(target.id, user.currency);
    return message.reply(`✅ Removed ${fmt(amount)} from **${target.username}**.`);
  }
  if (cmd === 'removeplant') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const target = await resolveTarget(message, args[1]);
    if (!target) return message.reply('Usage: `!removeplant @user <plant name> [-v version] [-m mutation] [-r rarity] [--all]`');
    const db = loadDB(); const user = getUser(db, target.id);

    const rawRemove = args.slice(2).join(' ');
    const vMatch = rawRemove.match(/-v\s*(\d+)/i);
    const mMatch = rawRemove.match(/-m\s+([a-z]+)/i);
    const rMatch = rawRemove.match(/-r\s+([a-z]+)/i);
    const doAll  = rawRemove.includes('--all');
    const plantName = rawRemove.replace(/-v\s*\d+/i,'').replace(/-m\s+\S+/i,'').replace(/-r\s+\S+/i,'').replace('--all','').trim();

    if (!plantName && !rMatch && !mMatch) return message.reply('Usage: `!removeplant @user <plant name> [-v version] [-m mutation] [-r rarity] [--all]`');

    let candidates = user.collection
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => {
        if (plantName && p.name.toLowerCase() !== plantName.toLowerCase()) return false;
        if (vMatch && p.version !== parseInt(vMatch[1])) return false;
        if (mMatch && (!p.mutation || p.mutation.name.toLowerCase() !== mMatch[1].toLowerCase())) return false;
        if (rMatch && p.rarity.toLowerCase() !== rMatch[1].toLowerCase()) return false;
        return true;
      });

    if (!candidates.length) return message.reply(`No matching plants found on **${target.username}**.`);

    // If multiple matches and no --all, show list
    if (candidates.length > 1 && !doAll) {
      const lines = candidates.map(({ p }) => {
        const mutStr = p.mutation ? ` ${p.mutation.emoji} ${p.mutation.name}` : '';
        return `${getRarityConfig(p.rarity).emoji} **${p.name}** \`v${p.version || '?'}\`${mutStr} *(${p.rarity})*`;
      });
      return message.reply({ embeds: [new EmbedBuilder()
        .setTitle(`Found ${candidates.length} matching plants`)
        .setDescription(lines.join('\n') + '\n\nAdd `--all` to remove all of them, or narrow your filters.')
        .setColor(0xFF6600)
      ]});
    }

    // Remove all candidates
    const removed = [];
    for (const { p } of candidates) {
      removed.push(p);
    }
    // Remove from highest index down
    candidates.sort((a, b) => b.i - a.i);
    for (const { i } of candidates) user.collection.splice(i, 1);
    saveDB(db);

    const lines = removed.map(p => {
      const mutStr = p.mutation ? ` ${p.mutation.emoji} ${p.mutation.name}` : '';
      return `${getRarityConfig(p.rarity).emoji} **${p.name}** \`v${p.version || '?'}\`${mutStr}`;
    });
    return message.reply({ embeds: [new EmbedBuilder()
      .setTitle(`✅ Removed ${removed.length} plant${removed.length !== 1 ? 's' : ''} from ${target.username}`)
      .setDescription(lines.join('\n'))
      .setColor(0x00FF00)
    ]});
  }

  // ── !wipeuser ─────────────────────────────────────────────────────────────
  if (cmd === 'wipeuser') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const target = await resolveTarget(message, args[1]);
    if (!target) return message.reply('Usage: `!wipeuser @user`');
    const CONFIRM_PHRASE = `WIPE-USER-${target.id.slice(-6).toUpperCase()}`;
    pendingWipes[`user_${message.author.id}`] = { targetId: target.id, targetName: target.username, phrase: CONFIRM_PHRASE, ts: Date.now() };
    setTimeout(() => delete pendingWipes[`user_${message.author.id}`], 60_000);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle(`☢️  Wipe User — ${target.username}`).setDescription(`**Cannot be undone.**\n\nTo confirm:\n\`\`\`\n${CONFIRM_PHRASE}\n\`\`\`\n60 seconds.`).setColor(0xFF6600)] });
  }



  // ── !market / !m ─────────────────────────────────────────────────────────
  if (cmd === 'market' || cmd === 'm') {
    const rawSlice = args.slice(1).join(' ');
    let versionFilter = null, mutationFilter = null;
    const vfMatch = rawSlice.match(/-version\s*([<>=!]+)\s*(\d+)/i), mfMatch = rawSlice.match(/-m\s+([a-z]+)/i);
    if (vfMatch) versionFilter = { op: vfMatch[1], n: parseInt(vfMatch[2]) };
    if (mfMatch) mutationFilter = mfMatch[1].toLowerCase();
    const cleanSlice = rawSlice.replace(/-version\s*[<>=!]+\s*\d+/i,'').replace(/-m\s+\S+/i,'').trim();
    const trailingPageMatch = cleanSlice.match(/^(.*?)\s+(\d+)$/);
    let plantName = cleanSlice, explicitPage = null;
    if (trailingPageMatch) { const possiblePlant = trailingPageMatch[1].trim(), possiblePage = parseInt(trailingPageMatch[2]); if (possiblePlant && PLANTS.some(p => p.name.toLowerCase() === possiblePlant.toLowerCase())) { plantName = possiblePlant; explicitPage = possiblePage; } }
    if (plantName) {
      const plant = PLANTS.find(p => p.name.toLowerCase() === plantName.toLowerCase());
      if (!plant) return message.reply(`Plant **${plantName}** not found.`);
      const rCfg = getRarityConfig(plant.rarity), mult = getMarketMultiplier(plant.name);
      const trend = mult > 1.1 ? '📈 Rising' : mult < 0.9 ? '📉 Falling' : '📊 Stable';
      const filterParts = []; if (versionFilter) filterParts.push(`version ${versionFilter.op}${versionFilter.n}`); if (mutationFilter) filterParts.push(`mutation: ${mutationFilter}`);
      const PER_PAGE = 10;

      function buildMarketData() {
        const db = loadDB(), versionEntries = {};
        for (const [uid, userData] of Object.entries(db)) { for (const p of (userData.collection || [])) { if (p.name !== plant.name || !p.version) continue; if (!versionEntries[p.version]) versionEntries[p.version] = []; versionEntries[p.version].push({ userId: uid, mutation: p.mutation || null }); } }
        const knownVersions = Object.keys(versionEntries).map(Number), maxKnownVersion = knownVersions.length > 0 ? Math.max(...knownVersions) : 0;
        const totalVersions = Math.max(10, maxKnownVersion), totalPages = Math.ceil(totalVersions / PER_PAGE);
        return { versionEntries, totalVersions, totalPages };
      }

      function buildMarketEmbed(p) {
        const { versionEntries, totalVersions, totalPages } = buildMarketData();
        const page = Math.max(1, Math.min(p, totalPages));
        const startV = (page - 1) * PER_PAGE + 1, endV = Math.min(startV + PER_PAGE - 1, totalVersions);
        let versionLines = '';
        for (let v = startV; v <= endV; v++) {
          if (versionFilter) { const { op, n } = versionFilter; const pass = (op==='>'&&v>n)||(op==='>='&&v>=n)||(op==='<'&&v<n)||(op==='<='&&v<=n)||((op==='='||op==='==')&&v===n); if (!pass) continue; }
          const holders = (versionEntries[v] || []).filter(e => { if (!mutationFilter) return true; if (mutationFilter === 'none') return !e.mutation; return e.mutation && e.mutation.name.toLowerCase() === mutationFilter; });
          if (mutationFilter && holders.length === 0 && (versionEntries[v] || []).length > 0) continue;
          const verPill = `\`v${String(v).padStart(2, ' ')}\``;
          const ownerStr = !versionEntries[v] || versionEntries[v].length === 0 ? '*unclaimed*' : holders.length === 0 ? '*no matches*' : holders.map(e => { const mutTag = e.mutation ? ` ${e.mutation.emoji}` : ''; return `<@${e.userId}>${mutTag}`; }).join('  ');
          versionLines += `${verPill}  ${ownerStr}\n`;
        }
        if (!versionLines) versionLines = '*No versions match those filters on this page.*\n';
        return { totalPages, page, embed: new EmbedBuilder().setTitle(`${plant.name} — Version Ownership`).setDescription(`${rCfg.emoji} **${plant.rarity}**  ·  Demand: **${trend}**${filterParts.length ? `  ·  filter: ${filterParts.join(' + ')}` : ''}\n\n${versionLines}`).setThumbnail(`attachment://${plant.display}`).setColor(rCfg.color).setFooter({ text: `v${startV}–v${endV}  ·  Page ${page}/${totalPages}` }) };
      }

      function buildMarketRow(p, totalPages) {
        return new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('market_prev').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(p <= 1),
          new ButtonBuilder().setCustomId('market_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(p >= totalPages)
        );
      }

      const marketAttach = new AttachmentBuilder(`${IMAGES_DIR}/${plant.display}`, { name: plant.display });
      const initial = buildMarketEmbed(Math.max(1, explicitPage || 1));

      if (initial.totalPages <= 1) {
        return message.channel.send({ embeds: [initial.embed], files: [marketAttach] });
      }

      const marketMsg = await message.channel.send({ embeds: [initial.embed], files: [marketAttach], components: [buildMarketRow(initial.page, initial.totalPages)] });
      let currentMarketPage = initial.page;
      const marketCollector = marketMsg.createMessageComponentCollector({ time: 120_000 });
      marketCollector.on('collect', async interaction => {
        if (interaction.user.id !== message.author.id) {
          return interaction.reply({ content: '❌ Only the person who ran this command can flip pages.', ephemeral: true });
        }
        const { totalPages } = buildMarketData();
        if (interaction.customId === 'market_prev') currentMarketPage = Math.max(1, currentMarketPage - 1);
        if (interaction.customId === 'market_next') currentMarketPage = Math.min(totalPages, currentMarketPage + 1);
        const fresh = buildMarketEmbed(currentMarketPage);
        await interaction.update({ embeds: [fresh.embed], components: [buildMarketRow(fresh.page, fresh.totalPages)] });
      });
      marketCollector.on('end', () => {
        marketMsg.edit({ components: [] }).catch(() => {});
      });
      return;
    } else {
      const trending = PLANTS.map(p => ({ name: p.name, rarity: p.rarity, mult: getMarketMultiplier(p.name) })).sort((a,b) => b.mult - a.mult).slice(0, 8);
      const lines = trending.map(p => { const r = getRarityConfig(p.rarity); const arrow = p.mult > 1.1 ? '📈' : p.mult < 0.9 ? '📉' : '📊'; return `${arrow} ${r.emoji} **${p.name}** — ×${p.mult.toFixed(2)}`; });
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle('📊 Plant Market — Trending').setDescription(lines.join('\n') + '\n\n*Use `!m <plant>` to see version owners*').setColor(0x4CAF50)] });
    }
  }

  if (cmd === 'fixsellvalues') {
    if (!isBotAdmin(message.author.id)) return message.reply('Admins only.');
    const db = loadDB();
    let fixed = 0;
    let skipped = 0;
    for (const userData of Object.values(db)) {
      for (const p of (userData.collection || [])) {
        const plantDef = PLANTS.find(pl => pl.name === p.name) || { name: p.name, dropOnly: false };
        const rarity   = getRarityConfig(p.rarity);
        const mutDef   = p.mutation
          ? MUTATIONS.find(m => m.name === p.mutation.name) || p.mutation
          : null;
        const correct  = calcSellValue(plantDef, rarity, mutDef, p.version || 1);
        if (p.sellValue !== correct) {
          p.sellValue = correct;
          fixed++;
        } else {
          skipped++;
        }
      }
    }
    saveDB(db);
    return message.reply(`✅ Sell values fixed.\n**Updated:** ${fixed} plants\n**Already correct:** ${skipped} plants`);
  }

  if (cmd === 'fixdupes' || cmd === 'currentdupes') {
    if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
    const db = loadDB();
    const seen = {};
    let count = 0;
    const dupeList = [];
    for (const [userId, userData] of Object.entries(db)) {
      if (!userData.collection) continue;
      const toRemove = [];
      for (let i = 0; i < userData.collection.length; i++) {
        const p = userData.collection[i];
        const key = `${p.name}:${p.version}`;
        if (seen[key]) {
          toRemove.push(i);
          count++;
          dupeList.push(`**${p.name}** v${p.version} — <@${userId}> (dupe of <@${seen[key]}>)`);
        } else {
          seen[key] = userId;
        }
      }
      if (cmd === 'fixdupes') {
        for (const idx of toRemove.reverse()) userData.collection.splice(idx, 1);
      }
    }
    if (cmd === 'fixdupes') {
      saveDB(db);
      const preview = dupeList.slice(0, 10).join('\n') + (dupeList.length > 10 ? `\n*...and ${dupeList.length - 10} more*` : '');
      return message.reply(`✅ Removed **${count}** duplicate plant${count !== 1 ? 's' : ''}${count > 0 ? `:\n${preview}` : '.'}`);
    } else {
      if (!count) return message.reply('✅ No duplicates found.');
      const preview = dupeList.slice(0, 15).join('\n') + (dupeList.length > 15 ? `\n*...and ${dupeList.length - 15} more*` : '');
      return message.reply(`Found **${count}** duplicate plant${count !== 1 ? 's' : ''}:\n${preview}`);
    }
  }

  if (cmd === 'restoredata') {
  if (!BOT_ADMIN_IDS.includes(message.author.id)) return message.reply('Admins only.');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return message.reply('✅ Data directory ensured. Now redeploy and your bot will recreate fresh files.');
}

  // ── !help / !h ────────────────────────────────────────────────────────────
  if (cmd === 'help' || cmd === 'h') {
    const sub = args[1]?.toLowerCase();

    // ── Category menu ────────────────────────────────────────────────────────
    if (!sub) {
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('🌿 Plant Bot — Help')
        .setDescription('Welcome to Plant Bot! Choose a category to learn more.')
        .addFields(
          { name: '📖  !help info', value: 'Rarities, mutations, charm effects & how the game works' },
          { name: '🎮  !help play', value: 'Claims, daily/weekly, inventory, selling, trading, market, profile' },
          { name: '🏆  !help compete', value: 'Races, leaderboards & garden ranking explained' },
          { name: '🛒  !help shop', value: 'Crates, charms and titles — prices & effects' },
          { name: '🔧  !help admin', value: 'Mod & admin commands *(restricted)*' }
        )
        .setFooter({ text: 'Type !help <category> to expand it  ·  !guide for a full beginner walkthrough' })
        .setColor(0x57F287)
      ]});
    }

    // ── Info ─────────────────────────────────────────────────────────────────
    if (sub === 'info') {
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('📖 Info — Rarities, Mutations & Charms')
        .addFields(
          {
            name: '⭐ Rarities',
            value: [
              `${RARITY_EMOJIS.Common} **Common** — very frequent · sell: 10 coins`,
              `${RARITY_EMOJIS.Uncommon} **Uncommon** — frequent · sell: 25 coins`,
              `${RARITY_EMOJIS.Rare} **Rare** — occasional · sell: 75 coins`,
              `${RARITY_EMOJIS.Epic} **Epic** — uncommon · sell: 2,000 coins`,
              `${RARITY_EMOJIS.Legendary} **Legendary** — rare · sell: 10,000 coins`,
              `${RARITY_EMOJIS.Mythic} **Mythic** — very rare · sell: 25,000 coins`,
              `${RARITY_EMOJIS.Super} **Super** — extremely rare · sell: 60,000 coins`,
              '*There are rumours of something even rarer...*',
            ].join('\n'),
          },
          {
  name: '✨ Mutations',
  value: [
    'Mutations are rare bonuses that increase a plant\'s sell value. They can appear on any rarity.',
    '',
    '<:eclipsed:1477666927135428650> **Eclipsed** — ×5.0 sell value',
    '<:ignited:1534229469185839204> **Ignited** — ×4.2 sell value',
    '<:bloodlit:1534227550920900831> **Bloodlit** — ×4.0 sell value',
    '<:glow:1477666867890884628> **Glow** — ×3.5 sell value',
    '<:starstruck:1534230447247327303> **Starstruck** — ×3.0 sell value',
    '<a:lightning:1534229071385333770> **Electric** — ×2.0 sell value',
    '<:frozen:1477666846382620683> **Frozen** — ×1.4 sell value',
    '<:aurora:1534229653211054262> **Aurora** — ×1.15 sell value',
    '',
    '*Mutations only affect sell value — they do not contribute to garden rank.*',
    '*Eclipsed is the rarest mutation.*',
  ].join('\n'),
},
          {
            name: '🔮 How Charms Work',
            value: [
              'Charms boost your rarity odds in `!daily`, `!weekly` and crate openings.',
              '⚠️ Charms do **not** affect channel drops — the rarity is decided when the plant spawns.',
              '',
              '🥉 **Bronze Charm** — Rare+ weights ×1.05',
              '🥈 **Silver Charm** — Rare+ weights ×1.15',
              '🥇 **Gold Charm** — Epic+ weights ×1.30',
              '🌀 **Void Charm** — Legendary+ ×1.75, Mythic+ ×1.75',
              '',
              'Use `!equip <charm>` to activate · `!unequip <charm>` to remove',
            ].join('\n'),
          },
          {
            name: '📦 Versions & Value',
            value: [
              'Every plant has a version number (v1, v2, v3...). Lower versions are worth more.',
              '🔖 **v1** is the first ever copy claimed — highly valued in trades, never sell it!',
              'Version multipliers: v1 = ×3.5 · v2 = ×2.2 · v3 = ×1.7 · v4 = ×1.4 · v5 = ×1.2 · v6+ = ×1.0',
            ].join('\n'),
          },
          {
            name: '⏳ Decay',
            value: [
              'If you go **3 days** without activity your plants start decaying — 1 random plant removed per hour.',
              'You\'ll get a DM warning after **2 days** of inactivity.',
              '🛡️ **v1–v10 plants are always safe from decay.**',
            ].join('\n'),
          }
        )
        .setFooter({ text: '!guide for a full beginner walkthrough  ·  !help for categories' })
        .setColor(0x9C27B0)
      ]});
    }

    // ── Play ─────────────────────────────────────────────────────────────────
    if (sub === 'play') {
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('🎮 Play — Commands')
        .addFields(
          {
            name: '🌱 Getting Plants',
            value: [
              '`claim <captcha>` — Claim a plant from an active drop in the drop channel',
              '`!daily` — Free plant + coins once per day',
              '`!weekly` — 3 free plants + coins once per week',
            ].join('\n'),
          },
          {
            name: '🎒 Inventory',
            value: [
              '`!inv [page]` — View your plants',
              '`!inv [@user] [plant name]` — View someone\'s plants, optionally filtered by plant',
              '`!inv -r <rarity>` — Filter by rarity (e.g. `-r legendary`)',
              '`!inv -m <mutation>` — Filter by mutation (e.g. `-m starstruck`)',
              '`!inv -version <op><n>` — Filter by version (e.g. `-version >10`)',
              '`!view <plant> [-v version]` — Detailed view of a specific plant',
            ].join('\n'),
          },
          {
            name: '💰 Selling',
            value: [
              '`!sell <plant>` — Sell a plant (prompts version picker if you own multiple)',
              '`!sell <plant> -v <n>` — Sell a specific version',
              '`!sell <plant> all` — Sell all copies at once',
              '`!sellbatch [-r rarity] [-m mutation] [-v op#] [-p plant] [--confirm]` — Bulk sell by filter',
              '*v1–v10 are always protected from batch sells.*',
            ].join('\n'),
          },
          {
            name: '🔒 Locking Plants',
            value: [
              'Locks protect plants from being sold accidentally — locked plants are skipped by `!sell all`, `!sellbatch`, and `!sell` attempts.',
              '',
              '`!lock <plant>` — Lock all copies of a plant',
              '`!lock <plant> -v <n>` — Lock a specific version only',
              '`!lock -r <rarity>` — Lock all plants of a rarity (e.g. `-r legendary`)',
              '`!lock -m <mutation>` — Lock all plants with a mutation (e.g. `-m starstruck`)',
              '`!unlock <same filters>` — Remove a matching lock',
              '`!locks` — View all your active locks',
              '',
              '**Examples:**',
              '`!lock Carrot -v 1` — protect your v1 Carrot',
              '`!lock -r mythic` — protect all mythics',
              '`!lock -m starstruck` — protect all starstruck plants',
            ].join('\n'),
          },
          {
            name: '🔄 Trading',
            value: [
              '`!trade @user` — Start a trade session',
              'During a trade, type to add to your offer:',
              '> `Carrot` — adds your only copy, or shows picker if multiple',
              '> `Carrot v3` — adds a specific version',
              '> `Carrot all` — adds every copy you own',
              '> `500` — offer 500 coins',
              '`!remove <plant>` — Remove a plant from your offer',
              '`!confirm` — Lock in your side (both must confirm to complete)',
              '`!canceltrade` — Cancel at any time',
            ].join('\n'),
          },
          {
            name: '📈 Market',
            value: [
              '`!market` — See trending plants by demand',
              '`!market <plant>` — See who owns each version of a plant',
              '`!market <plant> -version <op><n>` — Filter by version',
              '`!market <plant> -m <mutation>` — Filter by mutation',
            ].join('\n'),
          },
          {
            name: '👤 Profile & Progress',
            value: [
              '`!prof [@user]` — View your profile card',
              '`!lvl [@user]` — View your level card',
              '`!coins [@user]` — Check coin balance',
              '`!ach [@user]` — View achievements',
              '`!titles [@user]` — View owned titles',
              '`!title <key>` — Equip a title · `!title none` to clear',
            ].join('\n'),
          }
        )
        .setFooter({ text: '!help for categories  ·  !guide for a beginner walkthrough' })
        .setColor(0x4d96ff)
      ]});
    }

    // ── Compete ───────────────────────────────────────────────────────────────
    if (sub === 'compete') {
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('🏆 Compete — Races & Leaderboards')
        .addFields(
          {
            name: '🏁 Races',
            value: [
              '`!race` *(Mod only)* — Starts a race in the current channel',
              'Type the captcha shown as fast as possible — first 5 to finish place on the board',
              'Winners earn XP and improve their best time',
            ].join('\n'),
          },
          {
            name: '📊 Leaderboards',
            value: [
              '`!invlb` — Garden leaderboard ranked by weighted garden score',
              '`!llb [page]` — Level leaderboard',
              '`!mlb` — Richest players by coins',
              '`!rlb` — Fastest race times',
              '`!streaklb` — Longest claim streaks',
            ].join('\n'),
          },
          {
            name: '🌿 Garden Score & Tiers',
            value: [
              'Your garden score is calculated using a **weighted ranking system** — higher rarity plants contribute more, but with diminishing returns so 100 commons can\'t beat 1 legendary.',
              '',
              GARDEN_TIERS.filter(t => t.name !== 'Secret').map(t => `${t.emoji} ${t.name}`).join(' · '),
              '',
              'Mutations and low version numbers both increase a plant\'s contribution to your score.',
            ].join('\n'),
          },
          {
            name: '⬆️ Levels & Ranks',
            value: [
              'Earn XP by claiming drops, daily/weekly, races and opening crates.',
              '',
              '🌱 Seedling (Lv.1) · 🌿 Sprout (Lv.5) · 🌾 Gardener (Lv.10) · 🌺 Botanist (Lv.20)',
              '💐 Florist (Lv.35) · 🌳 Arborist (Lv.50) · 🍃 Naturalist (Lv.75) · ✨ Verdant (Lv.100)',
            ].join('\n'),
          }
        )
        .setFooter({ text: '!help for categories' })
        .setColor(0xFFAA00)
      ]});
    }

    // ── Shop ──────────────────────────────────────────────────────────────────
    if (sub === 'shop') {
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('🛒 Shop — Crates, Charms & Titles')
        .setDescription('Use `!shop` to browse in-game · `!buy <item>` to purchase')
        .addFields(
          {
            name: '📦 Crates — open 10 plants at once',
            value: [
              '`bronze` — 1,000 coins',
              '`silver` — 5,000 coins',
              '`gold` — 10,000 coins',
              '`diamond` — 30,000 coins',
              '`ruby` — 75,000 coins',
              '*Higher tier crates have significantly better rarity odds.*',
            ].join('\n'),
          },
          {
            name: '🔮 Charms — boost daily/weekly/crate odds',
            value: [
              '🥉 `bronze_charm` — Rare+ ×1.05 · 50,000 coins',
              '🥈 `silver_charm` — Rare+ ×1.15 · 250,000 coins',
              '🥇 `gold_charm` — Epic+ ×1.30 · 1,000,000 coins',
              '🌀 `void_charm` — Legendary+ ×1.75 · 5,000,000 coins',
              '⚠️ Charms do **not** affect channel drops.',
              'Use `!equip <key>` · `!unequip <key>`',
            ].join('\n'),
          },
          {
            name: '🏷️ Titles — cosmetic flair on your profile',
            value: [
              '🗺️ `wanderer` — 2,000 coins',
              '🛡️ `guardian` — 5,000 coins',
              '👻 `phantom` — 15,000 coins',
              '👑 `sovereign` — 50,000 coins',
              '🌙 `celestial` — 200,000 coins',
              'Use `!title <key>` to equip · `!title none` to clear',
            ].join('\n'),
          }
        )
        .setFooter({ text: '!help for categories  ·  !shop to see your balance alongside items' })
        .setColor(0xFFD700)
      ]});
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    if (sub === 'admin') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('You don\'t have permission to view admin commands.');
      return message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('🔧 Admin & Mod Commands')
        .addFields(
          {
            name: '🌱 Drop Management *(Manage Messages)*',
            value: [
              '`!setdrop [#channel or ID]` — Set the drop channel',
              '`!setdrop stop` — Disable drops',
              '`!setvping [#channel or ID]` — Set the v1 ping channel',
              '`!setvping stop` — Disable v1 pings',
              '`!drop [-r rarity] [-p "plant"] [-m mutation]` — Force a drop',
              '`!race` — Start a race in the current channel',
            ].join('\n'),
          },
          {
            name: '⚙️ Server Settings *(Administrator)*',
            value: [
              '`!setrarity <rarity>` — Lock all drops to a specific rarity',
              '`!setrarity clear` — Remove the lock',
              '`!testrank` — Preview all garden tier icons',
            ].join('\n'),
          },
          {
            name: '👤 User Management *(Administrator)*',
            value: [
              '`!addcurrency @user <amount>` — Give coins',
              '`!removecurrency @user <amount>` — Remove coins',
              '`!addxp @user <amount>` — Give XP',
              '`!removexp @user <amount>` — Remove XP',
              '`!removeplant @user <plant>` — Remove a plant from a user',
              '`!wipeuser @user` — Delete all data for a user',
              '`!wipeall` — Wipe all server data *(nuclear, requires confirmation)*',
            ].join('\n'),
          }
        )
        .setFooter({ text: 'Admin commands require confirmation phrases for destructive actions' })
        .setColor(0xFF6600)
      ]});
    }

    // Unknown subcommand
    return message.reply('Unknown category. Use `!help` to see available categories.');
  }
}); 

// ─── End Auction ──────────────────────────────────────────────────────────────
async function endAuction(auctionId, fallbackChannel) {
  const auctions = loadAuctions();
  const idx = auctions.findIndex(a => a.id === auctionId);
  if (idx === -1) return; // already resolved
  const auction = auctions.splice(idx, 1)[0];
  saveAuctions(auctions);

  const rCfg = getRarityConfig(auction.plant.rarity);

  if (!auction.bids.length) {
    // No bids — return plant to seller
    const db = loadDB();
    const seller = getUser(db, auction.sellerId);
    seller.collection.push({ ...auction.plant, claimedAt: new Date().toISOString() });
    saveDB(db);
    const embed = new EmbedBuilder()
      .setTitle(`🔨 Auction Ended — No Bids`)
      .setDescription(`**${auction.plant.name}** \`v${auction.plant.version || '?'}\` returned to **${auction.sellerName}**.`)
      .setColor(0x9E9E9E);
    if (fallbackChannel) fallbackChannel.send({ embeds: [embed] }).catch(() => {});
    return;
  }

  const winner = auction.bids[auction.bids.length - 1];
  const db = loadDB();
  const buyer  = getUser(db, winner.userId);
  const seller = getUser(db, auction.sellerId);

  // Coins were already deducted from the winner at bid time — just pay the seller
  seller.currency += winner.amount;
  buyer.collection.push({ ...auction.plant, claimedAt: new Date().toISOString() });
  saveDB(db);

  broadcastAll({ type: 'auction_ended', auctionId });
  pushCoinUpdate(winner.userId, buyer.currency);
  pushCoinUpdate(auction.sellerId, seller.currency);
  pushCollectionUpdate(winner.userId);
  broadcastLeaderboardUpdate();

  const embed = new EmbedBuilder()
    .setTitle('🔨 Auction Complete!')
    .setDescription(`${rCfg.emoji} **${auction.plant.name}** \`v${auction.plant.version || '?'}\`${auction.plant.mutation ? ` ${auction.plant.mutation.emoji} ${auction.plant.mutation.name}` : ''}\n\n🏆 Won by **${winner.username}** for ${fmt(winner.amount)}!`)
    .setColor(rCfg.color)
    .setFooter({ text: `Seller: ${auction.sellerName}` });

  if (fallbackChannel) fallbackChannel.send({ embeds: [embed] }).catch(() => {});

  // DM winner
  try { const u = await client.users.fetch(winner.userId); await u.send({ embeds: [new EmbedBuilder().setTitle('🏆 You won an auction!').setDescription(`You won **${auction.plant.name}** \`v${auction.plant.version||'?'}\` for **${fmt(winner.amount)} coins**!`).setColor(0x00c864)] }); } catch {}
  // DM seller
  try { const s = await client.users.fetch(auction.sellerId); await s.send({ embeds: [new EmbedBuilder().setTitle('💰 Your auction sold!').setDescription(`**${auction.plant.name}** sold to **${winner.username}** for **${fmt(winner.amount)} coins**!`).setColor(0x52b788)] }); } catch {}
  // DM outbid users
  for (const bid of auction.bids.slice(0,-1)) {
    if (bid.userId === winner.userId) continue;
    try { const u = await client.users.fetch(bid.userId); await u.send({ embeds: [new EmbedBuilder().setTitle('📉 You were outbid!').setDescription(`You were outbid on **${auction.plant.name}**. Final price: **${fmt(winner.amount)} coins**.`).setColor(0xFF6600)] }); } catch {}
  }
}

// ─── End Race ─────────────────────────────────────────────────────────────────
async function endRace(channel, race) {
  if (!activeRaces[channel.id]) return;
  delete activeRaces[channel.id];
  if (!race.finishers.length) return channel.send({ embeds: [new EmbedBuilder().setTitle('🏁 Race Over — No Finishers!').setColor(0x555555)] });
  race.finishers.sort((a,b) => a.time-b.time);
  const lines = race.finishers.slice(0,5).map((f,i) => `${medal(i)} <@${f.userId}> — **${msToStr(f.time)}**`);
  return channel.send({ embeds: [new EmbedBuilder().setTitle('🏁 Race Results!').setDescription(`${medal(0)} Winner: <@${race.finishers[0].userId}> in **${msToStr(race.finishers[0].time)}**\n\n**Standings:**\n${lines.join('\n')}`).setColor(0xFFAA00)] });
}

// ─── Login ────────────────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('❌ No BOT_TOKEN'); process.exit(1); }
if (ENABLE_WEB_DASHBOARD) {
// ─── Web Server ───────────────────────────────────────────────────────────────
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const { Strategy: DiscordStrategy } = require('passport-discord');
const app = express();

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'gardenhorizons_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    sameSite: 'lax', 
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  },
}));
app.use(passport.initialize());
app.use(passport.session());
app.use('/images', express.static(path.join(__dirname, 'images')));
app.use(express.static(__dirname));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
  scope: ['identify'],
}, (accessToken, refreshToken, profile, done) => {
  return done(null, { id: profile.id, username: profile.username, avatar: profile.avatar });
}));

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);
app.get('/auth/logout', (req, res) => { req.logout(() => {}); res.redirect('/'); });
app.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: req.user });
});

app.get('/api/leaderboards', (req, res) => {
  try {
    const db   = loadDB();
    const meta = loadMeta();
    const raceLB = loadRaceLB();
    const claimsLB = loadClaimsLB();
    const now = Date.now();
    const DAY  = 24 * 60 * 60 * 1000;
    const WEEK = 167 * 60 * 60 * 1000;

    const garden = Object.entries(db)
      .filter(([id]) => !TEST_IDS.has(id))
      .map(([id, u]) => ({ id, score: calcWeightedGardenScore(u.collection||[]), plants: (u.collection||[]).length, tier: getGardenTier(calcWeightedGardenScore(u.collection||[])) }))
      .filter(e => e.score > 0).sort((a,b) => b.score - a.score).slice(0,10);

    const level = Object.entries(db)
      .filter(([id]) => !TEST_IDS.has(id))
      .map(([id, u]) => ({ id, xp: u.xp||0, level: getLevelFromXP(u.xp||0) }))
      .sort((a,b) => b.xp - a.xp).slice(0,10);

    const money = Object.entries(db)
      .filter(([id]) => !TEST_IDS.has(id))
      .map(([id, u]) => ({ id, currency: u.currency||0 }))
      .sort((a,b) => b.currency - a.currency).slice(0,10);

    const race = raceLB.slice(0,10);

    const daily = claimsLB
      .filter(e => !TEST_IDS.has(e.userId))
      .map(e => ({ userId: e.userId, username: e.username, count: getClaimsInWindow(e.claims, DAY) }))
      .filter(e => e.count > 0).sort((a,b) => b.count - a.count).slice(0,10);

    const weekly = claimsLB
      .filter(e => !TEST_IDS.has(e.userId))
      .map(e => ({ userId: e.userId, username: e.username, count: getClaimsInWindow(e.claims, WEEK) }))
      .filter(e => e.count > 0).sort((a,b) => b.count - a.count).slice(0,10);

    const name = (id) => {
      const u = db[id];
      return u?.username || `User#${id.slice(-4)}`;
    };

    res.json({
      garden: garden.map(e => ({ ...e, username: name(e.id), tierName: e.tier.name, tierEmoji: e.tier.emoji, rainbowTag: !!(db[e.id]?.rainbowTag && db[e.id].rainbowTag.expiresAt > now) })),
      level:  level.map(e  => ({ ...e, username: name(e.id), rank: getRank(e.level), rainbowTag: !!(db[e.id]?.rainbowTag && db[e.id].rainbowTag.expiresAt > now) })),
      money:  money.map(e  => ({ ...e, username: name(e.id), rainbowTag: !!(db[e.id]?.rainbowTag && db[e.id].rainbowTag.expiresAt > now) })),
      race:   race.map(e   => ({ ...e, rainbowTag: !!(db[e.userId]?.rainbowTag && db[e.userId].rainbowTag.expiresAt > now) })),
      daily:  daily.map(e  => ({ ...e, rainbowTag: !!(db[e.userId]?.rainbowTag && db[e.userId].rainbowTag.expiresAt > now) })),
      weekly: weekly.map(e => ({ ...e, rainbowTag: !!(db[e.userId]?.rainbowTag && db[e.userId].rainbowTag.expiresAt > now) })),
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/profile/:id', (req, res) => {
  try {
    const db   = loadDB();
    const user = db[req.params.id];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const xp    = user.xp || 0;
    const level = getLevelFromXP(xp);
    const rank  = getRank(level);
    const { pct, needed, progress } = xpToNextLevel(xp);
    const score = calcWeightedGardenScore(user.collection||[]);
    const tier  = getGardenTier(score);
    const title = getActiveTitle(user);
    const allUsers = Object.entries(db).filter(([id]) => !TEST_IDS.has(id)).map(([id,u]) => ({ id, score: calcWeightedGardenScore(u.collection||[]) })).sort((a,b) => b.score-a.score);
    const serverRank = allUsers.findIndex(e => e.id === req.params.id) + 1;
    res.json({
      id: req.params.id,
      username: user.username || `User#${req.params.id.slice(-4)}`,
      level, xp, pct, needed, progress,
      rank: { name: rank.name, emoji: rank.emoji },
      currency: user.currency || 0,
      plants: user.collection?.length || 0,
      achievements: user.achievements?.length || 0,
      collection: (user.collection||[]),
      gardenScore: score,
      gardenTier: { name: tier.name, emoji: tier.emoji, color: tier.color },
      title,
      serverRank,
      serverTotal: allUsers.length,
      cratesOpened: user.cratesOpened || 0,
      raceWins: user.raceWins || 0,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/players', (req, res) => {
  try {
    const db = loadDB();
    const players = Object.entries(db)
      .filter(([id]) => !TEST_IDS.has(id))
      .map(([id, u]) => {
        const score = calcWeightedGardenScore(u.collection||[]);
        const level = getLevelFromXP(u.xp||0);
        const tier  = getGardenTier(score);
        const rank  = getRank(level);
        return { id, username: u.username || `User#${id.slice(-4)}`, avatarUrl: u.avatarUrl || null, level, score, plants: (u.collection||[]).length, tierName: tier.name, tierEmoji: tier.emoji, rankEmoji: rank.emoji, rankName: rank.name };
      })
      .filter(e => e.plants >= 0)
      .sort((a,b) => b.score - a.score);
    res.json(players);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auctions/:id/bid', express.json({ strict: false }), async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    const { amount, buyout } = req.body;

    // Buy now path
    if (buyout) {
      const auctions = loadAuctions();
      const idx = auctions.findIndex(a => a.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Auction not found' });
      const auction = auctions[idx];
      if (!auction.buyoutPrice) return res.status(400).json({ error: 'No buyout price set' });
      if (Date.now() > auction.endsAt) return res.status(400).json({ error: 'Auction has ended' });
      if (auction.sellerId === req.user.id) return res.status(400).json({ error: "You can't buy your own auction" });
      const db = loadDB();
      const buyer = getUser(db, req.user.id);
      if (buyer.currency < auction.buyoutPrice) return res.status(400).json({ error: `Not enough coins`, balance: buyer.currency });
      const seller = getUser(db, auction.sellerId);
      buyer.currency -= auction.buyoutPrice;
      seller.currency += auction.buyoutPrice;
      buyer.collection.push({ ...auction.plant, claimedAt: new Date().toISOString() });
      saveDB(db);
      auctions.splice(idx, 1);
      saveAuctions(auctions);
      broadcastAll({ type: 'auction_ended', auctionId: req.params.id });
      pushCoinUpdate(req.user.id, buyer.currency);
      pushCoinUpdate(auction.sellerId, seller.currency);
      pushCollectionUpdate(req.user.id);
      broadcastLeaderboardUpdate();
      return res.json({ success: true, buyout: true });
    }

    const bidAmount = parseInt(amount);
    if (isNaN(bidAmount) || bidAmount <= 0) return res.status(400).json({ error: 'Invalid bid amount' });

    const auctions = loadAuctions();
    const auction  = auctions.find(a => a.id === req.params.id);
    if (!auction)              return res.status(404).json({ error: 'Auction not found' });
    if (Date.now() > auction.endsAt) return res.status(400).json({ error: 'This auction has already ended' });
    if (auction.sellerId === req.user.id) return res.status(400).json({ error: "You can't bid on your own auction" });

    const db   = loadDB();
    const user = getUser(db, req.user.id);

    const prevTopBid = auction.bids.length ? auction.bids[auction.bids.length - 1] : null;
    const prevTopAmount = prevTopBid ? prevTopBid.amount : auction.startPrice - 1;
    const minBid = Math.max(prevTopAmount + 1, Math.ceil(prevTopAmount * 1.05));
    if (bidAmount < minBid) return res.status(400).json({ error: `Minimum bid is ${minBid.toLocaleString()} coins (5% above current)`, minBid });

    if (!user || user.currency === undefined) return res.status(400).json({ error: 'Your account was not found. Use the bot first to register.' });
    if (user.currency < bidAmount) return res.status(400).json({ error: `You only have ${user.currency.toLocaleString()} coins`, balance: user.currency });

    // Refund the previous top bidder before placing the new bid
    if (prevTopBid && prevTopBid.userId !== req.user.id) {
      const prevBidder = getUser(db, prevTopBid.userId);
      prevBidder.currency += prevTopBid.amount;
      pushCoinUpdate(prevTopBid.userId, prevBidder.currency);
    } else if (prevTopBid && prevTopBid.userId === req.user.id) {
      // Same user raising their own bid — refund their previous amount first
      user.currency += prevTopBid.amount;
    }

    // Deduct new bid amount immediately
    user.currency -= bidAmount;

    // Soft-close extension
    const timeLeft   = auction.endsAt - Date.now();
    const totalAdded = auction.totalExtended || 0;
    const remaining  = Math.max(0, AUCTION_MAX_EXTENSION - totalAdded);
    let extended = 0;
    if (remaining > 0) {
      if (timeLeft <= AUCTION_EXTEND_THRESHOLD_2)      extended = Math.min(AUCTION_EXTEND_AMOUNT_2, remaining);
      else if (timeLeft <= AUCTION_EXTEND_THRESHOLD_1) extended = Math.min(AUCTION_EXTEND_AMOUNT_1, remaining);
    }
    if (extended > 0) {
      auction.endsAt += extended;
      auction.totalExtended = totalAdded + extended;
    }

    auction.bids.push({ userId: req.user.id, username: req.user.username, amount: bidAmount, time: Date.now() });
    saveAuctions(auctions);
    touchActivity(db, req.user.id);
    saveDB(db);
    pushCoinUpdate(req.user.id, user.currency);

    // Broadcast live bid update to WebSocket clients in this auction room
    const bidPayload = JSON.stringify({
      type: 'bid',
      auctionId: req.params.id,
      bids: auction.bids.slice(-10).reverse().map(b => ({
        userId: b.userId,
        username: b.username,
        amount: b.amount,
        time: b.time
      })),
      currentBid: bidAmount,
      endsAt: auction.endsAt
    });
    (auctionRooms[req.params.id] || []).forEach(client => {
      if (client.readyState === 1) client.send(bidPayload);
    });
    // Also broadcast a lightweight grid update to all users
    broadcastAll({ type: 'auction_bid_grid', auctionId: req.params.id, currentBid: bidAmount, topBidder: req.user.username, endsAt: auction.endsAt });

    res.json({
      success: true,
      extended: extended,
      endsAt: auction.endsAt,
      newMin: Math.ceil(bidAmount * 1.05),
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auctions', (req, res) => {
  try {
    const auctions = loadAuctions();
    const db = loadDB();
    const now = Date.now();
    res.json(auctions.map(a => {
      const rCfg = getRarityConfig(a.plant.rarity);
      const topBid = a.bids.length ? a.bids[a.bids.length - 1] : null;
      const seller = db[a.sellerId];
      const boosted = !!(seller?.listingBoost && seller.listingBoost.expiresAt > now);
      return {
        id: a.id,
        sellerId: a.sellerId,
        sellerName: a.sellerName,
        boosted,
        plant: {
          name: a.plant.name,
          rarity: a.plant.rarity,
          version: a.plant.version,
          mutation: a.plant.mutation,
          image: a.plant.image,
          localImage: (() => {
            const match = PLANTS.find(p => p.name === a.plant.name);
            return match ? '/images/' + match.file.replace('./images/', '') : null;
          })(),
          color: rCfg.color,
          emoji: rCfg.emoji,
        },
        startPrice: a.startPrice,
        buyoutPrice: a.buyoutPrice || null,
        minIncrement: a.minIncrement,
        currentBid: topBid ? topBid.amount : a.startPrice || 0,
        topBidder: topBid ? topBid.username : null,
        bidCount: a.bids.length,
        bids: a.bids.slice(-10).reverse(),
        endsAt: a.endsAt,
        timeLeft: Math.max(0, a.endsAt - now),
      };
    }).sort((a, b) => (b.boosted ? 1 : 0) - (a.boosted ? 1 : 0)));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/avatar/:id', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600');
    const user = await client.users.fetch(req.params.id);
    const url  = user.displayAvatarURL({ extension: 'png', size: 128 });
    res.json({ url });
  } catch(err) { res.json({ url: null }); }
});

app.post('/api/avatars/bulk', async (req, res) => {
  const ids = req.body.ids || [];
  const results = {};
  await Promise.all(ids.map(async id => {
    try {
      const user = await client.users.fetch(id);
      results[id] = user.displayAvatarURL({ extension: 'png', size: 128 });
    } catch { results[id] = null; }
  }));
  res.json(results);
});
const PORT = process.env.PORT || 3000;
const { WebSocketServer } = require('ws');
const httpServer = require('http').createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Global user socket map — userId -> ws
const userSockets = {};

pushToUser = function(userId, payload) {
  const ws = userSockets[userId];
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
};

broadcastAll = function(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
};

pushCoinUpdate = function(userId, newBalance) {
  pushToUser(userId, { type: 'coin_update', balance: newBalance });
};

// Push a user's full collection to them live (for inventory sync)
pushCollectionUpdate = function(userId) {
  try {
    const db   = loadDB();
    const user = db[userId];
    if (!user) return;
    const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    const collection = (user.collection || []).map(p => {
      const base = PLANTS.find(b => b.name === p.name) || DROP_ONLY_PLANTS.find(b => b.name === p.name) || {};
      return {
        name:      p.name,
        rarity:    p.rarity,
        version:   p.version,
        mutation:  p.mutation || null,
        image:     base.display || '',
        sellPrice: getLiveSellValue(p),
      };
    });
    pushToUser(userId, { type: 'collection_update', collection });
  } catch {}
};

// Broadcast a leaderboard refresh signal to all connected clients
broadcastLeaderboardUpdate = function() {
  broadcastAll({ type: 'leaderboard_update' });
};

// ── CHAT PERSISTENCE ──────────────────────────────────────────────────────
const CHAT_FILE = `${DATA_DIR}/auction_chats.json`;
function loadChats() {
  try { return JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); } catch { return {}; }
}
function saveChats(chats) {
  fs.writeFileSync(CHAT_FILE, JSON.stringify(chats, null, 2));
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────
const auctionRooms = {};

wss.on('connection', (ws) => {
  let currentRoom = null;
  let userInfo = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        // Global auth — register this socket to the user
        if (msg.userId) {
          userInfo = { userId: msg.userId, username: msg.username, avatarUrl: msg.avatarUrl };
          userSockets[msg.userId] = ws;
        }
      } else if (msg.type === 'join') {
        currentRoom = msg.auctionId;
        userInfo = { ...userInfo, username: msg.username, avatarUrl: msg.avatarUrl };
        if (!auctionRooms[currentRoom]) auctionRooms[currentRoom] = [];
        auctionRooms[currentRoom].push(ws);
        // Send existing messages to this client
        const chats = loadChats();
        const history = (chats[currentRoom] || []).slice(-50);
        ws.send(JSON.stringify({ type: 'history', messages: history }));
      } else if (msg.type === 'chat' && currentRoom && userInfo) {
        const chatMsg = {
          username: userInfo.username,
          avatarUrl: userInfo.avatarUrl,
          text: msg.text.slice(0, 300),
          time: Date.now()
        };
        // Save to file
        const chats = loadChats();
        if (!chats[currentRoom]) chats[currentRoom] = [];
        chats[currentRoom].push(chatMsg);
        // Keep max 200 messages per auction
        if (chats[currentRoom].length > 200) chats[currentRoom] = chats[currentRoom].slice(-200);
        saveChats(chats);
        // Broadcast to all in room
        const payload = JSON.stringify({ type: 'chat', ...chatMsg });
        (auctionRooms[currentRoom] || []).forEach(client => {
          if (client.readyState === 1) client.send(payload);
        });
      }
    } catch {}
  });

  ws.on('close', () => {
    if (currentRoom && auctionRooms[currentRoom]) {
      auctionRooms[currentRoom] = auctionRooms[currentRoom].filter(c => c !== ws);
    }
    if (userInfo?.userId && userSockets[userInfo.userId] === ws) {
      delete userSockets[userInfo.userId];
    }
  });
});

// ── CHAT API (for loading history on page open) ───────────────────────────
app.delete('/api/auction/:id', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const auctions = loadAuctions();
  const auction  = auctions.find(a => a.id === req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  if (auction.sellerId !== req.user.id) return res.status(403).json({ error: 'Not your auction' });
  if (auction.bids.length) return res.status(400).json({ error: 'Cannot remove — auction already has bids' });
  const db   = loadDB();
  const user = getUser(db, req.user.id);
  user.collection.push({ ...auction.plant });
  saveDB(db);
  saveAuctions(auctions.filter(a => a.id !== req.params.id));
  broadcastAll({ type: 'auction_ended', auctionId: req.params.id });
  pushCollectionUpdate(req.user.id);
  res.json({ success: true });
});

app.post('/api/auction/create', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { plantName, version, startPrice, buyoutPrice, hours } = req.body;
  if (!plantName) return res.status(400).json({ error: 'Plant name required' });

  const db   = loadDB();
  const user = getUser(db, req.user.id);

  let candidates = user.collection.map((p, i) => ({ p, i })).filter(({ p }) => p.name.toLowerCase() === plantName.toLowerCase());
  if (version) candidates = candidates.filter(({ p }) => p.version === parseInt(version));
  if (!candidates.length) return res.status(400).json({ error: `You don't own ${plantName}${version ? ` v${version}` : ''}` });
  if (candidates.length > 1 && !version) {
    const versions = candidates.map(({ p }) => `v${p.version}`).join(', ');
    return res.status(400).json({ error: `You own multiple copies: ${versions}. Specify a version.` });
  }

  const { p: plant, i: plantIndex } = candidates[0];
  if (isLocked(req.user.id, plant)) return res.status(400).json({ error: `${plant.name} v${plant.version} is locked.` });

  const h          = Math.min(72, Math.max(1, parseInt(hours) || 24));
  const start      = parseInt(startPrice) || (plant.sellValue || getRarityConfig(plant.rarity).sellPrice);
  const buyout     = buyoutPrice ? parseInt(buyoutPrice) : null;
  const minIncr    = Math.max(100, Math.round(start * 0.05));

  if (buyout && buyout <= start) return res.status(400).json({ error: 'Buyout must be higher than starting bid' });

  const auctionId = `a_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const endsAt    = Date.now() + h * 3600000;

  user.collection.splice(plantIndex, 1);
  saveDB(db);

  const auctions = loadAuctions();
  auctions.push({ id: auctionId, sellerId: req.user.id, sellerName: req.user.username, plant: { ...plant }, startPrice: start, buyoutPrice: buyout, minIncrement: minIncr, bids: [], endsAt, createdAt: Date.now() });
  saveAuctions(auctions);

  setTimeout(() => endAuction(auctionId, null), h * 3600000);

  broadcastAll({ type: 'auction_new' });
  pushCollectionUpdate(req.user.id);
  res.json({ success: true, auctionId });
});

// ── MARKET LISTINGS ──────────────────────────────────────────────────────
function saveListings(l) { fs.writeFileSync(LISTINGS_FILE, JSON.stringify(l, null, 2)); }

// ── CRATE OPEN API (web) — mirrors !buy [crate] exactly ──────────────────────
app.post('/api/crate/open', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const { crateId } = req.body;
  return queueForUser(req.user.id, async () => {
    try {
      if (!crateId || !CRATES[crateId]) return res.status(400).json({ error: 'Unknown crate' });
      const crate = CRATES[crateId];
      const db    = loadDB();
      const user  = getUser(db, req.user.id);

      const userLevel = getLevelFromXP(user.xp || 0);
      if (userLevel < crate.minLevel)
        return res.status(400).json({ error: `You need to be Level ${crate.minLevel} to open the ${crate.name}. You're currently Level ${userLevel}.` });

      if (!user.crateCooldowns) user.crateCooldowns = {};
      const lastUsed  = user.crateCooldowns[crateId] || 0;
      const cdMs      = CRATE_COOLDOWNS[crateId] || 0;
      const remaining = cdMs - (Date.now() - lastUsed);
      if (remaining > 0)
        return res.status(400).json({ error: 'On cooldown', cooldownMs: remaining });

      if ((user.currency || 0) < crate.price)
        return res.status(400).json({ error: `Not enough coins — need ${crate.price.toLocaleString()}` });

      const results     = openCrate(crateId, db, req.user.id);
      const addedPlants = [];
      user.currency -= crate.price;
      user.crateCooldowns[crateId] = Date.now();

      const crateMeta = loadMeta();
      for (const p of results) {
        const ver = getAvailableVersionFromMeta(p.name, db, crateMeta);
        if ((crateMeta.plantVersions[p.name] || 0) < ver) crateMeta.plantVersions[p.name] = ver;
        const sv    = calcSellValue(p, p.rarityConfig, p.mutation, ver);
        const entry = {
          name: p.name, image: p.display, rarity: p.rarity,
          mutation: p.mutation ? { name: p.mutation.name, emoji: p.mutation.emoji, multiplier: p.mutation.multiplier } : null,
          version: ver, sellValue: sv, claimedAt: new Date().toISOString(),
        };
        if (!user.collection.some(c => c.name === entry.name && c.version === entry.version)) {
          user.collection.push(entry);
          addedPlants.push(entry);
        }
        db[req.user.id] = user;
      }
      saveMeta(crateMeta);
      user.cratesOpened = (user.cratesOpened || 0) + 1;
      addXP(db, req.user.id, XP_REWARDS.crate_open);
      checkAchievements(user);
      const autoEarned = applyAutosellRules(user, req.user.id, addedPlants);
      saveDB(db);
      pushCoinUpdate(req.user.id, user.currency);
      pushCollectionUpdate(req.user.id);

      return res.json({
        ok: true,
        plants: addedPlants,
        newBalance: user.currency,
        autoSold: autoEarned,
        cooldownMs: CRATE_COOLDOWNS[crateId] || 0,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
});

// ── CRATE COOLDOWN STATUS (web) ───────────────────────────────────────────────
app.get('/api/crate/cooldowns', (req, res) => {
  if (!req.user) return res.json({});
  const db   = loadDB();
  const user = db[req.user.id];
  if (!user) return res.json({});
  const now    = Date.now();
  const result = {};
  for (const [key, cdMs] of Object.entries(CRATE_COOLDOWNS)) {
    const lastUsed  = (user.crateCooldowns || {})[key] || 0;
    const remaining = cdMs - (now - lastUsed);
    result[key] = remaining > 0 ? remaining : 0;
  }
  res.json(result);
});

app.get('/api/plants', (req, res) => {
  try {
    const db = loadDB();
    const ownerCounts = {};
    for (const [id, user] of Object.entries(db)) {
      if (TEST_IDS.has(id)) continue;
      const seen = new Set();
      for (const p of (user.collection || [])) {
        if (!seen.has(p.name)) { seen.add(p.name); ownerCounts[p.name] = (ownerCounts[p.name] || 0) + 1; }
      }
    }

    res.json(PLANTS.map(p => {
  const rCfg = getRarityConfig(p.rarity);
  return {
    name: p.name,
    rarity: p.rarity,
    image: '/images/' + p.file.replace('./images/', ''),
    sellPrice: rCfg.sellPrice || 0,
  };
}));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/market', (req, res) => {
  try {
    const listings = loadListings();
    const db = loadDB();
    const rarityColors = { Common:'#9E9E9E',Uncommon:'#4CAF50',Rare:'#2196F3',Epic:'#9C27B0',Legendary:'#FFD700',Mythic:'#F44336',Secret:'#111111' };
    const allowedRarities = ['Epic', 'Legendary', 'Mythic', 'Secret'];
    const now = Date.now();
    res.json(listings
      .filter(l => allowedRarities.includes(l.plant.rarity))
      .map(l => {
        const plantMatch = PLANTS.find(p => p.name === l.plant.name);
        const seller = db[l.sellerId];
        const boosted = seller?.listingBoost && seller.listingBoost.expiresAt > now;
        return {
          id: l.id,
          name: l.plant.name,
          rarity: l.plant.rarity,
          version: l.plant.version,
          mutation: l.plant.mutation || null,
          emoji: l.plant.emoji || '🌿',
          localImage: plantMatch ? '/images/' + plantMatch.file.replace('./images/', '') : null,
          color: rarityColors[l.plant.rarity] || '#999',
          price: l.price,
          sellerName: l.sellerName,
          sellerId: l.sellerId,
          boosted: boosted || false,
        };
      })
      .sort((a, b) => (b.boosted ? 1 : 0) - (a.boosted ? 1 : 0)));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/market/list', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { plantName, version, price } = req.body;
  if (!plantName || !price) return res.status(400).json({ error: 'Plant name and price required' });

  const db   = loadDB();
  const user = getUser(db, req.user.id);

  let candidates = (user.collection || []).map((p, i) => ({ p, i })).filter(({ p }) => p.name.toLowerCase() === plantName.toLowerCase());
  if (version) candidates = candidates.filter(({ p }) => p.version === parseInt(version));
  if (!candidates.length) return res.status(400).json({ error: `You don't own ${plantName}${version ? ` v${version}` : ''}` });

  const { p: plant, i: plantIndex } = candidates[0];
  if (isLocked(req.user.id, plant)) return res.status(400).json({ error: `${plant.name} v${plant.version} is locked.` });
  const allowedRarities = ['Epic', 'Legendary', 'Mythic', 'Secret'];
  if (!allowedRarities.includes(plant.rarity)) return res.status(400).json({ error: `Only Epic, Legendary, Mythic, and Secret plants can be listed on the market.` });

  const listingId = `l_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  user.collection.splice(plantIndex, 1);
  saveDB(db);

  const listings = loadListings();
  listings.push({ id: listingId, sellerId: req.user.id, sellerName: req.user.username, plant: { ...plant }, price: parseInt(price), listedAt: Date.now() });
  saveListings(listings);

  broadcastAll({ type: 'market_update' });
  pushCoinUpdate(req.user.id, getUser(loadDB(), req.user.id).currency);
  pushCollectionUpdate(req.user.id);

  // ── Price Alert: notify users who have a matching alert ──
  const listedPrice = parseInt(price);
  const freshDb = loadDB();
  for (const [alertUserId, alertUser] of Object.entries(freshDb)) {
    if (alertUserId === req.user.id) continue;
    if (!alertUser.priceAlerts?.length) continue;
    for (const alert of alertUser.priceAlerts) {
      if (alert.rarity && alert.rarity !== plant.rarity) continue;
      if (alert.maxPrice && listedPrice > alert.maxPrice) continue;
      // Match — DM the user
      try {
        const u = await client.users.fetch(alertUserId);
        await u.send({ embeds: [new EmbedBuilder()
          .setTitle('🔔 Price Alert!')
          .setDescription(`A **${plant.rarity} ${plant.name}** \`v${plant.version || '?'}\` was just listed for **${listedPrice.toLocaleString()} coins** — within your alert threshold of **${alert.maxPrice?.toLocaleString() ?? 'any price'}**!\n\nHead to the Market to buy it.`)
          .setColor(0xFFD700)
        ]});
      } catch {}
      break; // only one alert match per user per listing
    }
  }

  res.json({ success: true, listingId });
});

app.delete('/api/market/:id', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const listings = loadListings();
  const listing  = listings.find(l => l.id === req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.sellerId !== req.user.id) return res.status(403).json({ error: 'Not your listing' });
  const db   = loadDB();
  const user = getUser(db, req.user.id);
  user.collection.push({ ...listing.plant });
  saveDB(db);
  saveListings(listings.filter(l => l.id !== req.params.id));
  broadcastAll({ type: 'market_update' });
  pushCoinUpdate(req.user.id, getUser(db, req.user.id).currency);
  pushCollectionUpdate(req.user.id);
  res.json({ success: true });
});

app.post('/api/market/buy/:id', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const listings = loadListings();
  const listing  = listings.find(l => l.id === req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.sellerId === req.user.id) return res.status(400).json({ error: "You can't buy your own listing" });

  const db     = loadDB();
  const buyer  = getUser(db, req.user.id);
  const seller = getUser(db, listing.sellerId);

  if (buyer.currency < listing.price) return res.status(400).json({ error: `Not enough coins — need ${listing.price.toLocaleString()}` });

  buyer.currency  -= listing.price;
  seller.currency += listing.price;
  buyer.collection.push({ ...listing.plant, claimedAt: new Date().toISOString() });

  saveDB(db);
  saveListings(listings.filter(l => l.id !== req.params.id));

  // DM seller
  try { const u = await client.users.fetch(listing.sellerId); await u.send({ embeds: [new EmbedBuilder().setTitle('💰 Your plant sold!').setDescription(`**${listing.plant.name}** \`v${listing.plant.version||'?'}\` was bought by **${req.user.username}** for **${listing.price.toLocaleString()} coins**!`).setColor(0x00c864)] }); } catch {}

  broadcastAll({ type: 'market_update' });
  pushCoinUpdate(req.user.id, buyer.currency);
  pushCoinUpdate(listing.sellerId, seller.currency);
  pushCollectionUpdate(req.user.id);
  broadcastLeaderboardUpdate();
  res.json({ success: true });
});

app.get('/api/auction/:auctionId/chats', (req, res) => {
  const chats = loadChats();
  res.json(chats[req.params.auctionId] || []);
});


// ─── Web Trade API ────────────────────────────────────────────────────────────
app.post('/api/trade/create', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: 'Missing targetId' });
  if (targetId === req.user.id) return res.status(400).json({ error: "Can't trade with yourself" });
  const alreadyIn = Object.values(webTrades).find(t =>
    t.status === 'active' && (t.initiatorId === req.user.id || t.targetId === req.user.id ||
    t.initiatorId === targetId || t.targetId === targetId)
  );
  if (alreadyIn) return res.status(400).json({ error: 'One of the users already has an active trade' });
  const db = loadDB();
  const targetUser = db[targetId];
  if (!targetUser) return res.status(404).json({ error: 'Target user not found' });
  const tradeId = `wt_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  webTrades[tradeId] = {
    id: tradeId,
    initiatorId: req.user.id,
    initiatorName: req.user.username,
    targetId,
    targetName: targetUser.username || targetId,
    sides: {
      [req.user.id]: { plants: [], coins: 0, confirmed: false },
      [targetId]:    { plants: [], coins: 0, confirmed: false }
    },
    status: 'active',
    createdAt: Date.now()
  };
  saveTrades(webTrades);
  setTimeout(() => {
    if (webTrades[tradeId] && webTrades[tradeId].status === 'active') {
      webTrades[tradeId].status = 'expired';
      saveTrades(webTrades);
    }
  }, 10 * 60_000);
  // Notify target player instantly
  pushToUser(targetId, {
    type: 'notification',
    notifType: 'trade_received',
    message: `${req.user.username} wants to trade with you! Go to the Trade page.`
  });
  try { if (canBotDM(targetId, 'trade_received')) { const u = await client.users.fetch(targetId); await u.send({ embeds: [new EmbedBuilder().setTitle('🔄 Trade Request!').setDescription(`**${req.user.username}** wants to trade with you! Visit the Trade page on the website.`).setColor(0x5865F2)] }); } } catch {}
  res.json({ tradeId });
});

app.get('/api/trade/active/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const trade = Object.values(webTrades).find(t =>
    t.status === 'active' && (t.initiatorId === req.user.id || t.targetId === req.user.id)
  );
  res.json(trade || null);
});

app.get('/api/trade/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const trade = webTrades[req.params.id];
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  if (trade.initiatorId !== req.user.id && trade.targetId !== req.user.id)
    return res.status(403).json({ error: 'Not your trade' });
  res.json(trade);
});

app.post('/api/trade/:id/offer', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const trade = webTrades[req.params.id];
  if (!trade || trade.status !== 'active') return res.status(400).json({ error: 'Trade not active' });
  if (trade.initiatorId !== req.user.id && trade.targetId !== req.user.id)
    return res.status(403).json({ error: 'Not your trade' });
  const mySide = trade.sides[req.user.id];
  if (mySide.confirmed) return res.status(400).json({ error: 'Already confirmed — cancel to modify' });
  const { plants, coins } = req.body;
  const db = loadDB();
  const user = db[req.user.id];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const TRADEABLE_RARITIES = ['Epic','Legendary','Mythic','Secret'];
  if (plants !== undefined) {
    for (const p of plants) {
      if (!TRADEABLE_RARITIES.includes(p.rarity)) return res.status(400).json({ error: 'Only Epic, Legendary, Mythic, and Secret plants can be traded.' });
      const owns = user.collection.some(c => c.name === p.name && c.version === p.version);
      if (!owns) return res.status(400).json({ error: `You don't own ${p.name} v${p.version}` });
    }
    mySide.plants = plants;
  }
  if (coins !== undefined) {
    if (coins < 0 || coins > (user.currency || 0))
      return res.status(400).json({ error: 'Invalid coin amount' });
    mySide.coins = coins;
  }
  mySide.confirmed = false;
  const otherId = trade.initiatorId === req.user.id ? trade.targetId : trade.initiatorId;
  trade.sides[otherId].confirmed = false;
  saveTrades(webTrades);
  res.json(trade);
});

app.post('/api/trade/:id/confirm', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const trade = webTrades[req.params.id];
  if (!trade || trade.status !== 'active') return res.status(400).json({ error: 'Trade not active' });
  if (trade.initiatorId !== req.user.id && trade.targetId !== req.user.id)
    return res.status(403).json({ error: 'Not your trade' });
  const mySide = trade.sides[req.user.id];
  if (!mySide.plants.length && mySide.coins === 0)
    return res.status(400).json({ error: 'Add something to your offer first' });
  mySide.confirmed = true;
  if (Object.values(trade.sides).every(s => s.confirmed)) {
    const db = loadDB();
    const iUser = db[trade.initiatorId];
    const tUser = db[trade.targetId];
    const iSide = trade.sides[trade.initiatorId];
    const tSide = trade.sides[trade.targetId];

    const failTrade = (reason) => {
      trade.status = 'failed';
      trade.failReason = reason;
      iSide.confirmed = false;
      tSide.confirmed = false;
      saveTrades(webTrades);
      return res.status(400).json({ error: reason });
    };

    if (iSide.coins > 0 && (iUser.currency || 0) < iSide.coins)
      return failTrade(`${trade.initiatorName} no longer has enough coins (offered ${iSide.coins}, has ${iUser.currency || 0})`);
    if (tSide.coins > 0 && (tUser.currency || 0) < tSide.coins)
      return failTrade(`${trade.targetName} no longer has enough coins (offered ${tSide.coins}, has ${tUser.currency || 0})`);

    const iPlantIndices = [];
    for (const p of iSide.plants) {
      const idx = iUser.collection.findIndex(c => c.name === p.name && c.version === p.version);
      if (idx === -1) return failTrade(`${trade.initiatorName} no longer has ${p.name} v${p.version}`);
      iPlantIndices.push(idx);
    }
    const tPlantIndices = [];
    for (const p of tSide.plants) {
      const idx = tUser.collection.findIndex(c => c.name === p.name && c.version === p.version);
      if (idx === -1) return failTrade(`${trade.targetName} no longer has ${p.name} v${p.version}`);
      tPlantIndices.push(idx);
    }

    for (let i = iPlantIndices.length - 1; i >= 0; i--) {
      const [removed] = iUser.collection.splice(iPlantIndices[i], 1);
      tUser.collection.push({ ...removed, claimedAt: new Date().toISOString() });
      recordTrade(removed.name);
    }
    for (let i = tPlantIndices.length - 1; i >= 0; i--) {
      const [removed] = tUser.collection.splice(tPlantIndices[i], 1);
      iUser.collection.push({ ...removed, claimedAt: new Date().toISOString() });
      recordTrade(removed.name);
    }

    if (iSide.coins > 0) { iUser.currency -= iSide.coins; tUser.currency += iSide.coins; }
    if (tSide.coins > 0) { tUser.currency -= tSide.coins; iUser.currency += tSide.coins; }

    touchActivity(db, trade.initiatorId); touchActivity(db, trade.targetId);
    saveDB(db);
    trade.status = 'complete';
    pushToUser(trade.initiatorId, { type: 'trade_complete' });
    pushToUser(trade.targetId,    { type: 'trade_complete' });
    pushCoinUpdate(trade.initiatorId, iUser.currency);
    pushCoinUpdate(trade.targetId,    tUser.currency);
    pushCollectionUpdate(trade.initiatorId);
    pushCollectionUpdate(trade.targetId);
    broadcastLeaderboardUpdate();
    try { if (canBotDM(trade.initiatorId, 'trade_complete')) { const u = await client.users.fetch(trade.initiatorId); await u.send({ embeds: [new EmbedBuilder().setTitle('✅ Trade Complete!').setDescription(`Your trade with **${trade.targetName}** completed successfully!`).setColor(0x00c864)] }); } } catch {}
    try { if (canBotDM(trade.targetId,    'trade_complete')) { const u = await client.users.fetch(trade.targetId);    await u.send({ embeds: [new EmbedBuilder().setTitle('✅ Trade Complete!').setDescription(`Your trade with **${trade.initiatorName}** completed successfully!`).setColor(0x00c864)] }); } } catch {}
  }
  saveTrades(webTrades);
  res.json(trade);
});

app.post('/api/trade/:id/cancel', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const trade = webTrades[req.params.id];
  if (!trade || trade.status !== 'active') return res.status(400).json({ error: 'Trade not active' });
  if (trade.initiatorId !== req.user.id && trade.targetId !== req.user.id)
    return res.status(403).json({ error: 'Not your trade' });
  trade.status = 'cancelled';
  saveTrades(webTrades);
  const otherId = trade.initiatorId === req.user.id ? trade.targetId : trade.initiatorId;
  pushToUser(otherId, { type: 'trade_declined' });
  res.json({ ok: true });
});

// Target accepts the trade request — notifies initiator via WebSocket to dismiss waiting overlay
app.post('/api/trade/:id/accept', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const trade = webTrades[req.params.id];
  if (!trade || trade.status !== 'active') return res.status(400).json({ error: 'Trade not active' });
  if (trade.targetId !== req.user.id) return res.status(403).json({ error: 'Only the trade target can accept' });
  pushToUser(trade.initiatorId, { type: 'trade_accepted', tradeId: trade.id });
  res.json({ ok: true });
});

// ─── Notification Preferences API ────────────────────────────────────────────
function canBotDM(userId, notifType) {
  const db = loadDB();
  const user = db[userId];
  if (!user) return true;
  const pref = (user.notifPrefs || {})[notifType] || 'site';
  return pref === 'bot' || pref === 'both';
}

app.get('/api/notif-prefs', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const db = loadDB();
  const user = getUser(db, req.user.id);
  res.json(user.notifPrefs || {});
});

app.post('/api/notif-prefs', express.json(), (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const db = loadDB();
  const user = getUser(db, req.user.id);
  user.notifPrefs = { ...(user.notifPrefs || {}), ...req.body };
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/rawdb', (req, res) => {
  res.send(fs.readFileSync(DB_FILE, 'utf8'));
});

app.get('/api/rawmeta', (req, res) => {
  res.send(fs.readFileSync(META_FILE, 'utf8'));
});

app.get('/api/fixmeta', (req, res) => {
  try {
    const correct = {
      plantVersions: { "Tomato":53,"Strawberry":54,"Goldenberry":210,"Biohazard Melon":1262,"Banana":27,"Carrot":1312,"Corn":1252,"Bell Pepper":61,"Apple":49,"Dawn Fruit":20,"Onion":67,"Potato":30,"Birch":59,"Amberpine":58,"Dawn Blossom":37,"Lablush Berry":74,"Mango":23,"Radiant Petal":33,"Bamboo":25,"Sunpetal":1272,"Beetroot":67,"Dandelion":1336,"Orange":35,"Rose":41,"Emberwood":34,"Mushroom":59,"Cabbage":31,"Wheat":36,"Plum":44,"Octobranch":14,"Cherry":19,"Pomegranate":27,"Olive":42,"Starvine":16 },
      totalDrops: 7778,
      plantClaimed: JSON.parse(fs.readFileSync(META_FILE, 'utf8').replace(/,\s*}/, '}').replace(/\]\s*}\s*}\s*\]\s*}\s*}$/, '} }')).plantClaimed
    };
    fs.writeFileSync(META_FILE, JSON.stringify(correct, null, 2));
    res.json({ ok: true });
  } catch(e) {
    const correct = { plantVersions: { "Tomato":53,"Strawberry":54,"Goldenberry":210,"Biohazard Melon":1262,"Banana":27,"Carrot":1312,"Corn":1252,"Bell Pepper":61,"Apple":49,"Dawn Fruit":20,"Onion":67,"Potato":30,"Birch":59,"Amberpine":58,"Dawn Blossom":37,"Lablush Berry":74,"Mango":23,"Radiant Petal":33,"Bamboo":25,"Sunpetal":1272,"Beetroot":67,"Dandelion":1336,"Orange":35,"Rose":41,"Emberwood":34,"Mushroom":59,"Cabbage":31,"Wheat":36,"Plum":44,"Octobranch":14,"Cherry":19,"Pomegranate":27,"Olive":42,"Starvine":16 }, totalDrops: 7778, plantClaimed: {} };
    fs.writeFileSync(META_FILE, JSON.stringify(correct, null, 2));
    res.json({ ok: true, reset: true });
  }
});

// ── MERCHANT API ─────────────────────────────────────────────────────────────

app.get('/api/merchant/is-admin', async (req, res) => {
  if (!req.user) return res.json({ isAdmin: false });
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(req.user.id);
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    res.json({ isAdmin });
  } catch (e) {
    res.json({ isAdmin: false });
  }
});

app.post('/api/merchant/restock', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(req.user.id);
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return res.status(403).json({ error: 'Missing Manage Guild permission' });
    }
  } catch (e) {
    return res.status(403).json({ error: 'Could not verify permissions' });
  }
  res.json({ ok: true, restockToken: Date.now() });
});

const MERCHANT_ITEM_PRICES = {
  xp_boost:      17500,
  mystery_box:    6000,
  rainbow_tag:   48500,
  sprint_boost:  25000,
  listing_boost: 10000,
};

const MERCHANT_CRATE_POOLS = {
  crate_bronze:  [ {rarity:'Common',w:60},{rarity:'Uncommon',w:30},{rarity:'Rare',w:9},{rarity:'Epic',w:1} ],
  crate_silver:  [ {rarity:'Common',w:30},{rarity:'Uncommon',w:35},{rarity:'Rare',w:25},{rarity:'Epic',w:9},{rarity:'Legendary',w:1} ],
  crate_gold:    [ {rarity:'Uncommon',w:20},{rarity:'Rare',w:35},{rarity:'Epic',w:30},{rarity:'Legendary',w:13},{rarity:'Mythic',w:2} ],
  crate_diamond: [ {rarity:'Rare',w:15},{rarity:'Epic',w:35},{rarity:'Legendary',w:30},{rarity:'Mythic',w:16},{rarity:'Secret',w:4} ],
  crate_ruby:    [ {rarity:'Epic',w:25},{rarity:'Legendary',w:30},{rarity:'Mythic',w:30},{rarity:'Secret',w:15} ],
};

function merchantWeightedPick(pool) {
  const total = pool.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const item of pool) { r -= item.w; if (r <= 0) return item.rarity; }
  return pool[pool.length-1].rarity;
}

function getMerchantPlantByRarity(rarity) {
  const meta = JSON.parse(fs.existsSync(META_FILE) ? fs.readFileSync(META_FILE) : '{}');
  const allPlants = Object.entries(meta.plantVersions || {}).map(([name, maxV]) => ({ name, maxV }));
  if (!allPlants.length) return null;
  const picked = allPlants[Math.floor(Math.random() * allPlants.length)];
  const version = getAvailableVersion(picked.name, loadDB()); recordVersionHighWater(picked.name, version);
  return {
    name: picked.name, rarity, version,
    emoji: RARITY_EMOJIS[rarity] || RARITY_EMOJIS.Common,
    claimedAt: new Date().toISOString(),
    source: 'merchant',
    sellValue: getRarityConfig(rarity).sellPrice,
  };
}

app.post('/api/merchant/buy', express.json(), (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const { itemId, type, price, name } = req.body;
  if (!itemId || !type || price === undefined) return res.status(400).json({ error: 'Missing fields' });
  const basePrice = MERCHANT_ITEM_PRICES[itemId];
  if (basePrice === undefined) return res.status(400).json({ error: 'Unknown item' });
  const minAllowed = Math.floor(basePrice * 0.65);
  if (price < minAllowed || price > basePrice * 1.05) return res.status(400).json({ error: 'Invalid price' });

  const db = loadDB();
  const user = getUser(db, req.user.id);
  if ((user.currency || 0) < price) return res.status(400).json({ error: 'Not enough coins' });
  user.currency -= price;

  const now = Date.now();
  let extraData = {};

  if (itemId === 'mystery_box') {
    const ACTIVE_ITEMS = [
      { id: 'xp_boost',      name: 'XP Tome' },
      { id: 'rainbow_tag',   name: 'Rainbow Nametag' },
      { id: 'sprint_boost',  name: 'Sprint Boost' },
      { id: 'listing_boost', name: 'Listing Boost' },
    ];
    const won = ACTIVE_ITEMS[Math.floor(Math.random() * ACTIVE_ITEMS.length)];
    extraData.wonItemId = won.id;
    extraData.wonName = won.name;
    if (won.id === 'xp_boost') {
      const existing = user.xpBoost && user.xpBoost.expiresAt > now ? user.xpBoost.expiresAt : now;
      user.xpBoost = { expiresAt: existing + 30 * 60 * 1000 };
    } else if (won.id === 'rainbow_tag') {
      user.rainbowTag = { expiresAt: now + 6 * 60 * 60 * 1000 };
    } else if (won.id === 'sprint_boost') {
      user.sprintBoost = { expiresAt: now + 60 * 60 * 1000 };
    } else if (won.id === 'listing_boost') {
      user.listingBoost = { expiresAt: now + 24 * 60 * 60 * 1000 };
    } else if (won.id === 'price_alert') {
      user.merchantConsumables = user.merchantConsumables || [];
      user.merchantConsumables.push({ itemId: 'price_alert', name: 'Price Alert', purchasedAt: now, used: false });
      extraData.needsSetup = true;
    }

  } else if (itemId === 'xp_boost') {
    const existing = user.xpBoost && user.xpBoost.expiresAt > now ? user.xpBoost.expiresAt : now;
    user.xpBoost = { expiresAt: existing + 30 * 60 * 1000 };
    extraData.xpBoostExpiresAt = user.xpBoost.expiresAt;

  } else if (itemId === 'rainbow_tag') {
    user.rainbowTag = { expiresAt: now + 6 * 60 * 60 * 1000 };

  } else if (itemId === 'sprint_boost') {
    user.sprintBoost = { expiresAt: now + 60 * 60 * 1000 };

  } else if (itemId === 'listing_boost') {
    user.listingBoost = { expiresAt: now + 24 * 60 * 60 * 1000 };

  } else if (type === 'seed') {
    const rarityMap = { seed_common:'Common', seed_uncommon:'Uncommon', seed_rare:'Rare', seed_epic:'Epic', seed_legendary:'Legendary' };
    const rarity = rarityMap[itemId];
    if (rarity) {
      const plant = getMerchantPlantByRarity(rarity);
      if (plant) { user.collection = user.collection || []; user.collection.push(plant); }
    }
  } else if (type === 'upgrade') {
    user.merchantUpgrades = user.merchantUpgrades || {};
    user.merchantUpgrades[itemId] = (user.merchantUpgrades[itemId] || 0) + 1;
  } else {
    user.merchantConsumables = user.merchantConsumables || [];
    user.merchantConsumables.push({ itemId, name, purchasedAt: now, used: false });
  }

  saveDB(db);
  pushCoinUpdate(req.user.id, user.currency);
  if (type === 'seed') pushCollectionUpdate(req.user.id);
  res.json({ ok: true, newBalance: user.currency, ...extraData });
});

app.post('/api/merchant/crate', express.json(), (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const { crateId, price } = req.body;
  const pool = MERCHANT_CRATE_POOLS[crateId];
  if (!pool) return res.status(400).json({ error: 'Unknown crate' });
  const basePrice = MERCHANT_ITEM_PRICES[crateId];
  if (!basePrice || price < basePrice * 0.95 || price > basePrice * 1.05) return res.status(400).json({ error: 'Invalid price' });

  const db = loadDB();
  const user = getUser(db, req.user.id);
  if ((user.currency || 0) < price) return res.status(400).json({ error: 'Not enough coins' });
  user.currency -= price;

  const rarity = merchantWeightedPick(pool);
  const plant = getMerchantPlantByRarity(rarity);
  if (plant) { user.collection = user.collection || []; user.collection.push(plant); }

  saveDB(db);
  pushCoinUpdate(req.user.id, user.currency);
  pushCollectionUpdate(req.user.id);
  res.json({ ok: true, newBalance: user.currency, plant: plant || null });
});

// ── PRICE ALERT API ───────────────────────────────────────────────────────────

app.post('/api/merchant/price-alert/set', express.json(), (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const { rarity, maxPrice } = req.body;
  const validRarities = ['Epic', 'Legendary', 'Mythic', 'Secret'];
  if (rarity && !validRarities.includes(rarity)) return res.status(400).json({ error: 'Invalid rarity' });
  if (!maxPrice || isNaN(maxPrice) || maxPrice <= 0) return res.status(400).json({ error: 'Invalid max price' });

  const db = loadDB();
  const user = getUser(db, req.user.id);
  user.priceAlerts = user.priceAlerts || [];

  if (user.priceAlerts.length >= 5) return res.status(400).json({ error: 'You already have 5 active alerts. Delete one first.' });

  user.priceAlerts.push({ id: `pa_${Date.now()}`, rarity: rarity || null, maxPrice: parseInt(maxPrice), createdAt: Date.now() });
  saveDB(db);
  res.json({ ok: true, alerts: user.priceAlerts });
});

app.get('/api/merchant/price-alert', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const db = loadDB();
  const user = getUser(db, req.user.id);
  res.json(user.priceAlerts || []);
});

app.get('/api/merchant/boost-status', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const db = loadDB();
  const user = getUser(db, req.user.id);
  const now = Date.now();
  res.json({
    xpBoost: user.xpBoost && user.xpBoost.expiresAt > now
      ? { active: true, expiresAt: user.xpBoost.expiresAt, msLeft: user.xpBoost.expiresAt - now }
      : { active: false },
    rainbowTag: user.rainbowTag && user.rainbowTag.expiresAt > now
      ? { active: true, expiresAt: user.rainbowTag.expiresAt, msLeft: user.rainbowTag.expiresAt - now }
      : { active: false },
    sprintBoost: user.sprintBoost && user.sprintBoost.expiresAt > now
      ? { active: true, expiresAt: user.sprintBoost.expiresAt, msLeft: user.sprintBoost.expiresAt - now }
      : { active: false },
    listingBoost: user.listingBoost && user.listingBoost.expiresAt > now
      ? { active: true, expiresAt: user.listingBoost.expiresAt, msLeft: user.listingBoost.expiresAt - now }
      : { active: false },
  });
});

app.delete('/api/merchant/price-alert/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const db = loadDB();
  const user = getUser(db, req.user.id);
  user.priceAlerts = (user.priceAlerts || []).filter(a => a.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true, alerts: user.priceAlerts });
});

// ── One-time startup cleanup: remove listingBoost from users who never bought it ──
(function cleanupListingBoost() {
  try {
    const db = loadDB();
    const now = Date.now();
    const maxValid = now + 25 * 60 * 60 * 1000;
    let fixed = 0;
    for (const user of Object.values(db)) {
      if (user.listingBoost && user.listingBoost.expiresAt > maxValid) {
        delete user.listingBoost;
        fixed++;
      }
    }
    if (fixed > 0) { saveDB(db); console.log(`[cleanup] Removed corrupted listingBoost from ${fixed} users`); }
  } catch(e) { console.error('[cleanup] listingBoost cleanup failed:', e); }
})();

httpServer.listen(PORT, () => console.log(`🌐 Website running on port ${PORT}`));
}

client.login(TOKEN);