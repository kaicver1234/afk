'use strict';

// Auto-eat: heals the fake player by eating the moment its health drops below
// full. Eating restores hunger and the saturation that follows regenerates
// hearts — so whenever the player is hurt and can still eat, it eats. Runs
// entirely through mineflayer's own inventory API, so it behaves like a player
// clicking through their hotbar.
//
// Toggle per bot via info.autoEat (true/false); armed from index.js on spawn.

const HEALTH_FULL = 20;      // eat the moment health isn't full anymore
const FOOD_FULL = 20;        // at full hunger you can't eat (natural regen already runs)
const EAT_COOLDOWN_MS = 1500;  // spacing between attempts; a failed eat retries here

// Foods that hurt more than they help unless we're desperate.
const LAST_RESORT = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'raw_chicken']);

function foodQuality(mc, item) {
  const def = mc.registry?.foodsByName?.[item.name];
  if (!def || def.foodPoints == null) return null; // not edible
  return {
    item,
    name: item.name,
    quality: def.effectiveQuality ?? def.saturation ?? 0,
    desperation: LAST_RESORT.has(item.name),
  };
}

// Best edible item in the inventory: highest effective quality first,
// last-resort foods only when nothing else is available.
function pickFood(info) {
  const mc = info.mcBot;
  if (!mc?.inventory?.slots) return null;
  let bestNormal = null;
  let bestDesperate = null;
  for (const item of mc.inventory.slots) {
    if (!item) continue;
    const q = foodQuality(mc, item);
    if (!q) continue;
    if (q.desperation) {
      if (!bestDesperate || q.quality > bestDesperate.quality) bestDesperate = q;
    } else if (!bestNormal || q.quality > bestNormal.quality) {
      bestNormal = q;
    }
  }
  return bestNormal || bestDesperate;
}

// True when the player is hurt and eating would help: health below full, and
// the hunger bar still has room (at 20/20 the game won't let you eat, and
// natural regeneration is already running).
function shouldEat(mc) {
  if (mc.health == null || mc.food == null) return false;
  return mc.health < HEALTH_FULL && mc.food < FOOD_FULL;
}

async function tryEat(info, why) {
  const mc = info.mcBot;
  if (!info.autoEat) return false;
  if (!mc || info.status !== 'online') return false;
  if (info.eatBusy) return false;
  if (!shouldEat(mc)) return false;

  const food = pickFood(info);
  if (!food) {
    // Only nag once per hurt spell, not every health tick.
    if (!info.eatWarnedAt || Date.now() - info.eatWarnedAt > 60000) {
      info.eatWarnedAt = Date.now;
      info.error = `Hurt — no food in inventory`;
    }
    return false;
  }

  info.eatBusy = true;
  const prevHeldType = mc.heldItem ? mc.heldItem.type : null;
  try {
    await mc.equip(food.item, 'hand');
    await mc.consume();
    info.eatWarnedAt = 0;
  } catch (e) {
    info.error = `Auto-eat failed: ${e.message}`;
  } finally {
    info.eatBusy = false;
    // Put whatever was in hand back (skip if hand still holds the same thing).
    try {
      if (prevHeldType != null && (!mc.heldItem || mc.heldItem.type !== prevHeldType)) {
        const prev = mc.inventory.findInventoryItem(prevHeldType);
        if (prev) await mc.equip(prev, 'hand');
      }
    } catch (_) {}
  }
  return true;
}

// Wire listeners onto a freshly spawned bot. Returns a disposer that stops
// the loop and detaches everything for this connection.
function attach(info) {
  let timer = null;
  let kickstart = null;
  let stopped = false;

  function tick() {
    if (stopped) return;
    tryEat(info, 'health was low').catch(() => {}).finally(() => {
      if (!stopped && info.status === 'online') armCooldown(EAT_COOLDOWN_MS);
    });
  }

  function armCooldown(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, ms);
  }

  const onHealth = () => {
    if (stopped || !info.autoEat) return;
    if (info.mcBot == null) return;
    if (info.eatBusy) return;
    if (shouldEat(info.mcBot)) tick();
  };

  // Pin the connection this loop watches: the disposer must be able to detach
  // from it even if info.mcBot has already been cleared by teardown.
  const bot = info.mcBot;
  if (!bot) return () => {};
  bot.on('health', onHealth);
  // Also check once shortly after spawn — health may already be low on rejoin.
  kickstart = setTimeout(onHealth, 3000);
  if (kickstart.unref) kickstart.unref();

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(kickstart);
    // Detach the health hook — the manager no longer wipes every bot listener
    // on teardown, so this loop has to clean up after itself.
    try { bot.off('health', onHealth); } catch (_) {}
  };
}

module.exports = { attach, tryEat, pickFood, shouldEat, HEALTH_FULL };
