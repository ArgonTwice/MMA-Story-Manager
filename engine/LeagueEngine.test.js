/**
 * engine/LeagueEngine.test.js
 * Run with: node --test engine/LeagueEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import {
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
  getLeagueEligibility,
  signLeagueContract,
  releaseGalaExclusivity,
} from './LeagueEngine.js';

/** A fighter whose getOverallRating() clears every GALA_CIRCUIT org's eligibility.minOverall bar (highest is APEX's 75) — used by every V3.9 league-contract test below. */
function makeEliteFighter(overrides = {}) {
  const skills = { boxe: 85, jambes: 85, sol: 85, soumission: 85, cardio: 85, intelligence: 85 };
  return new Fighter({
    identity: { id: 'f1', name: 'F1', gender: 'M', weightClass: 'Poids Welter' },
    attributes: { skills },
    ...overrides,
  });
}

test('a fresh gym starts in the bottom tier (LOCAL_UNDERGROUND) with a 1x purse/passive-income multiplier', () => {
  const playerState = new PlayerState({ money: 25000 });
  const tier = getCurrentTier(playerState);
  assert.equal(tier.id, BALANCE.LEAGUE_PYRAMID.TIER_ORDER[0]);
  assert.equal(getPurseMultiplier(playerState), 1);
  assert.equal(getPassiveIncomeMultiplier(playerState), 1);
});

test('getWinrate is null with no fight history, then reflects wins/total as results are recorded', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 0 });
  assert.equal(getWinrate(playerState), null);

  recordLeagueFightResult(playerState, true);
  recordLeagueFightResult(playerState, false);
  assert.equal(getWinrate(playerState), 0.5);
});

test('recentFightResults is capped at FIGHT_HISTORY_WINDOW (FIFO — oldest dropped first)', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 0 });
  const window = BALANCE.LEAGUE_PYRAMID.FIGHT_HISTORY_WINDOW;
  for (let i = 0; i < window + 5; i += 1) recordLeagueFightResult(playerState, i % 2 === 0);
  assert.equal(playerState.recentFightResults.length, window);
});

test('promotion requires BOTH sufficient Reputation AND winrate >= PROMOTION_WINRATE_THRESHOLD, not either alone', () => {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const nextTier = cfg.TIERS[cfg.TIER_ORDER[1]];

  // High reputation, but a losing record — must NOT promote.
  const lowWinrateGym = new PlayerState({ money: 25000, reputation: nextTier.promotionReputationThreshold + 10 });
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) recordLeagueFightResult(lowWinrateGym, false);
  assert.equal(lowWinrateGym.leagueTier, cfg.TIER_ORDER[0]);

  // Good record, but reputation too low — must NOT promote.
  const lowRepGym = new PlayerState({ money: 25000, reputation: 0 });
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) recordLeagueFightResult(lowRepGym, true);
  assert.equal(lowRepGym.leagueTier, cfg.TIER_ORDER[0]);

  // Both conditions met — must promote.
  const readyGym = new PlayerState({ money: 25000, reputation: nextTier.promotionReputationThreshold + 10 });
  let lastEvaluation;
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) lastEvaluation = recordLeagueFightResult(readyGym, true);
  assert.equal(readyGym.leagueTier, nextTier.id);
  assert.equal(lastEvaluation.changed, true);
  assert.equal(lastEvaluation.direction, 'PROMOTED');
});

test('relegation triggers on winrate < RELEGATION_WINRATE_THRESHOLD alone, even with high reputation', () => {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const nationalTierId = cfg.TIER_ORDER[1];
  const playerState = new PlayerState({ money: 25000, reputation: 100, leagueTier: nationalTierId });

  let lastEvaluation;
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) lastEvaluation = recordLeagueFightResult(playerState, false);

  assert.equal(playerState.leagueTier, cfg.TIER_ORDER[0]);
  assert.equal(lastEvaluation.direction, 'RELEGATED');
});

test('no promotion/relegation evaluated below MIN_FIGHTS_FOR_EVALUATION, even with a perfect or winless record', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 100 });
  recordLeagueFightResult(playerState, true);
  const evaluation = evaluateLeagueStanding(playerState);
  assert.equal(evaluation.changed, false);
});

test('the top tier never promotes further, and the bottom tier never relegates further', () => {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const topTierId = cfg.TIER_ORDER[cfg.TIER_ORDER.length - 1];
  const topGym = new PlayerState({ money: 25000, reputation: 100, leagueTier: topTierId });
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) recordLeagueFightResult(topGym, true);
  assert.equal(topGym.leagueTier, topTierId);

  const bottomGym = new PlayerState({ money: 25000, reputation: 0 });
  for (let i = 0; i < cfg.MIN_FIGHTS_FOR_EVALUATION; i += 1) recordLeagueFightResult(bottomGym, false);
  assert.equal(bottomGym.leagueTier, cfg.TIER_ORDER[0]);
});

test('getPromotionProgress reports null progress fields with no fight history, and 0-1 progress once fights are logged', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 10 });
  const emptyProgress = getPromotionProgress(playerState);
  assert.equal(emptyProgress.winrateProgress, null);

  recordLeagueFightResult(playerState, true);
  const progress = getPromotionProgress(playerState);
  assert.ok(progress.winrateProgress >= 0 && progress.winrateProgress <= 1);
  assert.ok(progress.reputationProgress >= 0 && progress.reputationProgress <= 1);
  assert.equal(progress.nextTier.id, BALANCE.LEAGUE_PYRAMID.TIER_ORDER[1]);
});

test('a higher league tier scales purses and passive income up (ELITE_MONDIALE > NATIONAL > LOCAL_UNDERGROUND)', () => {
  const cfg = BALANCE.LEAGUE_PYRAMID;
  const local = new PlayerState({ money: 25000, leagueTier: cfg.TIER_ORDER[0] });
  const national = new PlayerState({ money: 25000, leagueTier: cfg.TIER_ORDER[1] });
  const elite = new PlayerState({ money: 25000, leagueTier: cfg.TIER_ORDER[2] });

  assert.ok(getPurseMultiplier(national) > getPurseMultiplier(local));
  assert.ok(getPurseMultiplier(elite) > getPurseMultiplier(national));
  assert.ok(getPassiveIncomeMultiplier(elite) > getPassiveIncomeMultiplier(local));
});

// ---- V3.5: regional organizations -----------------------------------------

test('resolveRegionalOrg matches Brazil/Europe/USA countries case-insensitively, and falls back to GLOBAL (WFC) otherwise', () => {
  assert.equal(resolveRegionalOrg('Bresil').id, BALANCE.REGIONAL_ORGS.BRAZIL.id);
  assert.equal(resolveRegionalOrg('BRAZIL').id, BALANCE.REGIONAL_ORGS.BRAZIL.id);
  assert.equal(resolveRegionalOrg('France').id, BALANCE.REGIONAL_ORGS.EUROPE.id);
  assert.equal(resolveRegionalOrg('USA').id, BALANCE.REGIONAL_ORGS.USA.id);
  assert.equal(resolveRegionalOrg('Atlantis').id, BALANCE.REGIONAL_ORGS.GLOBAL.id);
  assert.equal(resolveRegionalOrg('').id, BALANCE.REGIONAL_ORGS.GLOBAL.id);
  assert.equal(resolveRegionalOrg(null).id, BALANCE.REGIONAL_ORGS.GLOBAL.id);
});

test('resolveRegionalOrg defaults every unmatched/empty country to the same \'WFC\' id every pre-V3.5 fixture already assumes', () => {
  assert.equal(resolveRegionalOrg(undefined).id, 'WFC');
});

test('getWeightClassRanking gathers the player\'s roster and every rival gym\'s roster in one weight class, sorted by rating descending', () => {
  const playerState = new PlayerState({ gymName: 'My Gym', money: 25000 });
  const worldState = new WorldState();

  const strongPlayer = new Fighter({
    identity: { name: 'Strong Player', weightClass: 'Poids Welter' },
    attributes: { skills: { boxe: 90, jambes: 90, sol: 90, soumission: 90, cardio: 90, intelligence: 90 } },
  });
  const weakPlayer = new Fighter({
    identity: { name: 'Weak Player', weightClass: 'Poids Welter' },
    attributes: { skills: { boxe: 10, jambes: 10, sol: 10, soumission: 10, cardio: 10, intelligence: 10 } },
  });
  const otherWeightClass = new Fighter({ identity: { name: 'Off Class', weightClass: 'Poids Lourd' } });
  playerState.addFighter(strongPlayer);
  playerState.addFighter(weakPlayer);
  playerState.addFighter(otherWeightClass);

  const rivalFighter = new Fighter({
    identity: { name: 'Rival Mid', weightClass: 'Poids Welter' },
    attributes: { skills: { boxe: 50, jambes: 50, sol: 50, soumission: 50, cardio: 50, intelligence: 50 } },
  });
  worldState.addRivalGym({ name: 'Rival Gym', reputation: 50, roster: [rivalFighter.toJSON()] });

  const ranking = getWeightClassRanking(playerState, worldState, 'Poids Welter');
  assert.equal(ranking.length, 3);
  assert.equal(ranking[0].name, 'Strong Player');
  assert.equal(ranking[ranking.length - 1].name, 'Weak Player');
  assert.ok(!ranking.some((entry) => entry.name === 'Off Class'), 'a different weight class should never appear in this ranking');
  assert.ok(ranking.every((entry) => typeof entry.overallRating === 'number'));
});

test('getWeightClassRanking respects the limit parameter', () => {
  const playerState = new PlayerState({ gymName: 'My Gym', money: 25000 });
  const worldState = new WorldState();
  for (let i = 0; i < 5; i += 1) {
    playerState.addFighter(new Fighter({ identity: { name: `Fighter ${i}`, weightClass: 'Poids Welter' } }));
  }
  const ranking = getWeightClassRanking(playerState, worldState, 'Poids Welter', 2);
  assert.equal(ranking.length, 2);
});

test('getAllWeightClassRankings returns every M/F division for the resolved org, defaulting to a Top 15 each', () => {
  const playerState = new PlayerState({ gymName: 'My Gym', money: 25000, country: 'France' });
  const worldState = new WorldState();
  playerState.addFighter(new Fighter({ identity: { name: 'Fighter M', gender: 'M', weightClass: 'Poids Welter' } }));
  playerState.addFighter(new Fighter({ identity: { name: 'Fighter F', gender: 'F', weightClass: 'Poids Paille' } }));

  const board = getAllWeightClassRankings(playerState, worldState);

  assert.equal(board.org.id, resolveRegionalOrg('France').id);
  assert.equal(board.byGender.M.length, BALANCE.PHYSICAL.WEIGHT_CLASSES.M.length);
  assert.equal(board.byGender.F.length, BALANCE.PHYSICAL.WEIGHT_CLASSES.F.length);

  const welter = board.byGender.M.find((division) => division.label === 'Poids Welter');
  assert.equal(welter.ranking.length, 1);
  assert.equal(welter.ranking[0].name, 'Fighter M');

  const paille = board.byGender.F.find((division) => division.label === 'Poids Paille');
  assert.equal(paille.ranking.length, 1);
  assert.equal(paille.ranking[0].name, 'Fighter F');

  const empty = board.byGender.M.find((division) => division.label === 'Poids Lourd');
  assert.deepEqual(empty.ranking, []);
});

test('getAllWeightClassRankings respects a custom limit', () => {
  const playerState = new PlayerState({ gymName: 'My Gym', money: 25000 });
  const worldState = new WorldState();
  for (let i = 0; i < 5; i += 1) {
    playerState.addFighter(new Fighter({ identity: { name: `Fighter ${i}`, weightClass: 'Poids Welter' } }));
  }
  const board = getAllWeightClassRankings(playerState, worldState, { limit: 2 });
  const welter = board.byGender.M.find((division) => division.label === 'Poids Welter');
  assert.equal(welter.ranking.length, 2);
});

// ---- V3.7: Gala Calendar ----------------------------------------------------------

test('getUpcomingGalas returns UPCOMING_COUNT_PER_ORG galas per organization, every day at/after FIRST_GALA_MIN_DAYS_OUT, sorted soonest-first', () => {
  const worldState = new WorldState();
  const galas = getUpcomingGalas(worldState);
  const cfg = BALANCE.GALA_CIRCUIT;

  assert.equal(galas.length, Object.keys(cfg.ORGANIZATIONS).length * cfg.UPCOMING_COUNT_PER_ORG);
  for (const gala of galas) {
    assert.ok(gala.day >= worldState.currentDay + cfg.FIRST_GALA_MIN_DAYS_OUT);
    assert.ok(Object.values(cfg.ORGANIZATIONS).some((org) => org.id === gala.orgId));
    assert.ok(gala.weightClassSlots.length > 0);
  }
  for (let i = 1; i < galas.length; i += 1) {
    assert.ok(galas[i].day >= galas[i - 1].day);
  }
});

test('getUpcomingGalas is deterministic — the same calendar renders every time for the same currentDay', () => {
  const worldState = new WorldState();
  assert.deepEqual(getUpcomingGalas(worldState), getUpcomingGalas(worldState));
});

test('getUpcomingGalas respects a custom count override', () => {
  const worldState = new WorldState();
  const galas = getUpcomingGalas(worldState, { count: 1 });
  assert.equal(galas.length, Object.keys(BALANCE.GALA_CIRCUIT.ORGANIZATIONS).length);
});

test('getGalaById reconstructs the exact same gala a matching getUpcomingGalas entry describes', () => {
  const worldState = new WorldState();
  const [first] = getUpcomingGalas(worldState, { count: 1 });
  const reconstructed = getGalaById(worldState, first.id);
  assert.deepEqual(reconstructed, first);
});

test('getGalaById returns null for a malformed or unknown gala id', () => {
  const worldState = new WorldState();
  assert.equal(getGalaById(worldState, 'NOT_A_REAL_ORG#0'), null);
  assert.equal(getGalaById(worldState, 'garbage'), null);
});

test('drawGalaOpponent draws from a matching rival gym roster when one is available', () => {
  const worldState = new WorldState();
  const rivalFighter = new Fighter({ identity: { name: 'Rival', gender: 'M', weightClass: 'Poids Welter' } });
  worldState.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [rivalFighter.toJSON()] });

  const draw = drawGalaOpponent(worldState, { weightClass: 'Poids Welter', gender: 'M', rng: () => 0 }); // 0 < INDEPENDENT_CHANCE is false only if INDEPENDENT_CHANCE > 0, so force rng past it
  // rng() always 0 would trigger the independent branch since 0 < INDEPENDENT_CHANCE; use a value guaranteed above it instead.
  const draw2 = drawGalaOpponent(worldState, { weightClass: 'Poids Welter', gender: 'M', rng: () => 0.99 });
  assert.equal(draw2.fighter.identity.name, 'Rival');
  assert.equal(draw2.gymId, worldState.rivalGyms[0].id);
  assert.ok(draw.fighter); // independent branch still produced a valid fighter
});

test('drawGalaOpponent falls back to an independent fighter matching the exact weight class/gender when the pool is empty', () => {
  const worldState = new WorldState();
  const draw = drawGalaOpponent(worldState, { weightClass: 'Poids Paille', gender: 'F', rng: () => 0.99 });

  assert.equal(draw.gymId, null);
  assert.equal(draw.gymName, null);
  assert.equal(draw.fighter.identity.gender, 'F');
  assert.equal(draw.fighter.identity.weightClass, 'Poids Paille');
  assert.equal(draw.fighter.identity.origin, 'INDEPENDENT_GALA');
});

test('drawGalaOpponent excludes opposite-gender rival fighters unless allowMixedGender is set', () => {
  const worldState = new WorldState();
  const rivalFighter = new Fighter({ identity: { name: 'Rival Woman', gender: 'F', weightClass: 'Poids Welter' } });
  worldState.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [rivalFighter.toJSON()] });

  const strict = drawGalaOpponent(worldState, { weightClass: 'Poids Welter', gender: 'M', rng: () => 0.99 });
  assert.equal(strict.gymId, null, 'no matching-gender rival fighter exists, so it must fall back to independent');

  const mixed = drawGalaOpponent(worldState, { weightClass: 'Poids Welter', gender: 'M', allowMixedGender: true, rng: () => 0.99 });
  assert.equal(mixed.fighter.identity.name, 'Rival Woman');
});

test('registerForGala fails cleanly when already booked, fighter missing/injured, or the gala id is unknown', () => {
  const worldState = new WorldState();
  const playerState = new PlayerState({ money: 25000 });
  const fighter = new Fighter({ identity: { id: 'f1', name: 'F1', gender: 'M', weightClass: 'Poids Welter' } });
  playerState.addFighter(fighter);

  assert.equal(registerForGala(playerState, worldState, { galaId: 'nope#0', fighterId: 'missing' }).reason, 'FIGHTER_NOT_FOUND');

  fighter.applyInjury({ severity: 'MINOR', bodyPart: 'jambe', occurredOnDay: worldState.currentDay, injuredUntilDay: worldState.currentDay + 9999 });
  assert.equal(registerForGala(playerState, worldState, { galaId: 'nope#0', fighterId: 'f1' }).reason, 'FIGHTER_INJURED');
  fighter.medical.injuredUntil = null;

  assert.equal(registerForGala(playerState, worldState, { galaId: 'NOT_A_REAL_ORG#0', fighterId: 'f1' }).reason, 'GALA_NOT_FOUND');

  const [gala] = getUpcomingGalas(worldState, { count: 1 });
  const first = registerForGala(playerState, worldState, { galaId: gala.id, fighterId: 'f1', rng: () => 0.99 });
  assert.equal(first.success, true);

  const second = registerForGala(playerState, worldState, { galaId: gala.id, fighterId: 'f1', rng: () => 0.99 });
  assert.equal(second.reason, 'ALREADY_BOOKED');
});

test('a successful registerForGala books a Fight Launch Contract with opponentSnapshot/galaId/orgId/fightDay matching the chosen gala', () => {
  const worldState = new WorldState();
  const playerState = new PlayerState({ money: 25000 });
  const fighter = new Fighter({ identity: { id: 'f1', name: 'F1', gender: 'M', weightClass: 'Poids Welter' } });
  playerState.addFighter(fighter);

  const [gala] = getUpcomingGalas(worldState, { count: 1 });
  const result = registerForGala(playerState, worldState, { galaId: gala.id, fighterId: 'f1', rng: () => 0.99 });

  assert.equal(result.success, true);
  assert.equal(playerState.scheduledFight.fighterId, 'f1');
  assert.equal(playerState.scheduledFight.galaId, gala.id);
  assert.equal(playerState.scheduledFight.orgId, gala.orgId);
  assert.equal(playerState.scheduledFight.fightDay, gala.day);
  assert.ok(playerState.scheduledFight.opponentSnapshot);
  assert.equal(playerState.scheduledFight.opponentSnapshot.identity.gender, 'M');
  assert.equal(playerState.scheduledFight.opponentSnapshot.identity.weightClass, 'Poids Welter');
});

// ---- V3.9: League roster contracts (getLeagueEligibility/signLeagueContract) ------

test('getLeagueEligibility: a non-requiresContract org (Local Fighting) is always eligible with no requirements', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 0 });
  const fighter = makeEliteFighter();
  playerState.addFighter(fighter);

  const eligibility = getLeagueEligibility(playerState, fighter, 'LOCAL_FIGHTING');
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.requiresContract, false);
});

test('getLeagueEligibility: REQUIREMENTS_NOT_MET when the gym Reputation or fighter Overall falls short of the org bar', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 0 });
  const weakFighter = new Fighter({ identity: { id: 'f1', name: 'Weak', gender: 'M', weightClass: 'Poids Welter' } });
  playerState.addFighter(weakFighter);

  const eligibility = getLeagueEligibility(playerState, weakFighter, 'ECL');
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'REQUIREMENTS_NOT_MET');
  assert.deepEqual(eligibility.requirements, BALANCE.GALA_CIRCUIT.ORGANIZATIONS.ECL.eligibility);
});

test('getLeagueEligibility: eligible once both Reputation and Overall clear the bar, ALREADY_SIGNED once signed, UNDER_CONTRACT_ELSEWHERE while bound to a different org', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 80 });
  const fighter = makeEliteFighter();
  playerState.addFighter(fighter);

  const eligible = getLeagueEligibility(playerState, fighter, 'ECL');
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.requiresContract, true);
  assert.equal(eligible.alreadySigned, undefined);

  const signResult = signLeagueContract(playerState, 'f1', 'ECL');
  assert.equal(signResult.success, true);

  const alreadySigned = getLeagueEligibility(playerState, fighter, 'ECL');
  assert.equal(alreadySigned.eligible, true);
  assert.equal(alreadySigned.alreadySigned, true);

  const boundElsewhere = getLeagueEligibility(playerState, fighter, 'APEX');
  assert.equal(boundElsewhere.eligible, false);
  assert.equal(boundElsewhere.reason, 'UNDER_CONTRACT_ELSEWHERE');
  assert.equal(boundElsewhere.boundOrgId, 'ECL');
});

test('signLeagueContract pays the signing bonus and sets fightsRemaining from the org contract, and fails cleanly for every rejection path', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 80 });
  const fighter = makeEliteFighter();
  playerState.addFighter(fighter);
  const eclCfg = BALANCE.GALA_CIRCUIT.ORGANIZATIONS.ECL.contract;

  assert.equal(signLeagueContract(playerState, 'missing', 'ECL').reason, 'FIGHTER_NOT_FOUND');
  assert.equal(signLeagueContract(playerState, 'f1', 'LOCAL_FIGHTING').reason, 'NO_CONTRACT_REQUIRED');

  const moneyBefore = playerState.money;
  const result = signLeagueContract(playerState, 'f1', 'ECL');
  assert.equal(result.success, true);
  assert.equal(result.fightsRequired, eclCfg.fightsRequired);
  assert.equal(result.signingBonus, eclCfg.signingBonus);
  assert.equal(playerState.money, moneyBefore + eclCfg.signingBonus);
  assert.equal(fighter.contracts.exclusivity.orgId, 'ECL');
  assert.equal(fighter.contracts.exclusivity.fightsRemaining, eclCfg.fightsRequired);

  assert.equal(signLeagueContract(playerState, 'f1', 'ECL').reason, 'ALREADY_SIGNED');
  assert.equal(signLeagueContract(playerState, 'f1', 'APEX').reason, 'UNDER_CONTRACT_ELSEWHERE');
});

test('registerForGala rejects a requiresContract org gala (LEAGUE_CONTRACT_REQUIRED) until the fighter signs, then succeeds', () => {
  const worldState = new WorldState();
  const playerState = new PlayerState({ money: 25000, reputation: 80 });
  const fighter = makeEliteFighter();
  playerState.addFighter(fighter);

  const galas = getUpcomingGalas(worldState);
  const eclGala = galas.find((g) => g.orgId === 'ECL');

  const beforeSigning = registerForGala(playerState, worldState, { galaId: eclGala.id, fighterId: 'f1', rng: () => 0.99 });
  assert.equal(beforeSigning.success, false);
  assert.equal(beforeSigning.reason, 'LEAGUE_CONTRACT_REQUIRED');
  assert.equal(beforeSigning.orgId, 'ECL');

  const signResult = signLeagueContract(playerState, 'f1', 'ECL');
  assert.equal(signResult.success, true);

  const afterSigning = registerForGala(playerState, worldState, { galaId: eclGala.id, fighterId: 'f1', rng: () => 0.99 });
  assert.equal(afterSigning.success, true);
});

test('registerForGala never requires a contract for LOCAL_FIGHTING/UNDERGROUND_CIRCUIT galas', () => {
  const worldState = new WorldState();
  const playerState = new PlayerState({ money: 25000, reputation: 0 });
  const fighter = new Fighter({ identity: { id: 'f1', name: 'F1', gender: 'M', weightClass: 'Poids Welter' } });
  playerState.addFighter(fighter);

  const galas = getUpcomingGalas(worldState);
  const localGala = galas.find((g) => g.orgId === 'LOCAL_FIGHTING');
  const result = registerForGala(playerState, worldState, { galaId: localGala.id, fighterId: 'f1', rng: () => 0.99 });
  assert.equal(result.success, true);
});

test('registerForGala rejects registration to a gala from another organization while under a signed roster contract', () => {
  const worldState = new WorldState();
  const playerState = new PlayerState({ money: 25000, reputation: 80 });
  const fighter = makeEliteFighter();
  playerState.addFighter(fighter);
  signLeagueContract(playerState, 'f1', 'ECL');

  const galas = getUpcomingGalas(worldState);
  const apexGala = galas.find((g) => g.orgId === 'APEX');

  const result = registerForGala(playerState, worldState, { galaId: apexGala.id, fighterId: 'f1', rng: () => 0.99 });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'EXCLUSIVITY_CONTRACT_VIOLATION');
  assert.equal(result.boundOrgId, 'ECL');
});

test('releaseGalaExclusivity fails cleanly for a missing fighter, no active contract, or insufficient funds, then succeeds and charges the signed org\'s own release clause', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 80 });
  const fighter = makeEliteFighter();
  playerState.addFighter(fighter);
  const eclCfg = BALANCE.GALA_CIRCUIT.ORGANIZATIONS.ECL.contract;

  assert.equal(releaseGalaExclusivity(playerState, 'missing').reason, 'FIGHTER_NOT_FOUND');
  assert.equal(releaseGalaExclusivity(playerState, 'f1').reason, 'NO_ACTIVE_CONTRACT');

  signLeagueContract(playerState, 'f1', 'ECL');
  assert.ok(fighter.isUnderExclusivityContract());

  playerState.money = eclCfg.releaseClauseCost - 1;
  assert.equal(releaseGalaExclusivity(playerState, 'f1').reason, 'INSUFFICIENT_FUNDS');

  playerState.money = eclCfg.releaseClauseCost + 1000;
  const moneyBefore = playerState.money;
  const result = releaseGalaExclusivity(playerState, 'f1');
  assert.equal(result.success, true);
  assert.equal(result.cost, eclCfg.releaseClauseCost);
  assert.equal(playerState.money, moneyBefore - eclCfg.releaseClauseCost);
  assert.equal(fighter.isUnderExclusivityContract(), false);
});
