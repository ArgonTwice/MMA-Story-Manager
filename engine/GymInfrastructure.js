/**
 * engine/GymInfrastructure.js
 * ---------------------------------------------------------------------------
 * Facility tiers (BALANCE.GYM.TIERS, indexed by PlayerState.equipLevel) and
 * equipment quality/degradation (BALANCE.EQUIPMENT), on top of PlayerState's
 * pre-existing equipLevel/equipment/upgradeFacility()/addEquipmentItem()
 * fields — this module adds narrative tier metadata, weekly wear, repair,
 * and low-quality injury risk on top of an equipment system that already
 * existed (purchase cost, weekly maintenance, training-gain bonuses); it
 * does not replace any of that.
 *
 * Roster capacity is STRICTLY capped by the current tier — see
 * PlayerState#getRosterCapacity(), which reads BALANCE.GYM.TIERS directly
 * and is the single source of truth this module never duplicates.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {Object} playerState
 * @returns {number|null} The cost to upgrade from the CURRENT tier to the
 *   next one, or null if already at BALANCE.ECONOMY.FACILITY_UPGRADE.MAX_LEVEL.
 */
export function getNextTierUpgradeCost(playerState) {
  const cfg = BALANCE.ECONOMY.FACILITY_UPGRADE;
  if (playerState.equipLevel >= cfg.MAX_LEVEL) return null;
  return Math.round(cfg.BASE_COST * cfg.GROWTH ** playerState.equipLevel);
}

/**
 * @param {Object} playerState
 * @returns {Object|null} BALANCE.GYM.TIERS[equipLevel + 1], or null if already at the top tier.
 */
export function getNextTier(playerState) {
  return BALANCE.GYM.TIERS[playerState.equipLevel + 1] ?? null;
}

/**
 * Scales a raw multiplicative bonus (e.g. 1.12 = "+12%") by an item's
 * current quality (0-1): full quality keeps the full bonus, 0 quality
 * leaves it fully neutral (1) — never negative or worse than doing
 * nothing. Shared by engine/TrainingEngine.js and
 * engine/WeeklyPlanningEngine.js so every equipment-driven multiplier
 * degrades the same way.
 * @param {number} rawMultiplier
 * @param {number} quality - 0-1.
 * @returns {number}
 */
export function getQualityScaledMultiplier(rawMultiplier, quality) {
  return 1 + (rawMultiplier - 1) * clamp(quality, 0, 1);
}

/**
 * Cage de Competition's Clinch/Cage Control bonus, quality-scaled — see
 * engine/CombatEngine.js#_computeRoundOffense (applied only to the
 * player's own fighter, alongside the existing per-style clinch bonus).
 * @param {Object} playerState
 * @returns {number}
 */
export function getClinchOutputMultiplier(playerState) {
  let multiplier = 1;
  for (const item of playerState.equipment) {
    const def = BALANCE.EQUIPMENT.DEFINITIONS[item?.id];
    if (def?.clinchOutputMultiplier) multiplier *= getQualityScaledMultiplier(def.clinchOutputMultiplier, item.quality ?? 1);
  }
  return multiplier;
}

/**
 * Zone Cardio's Stamina Max bonus, quality-scaled — see
 * engine/CombatEngine.js#_processWeighIn.
 * @param {Object} playerState
 * @returns {number} A percentage bonus (0.1 = +10%), 0 with no such equipment.
 */
export function getStaminaMaxBonusPercent(playerState) {
  let bonus = 0;
  for (const item of playerState.equipment) {
    const def = BALANCE.EQUIPMENT.DEFINITIONS[item?.id];
    if (def?.staminaMaxBonusPercent) bonus += def.staminaMaxBonusPercent * clamp(item.quality ?? 1, 0, 1);
  }
  return bonus;
}

/**
 * Cryotherapy's weekly fatigue-accumulation reduction, quality-scaled —
 * see engine/WeeklyPlanningEngine.js#resolveSlot (applied to the *cost*
 * portion of physical/mental fatigue gain only, never to PHYSIO_REST's own
 * recovery deltas).
 * @param {Object} playerState
 * @returns {number}
 */
export function getFatigueAccumulationMultiplier(playerState) {
  let multiplier = 1;
  for (const item of playerState.equipment) {
    const def = BALANCE.EQUIPMENT.DEFINITIONS[item?.id];
    if (def?.fatigueAccumulationMultiplier) multiplier *= getQualityScaledMultiplier(def.fatigueAccumulationMultiplier, item.quality ?? 1);
  }
  return multiplier;
}

/** @returns {'🟢'|'🟡'|'🔴'} A traffic-light indicator for one item's current quality (0-1). */
export function getEquipmentHealthIndicator(quality) {
  if (quality >= 0.7) return '\u{1F7E2}';
  if (quality >= BALANCE.EQUIPMENT.LOW_QUALITY_THRESHOLD) return '\u{1F7E1}';
  return '\u{1F534}';
}

/**
 * Degrades every owned equipment item's quality by DEGRADATION_PER_WEEK,
 * floored at 0 — call once per week (see web/app.js's weekly resolution).
 * @param {Object} playerState
 */
export function degradeEquipmentWeekly(playerState) {
  const rate = BALANCE.EQUIPMENT.DEGRADATION_PER_WEEK;
  for (const item of playerState.equipment) {
    item.quality = clamp((item.quality ?? 1) - rate, 0, 1);
  }
}

/**
 * @param {string} equipmentId
 * @returns {number} The cost to repair this item back to full quality.
 */
export function getRepairCost(equipmentId) {
  const def = BALANCE.EQUIPMENT.DEFINITIONS[equipmentId];
  if (!def) return 0;
  return Math.round(def.purchaseCost * BALANCE.EQUIPMENT.REPAIR_COST_FRACTION_OF_PURCHASE);
}

/**
 * Repairs one owned equipment item back to 100% quality, deducting its
 * repair cost. No-ops (returns false) if the item isn't owned or the gym
 * can't afford it.
 * @param {Object} playerState
 * @param {string} equipmentId
 * @returns {boolean}
 */
export function repairEquipment(playerState, equipmentId) {
  const item = playerState.equipment.find((entry) => entry.id === equipmentId);
  if (!item) return false;

  const cost = getRepairCost(equipmentId);
  if (playerState.money < cost) return false;

  playerState.changeMoney(-cost, 'EQUIPMENT_REPAIR');
  item.quality = 1;
  return true;
}

/**
 * Aggregate multiplicative injury-risk bonus from every owned item
 * currently below LOW_QUALITY_THRESHOLD — compounds if multiple items are
 * simultaneously run-down. 1 (no effect) if nothing is degraded.
 * @param {Object} playerState
 * @returns {number}
 */
export function getLowQualityInjuryRiskMultiplier(playerState) {
  const cfg = BALANCE.EQUIPMENT;
  let multiplier = 1;
  for (const item of playerState.equipment) {
    if ((item.quality ?? 1) < cfg.LOW_QUALITY_THRESHOLD) multiplier *= cfg.LOW_QUALITY_INJURY_RISK_MULTIPLIER;
  }
  return multiplier;
}

/**
 * @param {Object} playerState
 * @returns {boolean} True if at least one owned item is below LOW_QUALITY_THRESHOLD — gates DramaEngine's material-incident events (see data/events.js's EQUIPMENT_BREAKDOWN, engine/DramaEngine.js's HAS_LOW_QUALITY_EQUIPMENT condition).
 */
export function hasLowQualityEquipment(playerState) {
  return playerState.equipment.some((item) => (item.quality ?? 1) < BALANCE.EQUIPMENT.LOW_QUALITY_THRESHOLD);
}

export default {
  getNextTierUpgradeCost,
  getNextTier,
  getQualityScaledMultiplier,
  getClinchOutputMultiplier,
  getStaminaMaxBonusPercent,
  getFatigueAccumulationMultiplier,
  getEquipmentHealthIndicator,
  degradeEquipmentWeekly,
  getRepairCost,
  repairEquipment,
  getLowQualityInjuryRiskMultiplier,
  hasLowQualityEquipment,
};
