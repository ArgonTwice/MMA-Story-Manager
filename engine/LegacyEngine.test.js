/**
 * engine/LegacyEngine.test.js
 * Run with: node --test engine/LegacyEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { processRetirement, LEGACY_ENGINE_OUTCOMES } from './LegacyEngine.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'Retiree', age: 45, ...overrides.identity },
    attributes: {
      skills: { boxe: 40, jambes: 40, sol: 40, soumission: 40, cardio: 40, intelligence: 40 },
      ...overrides.attributes,
    },
    career: { wins: 20, losses: 20, draws: 0, ...overrides.career },
    psychology: { personality: { archetype: 'Cameleon' }, ...overrides.psychology },
  });
}

/** Always rolls 0 — with weightedPickOutcome's cumulative-weight scan, this always lands on the FIRST outcome with a positive weight in iteration order (COACH_IN_GYM, PHYSIO, RIVAL_GYM_OWNER, RECRUITER). */
function zeroRng() {
  return 0;
}

function makeSeededRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

test('a Hall-of-Fame-eligible retiree is inducted before the reconversion pick runs', () => {
  const fighter = makeFighter({ career: { wins: 130, losses: 5, draws: 0 } });
  const playerState = new PlayerState();
  const worldState = new WorldState();

  const result = processRetirement(fighter, { playerState, worldState, rng: zeroRng });

  assert.equal(result.isHallOfFamer, true);
  assert.equal(fighter.career.hallOfFameStatus, 'inducted');
  assert.equal(worldState.getHallOfFame().length, 1);
});

test('a mediocre retiree is never inducted', () => {
  const fighter = makeFighter({ career: { wins: 20, losses: 20, draws: 0 } });
  const playerState = new PlayerState();
  const worldState = new WorldState();

  const result = processRetirement(fighter, { playerState, worldState, rng: zeroRng });

  assert.equal(result.isHallOfFamer, false);
  assert.equal(fighter.career.hallOfFameStatus, 'none');
  assert.equal(worldState.getHallOfFame().length, 0);
});

test('a COACH_IN_GYM outcome (forced via rng=0) actually hires the retiree onto playerState.coaches, skill mapped from getOverallRating()', () => {
  const fighter = makeFighter({
    attributes: { skills: { boxe: 90, jambes: 40, sol: 40, soumission: 40, cardio: 40, intelligence: 40 } },
  });
  const playerState = new PlayerState();
  const worldState = new WorldState();

  const result = processRetirement(fighter, { playerState, worldState, rng: zeroRng });

  assert.equal(result.outcome, LEGACY_ENGINE_OUTCOMES.COACH_IN_GYM);
  assert.equal(result.applied, true);
  assert.equal(playerState.coaches.length, 1);
  assert.equal(playerState.coaches[0].isLegacyCoach, true);
  assert.equal(playerState.coaches[0].formerFighterId, fighter.identity.id);
  assert.equal(playerState.coaches[0].specialty, 'boxe', 'boxe is this fighter\'s strongest skill');
  assert.equal(playerState.coaches[0].skill, Math.round(fighter.getOverallRating()));
});

test('MAX_LEGACY_COACHES caps hiring: once the cap is reached, further COACH_IN_GYM outcomes are still recorded but not applied', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const cap = BALANCE.LEGACY_ENGINE.MAX_LEGACY_COACHES;

  const results = [];
  for (let i = 0; i < cap + 2; i += 1) {
    const fighter = makeFighter({ identity: { name: `Coach Candidate ${i}` } });
    results.push(processRetirement(fighter, { playerState, worldState, rng: zeroRng }));
  }

  assert.ok(results.every((r) => r.outcome === LEGACY_ENGINE_OUTCOMES.COACH_IN_GYM));
  assert.equal(playerState.coaches.length, cap, 'hiring should stop exactly at the configured cap');
  const appliedCount = results.filter((r) => r.applied).length;
  assert.equal(appliedCount, cap);
});

test('a RIVAL_GYM_OWNER outcome boosts an existing rival gym\'s reputation and tags its new owner', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const gym = worldState.addRivalGym({ name: 'Rival Gym', reputation: 50 });

  // A fighter's own BALANCE.LEGACY_ENGINE.ARCHETYPE_RECONVERSION_LEAN can
  // shift the weighted pick's cumulative shares — use Predateur (leans
  // RIVAL_GYM_OWNER) with a roll landing past COACH_IN_GYM+PHYSIO's
  // combined weight share, safely inside RIVAL_GYM_OWNER's own slice.
  const predateurFighter = makeFighter({ psychology: { personality: { archetype: 'Predateur' } } });
  const weights = BALANCE.LEGACY_ENGINE.BASE_RECONVERSION_WEIGHTS;
  const lean = BALANCE.LEGACY_ENGINE.ARCHETYPE_RECONVERSION_LEAN.Predateur;
  const coachWeight = weights.COACH_IN_GYM * (lean.COACH_IN_GYM ?? 1);
  const physioWeight = weights.PHYSIO * (lean.PHYSIO ?? 1);
  const rivalWeight = weights.RIVAL_GYM_OWNER * (lean.RIVAL_GYM_OWNER ?? 1);
  const recruiterWeight = weights.RECRUITER * (lean.RECRUITER ?? 1);
  const total = coachWeight + physioWeight + rivalWeight + recruiterWeight;
  // Land just past COACH_IN_GYM + PHYSIO's combined share, safely inside RIVAL_GYM_OWNER's slice.
  const rollFraction = (coachWeight + physioWeight + rivalWeight / 2) / total;

  const result = processRetirement(predateurFighter, { playerState, worldState, rng: () => rollFraction });

  assert.equal(result.outcome, LEGACY_ENGINE_OUTCOMES.RIVAL_GYM_OWNER);
  assert.equal(result.applied, true);
  const updatedGym = worldState.rivalGyms.find((g) => g.id === gym.id);
  assert.equal(updatedGym.reputation, 50 + BALANCE.LEGACY_ENGINE.RIVAL_GYM_OWNER_REPUTATION_BOOST);
  assert.equal(updatedGym.formerChampionOwner, predateurFighter.identity.name);
});

test('a RIVAL_GYM_OWNER outcome with no rival gyms at all is still recorded, just not applied', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState(); // no addRivalGym call
  const fighter = makeFighter({ psychology: { personality: { archetype: 'Predateur' } } });

  const weights = BALANCE.LEGACY_ENGINE.BASE_RECONVERSION_WEIGHTS;
  const lean = BALANCE.LEGACY_ENGINE.ARCHETYPE_RECONVERSION_LEAN.Predateur;
  const coachWeight = weights.COACH_IN_GYM * (lean.COACH_IN_GYM ?? 1);
  const physioWeight = weights.PHYSIO * (lean.PHYSIO ?? 1);
  const rivalWeight = weights.RIVAL_GYM_OWNER * (lean.RIVAL_GYM_OWNER ?? 1);
  const recruiterWeight = weights.RECRUITER * (lean.RECRUITER ?? 1);
  const total = coachWeight + physioWeight + rivalWeight + recruiterWeight;
  const rollFraction = (coachWeight + physioWeight + rivalWeight / 2) / total;

  const result = processRetirement(fighter, { playerState, worldState, rng: () => rollFraction });

  assert.equal(result.outcome, LEGACY_ENGINE_OUTCOMES.RIVAL_GYM_OWNER);
  assert.equal(result.applied, false);
});

test('a Genie-archetype retiree picks COACH_IN_GYM far more often than a Cameleon baseline, over many independent retirements', () => {
  const tally = (archetype, seed) => {
    const rng = makeSeededRng(seed);
    let coachPicks = 0;
    const trials = 400;
    for (let i = 0; i < trials; i += 1) {
      const playerState = new PlayerState(); // fresh, uncapped roster every trial
      const worldState = new WorldState();
      const fighter = makeFighter({ psychology: { personality: { archetype } } });
      const result = processRetirement(fighter, { playerState, worldState, rng });
      if (result.outcome === LEGACY_ENGINE_OUTCOMES.COACH_IN_GYM) coachPicks += 1;
    }
    return coachPicks / trials;
  };

  const genieShare = tally('Genie', 7);
  const cameleonShare = tally('Cameleon', 7);

  assert.ok(genieShare > cameleonShare, `expected Genie's COACH_IN_GYM share (${genieShare}) to exceed Cameleon's (${cameleonShare})`);
});

test('PHYSIO and RECRUITER outcomes never touch playerState.coaches or worldState.rivalGyms', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  worldState.addRivalGym({ name: 'Untouched Gym', reputation: 50 });

  // Land squarely in PHYSIO's slice for a Veteran (leans PHYSIO 2.5x).
  const weights = BALANCE.LEGACY_ENGINE.BASE_RECONVERSION_WEIGHTS;
  const lean = BALANCE.LEGACY_ENGINE.ARCHETYPE_RECONVERSION_LEAN.Veteran;
  const coachWeight = weights.COACH_IN_GYM * (lean.COACH_IN_GYM ?? 1);
  const physioWeight = weights.PHYSIO * (lean.PHYSIO ?? 1);
  const total = coachWeight + physioWeight + weights.RIVAL_GYM_OWNER * (lean.RIVAL_GYM_OWNER ?? 1) + weights.RECRUITER * (lean.RECRUITER ?? 1);
  const rollFraction = (coachWeight + physioWeight / 2) / total;

  const fighter = makeFighter({ psychology: { personality: { archetype: 'Veteran' } } });
  const result = processRetirement(fighter, { playerState, worldState, rng: () => rollFraction });

  assert.equal(result.outcome, LEGACY_ENGINE_OUTCOMES.PHYSIO);
  assert.equal(result.applied, false);
  assert.equal(playerState.coaches.length, 0);
  assert.equal(worldState.rivalGyms[0].reputation, 50);
});
