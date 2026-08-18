/**
 * engine/MercatoEngine.js — V3.5 Item 8 ("Detection de talents & Mercato / Debauchage")
 * ---------------------------------------------------------------------------
 * Three player-initiated-or-targeted interactions with RIVAL rosters —
 * distinct from engine/TransferMarket.js (fully autonomous, rival-gym-only,
 * zero player/player-roster involvement):
 *   - SCOUT: pay to send a scout to a small (low-Reputation) rival club and
 *     unearth fresh rookie prospects the player can sign for free (the scout
 *     fee already paid for the discovery — only a weekly wage applies).
 *   - BUYOUT: pay a large transfer fee to poach a fighter directly off a
 *     rival gym's roster onto the player's own.
 *   - POACHING: the reverse risk — rival gyms may try to poach the player's
 *     OWN low-Loyalty fighters, resolved weekly.
 *
 * Like engine/TransferMarket.js, rival rosters live on WorldState as plain
 * JSON (never live Fighter instances) and are hydrated transiently here,
 * then written back via WorldState#updateRivalGym.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { generatePersonality, generateGenderedIdentity, generatePhysicalProfile } from './FighterGenerator.js';

/** Local flavor data for scouted rookies — same precedent as TransferMarket.js/AcademyEngine.js (each module keeps its own name pool). */
const MALE_FIRST_NAMES = Object.freeze(['Noah', 'Ilyes', 'Theo', 'Amir', 'Lucas', 'Kenji', 'Malik', 'Bruno', 'Ivo', 'Samir']);
const FEMALE_FIRST_NAMES = Object.freeze(['Nina', 'Amara', 'Yui', 'Lea', 'Fatima', 'Ines']);
const LAST_NAMES = Object.freeze([
  'Costa', 'Wojcik', 'Muller', 'Santos', 'Eriksen', 'Nakamura', 'Mensah', 'Ortega',
  'Romano', 'Holm', 'Ito', 'Pereira', 'Nowicki', 'Reyes', 'Karlsson', 'Achieng',
]);

const RECRUIT_STYLES = Object.freeze(['Boxe', 'Muay Thai', 'Lutte', 'Jiu-Jitsu Bresilien', 'Freestyle', 'Kickboxing']);
const SKILL_KEYS = Object.freeze(['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence']);

function hydrateRoster(roster) {
  return (roster ?? []).map((entry) => (entry instanceof Fighter ? entry : Fighter.fromJSON(entry)));
}

/**
 * @param {Object[]} rivalGyms - WorldState#rivalGyms.
 * @returns {Object[]} The rival gyms at/below SMALL_CLUB_REPUTATION_MAX — the only ones a scout can be sent to.
 */
export function getScoutableGyms(rivalGyms) {
  const cfg = BALANCE.MERCATO.SCOUT;
  return (rivalGyms ?? []).filter((gym) => (gym.reputation ?? 0) <= cfg.SMALL_CLUB_REPUTATION_MAX);
}

/**
 * Pure generation of 1-3 fresh rookie prospects unearthed by a scout sent to
 * a small club. Never touches PlayerState/WorldState — the caller deducts
 * BALANCE.MERCATO.SCOUT.COST upfront and, on signing, calls
 * PlayerState#addFighter() with a weeklySalary of the caller's choosing
 * (there is no "buy" cost here, the scouting fee already paid for access).
 *
 * @param {Object} [options]
 * @param {() => number} [options.rng]
 * @returns {Fighter[]}
 */
export function sendScout({ rng = Math.random } = {}) {
  const cfg = BALANCE.MERCATO.SCOUT;
  const count = cfg.ROOKIE_COUNT_MIN + Math.floor(rng() * (cfg.ROOKIE_COUNT_MAX - cfg.ROOKIE_COUNT_MIN + 1));

  return Array.from({ length: count }, () => {
    const identity = generateGenderedIdentity(rng, MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES);
    const physical = generatePhysicalProfile(rng, identity.gender);
    const skills = Object.fromEntries(
      SKILL_KEYS.map((key) => [key, Math.max(1, Math.round(cfg.ROOKIE_SKILL_MEAN + (rng() * 2 - 1) * cfg.ROOKIE_SKILL_SPREAD))])
    );

    return new Fighter({
      identity: {
        name: identity.name,
        age: cfg.ROOKIE_MIN_AGE + Math.floor(rng() * (cfg.ROOKIE_MAX_AGE - cfg.ROOKIE_MIN_AGE + 1)),
        style: RECRUIT_STYLES[Math.floor(rng() * RECRUIT_STYLES.length)],
        weightClass: physical.weightClassLabel,
        gender: physical.gender,
        heightCm: physical.heightCm,
        weightKg: physical.weightKg,
        origin: 'MERCATO_SCOUT',
      },
      attributes: { skills },
      psychology: { personality: generatePersonality(rng) },
    });
  });
}

/**
 * @param {Fighter} fighter
 * @returns {number} The transfer fee required to buy this fighter off a rival roster.
 */
export function computeBuyoutFee(fighter) {
  const recruitCfg = BALANCE.RECRUITMENT_MARKET;
  const mercatoCfg = BALANCE.MERCATO.BUYOUT;
  const rating = fighter.getOverallRating();

  const baseSigningCost = Math.max(recruitCfg.MIN_COST, recruitCfg.COST_BASE * recruitCfg.COST_GROWTH_PER_RATING_POINT ** rating);
  const titleMultiplier = fighter.isChampion() ? mercatoCfg.TITLE_HOLDER_EXTRA_MULTIPLIER : 1;

  return Math.round(baseSigningCost * mercatoCfg.MULTIPLIER_OF_RECRUITMENT_COST * titleMultiplier);
}

/**
 * Buys a fighter directly off a rival gym's roster onto the player's own,
 * for a fee computed by computeBuyoutFee(). Validates funds and roster
 * capacity; mutates both PlayerState and WorldState on success.
 *
 * @param {Object} playerState - A PlayerState instance.
 * @param {Object} worldState - A WorldState instance.
 * @param {string} gymId
 * @param {string} fighterId
 * @returns {{ success: boolean, reason?: string, fighter?: Fighter, fee?: number }}
 */
export function buyoutRivalFighter(playerState, worldState, gymId, fighterId) {
  const gym = worldState.rivalGyms.find((entry) => entry.id === gymId);
  if (!gym) return { success: false, reason: 'GYM_NOT_FOUND' };

  const roster = hydrateRoster(gym.roster);
  const index = roster.findIndex((fighter) => fighter.identity.id === fighterId);
  if (index === -1) return { success: false, reason: 'FIGHTER_NOT_FOUND' };

  const fighter = roster[index];
  const fee = computeBuyoutFee(fighter);

  if (playerState.money < fee) return { success: false, reason: 'INSUFFICIENT_FUNDS', fee };
  if (playerState.roster.length >= playerState.getRosterCapacity()) return { success: false, reason: 'ROSTER_FULL', fee };

  roster.splice(index, 1);
  worldState.updateRivalGym(gymId, { roster: roster.map((entry) => entry.toJSON()) });

  playerState.changeMoney(-fee, 'MERCATO_BUYOUT');
  fighter.contracts.currentContract = null;
  fighter.psychology.loyalty = BALANCE.PSYCHOLOGY.STARTING_VALUES.loyalty;
  playerState.addFighter(fighter);

  return { success: true, fighter, fee };
}

/**
 * Resolves one week of rival-gym poaching attempts against the player's own
 * low-Loyalty roster fighters. Any fighter below POACHING.LOYALTY_THRESHOLD
 * risks being poached; the lower their Loyalty, the higher the chance. On a
 * hit the fighter leaves PlayerState#roster and joins a randomly-chosen
 * rival gym's roster.
 *
 * @param {Object} playerState - A PlayerState instance.
 * @param {Object} worldState - A WorldState instance.
 * @param {() => number} [rng]
 * @returns {{ fighterId: string, fighterName: string, gymId: string, gymName: string }[]} Records of every fighter poached this week.
 */
export function rollWeeklyPoaching(playerState, worldState, rng = Math.random) {
  const cfg = BALANCE.MERCATO.POACHING;
  const poached = [];

  if (worldState.rivalGyms.length === 0) return poached;

  for (const fighter of [...playerState.roster]) {
    const loyalty = fighter.psychology.loyalty;
    if (loyalty >= cfg.LOYALTY_THRESHOLD) continue;

    const chance = cfg.BASE_WEEKLY_CHANCE + (cfg.LOYALTY_THRESHOLD - loyalty) * cfg.CHANCE_PER_LOYALTY_POINT_BELOW_THRESHOLD;
    if (rng() >= chance) continue;

    const gym = worldState.rivalGyms[Math.floor(rng() * worldState.rivalGyms.length)];
    playerState.removeFighter(fighter.identity.id);

    fighter.contracts.currentContract = { leagueId: null, gymId: gym.id, signedYear: worldState.year, expiresYear: worldState.year + 1 };
    worldState.updateRivalGym(gym.id, { roster: [...(gym.roster ?? []), fighter.toJSON()] });

    poached.push({ fighterId: fighter.identity.id, fighterName: fighter.identity.name, gymId: gym.id, gymName: gym.name ?? gym.id });
  }

  return poached;
}

/**
 * "Debauchage Rival": does this roster fighter's Hype, win streak, or a
 * held title make them worth a rival gym's attention? See
 * BALANCE.MERCATO.RIVAL_TRANSFER_TARGET — the sole eligibility gate for
 * engine/InboxEngine.js#evaluateTransferBids (V4.3 rework; replaces the
 * old flat MIN_OVERALL floor).
 * @param {Fighter} fighter
 * @returns {boolean}
 */
export function isRivalTransferTarget(fighter) {
  const cfg = BALANCE.MERCATO.RIVAL_TRANSFER_TARGET;
  return (
    fighter.attributes.hype > cfg.HYPE_THRESHOLD ||
    fighter.career.currentWinStreak >= cfg.WIN_STREAK_THRESHOLD ||
    fighter.isChampion()
  );
}

/**
 * "Debauchage Rival": BaseValue = Overall*OVERALL_MULTIPLIER +
 * Hype*HYPE_MULTIPLIER — the transfer amount a rival gym opens with for an
 * isRivalTransferTarget() fighter (see BALANCE.MERCATO.RIVAL_TRANSFER_TARGET).
 * Deliberately a different formula from computeBuyoutFee() above (that one
 * prices the PLAYER buying FROM a rival off RECRUITMENT_MARKET's own
 * exponential signing-cost curve; this one prices a RIVAL buying the
 * player's fighter off Hype/Overall directly, per the spec's own formula).
 * @param {Fighter} fighter
 * @returns {number}
 */
export function computeRivalTransferValue(fighter) {
  const cfg = BALANCE.MERCATO.RIVAL_TRANSFER_TARGET;
  return Math.round(fighter.getOverallRating() * cfg.OVERALL_MULTIPLIER + fighter.attributes.hype * cfg.HYPE_MULTIPLIER);
}

/**
 * "Envie de depart": does this fighter already want to leave the gym,
 * independent of any transfer bid? True below BALANCE.INBOX.ROSTER_NEWS
 * .LOW_LOYALTY_THRESHOLD, or once Hype clears the gym's own Reputation by
 * at least HYPE_OUTGROWS_GYM_GAP points — the same two conditions
 * engine/InboxEngine.js#evaluateRosterNews alerts on, reused here so a
 * TRANSFER_BID decline only costs Loyalty when the fighter was already
 * unhappy (see resolveTransferBid's own DECLINE branch).
 * @param {Fighter} fighter
 * @param {Object} playerState
 * @returns {boolean}
 */
export function fighterWantsToLeave(fighter, playerState) {
  const cfg = BALANCE.INBOX.ROSTER_NEWS;
  return (
    fighter.psychology.loyalty < cfg.LOW_LOYALTY_THRESHOLD ||
    fighter.attributes.hype - playerState.reputation >= cfg.HYPE_OUTGROWS_GYM_GAP
  );
}

export default {
  getScoutableGyms,
  sendScout,
  computeBuyoutFee,
  buyoutRivalFighter,
  rollWeeklyPoaching,
  isRivalTransferTarget,
  computeRivalTransferValue,
  fighterWantsToLeave,
};
