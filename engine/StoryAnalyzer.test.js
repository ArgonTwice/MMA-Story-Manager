/**
 * engine/StoryAnalyzer.test.js
 * Run with: node --test engine/StoryAnalyzer.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import { PlayerState } from '../state/PlayerState.js';
import { WorldState } from '../state/WorldState.js';
import { analyzeSeason, hasAnyTrophy, TROPHY_CATEGORIES } from './StoryAnalyzer.js';

function makeFighter(name, overrides = {}) {
  return new Fighter({
    identity: { name, age: 27, ...overrides.identity },
    attributes: { skills: { boxe: 50, jambes: 50, sol: 50, soumission: 50, cardio: 50, intelligence: 50 }, ...overrides.attributes },
  });
}

/** Shapes a mock fight result matching CombatEngine's real result object fields StoryAnalyzer reads. */
function makeFightResult({ fighterA, fighterB, winner, method = 'UNANIMOUS_DECISION', preFightRatings = null }) {
  return {
    fighters: { A: fighterA.identity.id, B: fighterB.identity.id },
    names: { A: fighterA.identity.name, B: fighterB.identity.name },
    winner,
    method,
    preFightRatings,
  };
}

test('analyzeSeason returns every fight/coach-dependent trophy as null on a fresh gym with no fights, no coaches, no snapshot — but Gym of the Year always resolves (the player\'s own gym is always a valid candidate)', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  playerState.addFighter(makeFighter('Solo Fighter'));

  const analysis = analyzeSeason({ playerState, worldState, year: 1 });

  assert.equal(analysis.year, 1);
  assert.equal(analysis.rivalryOfTheYear, null);
  assert.equal(analysis.upsetOfTheYear, null);
  assert.equal(analysis.finisherKing, null);
  assert.equal(analysis.coachOfTheYear, null);
  assert.notEqual(analysis.gymOfTheYear, null);
  assert.equal(analysis.gymOfTheYear.isPlayerGym, true);
  assert.equal(hasAnyTrophy(analysis), true, 'Gym of the Year alone is enough to make hasAnyTrophy true');
});

test('Rivalry of the Year picks the fought pair with the highest current relationship tension, and is null with no tracked relationship', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const a = makeFighter('Rival A');
  const b = makeFighter('Rival B');
  const c = makeFighter('Rival C');
  const d = makeFighter('Rival D');
  [a, b, c, d].forEach((f) => playerState.addFighter(f));

  worldState.upsertRelationship(a.identity.id, b.identity.id, { tension: 40 });
  worldState.upsertRelationship(c.identity.id, d.identity.id, { tension: 10 });

  const fightResultsThisYear = [
    makeFightResult({ fighterA: a, fighterB: b, winner: 'A' }),
    makeFightResult({ fighterA: c, fighterB: d, winner: 'B' }),
  ];

  const analysis = analyzeSeason({ playerState, worldState, year: 1, fightResultsThisYear });
  assert.equal(analysis.rivalryOfTheYear.category, TROPHY_CATEGORIES.RIVALRY_OF_THE_YEAR);
  assert.equal(analysis.rivalryOfTheYear.fighterAId, a.identity.id);
  assert.equal(analysis.rivalryOfTheYear.fighterBId, b.identity.id);
  assert.equal(analysis.rivalryOfTheYear.tension, 40);
  assert.equal(analysis.rivalryOfTheYear.winnerName, 'Rival A');

  // No relationship tracked at all -> null.
  const noRelationshipAnalysis = analyzeSeason({
    playerState,
    worldState: new WorldState(),
    year: 1,
    fightResultsThisYear: [makeFightResult({ fighterA: a, fighterB: b, winner: 'A' })],
  });
  assert.equal(noRelationshipAnalysis.rivalryOfTheYear, null);
});

test('Upset of the Year picks the win with the largest preFightRatings gap in the underdog\'s favor, ignores draws, and is null without any preFightRatings', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const strong = makeFighter('Favorite');
  const weak = makeFighter('Underdog');
  const evenA = makeFighter('Even A');
  const evenB = makeFighter('Even B');
  [strong, weak, evenA, evenB].forEach((f) => playerState.addFighter(f));

  const fightResultsThisYear = [
    // Weak upsets Favorite: gap = 80 - 20 = 60 in the underdog's favor.
    makeFightResult({ fighterA: strong, fighterB: weak, winner: 'B', preFightRatings: { A: 80, B: 20 } }),
    // Favorite wins as expected: no upset (gap <= 0).
    makeFightResult({ fighterA: strong, fighterB: weak, winner: 'A', preFightRatings: { A: 80, B: 20 } }),
    // A draw never qualifies even with a big rating gap.
    makeFightResult({ fighterA: strong, fighterB: weak, winner: null, method: 'DRAW', preFightRatings: { A: 80, B: 20 } }),
    // Smaller upset, should lose to the 60-point gap above.
    makeFightResult({ fighterA: evenA, fighterB: evenB, winner: 'B', preFightRatings: { A: 55, B: 45 } }),
  ];

  const analysis = analyzeSeason({ playerState, worldState, year: 1, fightResultsThisYear });
  assert.equal(analysis.upsetOfTheYear.category, TROPHY_CATEGORIES.UPSET_OF_THE_YEAR);
  assert.equal(analysis.upsetOfTheYear.fighterId, weak.identity.id);
  assert.equal(analysis.upsetOfTheYear.opponentId, strong.identity.id);
  assert.equal(analysis.upsetOfTheYear.ratingGap, 60);

  const noRatingsAnalysis = analyzeSeason({
    playerState,
    worldState,
    year: 1,
    fightResultsThisYear: [makeFightResult({ fighterA: strong, fighterB: weak, winner: 'B' })],
  });
  assert.equal(noRatingsAnalysis.upsetOfTheYear, null);
});

test('Finisher King sums koWins+subWins from career.seasonHistory for the given year, and ignores other years / fighters off the roster', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();

  const finisher = makeFighter('Finisher');
  finisher.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'KO', seasonContext: { year: 1, orgId: 'WFC' } });
  finisher.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'SUBMISSION', seasonContext: { year: 1, orgId: 'WFC' } });
  // A finish from a DIFFERENT year should not count toward this year's trophy.
  finisher.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'KO', seasonContext: { year: 2, orgId: 'WFC' } });

  const decisioner = makeFighter('Decisioner');
  decisioner.recordFightResult({ outcome: 'win', byFinish: false, seasonContext: { year: 1, orgId: 'WFC' } });

  const offRoster = makeFighter('Released Finisher');
  offRoster.recordFightResult({ outcome: 'win', byFinish: true, finishMethod: 'KO', seasonContext: { year: 1, orgId: 'WFC' } });
  // Deliberately NOT added to playerState.roster — should not be considered.

  playerState.addFighter(finisher);
  playerState.addFighter(decisioner);

  const analysis = analyzeSeason({ playerState, worldState, year: 1 });
  assert.equal(analysis.finisherKing.category, TROPHY_CATEGORIES.FINISHER_KING);
  assert.equal(analysis.finisherKing.fighterId, finisher.identity.id);
  assert.equal(analysis.finisherKing.finishes, 2);
  assert.equal(analysis.finisherKing.koWins, 1);
  assert.equal(analysis.finisherKing.subWins, 1);
});

test('Coach of the Year requires both a coach AND a yearStartRosterRatings snapshot, credits the highest-skill coach, and sums real rating deltas', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const fighter = makeFighter('Improving Fighter', { attributes: { skills: { boxe: 70, jambes: 70, sol: 70, soumission: 70, cardio: 70, intelligence: 70 } } });
  playerState.addFighter(fighter);

  // No coach yet -> null even with a snapshot.
  let analysis = analyzeSeason({
    playerState,
    worldState,
    year: 1,
    yearStartRosterRatings: { [fighter.identity.id]: fighter.getOverallRating() - 5 },
  });
  assert.equal(analysis.coachOfTheYear, null);

  const weakCoach = playerState.addCoach({ name: 'Assistant', skill: 30 });
  const strongCoach = playerState.addCoach({ name: 'Head Coach', skill: 90 });

  // Coach present but no snapshot -> null.
  analysis = analyzeSeason({ playerState, worldState, year: 1 });
  assert.equal(analysis.coachOfTheYear, null);

  const startRating = fighter.getOverallRating() - 8;
  analysis = analyzeSeason({ playerState, worldState, year: 1, yearStartRosterRatings: { [fighter.identity.id]: startRating } });
  assert.equal(analysis.coachOfTheYear.category, TROPHY_CATEGORIES.COACH_OF_THE_YEAR);
  assert.equal(analysis.coachOfTheYear.coachId, strongCoach.id, 'the higher-skill coach should be credited');
  assert.notEqual(analysis.coachOfTheYear.coachId, weakCoach.id);
  assert.equal(analysis.coachOfTheYear.teamProgression, Math.round((fighter.getOverallRating() - startRating) * 10) / 10);
  assert.equal(analysis.coachOfTheYear.fightersTracked, 1);
});

test('Gym of the Year compares the player\'s reputation against every rival gym\'s, and a rival CAN win it', () => {
  const playerState = new PlayerState({ reputation: 40 });
  const worldState = new WorldState();
  worldState.addRivalGym({ name: 'Weaker Rival', reputation: 20 });

  let analysis = analyzeSeason({ playerState, worldState, year: 1 });
  assert.equal(analysis.gymOfTheYear.isPlayerGym, true);
  assert.equal(analysis.gymOfTheYear.reputation, 40);

  worldState.addRivalGym({ name: 'Dominant Rival', reputation: 95 });
  analysis = analyzeSeason({ playerState, worldState, year: 1 });
  assert.equal(analysis.gymOfTheYear.isPlayerGym, false);
  assert.equal(analysis.gymOfTheYear.gymName, 'Dominant Rival');
  assert.equal(analysis.gymOfTheYear.reputation, 95);
});

test('hasAnyTrophy is false only when every one of the 5 trophies is null, and true as soon as a single one is non-null', () => {
  const allNull = { rivalryOfTheYear: null, upsetOfTheYear: null, finisherKing: null, coachOfTheYear: null, gymOfTheYear: null };
  assert.equal(hasAnyTrophy(allNull), false);

  for (const key of Object.keys(allNull)) {
    const oneAwarded = { ...allNull, [key]: { category: TROPHY_CATEGORIES.FINISHER_KING } };
    assert.equal(hasAnyTrophy(oneAwarded), true, `expected hasAnyTrophy to be true when only "${key}" is non-null`);
  }
});
