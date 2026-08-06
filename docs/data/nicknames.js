/**
 * data/nicknames.js
 * ---------------------------------------------------------------------------
 * Phase 4.2 ("Memoire du Monde, Legacy Engine & Attachement au Roster"):
 * declarative catalog of emergent nickname rules, consumed by
 * models/Fighter.js#evaluateNickname. Same "zero magic numbers" spirit as
 * data/events.js — every threshold that decides a nickname lives here, in
 * plain data, never hardcoded inside Fighter.js's evaluation logic.
 *
 * Each rule is a plain object:
 *   {
 *     id          - unique string key.
 *     label       - the nickname text applied to Fighter.identity.nickname.
 *     statKey     - one of Fighter.career's numeric counters (see
 *                   models/Fighter.js's career fields: koWins, tkoWins,
 *                   submissionWins, decisionWins, comebackWins,
 *                   longestWinStreak).
 *     minValue    - the counter must be >= this for the rule to match.
 *     priority    - when multiple rules match at once, the highest priority
 *                   wins (Fighter.identity.nickname holds exactly one
 *                   nickname at a time, its most prestigious earned one).
 *     description - human-readable rationale, surfaced by tools/BalanceReporter.js.
 *   }
 *
 * Every counter here is monotonically non-decreasing over a career (see
 * Fighter#recordFightResult), so a fighter's nickname can only ever be
 * replaced by a higher-priority one — it never regresses mid-career.
 * ---------------------------------------------------------------------------
 */

export const NICKNAME_RULES = Object.freeze([
  Object.freeze({
    id: 'PHOENIX',
    label: 'Phoenix',
    statKey: 'comebackWins',
    minValue: 2,
    priority: 30,
    description:
      "A remporte au moins 2 combats alors qu'il/elle etait domine(e) au compteur de degats (voir " +
      'engine/CombatEngine.js#_processPostMatchRewards\'s comeback flag: judgePointsFromDamage du ' +
      "vainqueur strictement inferieur a celui du perdant) — une remontee heroique, pas juste une victoire.",
  }),
  Object.freeze({
    id: 'THE_HAMMER',
    label: 'The Hammer',
    statKey: 'koWins',
    minValue: 5,
    priority: 20,
    description: 'Au moins 5 victoires par KO en carriere.',
  }),
  Object.freeze({
    id: 'UNSTOPPABLE',
    label: 'Unstoppable',
    statKey: 'longestWinStreak',
    minValue: 10,
    priority: 25,
    description: 'A enchaine au moins 10 victoires consecutives en carriere (Fighter.career.longestWinStreak).',
  }),
  Object.freeze({
    id: 'THE_SILENCER',
    label: 'The Silencer',
    statKey: 'submissionWins',
    minValue: 5,
    priority: 22,
    description: 'Au moins 5 victoires par soumission en carriere.',
  }),
  Object.freeze({
    id: 'THE_FINISHER',
    label: 'The Finisher',
    statKey: 'tkoWins',
    minValue: 5,
    priority: 19,
    description: 'Au moins 5 victoires par TKO (ou arret medical) en carriere.',
  }),
  Object.freeze({
    id: 'THE_TECHNICIAN',
    label: 'The Technician',
    statKey: 'decisionWins',
    minValue: 10,
    priority: 10,
    description: 'Au moins 10 victoires aux points (decision) en carriere.',
  }),
  Object.freeze({
    id: 'THE_IRONMAN',
    label: 'The Ironman',
    statKey: 'wins',
    // Deliberately <= 21 (4 koWins + 4 tkoWins + 4 submissionWins + 9
    // decisionWins, the most any fighter can accumulate while staying
    // strictly under every other rule's own minValue above): any higher
    // and a fighter mathematically cannot reach it without ALSO already
    // clearing a more specific rule first, making THE_IRONMAN unreachable
    // as the fighter's own top-matching nickname in practice.
    minValue: 15,
    priority: 5,
    description:
      'Au moins 15 victoires en carriere, toutes methodes confondues — le filet de securite pour un veteran polyvalent ' +
      "qui n'a pas (encore) accumule assez d'un type de finish/decision precis pour l'une des autres surnoms.",
  }),
]);

export default NICKNAME_RULES;
