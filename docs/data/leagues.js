/**
 * data/leagues.js
 * ---------------------------------------------------------------------------
 * Phase V2.7 ("Le Monde Vivant & Ecosysteme Global"): the 4 promotions
 * fights can be booked under. engine/CombatEngine.js already takes a free-
 * form `orgId` string per match (see setupMatch), and state/WorldState.js
 * already keys title belts by `${orgId}:${weightClass}` (see
 * WorldState#titleHolders/getTitleHolder) — this catalog just gives those
 * orgId strings real names/prestige/purse tiers instead of the single
 * hardcoded 'WFC' every call site (web/app.js, tools/SimRunner.js) has used
 * until now. Belts are "associated" to a league simply by using that
 * league's id as the orgId of a title fight — no new belt-storage mechanism
 * needed, titleHolders already works generically by orgId.
 *
 * Pure data, no logic — engine/TransferMarket.js and
 * engine/ProspectGenerator.js read it (via resolveLeagueForReputation) to
 * decide which league a rival gym's contracts are written under.
 * ---------------------------------------------------------------------------
 */

export const LEAGUES = Object.freeze({
  UNDERGROUND_CIRCUIT: {
    id: 'UNDERGROUND_CIRCUIT',
    name: 'Underground Circuit',
    tier: 1,
    /** Minimum gym Reputation (0-100) required to fight/sign under this league. */
    minReputation: 0,
    /** References BALANCE.ECONOMY.BASE_FIGHT_PURSE's own tier keys — this league's contracts are written at this purse tier. */
    purseTier: 'LOCAL_SHOW',
    description: 'Le circuit local ou tout le monde commence.',
  },
  RISING_WARRIORS: {
    id: 'RISING_WARRIORS',
    name: 'Rising Warriors',
    tier: 2,
    minReputation: 25,
    purseTier: 'REGIONAL',
    description: 'La ligue des espoirs qui percent.',
  },
  IRON_CAGE: {
    id: 'IRON_CAGE',
    name: 'Iron Cage',
    tier: 3,
    minReputation: 55,
    purseTier: 'NATIONAL',
    description: 'La grande ligue nationale.',
  },
  ELITE_CHAMPIONSHIP: {
    id: 'ELITE_CHAMPIONSHIP',
    name: 'Elite Championship',
    tier: 4,
    minReputation: 80,
    purseTier: 'MAJOR_PROMOTION',
    description: "L'elite mondiale, ou se jouent les titres les plus prestigieux.",
  },
});

/** Every valid league id, tier-ordered low to high (Object.freeze preserves insertion order for string keys). */
export const LEAGUE_IDS = Object.freeze(Object.keys(LEAGUES));

/**
 * @param {number} reputation - A gym's current Reputation (0-100).
 * @returns {Object} The highest-tier league this reputation qualifies for
 *   (always at least UNDERGROUND_CIRCUIT, whose minReputation is 0).
 */
export function resolveLeagueForReputation(reputation) {
  let best = LEAGUES.UNDERGROUND_CIRCUIT;
  for (const league of Object.values(LEAGUES)) {
    if (reputation >= league.minReputation && league.tier > best.tier) best = league;
  }
  return best;
}

export default LEAGUES;
