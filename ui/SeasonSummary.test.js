/**
 * ui/SeasonSummary.test.js
 * Run with: node --test ui/SeasonSummary.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { LEGACY_ENGINE_OUTCOMES } from '../engine/LegacyEngine.js';
import { SeasonSummary } from './SeasonSummary.js';

function makeWeekSummary(overrides = {}) {
  return {
    economyReport: { netChange: 100 },
    retirements: [],
    ...overrides,
  };
}

test('build() with no window data reports zero fights/retirements and a null net money change', () => {
  const playerState = new PlayerState({ money: 5000 });
  const worldState = new WorldState();
  const summary = new SeasonSummary({ playerState, worldState }).build();

  assert.equal(summary.weeksSimulated, 0);
  assert.equal(summary.fights.total, 0);
  assert.equal(summary.retirements.length, 0);
  assert.equal(summary.money.netChange, null);
  assert.equal(summary.money.end, 5000);
});

test('build() computes the TRUE net money change (end - start), not merely the sum of each week\'s recurring economy delta', () => {
  const playerState = new PlayerState({ money: 5000 });
  const worldState = new WorldState();
  // Two weeks each reporting only +100 via economyReport.netChange, but the
  // gym's actual money moved by +2000 total (e.g. a fight purse the economy
  // engine never sees) — the summary must reflect the real delta.
  playerState.money = 7000;
  const weeklyResults = [
    { weekSummary: makeWeekSummary({ economyReport: { netChange: 100 } }), dramaReport: null },
    { weekSummary: makeWeekSummary({ economyReport: { netChange: 100 } }), dramaReport: { choiceId: 'x' } },
  ];

  const summary = new SeasonSummary({ playerState, worldState }).build({ weeklyResults, startMoney: 5000 });

  assert.equal(summary.money.netChange, 2000);
  assert.equal(summary.dramaEventsResolved, 1);
  assert.equal(summary.weeksSimulated, 2);
});

test('build() aggregates fight results by method and counts retirements/Hall of Fame inductions from weekSummary.retirements', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const weeklyResults = [
    {
      weekSummary: makeWeekSummary({
        retirements: [
          {
            name: 'Legend',
            age: 45,
            wins: 130,
            losses: 10,
            draws: 0,
            reconversion: { isHallOfFamer: true, outcome: LEGACY_ENGINE_OUTCOMES.COACH_IN_GYM, nickname: 'The Hammer' },
          },
          {
            name: 'Journeyman',
            age: 45,
            wins: 20,
            losses: 30,
            draws: 1,
            reconversion: { isHallOfFamer: false, outcome: LEGACY_ENGINE_OUTCOMES.RECRUITER, nickname: null },
          },
        ],
      }),
      dramaReport: null,
    },
  ];
  const fightResults = [{ method: 'KO' }, { method: 'KO' }, { method: 'UNANIMOUS_DECISION' }];

  const summary = new SeasonSummary({ playerState, worldState }).build({ weeklyResults, fightResults });

  assert.deepEqual(summary.fights.byMethod, { KO: 2, UNANIMOUS_DECISION: 1 });
  assert.equal(summary.fights.total, 3);
  assert.equal(summary.retirements.length, 2);
  assert.equal(summary.hallOfFameInductionsThisWindow, 1);
  assert.equal(summary.retirements[0].record, '130-10-0');
  assert.equal(summary.retirements[0].isHallOfFamer, true);
});

test('build() snapshots the current roster (name/nickname/record/legacyStage/readiness) and world records', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const fighter = new Fighter({ identity: { name: 'Active Fighter' } });
  playerState.addFighter(fighter);
  worldState.trySetRecord('fastestKO', 10, { betterIf: 'LOWER', detail: 'fast' });

  const summary = new SeasonSummary({ playerState, worldState }).build();

  assert.equal(summary.rosterSnapshot.length, 1);
  assert.equal(summary.rosterSnapshot[0].name, 'Active Fighter');
  assert.equal(summary.worldRecords.fastestKO.value, 10);
  assert.equal(summary.hallOfFameTotal, 0);
});

test('toText renders a non-empty, readable recap including retirements and the roster', () => {
  const playerState = new PlayerState({ money: 9000 });
  const worldState = new WorldState();
  playerState.addFighter(new Fighter({ identity: { name: 'Snapshot Fighter' } }));
  const seasonSummary = new SeasonSummary({ playerState, worldState });

  const weeklyResults = [
    {
      weekSummary: makeWeekSummary({
        retirements: [
          {
            name: 'Retiree',
            age: 45,
            wins: 50,
            losses: 10,
            draws: 0,
            reconversion: { isHallOfFamer: false, outcome: LEGACY_ENGINE_OUTCOMES.PHYSIO, nickname: null },
          },
        ],
      }),
      dramaReport: null,
    },
  ];

  const summary = seasonSummary.build({ weeklyResults, startMoney: 5000 });
  const text = seasonSummary.toText(summary);

  assert.ok(text.includes('BILAN DE SAISON'));
  assert.ok(text.includes('Retiree'));
  assert.ok(text.includes('Snapshot Fighter'));
});

// ---- Phase 4.4 ("Playtests, Polish, Long-Term Economics & Release Candidate") --

test('build() extracts titleWins from fightResults, ignoring non-title fights and title fights ending in a draw', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const fightResults = [
    { winner: 'A', method: 'KO', titleOnTheLine: true, names: { A: 'New Champ', B: 'Ex Champ' }, weightClasses: { A: 'Poids Leger', B: 'Poids Leger' } },
    { winner: 'B', method: 'SUBMISSION', titleOnTheLine: false, names: { A: 'X', B: 'Y' } },
    { winner: null, method: 'DRAW', titleOnTheLine: true, names: { A: 'X', B: 'Y' } },
  ];

  const summary = new SeasonSummary({ playerState, worldState }).build({ fightResults });

  assert.equal(summary.titleWins.length, 1);
  assert.equal(summary.titleWins[0].winnerName, 'New Champ');
  assert.equal(summary.titleWins[0].weightClass, 'Poids Leger');
  assert.equal(summary.titleWins[0].method, 'KO');
});

test('toText celebrates a title win and a Hall of Fame induction with a visible banner', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const seasonSummary = new SeasonSummary({ playerState, worldState });

  const fightResults = [
    { winner: 'A', method: 'KO', titleOnTheLine: true, names: { A: 'New Champ', B: 'Ex Champ' }, weightClasses: { A: 'Poids Leger', B: 'Poids Leger' } },
  ];
  const weeklyResults = [
    {
      weekSummary: makeWeekSummary({
        retirements: [
          {
            name: 'Legend',
            age: 45,
            wins: 150,
            losses: 10,
            draws: 0,
            reconversion: { isHallOfFamer: true, outcome: LEGACY_ENGINE_OUTCOMES.COACH_IN_GYM, nickname: 'The Hammer' },
          },
        ],
      }),
      dramaReport: null,
    },
  ];

  const summary = seasonSummary.build({ weeklyResults, fightResults });
  const text = seasonSummary.toText(summary);

  assert.ok(text.includes('TITRES EN JEU'));
  assert.ok(text.includes('New Champ'));
  assert.ok(text.includes('HALL OF FAME'));
  assert.ok(text.includes('Legend'));
});
