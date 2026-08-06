/**
 * ui/WorldFeed.test.js
 * Run with: node --test ui/WorldFeed.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import { WORLD_EVENTS } from '../state/WorldState.js';
import { DRAMA_ENGINE_EVENTS } from '../engine/DramaEngine.js';
import { NARRATIVE_ENGINE_EVENTS } from '../engine/NarrativeEngine.js';
import { COMBAT_EVENTS } from '../engine/CombatEngine.js';
import { DRAMA_EVENTS } from '../data/events.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { WorldFeed } from './WorldFeed.js';

function makeFeed(overrides = {}) {
  const playerState = overrides.playerState ?? new PlayerState();
  const worldState = overrides.worldState ?? new WorldState();
  return new WorldFeed({ playerState, worldState }).attach();
}

test('a DRAMA_ENGINE_EVENTS.RESOLVED event is logged with the featured fighter\'s real name and the choice\'s label', () => {
  const playerState = new PlayerState();
  const fighter = new Fighter({ identity: { name: 'Drama Star' } });
  playerState.addFighter(fighter);
  const feed = makeFeed({ playerState });

  const realEvent = DRAMA_EVENTS[0];
  const realChoice = realEvent.choices[0];
  EventBus.publish(DRAMA_ENGINE_EVENTS.RESOLVED, {
    eventId: realEvent.id,
    category: realEvent.category,
    fighterId: fighter.identity.id,
    choiceId: realChoice.id,
    day: 10,
  });
  feed.detach();

  const [entry] = feed.getEntries();
  assert.equal(entry.category, 'DRAMA');
  assert.equal(entry.day, 10);
  assert.ok(entry.text.includes('Drama Star'));
  assert.ok(entry.text.includes(realChoice.label));
});

test('a WORLD_EVENTS.RECORD_BROKEN event is logged using the record\'s own detail text', () => {
  const feed = makeFeed();
  EventBus.publish(WORLD_EVENTS.RECORD_BROKEN, {
    key: 'fastestKO',
    record: { value: 12, day: 5, detail: 'Someone KOs someone in 12 seconds.', meta: null },
    previous: { value: null, day: null, detail: null, meta: null },
  });
  feed.detach();

  const [entry] = feed.getEntries();
  assert.equal(entry.category, 'RECORD');
  assert.equal(entry.text, 'Someone KOs someone in 12 seconds.');
  assert.equal(entry.day, 5);
});

test('a WORLD_EVENTS.HALL_OF_FAME_INDUCTED event is logged with the inductee\'s name/nickname/record', () => {
  const feed = makeFeed();
  EventBus.publish(WORLD_EVENTS.HALL_OF_FAME_INDUCTED, {
    entry: { name: 'Legend Name', nickname: 'The Hammer', record: '150-10-0', finishes: 90, inductedOnDay: 999 },
  });
  feed.detach();

  const [entry] = feed.getEntries();
  assert.equal(entry.category, 'HALL_OF_FAME');
  assert.ok(entry.text.includes('Legend Name'));
  assert.ok(entry.text.includes('The Hammer'));
  assert.equal(entry.day, 999);
});

test('a FORCED_RETIREMENT global event is described with age/Hall of Fame tag/reconversion outcome', () => {
  const worldState = new WorldState();
  const feed = makeFeed({ worldState });

  worldState.addGlobalEvent({
    type: 'FORCED_RETIREMENT',
    fighterId: 'f1',
    name: 'Old Champ',
    age: 45,
    isHallOfFamer: true,
    nickname: 'Phoenix',
    reconversionOutcome: 'COACH_IN_GYM',
  });
  feed.detach();

  const [entry] = feed.getEntries();
  assert.equal(entry.category, 'WORLD');
  assert.ok(entry.text.includes('Old Champ'));
  assert.ok(entry.text.includes('Phoenix'));
  assert.ok(entry.text.includes('HALL OF FAME'));
  assert.ok(entry.text.includes('COACH_IN_GYM'));
});

test('a RIVAL_FIGHT_RESULT global event and an unrecognized global event type: the former is logged, the latter is silently skipped', () => {
  const worldState = new WorldState();
  const feed = makeFeed({ worldState });

  worldState.addGlobalEvent({ type: 'RIVAL_FIGHT_RESULT', method: 'KO' });
  worldState.addGlobalEvent({ type: 'SOME_FUTURE_EVENT_TYPE' });
  feed.detach();

  assert.equal(feed.getEntries().length, 1);
  assert.ok(feed.getEntries()[0].text.includes('KO'));
});

test('a NARRATIVE_ENGINE_EVENTS.PUBLISHED beat is logged using its own headline', () => {
  const feed = makeFeed();
  EventBus.publish(NARRATIVE_ENGINE_EVENTS.PUBLISHED, {
    id: 'narrative_1',
    form: 'DECLARATION',
    opportunityType: 'RIVALRY_IGNITED',
    headline: 'Une rivalite s\'enflamme.',
    day: 42,
  });
  feed.detach();

  const [entry] = feed.getEntries();
  assert.equal(entry.category, 'NARRATIVE');
  assert.equal(entry.text, 'Une rivalite s\'enflamme.');
  assert.equal(entry.day, 42);
});

test('getEntries/toText are newest-first, and detach() stops the feed from reacting further', () => {
  const worldState = new WorldState();
  const feed = makeFeed({ worldState });

  worldState.addGlobalEvent({ type: 'RIVAL_FIGHT_RESULT', method: 'FIRST' });
  worldState.addGlobalEvent({ type: 'RIVAL_FIGHT_RESULT', method: 'SECOND' });
  feed.detach();
  worldState.addGlobalEvent({ type: 'RIVAL_FIGHT_RESULT', method: 'THIRD_AFTER_DETACH' });

  const entries = feed.getEntries();
  assert.equal(entries.length, 2, 'the post-detach event must not have been logged');
  assert.ok(entries[0].text.includes('SECOND'));
  assert.ok(entries[1].text.includes('FIRST'));

  const text = feed.toText();
  assert.ok(text.indexOf('SECOND') < text.indexOf('FIRST'));
});

// ---- Phase 4.4 ("Playtests, Polish, Long-Term Economics & Release Candidate") --

test('a title fight with a winner is celebrated with a TITLE-category banner entry', () => {
  const feed = makeFeed();

  EventBus.publish(COMBAT_EVENTS.FINISHED, {
    winner: 'A',
    method: 'UNANIMOUS_DECISION',
    titleOnTheLine: true,
    names: { A: 'Champion Name', B: 'Challenger Name' },
    weightClasses: { A: 'Poids Welter', B: 'Poids Welter' },
    fighters: { A: 'f1', B: 'f2' },
  });
  feed.detach();

  const [entry] = feed.getEntries();
  assert.equal(entry.category, 'TITLE');
  assert.ok(entry.text.includes('Champion Name'));
  assert.ok(entry.text.includes('Poids Welter'));
});

test('a non-title fight and a title fight ending in a draw are both ignored by the TITLE celebration', () => {
  const feed = makeFeed();

  EventBus.publish(COMBAT_EVENTS.FINISHED, { winner: 'A', method: 'KO', titleOnTheLine: false, names: { A: 'X', B: 'Y' } });
  EventBus.publish(COMBAT_EVENTS.FINISHED, { winner: null, method: 'DRAW', titleOnTheLine: true, names: { A: 'X', B: 'Y' } });
  feed.detach();

  assert.equal(feed.getEntries().length, 0);
});

test('a Hall of Fame induction entry carries a visible celebratory banner', () => {
  const feed = makeFeed();
  EventBus.publish(WORLD_EVENTS.HALL_OF_FAME_INDUCTED, {
    entry: { name: 'Legend', nickname: null, record: '150-10-0', finishes: 90, inductedOnDay: 1 },
  });
  feed.detach();

  assert.ok(feed.getEntries()[0].text.includes('HALL OF FAME'));
});
