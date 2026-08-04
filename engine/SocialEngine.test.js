/**
 * engine/SocialEngine.test.js
 * Run with: node --test engine/SocialEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import Fighter from '../models/Fighter.js';
import PlayerState, { PLAYER_EVENTS } from '../state/PlayerState.js';
import { CombatEngine, createSeededRng } from './CombatEngine.js';
import { SocialEngine } from './SocialEngine.js';

function makeFighter(name, value) {
  return new Fighter({
    identity: { name, age: 27 },
    attributes: {
      skills: { boxe: value, jambes: value, sol: value, soumission: value, cardio: value, intelligence: value },
    },
  });
}

test('a decisive win by finish posts a fan reaction, a journalist recap and a fighter statement', () => {
  const player = new PlayerState({ gymName: 'Champions Gym', hype: 20 });
  const strong = makeFighter('Strong', 90);
  const weak = makeFighter('Weak', 15);
  player.addFighter(strong);

  const social = new SocialEngine().attach(player);
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  engine.setupMatch(strong, weak, 'WFC', false);
  engine.setGameplan('A', { tempo: 'AGGRESSIVE' });
  engine.setGameplan('B', { tempo: 'AGGRESSIVE' });
  const result = engine.simulateFullMatch();
  social.detach();

  assert.equal(result.method, 'KO');
  assert.equal(player.socialFeed.length, 3);
  assert.deepEqual(
    player.socialFeed.map((p) => p.authorType).sort(),
    ['FAN', 'FIGHTER_STATEMENT', 'JOURNALIST'].sort()
  );
  assert.ok(player.socialFeed.every((p) => p.likes > 0));
});

test('a loss by finish additionally posts rival trash talk', () => {
  const player = new PlayerState({ gymName: 'Underdog Gym', hype: 20 });
  const weak = makeFighter('Underdog', 15);
  const strong = makeFighter('Bully', 90);
  player.addFighter(weak);

  const social = new SocialEngine().attach(player);
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  engine.setupMatch(weak, strong, 'WFC', false);
  engine.setGameplan('A', { tempo: 'AGGRESSIVE' });
  engine.setGameplan('B', { tempo: 'AGGRESSIVE' });
  const result = engine.simulateFullMatch();
  social.detach();

  assert.equal(result.method, 'KO');
  assert.equal(player.socialFeed.length, 4);
  assert.ok(player.socialFeed.some((p) => p.authorType === 'RIVAL'));
});

test('a fight not involving any roster fighter produces no posts', () => {
  const player = new PlayerState({ gymName: 'Bystander Gym' });
  const social = new SocialEngine().attach(player);

  const a = makeFighter('Outsider A', 50);
  const b = makeFighter('Outsider B', 50);
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  engine.setupMatch(a, b, 'WFC', false);
  engine.simulateFullMatch();
  social.detach();

  assert.equal(player.socialFeed.length, 0);
});

test('adding a fighter to the roster posts a welcome message', () => {
  const player = new PlayerState({ gymName: 'Welcoming Gym' });
  const social = new SocialEngine().attach(player);

  const fighter = makeFighter('Newcomer', 30);
  player.addFighter(fighter);
  social.detach();

  assert.equal(player.socialFeed.length, 1);
  assert.equal(player.socialFeed[0].authorType, 'FAN');
  assert.ok(player.socialFeed[0].text.includes('Newcomer'));
});

test('upgrading the facility posts an announcement', () => {
  const player = new PlayerState({ gymName: 'Upgrading Gym', money: 100000 });
  const social = new SocialEngine().attach(player);

  player.upgradeFacility(1);
  social.detach();

  assert.equal(player.socialFeed.length, 1);
});

test('post like counts scale with PlayerState.hype', () => {
  const lowHype = new PlayerState({ gymName: 'Low Hype', hype: 0 });
  const socialLow = new SocialEngine({ rng: () => 0.5 }).attach(lowHype);
  lowHype.addFighter(makeFighter('X', 30));
  const lowLikes = lowHype.socialFeed[0].likes;
  socialLow.detach();

  const highHype = new PlayerState({ gymName: 'High Hype', hype: 100 });
  const socialHigh = new SocialEngine({ rng: () => 0.5 }).attach(highHype);
  highHype.addFighter(makeFighter('Y', 30));
  const highLikes = highHype.socialFeed[0].likes;
  socialHigh.detach();

  assert.ok(highLikes > lowLikes, `expected high-hype likes (${highLikes}) > low-hype likes (${lowLikes})`);
});

test('every generated post reaches the feed through PlayerState.SOCIAL_FEED_ENTRY_ADDED (no separate engine event)', () => {
  const player = new PlayerState({ gymName: 'Wired Gym' });
  const social = new SocialEngine().attach(player);

  const feedEvents = [];
  const unsub = EventBus.subscribe(PLAYER_EVENTS.SOCIAL_FEED_ENTRY_ADDED, (payload) => feedEvents.push(payload));
  player.addFighter(makeFighter('Wired Fighter', 30));
  unsub();
  social.detach();

  assert.equal(feedEvents.length, 1);
  assert.equal(feedEvents[0].entry.author, 'Fan de la salle');
});

test('detach() stops the engine from reacting to further events', () => {
  const player = new PlayerState({ gymName: 'Detach Gym' });
  const social = new SocialEngine().attach(player);
  social.detach();

  player.addFighter(makeFighter('Ghost', 30));

  assert.equal(player.socialFeed.length, 0, 'no post should be generated after detach()');
});
