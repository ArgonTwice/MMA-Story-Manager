/**
 * engine/ScoutingEngine.test.js
 * Run with: node --test engine/ScoutingEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import {
  generateScoutingReport,
  getRevealProgress,
  estimateFighterSkills,
  getRevealedTraits,
  advanceWeeksAtGym,
} from './ScoutingEngine.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'Scouted Fighter', age: 27, style: 'Freestyle', weightClass: 'Lightweight', ...overrides.identity },
    attributes: overrides.attributes,
    psychology: overrides.psychology,
    career: overrides.career,
  });
}

test('generateScoutingReport never exposes a raw number — every line is qualitative text', () => {
  const fighter = makeFighter({ attributes: { skills: { boxe: 90, jambes: 10, sol: 50, soumission: 50, cardio: 50, intelligence: 50 } } });
  const report = generateScoutingReport(fighter);

  assert.ok(report.length > 0);
  for (const line of report) {
    assert.equal(typeof line, 'string');
    assert.ok(!/\d/.test(line), `expected no digits in a scouting line (no exact stats), got: "${line}"`);
  }
});

test('a fighter with one clearly dominant skill and one clearly weak skill gets both called out', () => {
  const fighter = makeFighter({ attributes: { skills: { boxe: 95, jambes: 10, sol: 50, soumission: 50, cardio: 50, intelligence: 50 } } });
  const report = generateScoutingReport(fighter);

  assert.ok(report.some((line) => line.includes('Fort en Boxe')));
  assert.ok(report.some((line) => line.includes('Faible en Jeu de jambes')));
});

test('an aggressive trait produces a matching scouting line', () => {
  const fighter = makeFighter({ psychology: { personality: { archetype: 'Guerrier', traits: ['Agressif'] } } });
  const report = generateScoutingReport(fighter);
  assert.ok(report.some((line) => line.toLowerCase().includes('agressif')));
});

test('a perfectly average fighter with no notable trait still returns at least one line', () => {
  const fighter = makeFighter({ attributes: { skills: { boxe: 50, jambes: 50, sol: 50, soumission: 50, cardio: 50, intelligence: 50 } } });
  const report = generateScoutingReport(fighter);
  assert.ok(report.length >= 1);
});

test('generateScoutingReport is pure and deterministic — the same fighter always yields the same report', () => {
  const fighter = makeFighter({ attributes: { skills: { boxe: 80, jambes: 20, sol: 60, soumission: 40, cardio: 70, intelligence: 30 } } });
  const reportA = generateScoutingReport(fighter);
  const reportB = generateScoutingReport(fighter);
  assert.deepEqual(reportA, reportB);
});

test('generateScoutingReport returns at most 5 lines', () => {
  const fighter = makeFighter({
    attributes: { skills: { boxe: 95, jambes: 5, sol: 90, soumission: 90, cardio: 90, intelligence: 5 } },
    psychology: { personality: { archetype: 'Predateur', traits: ['Agressif', 'Intense'] } },
    career: { wins: 10, finishes: 8, decisionWins: 2 },
  });
  const report = generateScoutingReport(fighter);
  assert.ok(report.length <= 5);
});

// ---- Fog of War: prospect stat estimation --------------------------------------

test('estimateFighterSkills with no coach hired (NO_COACH_COMPETENCE) and 0 weeks at gym uses the full formula error window', () => {
  const fighter = makeFighter({ attributes: { skills: { boxe: 50, jambes: 50, sol: 50, soumission: 50, cardio: 50, intelligence: 50 } } });
  const { estimated, errorWindow, fullyRevealed } = estimateFighterSkills(fighter, { weeksAtGym: 0 });

  const expectedWindow = (100 - BALANCE.SCOUTING_FOG.NO_COACH_COMPETENCE) * BALANCE.SCOUTING_FOG.ERROR_PER_MISSING_COMPETENCE_POINT;
  assert.ok(Math.abs(errorWindow - expectedWindow) < 1e-9);
  assert.equal(fullyRevealed, false);

  for (const [key, value] of Object.entries(estimated)) {
    assert.ok(Math.abs(value - fighter.attributes.skills[key]) <= expectedWindow + 1, `estimate for ${key} strayed further than the error window allows`);
  }
});

test('a higher headCoachSkill (CompetenceCoach) produces a tighter error window than no coach at all', () => {
  const fighter = makeFighter();
  const noCoach = estimateFighterSkills(fighter, { weeksAtGym: 0 });
  const goodCoach = estimateFighterSkills(fighter, { headCoachSkill: 90, weeksAtGym: 0 });
  assert.ok(goodCoach.errorWindow < noCoach.errorWindow);
});

test('the error window shrinks toward 0 (full reveal) as weeksAtGym grows, per WEEKLY_ERROR_REDUCTION_FRACTION', () => {
  const fighter = makeFighter();
  const week0 = estimateFighterSkills(fighter, { weeksAtGym: 0 });
  const week10 = estimateFighterSkills(fighter, { weeksAtGym: 10 });
  const week100 = estimateFighterSkills(fighter, { weeksAtGym: 100 });

  assert.ok(week10.errorWindow < week0.errorWindow);
  assert.ok(week100.errorWindow < week10.errorWindow);
  assert.equal(week100.fullyRevealed, true);
  assert.deepEqual(week100.estimated, fighter.attributes.skills, 'fully revealed estimate should exactly match real skills');
});

test('estimateFighterSkills is pure and deterministic — same fighter/coach/weeks always yields the same estimate', () => {
  const fighter = makeFighter();
  const first = estimateFighterSkills(fighter, { headCoachSkill: 60, weeksAtGym: 3 });
  const second = estimateFighterSkills(fighter, { headCoachSkill: 60, weeksAtGym: 3 });
  assert.deepEqual(first, second);
});

test('getRevealedTraits reveals traits progressively and matches all real traits once fully revealed', () => {
  const fighter = makeFighter({ psychology: { personality: { archetype: 'Guerrier', traits: ['Agressif', 'Discipline'] } } });

  assert.deepEqual(getRevealedTraits(fighter, 0), []);
  const fullyRevealed = getRevealedTraits(fighter, 100);
  assert.deepEqual(fullyRevealed.sort(), [...fighter.psychology.personality.traits].sort());
});

test('getRevealProgress is 0 at 0 weeks and clamped at 1 far beyond full reveal', () => {
  assert.equal(getRevealProgress(0), 0);
  assert.equal(getRevealProgress(100000), 1);
});

test('advanceWeeksAtGym increments every roster fighter\'s weeksAtGym by exactly 1', () => {
  const playerState = new PlayerState({ money: 25000 });
  const fighterA = makeFighter();
  const fighterB = makeFighter();
  playerState.addFighter(fighterA);
  playerState.addFighter(fighterB);

  advanceWeeksAtGym(playerState);
  assert.equal(fighterA.weeksAtGym, 1);
  assert.equal(fighterB.weeksAtGym, 1);

  advanceWeeksAtGym(playerState);
  assert.equal(fighterA.weeksAtGym, 2);
});
