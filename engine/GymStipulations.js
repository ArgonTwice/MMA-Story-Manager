/**
 * engine/GymStipulations.js — "Underground Circuit, Special Rulesets &
 * Gym-Stipulation Matches"
 * ---------------------------------------------------------------------------
 * Applies the direct gym-level stakes of an Underground Circuit stipulation
 * match AFTER the fight itself has already been resolved by
 * engine/UndergroundEngine.js/engine/CombatEngine.js — this module never
 * touches combat math, it only consumes a finished fight's winner/loser and
 * moves equipment/reputation/loyalty/contracts/money around accordingly.
 *
 * Four stipulations:
 *   - GYM_TAKEOVER: win = a free top-tier equipment item; lose = a rival
 *     gym seizes one facility level (PlayerState#seizeFacilityLevel).
 *   - COACHS_HONOUR: win = Reputation + roster-wide Loyalty boost; lose =
 *     roster-wide Loyalty crashes by a fraction of each fighter's current
 *     value (a flat -20 would be disproportionate near 0 — see
 *     BALANCE.UNDERGROUND.GYM_STIPULATIONS.COACHS_HONOUR).
 *   - PINK_SLIP: the LOSING side's fighter transfers to the winning side's
 *     gym with no compensation — symmetric: the player can win a rival's
 *     fighter for free exactly as they can lose their own. Requires
 *     `opponentGymId` (which rival gym the opponent fighter belongs to —
 *     see engine/TransferMarket.js's own plain-JSON-roster convention,
 *     reused here) so the transfer can update the correct
 *     worldState.rivalGyms entry.
 *   - SPONSORSHIP_RAID: win = captures a timed recurring sponsor deal
 *     (BALANCE.UNDERGROUND.GYM_STIPULATIONS.SPONSORSHIP_RAID), paid out
 *     weekly by processActiveDeals() below; lose = nothing beyond the
 *     fight's own normal consequences (no specific penalty is described in
 *     the spec for a failed raid).
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';

/** The four gym-stipulation stakes an Underground Circuit match can carry. */
export const GYM_STIPULATIONS = Object.freeze({
  GYM_TAKEOVER: 'GYM_TAKEOVER',
  COACHS_HONOUR: 'COACHS_HONOUR',
  PINK_SLIP: 'PINK_SLIP',
  SPONSORSHIP_RAID: 'SPONSORSHIP_RAID',
});

function assertValidStipulation(stipulationKey) {
  if (!Object.values(GYM_STIPULATIONS).includes(stipulationKey)) {
    throw new TypeError(`GymStipulations: invalid stipulation "${stipulationKey}".`);
  }
}

/** Highest-purchaseCost equipment definition the player doesn't already own — "haut de gamme" (top-tier), operationalized as the priciest one still missing. Null if every item is already owned. */
function pickBestUnownedEquipment(playerState) {
  const owned = new Set(playerState.equipment.map((item) => item.id));
  const candidates = Object.entries(BALANCE.EQUIPMENT.DEFINITIONS).filter(([id]) => !owned.has(id));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => (candidate[1].purchaseCost > best[1].purchaseCost ? candidate : best))[0];
}

function resolveGymTakeover({ playerWon, playerState }) {
  if (playerWon) {
    const equipmentId = pickBestUnownedEquipment(playerState);
    if (!equipmentId) return { type: 'NOTHING_TO_GAIN', detail: 'Le gym possede deja tout le catalogue d\'equipement.' };

    playerState.addEquipmentItem({ id: equipmentId, origin: 'GYM_TAKEOVER' });
    return { type: 'EQUIPMENT_GAINED', equipmentId, label: BALANCE.EQUIPMENT.DEFINITIONS[equipmentId].label };
  }

  const seized = playerState.seizeFacilityLevel();
  if (!seized) return { type: 'NOTHING_TO_LOSE', detail: 'Le gym n\'a aucune installation a saisir (niveau 0).' };
  return { type: 'FACILITY_LEVEL_SEIZED', newEquipLevel: playerState.equipLevel };
}

function resolveCoachsHonour({ playerWon, playerState }) {
  const cfg = BALANCE.UNDERGROUND.GYM_STIPULATIONS.COACHS_HONOUR;

  if (playerWon) {
    playerState.changeReputation(cfg.REPUTATION_WIN_BONUS, 'GYM_STIPULATION:COACHS_HONOUR');
    for (const fighter of playerState.roster) fighter.adjustLoyalty(cfg.LOYALTY_WIN_BONUS);
    return { type: 'HONOUR_UPHELD', reputationDelta: cfg.REPUTATION_WIN_BONUS, loyaltyDelta: cfg.LOYALTY_WIN_BONUS, rosterSize: playerState.roster.length };
  }

  const deltas = [];
  for (const fighter of playerState.roster) {
    const delta = -(fighter.psychology.loyalty * cfg.LOYALTY_LOSS_FRACTION);
    fighter.adjustLoyalty(delta);
    deltas.push({ fighterId: fighter.identity.id, delta: Math.round(delta * 10) / 10 });
  }
  return { type: 'HONOUR_LOST', deltas };
}

/** Removes `fighterId` from a rival gym's plain-JSON roster, if present. No-ops silently if the gym or fighter isn't found (a gym may have been pruned independently — same defensive spirit as WorldState#updateRivalGym). */
function removeFighterFromRivalGym({ fighterId, gymId, worldState }) {
  const gym = worldState.rivalGyms.find((entry) => entry.id === gymId);
  if (!gym) return;
  const nextRoster = (gym.roster ?? []).filter((entry) => entry.identity?.id !== fighterId);
  worldState.updateRivalGym(gymId, { roster: nextRoster });
}

/** Adds a Fighter (live instance, serialized here) to a rival gym's plain-JSON roster. */
function addFighterToRivalGym({ fighter, gymId, worldState }) {
  const gym = worldState.rivalGyms.find((entry) => entry.id === gymId);
  const roster = gym?.roster ?? [];
  worldState.updateRivalGym(gymId, { roster: [...roster, fighter.toJSON()] });
}

function resolvePinkSlip({ playerWon, playerFighter, opponentFighter, opponentGymId, playerState, worldState }) {
  if (playerWon) {
    // The opponent's fighter cedes to the player's gym, no compensation.
    removeFighterFromRivalGym({ fighterId: opponentFighter.identity.id, gymId: opponentGymId, worldState });
    opponentFighter.identity.origin = 'PINK_SLIP';
    const added = playerState.addFighter(opponentFighter);
    return added
      ? { type: 'FIGHTER_ACQUIRED', fighterId: opponentFighter.identity.id, fighterName: opponentFighter.identity.name }
      : { type: 'ROSTER_FULL', detail: 'La cession n\'a pas pu avoir lieu : effectif du gym au complet.', fighterId: opponentFighter.identity.id };
  }

  // The player's own fighter cedes to the opponent's gym, no compensation.
  playerState.removeFighter(playerFighter.identity.id);
  playerFighter.identity.origin = 'PINK_SLIP';
  playerFighter.contracts.currentContract = null;
  addFighterToRivalGym({ fighter: playerFighter, gymId: opponentGymId, worldState });
  return { type: 'FIGHTER_LOST', fighterId: playerFighter.identity.id, fighterName: playerFighter.identity.name, gymId: opponentGymId };
}

function resolveSponsorshipRaid({ playerWon, playerState }) {
  if (!playerWon) return { type: 'RAID_FAILED' };

  const cfg = BALANCE.UNDERGROUND.GYM_STIPULATIONS.SPONSORSHIP_RAID;
  const deal = playerState.addActiveDeal({
    type: 'SPONSORSHIP_RAID',
    weeklyAmount: cfg.WEEKLY_AMOUNT,
    weeksRemaining: cfg.WEEKS,
  });
  return { type: 'SPONSOR_CAPTURED', deal };
}

/**
 * Applies a gym stipulation's stakes after an Underground Circuit fight has
 * already been resolved (see engine/UndergroundEngine.js#runUndergroundFight).
 *
 * @param {string} stipulationKey - One of GYM_STIPULATIONS.
 * @param {Object} options
 * @param {boolean} options.playerWon - True if the PLAYER's side won the fight (false for a loss OR a draw — a stipulation match needs a decisive outcome to trigger either consequence; a draw applies neither).
 * @param {Fighter} [options.playerFighter] - The player's own fighter who fought (required for PINK_SLIP).
 * @param {Fighter} [options.opponentFighter] - The rival gym's fighter who fought (required for PINK_SLIP).
 * @param {string} [options.opponentGymId] - Which worldState.rivalGyms entry the opponent belongs to (required for PINK_SLIP).
 * @param {Object} options.playerState - A PlayerState instance.
 * @param {Object} [options.worldState] - A WorldState instance (required for PINK_SLIP).
 * @returns {Object} A structured, stipulation-specific outcome record.
 */
export function resolveGymStipulation(stipulationKey, { playerWon, playerFighter, opponentFighter, opponentGymId, playerState, worldState }) {
  assertValidStipulation(stipulationKey);

  switch (stipulationKey) {
    case GYM_STIPULATIONS.GYM_TAKEOVER:
      return resolveGymTakeover({ playerWon, playerState });
    case GYM_STIPULATIONS.COACHS_HONOUR:
      return resolveCoachsHonour({ playerWon, playerState });
    case GYM_STIPULATIONS.PINK_SLIP:
      if (!(playerFighter instanceof Fighter) || !(opponentFighter instanceof Fighter) || !opponentGymId || !worldState) {
        throw new TypeError('GymStipulations.resolveGymStipulation: PINK_SLIP requires playerFighter, opponentFighter, opponentGymId, and worldState.');
      }
      return resolvePinkSlip({ playerWon, playerFighter, opponentFighter, opponentGymId, playerState, worldState });
    case GYM_STIPULATIONS.SPONSORSHIP_RAID:
      return resolveSponsorshipRaid({ playerWon, playerState });
    default:
      // Unreachable — assertValidStipulation already rejected anything else.
      throw new TypeError(`GymStipulations: unhandled stipulation "${stipulationKey}".`);
  }
}

/**
 * Weekly tick for every active timed deal (currently just Sponsorship
 * Raid's captured contract) — pays out `weeklyAmount`, counts down
 * `weeksRemaining`, and removes the deal once it expires. Call once per
 * resolved week (see web/app.js#_completeWeek), mirroring
 * engine/EconomyEngine.js#processWeeklyExpenses' own "one call per week"
 * shape, kept as its own function here (not folded into EconomyEngine)
 * since this phase's scope is Underground-specific.
 *
 * @param {Object} playerState - A PlayerState instance.
 * @returns {Object[]} One entry per deal processed this week (paid and/or expired).
 */
export function processActiveDeals(playerState) {
  const results = [];
  for (const deal of [...playerState.activeDeals]) {
    playerState.changeMoney(deal.weeklyAmount, `ACTIVE_DEAL:${deal.type}`);
    deal.weeksRemaining -= 1;

    const expired = deal.weeksRemaining <= 0;
    if (expired) playerState.removeActiveDeal(deal.id);

    results.push({ dealId: deal.id, type: deal.type, amountPaid: deal.weeklyAmount, weeksRemaining: deal.weeksRemaining, expired });
  }
  return results;
}
