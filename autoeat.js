'use strict';

// Auto-eat: keeps the fake player from starving. When the food bar drops below
// a threshold, equip the best food in the inventory, consume it, and put the
// previous item back in hand. Runs entirely through mineflayer's own inventory
// API, so it behaves like a player clicking through their hotbar.
//
// Toggle per bot via info.autoEat (true/false); armed from index.js on spawn.

const EAT_AT_FOOD = 14;        // start eating at 7 drumsticks (of 10)
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

async function tryEat(info, why) {
  const mc = info.mcBot;
  if (!info.autoEat) return false;
  if (!mc || info.status !== 'online') return false;
  if (info.eatBusy) return false;
  if (mc.food == null || mc.food > EAT_AT_FOOD) return false;

  const food = pickFood(info);
  if (!food) {
    // Only nag once per hungry spell, not every health tick.
    if (!info.eatWarnedAt || Date.now() - info.eatWarnedAt > 60000) {
      info.eatWarnedAt = Date.now();
      info.error = `Hungry — no food in inventory`;
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
    tryEat(info, 'food was low').catch(() => {}).finally(() => {
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
    if (info.mcBot.food != null && info.mcBot.food <= EAT_AT_FOOD) tick();
  };

  info.mcBot.on('health', onHealth);
  // Also check once shortly after spawn — food may already be low on rejoin.
  kickstart = setTimeout(onHealth, 3000);
  if (kickstart.unref) kickstart.unref();

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(kickstart);
  };
}

module.exports = { attach, tryEat, pickFood, EAT_AT_FOOD };
