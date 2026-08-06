/**
 * engine/WorldMemory.test.js
 * Run with: node --test engine/WorldMemory.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import WorldState, { WORLD_EVENTS } from '../state/WorldState.js';
import { WorldMemory } from './WorldMemory.js';

function combatFinishedPayload(overrides = {}) {
  return {
    matchId: 'match_test',
    orgId: 'WFC',
    winner: 'A',
    method: 'KO',
    round: 1,
    timeLabel: '1:30',
    timeSeconds: 90,
    fighters: { A: 'f1', B: 'f2' },
    names: { A: 'Alpha', B: 'Beta' },
    weightClasses: { A: 'Lightweight', B: 'Lightweight' },
    careerTitlesCount: { A: 0, B: 0 },
    titleOnTheLine: false,
    purses: { A: { gross: 3000 }, B: { gross: 2000 } },
    ...overrides,
  };
}

test('a KO/TKO sets the fastestKO record using elapsed round time, ignoring decisions', () => {
  const world = new WorldState();
  const engine = new WorldMemory().attach(world);

  EventBus.publish('combat:finished', combatFinishedPayload({ round: 2, timeSeconds: 30, method: 'KO' }));
  engine.detach();

  const expectedSeconds = (2 - 1) * BALANCE.COMBAT.ROUND_DURATION_SECONDS + 30;
  const record = world.getRecord('fastestKO');
  assert.equal(record.value, expectedSeconds);
  assert.ok(record.detail.includes('Alpha'));
});

test('a slower KO does not overwrite a faster one, but a faster one does', () => {
  const world = new WorldState();
  const engine = new WorldMemory().attach(world);

  EventBus.publish('combat:finished', combatFinishedPayload({ round: 1, timeSeconds: 20, method: 'KO' }));
  const afterFirst = world.getRecord('fastestKO').value;

  EventBus.publish('combat:finished', combatFinishedPayload({ round: 3, timeSeconds: 10, method: 'TKO' }));
  assert.equal(world.getRecord('fastestKO').value, afterFirst, 'a slower finish should not overwrite the record');

  EventBus.publish('combat:finished', combatFinishedPayload({ round: 1, timeSeconds: 5, method: 'KO' }));
  assert.equal(world.getRecord('fastestKO').value, 5, 'a faster finish should overwrite the record');

  engine.detach();
});

test('a decision never touches the fastestKO record', () => {
  const world = new WorldState();
  const engine = new WorldMemory().attach(world);

  EventBus.publish('combat:finished', combatFinishedPayload({ method: 'UNANIMOUS_DECISION', timeSeconds: 1 }));
  engine.detach();

  assert.equal(world.getRecord('fastestKO').value, null);
});

test('biggestFight tracks the highest combined purse and emits world:record_broken', () => {
  const world = new WorldState();
  const engine = new WorldMemory().attach(world);

  const brokenEvents = [];
  const unsub = EventBus.subscribe(WORLD_EVENTS.RECORD_BROKEN, (e) => brokenEvents.push(e));

  EventBus.publish('combat:finished', combatFinishedPayload({ purses: { A: { gross: 3000 }, B: { gross: 2000 } } }));
  EventBus.publish('combat:finished', combatFinishedPayload({ purses: { A: { gross: 1000 }, B: { gross: 500 } } }));
  unsub();
  engine.detach();

  assert.equal(world.getRecord('biggestFight').value, 5000);
  const biggestFightBroken = brokenEvents.filter((e) => e.key === 'biggestFight');
  assert.equal(biggestFightBroken.length, 1, 'only the genuinely bigger fight should have broken the biggestFight record');
});

test('biggestUpset tracks the largest preFightRatings gap overcome by a winner, ignoring draws and results without preFightRatings', () => {
  const world = new WorldState();
  const engine = new WorldMemory().attach(world);

  const brokenEvents = [];
  const unsub = EventBus.subscribe(WORLD_EVENTS.RECORD_BROKEN, (e) => brokenEvents.push(e));

  // Draw: never qualifies, even with a huge rating gap.
  EventBus.publish('combat:finished', combatFinishedPayload({ winner: null, preFightRatings: { A: 20, B: 80 } }));
  assert.equal(world.getRecord('biggestUpset').value, null);

  // Missing preFightRatings (older saves/results): ignored, not a crash.
  EventBus.publish('combat:finished', combatFinishedPayload({ winner: 'A', preFightRatings: undefined }));
  assert.equal(world.getRecord('biggestUpset').value, null);

  // Favorite wins as expected: no upset (gap <= 0), never sets the record.
  EventBus.publish('combat:finished', combatFinishedPayload({ winner: 'A', preFightRatings: { A: 70, B: 40 } }));
  assert.equal(world.getRecord('biggestUpset').value, null);

  // A genuine upset: B (rating 30) beats A (rating 65), gap = 35.
  EventBus.publish(
    'combat:finished',
    combatFinishedPayload({ winner: 'B', preFightRatings: { A: 65, B: 30 }, fighters: { A: 'f1', B: 'f2' }, names: { A: 'Alpha', B: 'Beta' } })
  );
  assert.equal(world.getRecord('biggestUpset').value, 35);
  assert.ok(world.getRecord('biggestUpset').detail.includes('Beta'));
  assert.ok(world.getRecord('biggestUpset').detail.includes('Alpha'));

  // A smaller upset afterwards must not overwrite the bigger one.
  EventBus.publish('combat:finished', combatFinishedPayload({ winner: 'B', preFightRatings: { A: 50, B: 45 } }));
  assert.equal(world.getRecord('biggestUpset').value, 35, 'a smaller upset should not overwrite the bigger one');

  unsub();
  engine.detach();

  const biggestUpsetBroken = brokenEvents.filter((e) => e.key === 'biggestUpset');
  assert.equal(biggestUpsetBroken.length, 1, 'only the genuinely bigger upset should have broken the biggestUpset record');
});

test('a title win sets the holder; dethroning it later records the correct reign length and title count', () => {
  const world = new WorldState();
  const engine = new WorldMemory().attach(world);

  EventBus.publish(
    'combat:finished',
    combatFinishedPayload({
      winner: 'A',
      fighters: { A: 'champion', B: 'challenger1' },
      names: { A: 'Champion', B: 'Challenger One' },
      titleOnTheLine: true,
      careerTitlesCount: { A: 1, B: 0 },
    })
  );

  assert.deepEqual(world.getTitleHolder('WFC:Lightweight'), {
    fighterId: 'champion',
    fighterName: 'Champion',
    sinceDay: 1,
  });
  assert.equal(world.getRecord('mostTitles').value, 1);

  world.advanceDay(45);

  EventBus.publish(
    'combat:finished',
    combatFinishedPayload({
      winner: 'A',
      fighters: { A: 'challenger1', B: 'champion' },
      names: { A: 'Challenger One', B: 'Champion' },
      titleOnTheLine: true,
      careerTitlesCount: { A: 1, B: 1 },
    })
  );
  engine.detach();

  assert.equal(world.getTitleHolder('WFC:Lightweight').fighterId, 'challenger1');
  assert.equal(world.getRecord('longestTitleReign').value, 45);
  assert.ok(world.getRecord('longestTitleReign').detail.includes('Champion'));
});

test('a fight where the title is not on the line never touches title records', () => {
  const world = new WorldState();
  const engine = new WorldMemory().attach(world);

  EventBus.publish('combat:finished', combatFinishedPayload({ titleOnTheLine: false, careerTitlesCount: { A: 3, B: 0 } }));
  engine.detach();

  assert.equal(world.getTitleHolder('WFC:Lightweight'), null);
  assert.equal(world.getRecord('mostTitles').value, 0);
});

test('detach() stops the engine from reacting to further events', () => {
  const world = new WorldState();
  const engine = new WorldMemory().attach(world);
  engine.detach();

  EventBus.publish('combat:finished', combatFinishedPayload());

  assert.equal(world.getRecord('fastestKO').value, null);
});
