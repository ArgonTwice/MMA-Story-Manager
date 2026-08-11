/**
 * engine/LeagueEngine.js
 * ---------------------------------------------------------------------------
 * The PLAYER's own 3-tier competitive pyramid (BALANCE.LEAGUE_PYRAMID):
 * Local/Underground -> National -> Elite Mondiale. Tracks a rolling
 * window of the gym's last FIGHT_HISTORY_WINDOW SANCTIONED fight results
 * (win/loss booleans, oldest first — see PlayerState#recentFightResults)
 * and promotes/relegates by Reputation + winrate:
 *
 *   - Promotion: Reputation >= the next tier's threshold AND winrate over
 *     the window >= PROMOTION_WINRATE_THRESHOLD.
 *   - Relegation: winrate over the window < RELEGATION_WINRATE_THRESHOLD,
 *     regardless of Reputation — a bad record demotes you even if the gym
 *     is still famous.
 *
 * Distinct from data/leagues.js's own LEAGUES catalog (4 entries, used
 * exclusively to tag which purse tier a RIVAL gym's autonomous
 * TransferMarket/ProspectGenerator contracts fall under, by Reputation
 * alone, with no promotion/relegation state) — the two never read each
 * other. Only web/app.js's normal Combat-tab fights count toward league
 * history; Underground Circuit bouts are explicitly "hors sanction
 * officielle" and never call recordLeagueFightResult.
 *
 * V3.5 also adds a THIRD, independent orgId concept at the bottom of this
 * file (resolveRegionalOrg/getWeightClassRanking): which sanctioned
 * promotion (Brazil Fighting Championship / Euro MMA Circuit / World
 * Fighting Championship) the gym's Combat-tab fights are booked under,
 * picked once from the country typed at game creation — purely
 * organizational, no promotion/relegation of its own, and never read by
 * either of the two systems above.
 *
 * V3.7 adds a FOURTH, independent orgId concept (getUpcomingGalas/
 * registerForGala, see BALANCE.GALA_CIRCUIT's own header note): the Gala
 * Calendar. Replaces the old "hand-pick a rival gym, hand-pick their
 * fighter" flow — the player instead registers their fighter onto an open
 * weight-class slot of an upcoming Gala, and the opponent is drawn
 * automatically from a global pool (a rival gym's roster, or a freshly
 * generated independent fighter). Never read by any of the three systems
 * above; resolveRegionalOrg/getWeightClassRanking's own "Classements
 * Officiels" board stays tied to REGIONAL_ORGS/country, untouched by this.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { assertNoIntraGymMatch, assertGenderMatch } from './Matchmaking.js';
import { generatePersonality } from './FighterGenerator.js';
import { scheduleFight } from './FightWeekEngine.js';

/** @returns {Object} BALANCE.LEAGUE_PYRAMID.TIERS[playerState.leagueTier], falling back to the bottom tier for an unrecognized/legacy value. */
export function getCurrentTier(playerState) {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  return cfg.TIERS[playerState.leagueTier] ?? cfg.TIERS[cfg.TIER_ORDER[0]];
}

/** @returns {number|null} Wins / total over the rolling window, or null if the window is empty. */
export function getWinrate(playerState) {
  const history = playerState.recentFightResults;
  if (history.length === 0) return null;
  return history.filter(Boolean).length / history.length;
}

function tierIndex(tierId) {
  return BALANCE.LEAGUE_PYRAMID.TIER_ORDER.indexOf(tierId);
}

/**
 * Evaluates (but does not itself record a result) whether the gym's
 * CURRENT standing should promote or relegate it, given its current
 * Reputation and rolling fight-history winrate. Pure: reads only, never
 * mutates — see recordLeagueFightResult() for the mutating counterpart
 * that actually calls this after logging a fight.
 *
 * @param {Object} playerState
 * @returns {{ changed: boolean, direction: 'PROMOTED'|'RELEGATED'|null, newTierId: string|null }}
 */
export function evaluateLeagueStanding(playerState) {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const winrate = getWinrate(playerState);
  if (winrate === null || playerState.recentFightResults.length < cfg.MIN_FIGHTS_FOR_EVALUATION) {
    return { changed: false, direction: null, newTierId: null };
  }

  const currentIndex = tierIndex(playerState.leagueTier);

  const nextTierId = cfg.TIER_ORDER[currentIndex + 1];
  if (nextTierId) {
    const nextTier = cfg.TIERS[nextTierId];
    if (playerState.reputation >= nextTier.promotionReputationThreshold && winrate >= cfg.PROMOTION_WINRATE_THRESHOLD) {
      return { changed: true, direction: 'PROMOTED', newTierId: nextTierId };
    }
  }

  const prevTierId = cfg.TIER_ORDER[currentIndex - 1];
  if (prevTierId && winrate < cfg.RELEGATION_WINRATE_THRESHOLD) {
    return { changed: true, direction: 'RELEGATED', newTierId: prevTierId };
  }

  return { changed: false, direction: null, newTierId: null };
}

/**
 * Logs one sanctioned fight's outcome into the rolling window (FIFO,
 * capped at FIGHT_HISTORY_WINDOW), then evaluates and applies any
 * resulting promotion/relegation. Call once per completed normal (WFC)
 * Combat-tab fight — never for Underground Circuit bouts or sparring.
 *
 * @param {Object} playerState
 * @param {boolean} won
 * @returns {{ changed: boolean, direction: 'PROMOTED'|'RELEGATED'|null, newTierId: string|null }}
 */
export function recordLeagueFightResult(playerState, won) {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  playerState.recentFightResults = [...playerState.recentFightResults, won].slice(-cfg.FIGHT_HISTORY_WINDOW);

  const evaluation = evaluateLeagueStanding(playerState);
  if (evaluation.changed) playerState.leagueTier = evaluation.newTierId;
  return evaluation;
}

/**
 * @param {Object} playerState
 * @returns {number} Fight purses scale by this multiplier at the gym's
 *   current league tier — see engine/CombatEngine.js#_computePurses.
 */
export function getPurseMultiplier(playerState) {
  return getCurrentTier(playerState).purseMultiplier;
}

/**
 * @param {Object} playerState
 * @returns {number} Weekly passive income ("retombees de sponsors") scales
 *   by this multiplier at the gym's current league tier — see
 *   engine/EconomyEngine.js#processWeeklyExpenses.
 */
export function getPassiveIncomeMultiplier(playerState) {
  return getCurrentTier(playerState).passiveIncomeMultiplier;
}

/**
 * @param {Object} playerState
 * @returns {{ tier: Object, nextTier: Object|null, winrate: number|null, reputationProgress: number|null, winrateProgress: number|null }}
 *   A UI-ready snapshot for a "progress toward promotion" readout (see
 *   web/app.js's Hub "Staff & Competitions" section). Progress values are
 *   0-1, or null when there's no next tier (already at the top) or no
 *   fight history yet.
 */
export function getPromotionProgress(playerState) {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const tier = getCurrentTier(playerState);
  const nextTierId = cfg.TIER_ORDER[tierIndex(tier.id) + 1];
  const nextTier = nextTierId ? cfg.TIERS[nextTierId] : null;
  const winrate = getWinrate(playerState);

  return {
    tier,
    nextTier,
    winrate,
    reputationProgress: nextTier ? Math.min(1, playerState.reputation / nextTier.promotionReputationThreshold) : null,
    winrateProgress: nextTier && winrate !== null ? Math.min(1, winrate / cfg.PROMOTION_WINRATE_THRESHOLD) : null,
  };
}

// ---- V3.5: regional organizations (a 3rd, independent orgId concept) --------

/**
 * Picks which BALANCE.REGIONAL_ORGS entry the gym's Combat-tab fights are
 * booked under, from the free-form country string typed at game creation
 * (PlayerState.country) — a simple substring match against each region's
 * countryMatch list, case/accent-insensitive. Falls back to GLOBAL (World
 * Fighting Championship, id 'WFC') when the country is empty or matches no
 * known region — the same orgId every pre-V3.5 save/test fixture already
 * assumes, so nothing existing breaks.
 *
 * @param {string} country
 * @returns {Object} One of BALANCE.REGIONAL_ORGS's entries.
 */
export function resolveRegionalOrg(country) {
  const cfg = BALANCE.REGIONAL_ORGS;
  const normalized = (country ?? '').trim().toLowerCase();
  if (!normalized) return cfg.GLOBAL;

  for (const region of Object.values(cfg)) {
    if (region.countryMatch.some((candidate) => normalized.includes(candidate))) return region;
  }
  return cfg.GLOBAL;
}

/**
 * A top-N power ranking for one weight class within the gym's regional
 * org, gathering the player's own roster and every rival gym's roster —
 * computed fresh on every call (rather than persisted via WorldState's own
 * orgRanks/setOrgRanking, which exist but have no writer anywhere in this
 * codebase) so it's always accurate and never goes stale.
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {string} weightClass
 * @param {number} [limit=10]
 * @returns {{ fighterId: string, name: string, gymName: string, overallRating: number, record: string }[]}
 *   Sorted by overallRating, highest first.
 */
export function getWeightClassRanking(playerState, worldState, weightClass, limit = 10) {
  const entries = [];

  for (const fighter of playerState.roster) {
    if (fighter.identity.weightClass === weightClass) entries.push({ fighter, gymName: playerState.gymName });
  }

  for (const gym of worldState.rivalGyms) {
    for (const entry of gym.roster ?? []) {
      if (entry.identity.weightClass !== weightClass) continue;
      entries.push({ fighter: Fighter.fromJSON(entry), gymName: gym.name ?? gym.id });
    }
  }

  return entries
    .map(({ fighter, gymName }) => ({
      fighterId: fighter.identity.id,
      name: fighter.identity.name,
      gymName,
      overallRating: Math.round(fighter.getOverallRating()),
      record: fighter.getRecordString(),
    }))
    .sort((a, b) => b.overallRating - a.overallRating)
    .slice(0, limit);
}

/**
 * V3.6 ("Fight Week, Logistique et Preparation Predictive" item 3): the
 * full "classement officiel" board for the gym's regional org — every
 * BALANCE.PHYSICAL.WEIGHT_CLASSES division (both genders), each with its
 * own Top-N ranking (see getWeightClassRanking above). A single call
 * builds the whole board web/app.js's "Classements Officiels" modal needs,
 * rather than the UI looping calls itself per division.
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {Object} [options]
 * @param {number} [options.limit=15] - Top-N per division (spec default: Top 15).
 * @returns {{ org: Object, byGender: { M: {id:string,label:string,ranking:Object[]}[], F: {id:string,label:string,ranking:Object[]}[] } }}
 */
export function getAllWeightClassRankings(playerState, worldState, { limit = 15 } = {}) {
  const org = resolveRegionalOrg(playerState.country);
  const byGender = {};

  for (const gender of Object.keys(BALANCE.PHYSICAL.WEIGHT_CLASSES)) {
    byGender[gender] = BALANCE.PHYSICAL.WEIGHT_CLASSES[gender].map((division) => ({
      id: division.id,
      label: division.label,
      ranking: getWeightClassRanking(playerState, worldState, division.label, limit),
    }));
  }

  return { org, byGender };
}

// ---- V3.7: Gala Calendar (a 4th, independent orgId concept) -----------------

/** Local flavor name pool for freshly-generated "independent" Gala opponents — same precedent as every other generator module in this codebase (each keeps its own small pool rather than cross-importing). */
const INDEPENDENT_MALE_FIRST_NAMES = Object.freeze(['Kaito', 'Rafael', 'Marek', 'Idris', 'Otis', 'Baptiste', 'Nikolai', 'Theon']);
const INDEPENDENT_FEMALE_FIRST_NAMES = Object.freeze(['Talia', 'Coralie', 'Wren', 'Bianca', 'Selma', 'Hana']);
const INDEPENDENT_LAST_NAMES = Object.freeze([
  'Voss', 'Adeyemi', 'Castellano', 'Brennan', 'Okafor', 'Lindgren', 'Marchetti', 'Dubois', 'Kowalczyk', 'Silveira',
]);
const INDEPENDENT_STYLES = Object.freeze(['Boxe', 'Muay Thai', 'Lutte', 'Jiu-Jitsu Bresilien', 'Freestyle', 'Kickboxing']);
const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/** @returns {number} The day-of-cycle offset that keeps each organization's galas from all landing on the same days. */
function computeAnchorOffset(orgIndex, orgCount) {
  return orgIndex * Math.round(BALANCE.GALA_CIRCUIT.GALA_INTERVAL_DAYS / orgCount);
}

/** Builds one gala record — a pure, deterministic function of (org, sequenceIndex, day), so the same id always reconstructs the exact same gala (see getGalaById). */
function buildGala(org, sequenceIndex, day) {
  const cfg = BALANCE.GALA_CIRCUIT;
  const cardSpread = cfg.CARD_SIZE_MAX - cfg.CARD_SIZE_MIN + 1;
  const weightClassSlots = [];
  for (const gender of Object.keys(BALANCE.PHYSICAL.WEIGHT_CLASSES)) {
    for (const division of BALANCE.PHYSICAL.WEIGHT_CLASSES[gender]) {
      weightClassSlots.push({ gender, weightClass: division.label });
    }
  }

  return {
    id: `${org.id}#${sequenceIndex}`,
    orgId: org.id,
    orgLabel: org.label,
    day,
    label: `${org.label} — Gala #${sequenceIndex + 1}`,
    cardSize: cfg.CARD_SIZE_MIN + (sequenceIndex % cardSpread),
    weightClassSlots,
  };
}

/**
 * The rolling Gala Calendar: BALANCE.GALA_CIRCUIT.UPCOMING_COUNT_PER_ORG
 * upcoming galas per organization, each with an open slot for every
 * weight-class division (both genders) — purely computed from
 * worldState.currentDay, never persisted, so the exact same calendar
 * renders every time it's viewed without needing any WorldState schema.
 *
 * @param {Object} worldState
 * @param {Object} [options]
 * @param {number} [options.count] - Overrides UPCOMING_COUNT_PER_ORG.
 * @returns {Object[]} Every upcoming gala across all 4 organizations, soonest first.
 */
export function getUpcomingGalas(worldState, { count } = {}) {
  const cfg = BALANCE.GALA_CIRCUIT;
  const orgs = Object.values(cfg.ORGANIZATIONS);
  const perOrgCount = count ?? cfg.UPCOMING_COUNT_PER_ORG;
  const earliestDay = worldState.currentDay + cfg.FIRST_GALA_MIN_DAYS_OUT;

  const galas = [];
  orgs.forEach((org, orgIndex) => {
    const anchorOffset = computeAnchorOffset(orgIndex, orgs.length);
    const startIndex = Math.max(0, Math.ceil((earliestDay - anchorOffset) / cfg.GALA_INTERVAL_DAYS));

    for (let i = 0; i < perOrgCount; i += 1) {
      const sequenceIndex = startIndex + i;
      const day = anchorOffset + sequenceIndex * cfg.GALA_INTERVAL_DAYS;
      galas.push(buildGala(org, sequenceIndex, day));
    }
  });

  return galas.sort((a, b) => a.day - b.day);
}

/**
 * Reconstructs a single gala from its id (deterministic — see buildGala).
 * @param {Object} worldState - Unused for reconstruction itself (ids are self-describing), kept for signature symmetry with getUpcomingGalas.
 * @param {string} galaId
 * @returns {Object|null}
 */
export function getGalaById(worldState, galaId) {
  const [orgId, sequenceIndexRaw] = String(galaId).split('#');
  const sequenceIndex = Number(sequenceIndexRaw);
  const orgs = Object.values(BALANCE.GALA_CIRCUIT.ORGANIZATIONS);
  const orgIndex = orgs.findIndex((org) => org.id === orgId);
  if (orgIndex === -1 || !Number.isInteger(sequenceIndex)) return null;

  const anchorOffset = computeAnchorOffset(orgIndex, orgs.length);
  const day = anchorOffset + sequenceIndex * BALANCE.GALA_CIRCUIT.GALA_INTERVAL_DAYS;
  return buildGala(orgs[orgIndex], sequenceIndex, day);
}

/** Same weight/height generation shape as engine/FighterGenerator.js#generatePhysicalProfile, but pinned to a SPECIFIC division rather than rolling one — needed here so an independent opponent always lands exactly in the Gala slot's own weight class. */
function generatePhysicalProfileForDivision(rng, gender, division) {
  const cfg = BALANCE.PHYSICAL;
  const divisions = cfg.WEIGHT_CLASSES[gender];
  const classIndex = divisions.findIndex((d) => d.label === division.label);
  const previousMaxKg = classIndex > 0 ? divisions[classIndex - 1].maxKg : division.maxKg - cfg.WEIGHT_UNDER_CAP_KG * 2;
  const weightFloorKg = Math.max(previousMaxKg, division.maxKg - cfg.WEIGHT_UNDER_CAP_KG);
  const weightKg = Math.round((weightFloorKg + rng() * (division.maxKg - weightFloorKg)) * 10) / 10;

  const heightRange = cfg.HEIGHT_CM[gender];
  const heightCm = Math.round(heightRange.MIN + rng() * (heightRange.MAX - heightRange.MIN));

  return { weightClassId: division.id, weightClassLabel: division.label, heightCm, weightKg };
}

/** Generates a fresh, gym-less "independent" opponent, exactly matching the requested weight class/gender. */
function generateIndependentFighter(rng, weightClassLabel, gender) {
  const cfg = BALANCE.GALA_CIRCUIT.OPPONENT_POOL;
  const division = BALANCE.PHYSICAL.WEIGHT_CLASSES[gender].find((d) => d.label === weightClassLabel);
  const physical = generatePhysicalProfileForDivision(rng, gender, division);
  const firstName = gender === 'M' ? pick(rng, INDEPENDENT_MALE_FIRST_NAMES) : pick(rng, INDEPENDENT_FEMALE_FIRST_NAMES);
  const name = `${firstName} ${pick(rng, INDEPENDENT_LAST_NAMES)}`;

  const skills = Object.fromEntries(
    SKILL_KEYS.map((key) => [key, Math.max(1, Math.round(cfg.INDEPENDENT_SKILL_MEAN + (rng() * 2 - 1) * cfg.INDEPENDENT_SKILL_SPREAD))])
  );

  return new Fighter({
    identity: {
      name,
      age: cfg.INDEPENDENT_MIN_AGE + Math.floor(rng() * (cfg.INDEPENDENT_MAX_AGE - cfg.INDEPENDENT_MIN_AGE + 1)),
      style: pick(rng, INDEPENDENT_STYLES),
      weightClass: physical.weightClassLabel,
      gender,
      heightCm: physical.heightCm,
      weightKg: physical.weightKg,
      origin: 'INDEPENDENT_GALA',
    },
    attributes: { skills },
    psychology: { personality: generatePersonality(rng) },
  });
}

/**
 * Draws one opponent for a Gala weight-class slot from the "pool global de
 * la ligue" — every rival gym's roster matching the slot's weight
 * class/gender, plus a chance (BALANCE.GALA_CIRCUIT.OPPONENT_POOL.INDEPENDENT_CHANCE)
 * of a freshly-generated independent (gym-less) fighter instead — always
 * independent if the rival-roster pool is empty.
 *
 * @param {Object} worldState
 * @param {Object} options
 * @param {string} options.weightClass
 * @param {string} options.gender
 * @param {boolean} [options.allowMixedGender]
 * @param {() => number} [options.rng]
 * @returns {{ fighter: Fighter, gymId: string|null, gymName: string|null }}
 */
export function drawGalaOpponent(worldState, { weightClass, gender, allowMixedGender = false, rng = Math.random }) {
  const cfg = BALANCE.GALA_CIRCUIT.OPPONENT_POOL;
  const pool = [];

  for (const gym of worldState.rivalGyms) {
    for (const entry of gym.roster ?? []) {
      if (entry.identity.weightClass !== weightClass) continue;
      if (!allowMixedGender && entry.identity.gender !== gender) continue;
      pool.push({ fighter: Fighter.fromJSON(entry), gymId: gym.id, gymName: gym.name ?? gym.id });
    }
  }

  if (pool.length === 0 || rng() < cfg.INDEPENDENT_CHANCE) {
    return { fighter: generateIndependentFighter(rng, weightClass, gender), gymId: null, gymName: null };
  }

  return pick(rng, pool);
}

/**
 * Registers the player's fighter onto an open weight-class slot of a Gala,
 * drawing an opponent from the global pool and locking the whole booking
 * in as a Fight Launch Contract (see engine/FightWeekEngine.js#scheduleFight).
 * The single source of truth web/app.js's Gala Calendar UI calls.
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {Object} options
 * @param {string} options.galaId
 * @param {string} options.fighterId
 * @param {boolean} [options.allowMixedGender]
 * @param {() => number} [options.rng]
 * @returns {{ success: boolean, reason?: string, message?: string, record?: Object, gala?: Object, opponent?: Fighter }}
 */
export function registerForGala(playerState, worldState, { galaId, fighterId, allowMixedGender = false, rng = Math.random }) {
  if (playerState.scheduledFight) return { success: false, reason: 'ALREADY_BOOKED' };

  const fighter = playerState.getFighter(fighterId);
  if (!fighter) return { success: false, reason: 'FIGHTER_NOT_FOUND' };
  if (fighter.isInjured?.(worldState.currentDay)) return { success: false, reason: 'FIGHTER_INJURED' };

  const gala = getGalaById(worldState, galaId);
  if (!gala) return { success: false, reason: 'GALA_NOT_FOUND' };

  // V3.8 "Contrats d'Exclusivite de Ligue": a fighter already bound to a
  // DIFFERENT organization cannot register for this gala at all — see
  // models/Fighter.js#signExclusivityContract, signed below on a
  // successful registration once the gym reaches National/Elite standing.
  if (fighter.contracts.exclusivity && fighter.contracts.exclusivity.orgId !== gala.orgId) {
    return { success: false, reason: 'EXCLUSIVITY_CONTRACT_VIOLATION', boundOrgId: fighter.contracts.exclusivity.orgId };
  }

  const slot = gala.weightClassSlots.find((s) => s.weightClass === fighter.identity.weightClass);
  if (!slot) return { success: false, reason: 'NO_OPEN_SLOT' };

  const draw = drawGalaOpponent(worldState, { weightClass: slot.weightClass, gender: fighter.identity.gender, allowMixedGender, rng });
  if (!draw?.fighter) return { success: false, reason: 'NO_OPPONENT_AVAILABLE' };

  try {
    assertNoIntraGymMatch(fighter, draw.fighter, playerState);
    assertGenderMatch(fighter, draw.fighter, { allowMixedGender });
  } catch (error) {
    return { success: false, reason: 'MATCHMAKING_VIOLATION', message: error.message };
  }

  const record = scheduleFight(playerState, worldState, {
    fighterId: fighter.identity.id,
    opponentSnapshot: draw.fighter.toJSON(),
    gymId: draw.gymId,
    galaId: gala.id,
    orgId: gala.orgId,
    fightDay: gala.day,
  });

  // V3.8: the gym's National/Elite standing now mandates exclusivity —
  // sign this fighter to it the first time they register while it applies
  // (a fighter who already signed one earlier, e.g. for this same org,
  // keeps their existing contract untouched — signExclusivityContract is
  // only ever called once per fighter, here).
  const exclusivityCfg = BALANCE.GALA_CIRCUIT.EXCLUSIVITY;
  let exclusivitySigned = false;
  if (!fighter.contracts.exclusivity && exclusivityCfg.REQUIRED_LEAGUE_TIERS.includes(playerState.leagueTier)) {
    fighter.signExclusivityContract(gala.orgId, exclusivityCfg.FIGHTS_REQUIRED);
    playerState.changeMoney(exclusivityCfg.SIGNING_BONUS, 'EXCLUSIVITY_SIGNING_BONUS');
    exclusivitySigned = true;
  }

  return { success: true, record, gala, opponent: draw.fighter, exclusivitySigned };
}

/**
 * Pays BALANCE.GALA_CIRCUIT.EXCLUSIVITY.RELEASE_CLAUSE_COST to break a
 * fighter's active exclusivity contract early, freeing them to register
 * for a Gala under any organization again.
 *
 * @param {Object} playerState
 * @param {string} fighterId
 * @returns {{ success: boolean, reason?: string, cost?: number }}
 */
export function releaseGalaExclusivity(playerState, fighterId) {
  const fighter = playerState.getFighter(fighterId);
  if (!fighter) return { success: false, reason: 'FIGHTER_NOT_FOUND' };
  if (!fighter.contracts.exclusivity) return { success: false, reason: 'NO_ACTIVE_CONTRACT' };

  const cost = BALANCE.GALA_CIRCUIT.EXCLUSIVITY.RELEASE_CLAUSE_COST;
  if (playerState.money < cost) return { success: false, reason: 'INSUFFICIENT_FUNDS', cost };

  playerState.changeMoney(-cost, 'EXCLUSIVITY_RELEASE_CLAUSE');
  fighter.releaseExclusivityContract();
  return { success: true, cost };
}

export default {
  getCurrentTier,
  getWinrate,
  evaluateLeagueStanding,
  recordLeagueFightResult,
  getPurseMultiplier,
  getPassiveIncomeMultiplier,
  getPromotionProgress,
  resolveRegionalOrg,
  getWeightClassRanking,
  getAllWeightClassRankings,
  getUpcomingGalas,
  getGalaById,
  drawGalaOpponent,
  registerForGala,
  releaseGalaExclusivity,
};
