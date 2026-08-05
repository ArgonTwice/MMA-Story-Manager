/**
 * engine/RelationshipEngine.test.js
 * Run with: node --test engine/RelationshipEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import WorldState from '../state/WorldState.js';
import { RelationshipEngine } from './RelationshipEngine.js';

test('combat:finished creates a relationship record and moves every gauge by COMBAT_EFFECTS, symmetrically', () => {
  const world = new WorldState();
  const engine = new RelationshipEngine().attach(world);

  EventBus.publish('combat:finished', {
    fighters: { A: 'f1', B: 'f2' },
    names: { A: 'Alpha', B: 'Beta' },
    method: 'UNANIMOUS_DECISION',
    isTitle: false,
    titleOnTheLine: false,
  });
  engine.detach();

  const cfg = BALANCE.RELATIONSHIP.COMBAT_EFFECTS;
  const rel = world.getRelationship('f1', 'f2');
  assert.equal(rel.gauges.relation, BALANCE.RELATIONSHIP.STARTING_RELATION + cfg.RELATION_DELTA);
  assert.equal(rel.gauges.tension, BALANCE.RELATIONSHIP.STARTING_TENSION + cfg.TENSION_DELTA);
  assert.equal(rel.gauges.respect, BALANCE.RELATIONSHIP.STARTING_RESPECT + cfg.RESPECT_DELTA);
  assert.equal(rel.gauges.popularity, BALANCE.RELATIONSHIP.STARTING_POPULARITY + cfg.POPULARITY_DELTA);
  assert.equal(rel.gauges.legacy, BALANCE.RELATIONSHIP.STARTING_LEGACY + cfg.LEGACY_DELTA_BASE);

  const reversed = world.getRelationship('f2', 'f1');
  assert.deepEqual(reversed.gauges, rel.gauges, 'relationship should be order-independent');

  assert.equal(rel.history.length, 1);
  assert.equal(rel.history[0].type, 'COMBAT');
  assert.ok(rel.history[0].description.includes('Alpha'));
});

test('a finish and a title fight both add legacy bonuses on top of the base delta', () => {
  const world = new WorldState();
  const engine = new RelationshipEngine().attach(world);

  EventBus.publish('combat:finished', {
    fighters: { A: 'f1', B: 'f2' },
    names: { A: 'Alpha', B: 'Beta' },
    method: 'KO',
    isTitle: true,
    titleOnTheLine: true,
  });
  engine.detach();

  const cfg = BALANCE.RELATIONSHIP.COMBAT_EFFECTS;
  const rel = world.getRelationship('f1', 'f2');
  const expectedLegacy =
    BALANCE.RELATIONSHIP.STARTING_LEGACY + cfg.LEGACY_DELTA_BASE + cfg.LEGACY_DELTA_FINISH_BONUS + cfg.LEGACY_DELTA_TITLE_BONUS;
  assert.equal(rel.gauges.legacy, expectedLegacy);
});

test('repeated fights accumulate gauges linearly and append to history in order', () => {
  const world = new WorldState();
  const engine = new RelationshipEngine().attach(world);
  const cfg = BALANCE.RELATIONSHIP.COMBAT_EFFECTS;

  for (let i = 0; i < 3; i += 1) {
    EventBus.publish('combat:finished', {
      fighters: { A: 'f1', B: 'f2' },
      names: { A: 'Alpha', B: 'Beta' },
      method: 'UNANIMOUS_DECISION',
      isTitle: false,
      titleOnTheLine: false,
    });
  }
  engine.detach();

  const rel = world.getRelationship('f1', 'f2');
  assert.equal(rel.gauges.tension, BALANCE.RELATIONSHIP.STARTING_TENSION + cfg.TENSION_DELTA * 3);
  assert.equal(rel.history.length, 3);
});

test('a PROVOCATION-toned narrative beat deepens tension and lowers relation between its two entities', () => {
  const world = new WorldState();
  const engine = new RelationshipEngine().attach(world);
  const cfg = BALANCE.RELATIONSHIP.PROVOCATION_EFFECTS;

  EventBus.publish('narrative:published', {
    tone: 'PROVOCATION',
    entities: ['f1', 'f2'],
    headline: 'Alpha nargue Beta publiquement.',
  });
  engine.detach();

  const rel = world.getRelationship('f1', 'f2');
  assert.equal(rel.gauges.relation, BALANCE.RELATIONSHIP.STARTING_RELATION + cfg.RELATION_DELTA);
  assert.equal(rel.gauges.tension, BALANCE.RELATIONSHIP.STARTING_TENSION + cfg.TENSION_DELTA);
  assert.equal(rel.history[0].type, 'PROVOCATION');
});

test('a NEUTRAL-toned narrative beat is ignored, and a single-entity beat cannot create a relationship', () => {
  const world = new WorldState();
  const engine = new RelationshipEngine().attach(world);

  EventBus.publish('narrative:published', { tone: 'NEUTRAL', entities: ['f1', 'f2'], headline: 'Rien de spécial.' });
  EventBus.publish('narrative:published', { tone: 'PROVOCATION', entities: ['f1'], headline: 'Un seul concerne.' });
  engine.detach();

  assert.equal(world.getRelationship('f1', 'f2'), null);
});

test('gauges clamp to their BALANCE bounds instead of overflowing', () => {
  const world = new WorldState();
  const engine = new RelationshipEngine().attach(world);

  for (let i = 0; i < 50; i += 1) {
    EventBus.publish('combat:finished', {
      fighters: { A: 'f1', B: 'f2' },
      names: { A: 'Alpha', B: 'Beta' },
      method: 'UNANIMOUS_DECISION',
      isTitle: false,
      titleOnTheLine: false,
    });
  }
  engine.detach();

  const rel = world.getRelationship('f1', 'f2');
  assert.equal(rel.gauges.relation, BALANCE.RELATIONSHIP.MIN_RELATION);
  assert.equal(rel.gauges.tension, BALANCE.RELATIONSHIP.MAX_GAUGE);
});

test('detach() stops the engine from reacting to further events', () => {
  const world = new WorldState();
  const engine = new RelationshipEngine().attach(world);
  engine.detach();

  EventBus.publish('combat:finished', {
    fighters: { A: 'f1', B: 'f2' },
    names: { A: 'Alpha', B: 'Beta' },
    method: 'UNANIMOUS_DECISION',
  });

  assert.equal(world.getRelationship('f1', 'f2'), null);
});
