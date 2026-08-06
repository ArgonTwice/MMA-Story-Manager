/**
 * engine/HistoryEngine.test.js
 * Run with: node --test engine/HistoryEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import WorldState, { WORLD_EVENTS } from '../state/WorldState.js';
import Fighter from '../models/Fighter.js';
import { HistoryEngine, evaluateHallOfFameEligibility, induct } from './HistoryEngine.js';

function combatFinishedPayload(overrides = {}) {
  return {
    matchId: 'match_test',
    orgId: 'WFC',
    winner: 'A',
    method: 'UNANIMOUS_DECISION',
    round: 3,
    timeLabel: '1:30',
    timeSeconds: 90,
    fighters: { A: 'f1', B: 'f2' },
    names: { A: 'Alpha', B: 'Beta' },
    weightClasses: { A: 'Lightweight', B: 'Lightweight' },
    careerTitlesCount: { A: 0, B: 0 },
    titleOnTheLine: false,
    ages: { A: 24, B: 27 },
    winStreaks: { A: 1, B: 0 },
    ...overrides,
  };
}

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'Tester', age: 28, ...overrides.identity },
    career: overrides.career,
    psychology: overrides.psychology,
  });
}

// ---- reactive: longestWinStreak / youngestChampion --------------------------

test('longestWinStreak is set from the winner\'s post-fight winStreaks value', () => {
  const world = new WorldState();
  const engine = new HistoryEngine().attach(world);

  EventBus.publish('combat:finished', combatFinishedPayload({ winStreaks: { A: 5, B: 0 } }));
  engine.detach();

  assert.equal(world.getRecord('longestWinStreak').value, 5);
  assert.ok(world.getRecord('longestWinStreak').detail.includes('Alpha'));
});

test('a shorter streak never overwrites a longer one, but a longer one does', () => {
  const world = new WorldState();
  const engine = new HistoryEngine().attach(world);

  EventBus.publish('combat:finished', combatFinishedPayload({ winStreaks: { A: 10, B: 0 } }));
  EventBus.publish('combat:finished', combatFinishedPayload({ winStreaks: { A: 3, B: 0 } }));
  assert.equal(world.getRecord('longestWinStreak').value, 10, 'a shorter streak should not overwrite the record');

  EventBus.publish('combat:finished', combatFinishedPayload({ winStreaks: { A: 15, B: 0 } }));
  engine.detach();

  assert.equal(world.getRecord('longestWinStreak').value, 15);
});

test('a draw never touches longestWinStreak', () => {
  const world = new WorldState();
  const engine = new HistoryEngine().attach(world);

  EventBus.publish('combat:finished', combatFinishedPayload({ winner: null, winStreaks: { A: 0, B: 0 } }));
  engine.detach();

  assert.equal(world.getRecord('longestWinStreak').value, 0);
});

test('a fighter\'s FIRST title win sets youngestChampion using their age', () => {
  const world = new WorldState();
  const engine = new HistoryEngine().attach(world);

  EventBus.publish(
    'combat:finished',
    combatFinishedPayload({ titleOnTheLine: true, careerTitlesCount: { A: 1, B: 0 }, ages: { A: 22, B: 30 } })
  );
  engine.detach();

  assert.equal(world.getRecord('youngestChampion').value, 22);
  assert.ok(world.getRecord('youngestChampion').detail.includes('Alpha'));
});

test('winning a SECOND title never re-triggers youngestChampion (careerTitlesCount !== 1)', () => {
  const world = new WorldState();
  const engine = new HistoryEngine().attach(world);

  EventBus.publish(
    'combat:finished',
    combatFinishedPayload({ titleOnTheLine: true, careerTitlesCount: { A: 2, B: 0 }, ages: { A: 20, B: 30 } })
  );
  engine.detach();

  assert.equal(world.getRecord('youngestChampion').value, null, 'a second title (not the first) should not set the record');
});

test('an older fighter winning their first title after a younger champion is already recorded does not overwrite it', () => {
  const world = new WorldState();
  const engine = new HistoryEngine().attach(world);

  EventBus.publish(
    'combat:finished',
    combatFinishedPayload({ titleOnTheLine: true, careerTitlesCount: { A: 1, B: 0 }, ages: { A: 20, B: 30 } })
  );
  EventBus.publish(
    'combat:finished',
    combatFinishedPayload({
      fighters: { A: 'f3', B: 'f4' },
      names: { A: 'Gamma', B: 'Delta' },
      titleOnTheLine: true,
      careerTitlesCount: { A: 1, B: 0 },
      ages: { A: 35, B: 30 },
    })
  );
  engine.detach();

  assert.equal(world.getRecord('youngestChampion').value, 20, 'the younger recorded champion should stick');
});

test('a fight where the title is not on the line never touches youngestChampion', () => {
  const world = new WorldState();
  const engine = new HistoryEngine().attach(world);

  EventBus.publish('combat:finished', combatFinishedPayload({ titleOnTheLine: false, careerTitlesCount: { A: 1, B: 0 }, ages: { A: 18, B: 30 } }));
  engine.detach();

  assert.equal(world.getRecord('youngestChampion').value, null);
});

test('detach() stops the engine from reacting to further events', () => {
  const world = new WorldState();
  const engine = new HistoryEngine().attach(world);
  engine.detach();

  EventBus.publish('combat:finished', combatFinishedPayload({ winStreaks: { A: 99, B: 0 } }));

  assert.equal(world.getRecord('longestWinStreak').value, 0);
});

// ---- Hall of Fame induction (retirement-triggered, pure functions) ----------

test('evaluateHallOfFameEligibility requires BOTH the win-count bar AND the win-rate bar', () => {
  const highWinsLowRate = makeFighter({ career: { wins: 200, losses: 200, draws: 0 } });
  const highRateLowWins = makeFighter({ career: { wins: 10, losses: 0, draws: 0 } });
  const bothClear = makeFighter({ career: { wins: 200, losses: 20, draws: 0 } });

  assert.equal(evaluateHallOfFameEligibility(highWinsLowRate), false, 'a mediocre win rate should fail eligibility regardless of volume');
  assert.equal(evaluateHallOfFameEligibility(highRateLowWins), false, 'too small a sample should fail eligibility regardless of rate');
  assert.equal(evaluateHallOfFameEligibility(bothClear), true);
});

test('a fighter with zero fights is never eligible (no division by zero)', () => {
  const rookie = makeFighter({ career: { wins: 0, losses: 0, draws: 0 } });
  assert.equal(evaluateHallOfFameEligibility(rookie), false);
});

test('induct() flips hallOfFameStatus to inducted and stores a full entry on WorldState.hallOfFame', () => {
  const world = new WorldState();
  const fighter = makeFighter({
    identity: { name: 'Legend One', age: 45 },
    career: { wins: 150, losses: 10, draws: 0, finishes: 60, titles: [] },
  });

  const entry = induct(fighter, world);

  assert.equal(fighter.career.hallOfFameStatus, 'inducted');
  assert.equal(world.getHallOfFame().length, 1);
  assert.equal(entry.name, 'Legend One');
  assert.equal(entry.record, '150-10-0');
  assert.equal(entry.finishes, 60);
  assert.equal(entry.biggestRival, null, 'no relationships tracked for this fighter, so no rival should be found');
});

test('induct() publishes world:hall_of_fame_inducted and finds the tracked rival with the highest tension', () => {
  const world = new WorldState();
  const fighter = makeFighter({ identity: { id: 'legend', name: 'Legend Two' }, career: { wins: 130, losses: 5, draws: 0 } });

  world.upsertRelationship('legend', 'rival-a', { tension: 40 });
  world.upsertRelationship('legend', 'rival-b', { tension: 90 });

  const events = [];
  const unsub = EventBus.subscribe(WORLD_EVENTS.HALL_OF_FAME_INDUCTED, (e) => events.push(e));
  const entry = induct(fighter, world);
  unsub();

  assert.equal(events.length, 1);
  assert.equal(entry.biggestRival.fighterId, 'rival-b');
  assert.equal(entry.biggestRival.tension, 90);
});
