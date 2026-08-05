/**
 * engine/StoryEngine.test.js
 * Run with: node --test engine/StoryEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { StoryEngine, STORY_ENGINE_EVENTS, OPPORTUNITY_TYPES } from './StoryEngine.js';

function makeFighter(name, value, overrides = {}) {
  return new Fighter({
    identity: { name, ...overrides.identity },
    attributes: {
      skills: { boxe: value, jambes: value, sol: value, soumission: value, cardio: value, intelligence: value },
    },
    psychology: overrides.psychology,
  });
}

function collectOpportunities() {
  const list = [];
  const unsub = EventBus.subscribe(STORY_ENGINE_EVENTS.OPPORTUNITY_DETECTED, (o) => list.push(o));
  return { list, stop: unsub };
}

test('UPSET_VICTORY fires when the winner\'s rating is far below the loser\'s, but not for an even match', () => {
  const player = new PlayerState({ gymName: 'Story Gym' });
  const world = new WorldState();
  const underdog = makeFighter('Underdog', 20);
  const favourite = makeFighter('Favourite', 80);
  player.addFighter(underdog);
  player.addFighter(favourite);
  const engine = new StoryEngine().attach(player, world);

  const { list, stop } = collectOpportunities();
  EventBus.publish('combat:finished', {
    fighters: { A: underdog.identity.id, B: favourite.identity.id },
    names: { A: 'Underdog', B: 'Favourite' },
    winner: 'A',
    method: 'KO',
    titleOnTheLine: false,
  });
  stop();
  engine.detach();

  const upset = list.find((o) => o.type === OPPORTUNITY_TYPES.UPSET_VICTORY);
  assert.ok(upset, 'expected an UPSET_VICTORY opportunity');
  assert.deepEqual(upset.entities, [underdog.identity.id, favourite.identity.id]);
  assert.ok(upset.context.ratingGap >= BALANCE.STORY.UPSET_VICTORY.MIN_RATING_GAP);

  // combat:finished carries names keyed by corner ('A'/'B'); the published opportunity's
  // context.names must be re-keyed by fighter id so NarrativeEngine.resolveName(context, id)
  // finds the real name instead of falling back to a generic placeholder.
  assert.equal(upset.context.names[underdog.identity.id], 'Underdog');
  assert.equal(upset.context.names[favourite.identity.id], 'Favourite');
});

test('an evenly matched fight does not trigger UPSET_VICTORY', () => {
  const player = new PlayerState({ gymName: 'Even Gym' });
  const world = new WorldState();
  const a = makeFighter('Even A', 50);
  const b = makeFighter('Even B', 50);
  player.addFighter(a);
  player.addFighter(b);
  const engine = new StoryEngine().attach(player, world);

  const { list, stop } = collectOpportunities();
  EventBus.publish('combat:finished', {
    fighters: { A: a.identity.id, B: b.identity.id },
    names: { A: 'Even A', B: 'Even B' },
    winner: 'A',
    method: 'UNANIMOUS_DECISION',
  });
  stop();
  engine.detach();

  assert.ok(!list.some((o) => o.type === OPPORTUNITY_TYPES.UPSET_VICTORY));
});

test('CONFLICT_POTENTIAL fires only when the loser has high ego AND pre-existing tension with the winner', () => {
  const player = new PlayerState({ gymName: 'Conflict Gym' });
  const world = new WorldState();
  const proudLoser = makeFighter('Proud Loser', 50, { psychology: { ego: 90 } });
  const humbleLoser = makeFighter('Humble Loser', 50, { psychology: { ego: 20 } });
  const winner = makeFighter('Winner', 50);
  player.addFighter(proudLoser);
  player.addFighter(humbleLoser);
  player.addFighter(winner);

  // Pre-seed high tension between proudLoser<->winner, but leave humbleLoser<->winner untouched.
  world.upsertRelationship(proudLoser.identity.id, winner.identity.id, { tension: BALANCE.STORY.CONFLICT_POTENTIAL.MIN_TENSION });

  const engine = new StoryEngine().attach(player, world);
  const { list, stop } = collectOpportunities();

  EventBus.publish('combat:finished', {
    fighters: { A: winner.identity.id, B: proudLoser.identity.id },
    names: { A: 'Winner', B: 'Proud Loser' },
    winner: 'A',
    method: 'UNANIMOUS_DECISION',
  });
  EventBus.publish('combat:finished', {
    fighters: { A: winner.identity.id, B: humbleLoser.identity.id },
    names: { A: 'Winner', B: 'Humble Loser' },
    winner: 'A',
    method: 'UNANIMOUS_DECISION',
  });
  stop();
  engine.detach();

  const conflicts = list.filter((o) => o.type === OPPORTUNITY_TYPES.CONFLICT_POTENTIAL);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].entities, [proudLoser.identity.id, winner.identity.id]);
});

test('RIVALRY_IGNITED fires once the post-fight relation is low enough', () => {
  const player = new PlayerState({ gymName: 'Rivalry Gym' });
  const world = new WorldState();
  const a = makeFighter('A', 50);
  const b = makeFighter('B', 50);
  player.addFighter(a);
  player.addFighter(b);

  world.upsertRelationship(a.identity.id, b.identity.id, {
    relation: BALANCE.RELATIONSHIP.STARTING_RELATION + BALANCE.STORY.RIVALRY_IGNITED.MAX_RELATION - 1,
  });

  const engine = new StoryEngine().attach(player, world);
  const { list, stop } = collectOpportunities();

  EventBus.publish('combat:finished', {
    fighters: { A: a.identity.id, B: b.identity.id },
    names: { A: 'A', B: 'B' },
    winner: 'A',
    method: 'UNANIMOUS_DECISION',
  });
  stop();
  engine.detach();

  assert.ok(list.some((o) => o.type === OPPORTUNITY_TYPES.RIVALRY_IGNITED));
});

test('draws never trigger any of these detectors', () => {
  const player = new PlayerState({ gymName: 'Draw Gym' });
  const world = new WorldState();
  const a = makeFighter('A', 10, { psychology: { ego: 95 } });
  const b = makeFighter('B', 90);
  player.addFighter(a);
  player.addFighter(b);
  world.upsertRelationship(a.identity.id, b.identity.id, { tension: 100, relation: -100 });

  const engine = new StoryEngine().attach(player, world);
  const { list, stop } = collectOpportunities();

  EventBus.publish('combat:finished', {
    fighters: { A: a.identity.id, B: b.identity.id },
    names: { A: 'A', B: 'B' },
    winner: null,
    method: 'DRAW',
  });
  stop();
  engine.detach();

  assert.equal(list.length, 0);
});

test('FINANCIAL_DISCONTENT fires for high-salary-demand personalities on economy:insolvent, not for loyal ones', () => {
  const player = new PlayerState({ gymName: 'Discontent Gym' });
  const world = new WorldState();
  const diva = new Fighter({
    identity: { name: 'Diva' },
    psychology: { personality: { archetype: 'Mercenaire', traits: ['Arrogant'] } },
  });
  const loyal = new Fighter({
    identity: { name: 'Loyal One' },
    psychology: { personality: { archetype: 'Guerrier', traits: ['Loyal'] } },
  });
  player.addFighter(diva);
  player.addFighter(loyal);

  const engine = new StoryEngine().attach(player, world);
  const { list, stop } = collectOpportunities();
  EventBus.publish('economy:insolvent', { balance: -6000, threshold: -5000 });
  stop();
  engine.detach();

  const discontents = list.filter((o) => o.type === OPPORTUNITY_TYPES.FINANCIAL_DISCONTENT);
  assert.equal(discontents.length, 1);
  assert.deepEqual(discontents[0].entities, [diva.identity.id]);
});

test('detach() stops the engine from reacting to further events', () => {
  const player = new PlayerState({ gymName: 'Detach Gym' });
  const world = new WorldState();
  const a = makeFighter('A', 10, { psychology: { ego: 95 } });
  const b = makeFighter('B', 90);
  player.addFighter(a);
  player.addFighter(b);

  const engine = new StoryEngine().attach(player, world);
  engine.detach();

  const { list, stop } = collectOpportunities();
  EventBus.publish('combat:finished', {
    fighters: { A: a.identity.id, B: b.identity.id },
    names: { A: 'A', B: 'B' },
    winner: 'A',
    method: 'KO',
  });
  stop();

  assert.equal(list.length, 0);
});
