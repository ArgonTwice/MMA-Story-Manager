/**
 * state/WorldState.test.js
 * Run with: node --test state/WorldState.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import WorldState, { WORLD_EVENTS } from './WorldState.js';

test('relationships: upsertRelationship creates a symmetric, BALANCE-seeded record and clamps deltas', () => {
  const world = new WorldState();

  const events = [];
  const unsub = EventBus.subscribe(WORLD_EVENTS.RELATIONSHIP_UPDATED, (e) => events.push(e));
  const record = world.upsertRelationship('f1', 'f2', { relation: -200, tension: 10 }, { type: 'TEST', description: 'seed' });
  unsub();

  assert.equal(record.gauges.relation, BALANCE.RELATIONSHIP.MIN_RELATION, 'relation should clamp at MIN_RELATION');
  assert.equal(record.gauges.tension, BALANCE.RELATIONSHIP.STARTING_TENSION + 10);
  assert.deepEqual(world.getRelationship('f2', 'f1').gauges, record.gauges);
  assert.equal(events.length, 1);
});

test('records: trySetRecord only overwrites when the candidate is genuinely better', () => {
  const world = new WorldState();

  assert.equal(world.trySetRecord('fastestKO', 60, { betterIf: 'LOWER', detail: 'first' }), true);
  assert.equal(world.trySetRecord('fastestKO', 90, { betterIf: 'LOWER' }), false);
  assert.equal(world.trySetRecord('fastestKO', 30, { betterIf: 'LOWER', detail: 'faster' }), true);
  assert.equal(world.getRecord('fastestKO').value, 30);
  assert.equal(world.getRecord('fastestKO').detail, 'faster');

  assert.throws(() => world.getRecord('notARecord'));
});

test('title holder bookkeeping is a plain get/set pair independent of the records themselves', () => {
  const world = new WorldState();
  assert.equal(world.getTitleHolder('WFC:Lightweight'), null);

  world.setTitleHolder('WFC:Lightweight', { fighterId: 'f1', fighterName: 'Fighter One', sinceDay: 5 });
  assert.deepEqual(world.getTitleHolder('WFC:Lightweight'), { fighterId: 'f1', fighterName: 'Fighter One', sinceDay: 5 });
});

test('toJSON()/fromJSON() round-trips relationships (with history), records, and titleHolders exactly', () => {
  const world = new WorldState();
  world.upsertRelationship('f1', 'f2', { relation: -20, tension: 30 }, { type: 'COMBAT', description: 'A vs B' });
  world.upsertRelationship('f1', 'f2', { respect: 15 }, { type: 'PROVOCATION', description: 'trash talk' });
  world.trySetRecord('biggestFight', 12000, { detail: 'huge purse', meta: { fighterAId: 'f1', fighterBId: 'f2' } });
  world.setTitleHolder('WFC:Lightweight', { fighterId: 'f1', fighterName: 'Fighter One', sinceDay: 1 });

  const json = world.toJSON();
  const rebuilt = WorldState.fromJSON(json);

  assert.deepEqual(rebuilt.getRelationship('f1', 'f2'), world.getRelationship('f1', 'f2'));
  assert.equal(rebuilt.getRelationship('f1', 'f2').history.length, 2);
  assert.deepEqual(rebuilt.getRecord('biggestFight'), world.getRecord('biggestFight'));
  assert.deepEqual(rebuilt.getTitleHolder('WFC:Lightweight'), world.getTitleHolder('WFC:Lightweight'));

  // Mutating the rebuilt copy must never reach back into the original (deep clone, not aliasing).
  rebuilt.upsertRelationship('f1', 'f2', { tension: 50 });
  assert.notEqual(rebuilt.getRelationship('f1', 'f2').gauges.tension, world.getRelationship('f1', 'f2').gauges.tension);
});
