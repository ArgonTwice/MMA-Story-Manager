/**
 * engine/ScoutingEngine.test.js
 * Run with: node --test engine/ScoutingEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import { generateScoutingReport } from './ScoutingEngine.js';

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
