/**
 * engine/NarrativeEngine.test.js
 * Run with: node --test engine/NarrativeEngine.test.js
 *
 * Uses fixed rng functions to pin down exactly which narrative form gets
 * picked (BALANCE.NARRATIVE.FORM_WEIGHTS_BY_OPPORTUNITY lists each
 * opportunity's forms in a known order, so a low rng always selects the
 * first-listed form and a high rng the last-listed one).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { NarrativeEngine, NARRATIVE_ENGINE_EVENTS, NARRATIVE_FORMS } from './NarrativeEngine.js';

function publishOpportunity(overrides = {}) {
  EventBus.publish('story:opportunity_detected', {
    id: 'story_test',
    type: 'CONFLICT_POTENTIAL',
    entities: ['f1', 'f2'],
    context: { names: { f1: 'Alpha', f2: 'Beta' } },
    day: 1,
    ...overrides,
  });
}

test('a low rng picks the first-listed form for an opportunity, dispatched to the social feed as a fighter statement', () => {
  const player = new PlayerState({ gymName: 'Narrative Gym', hype: 10 });
  const world = new WorldState();
  const engine = new NarrativeEngine({ rng: () => 0.001 }).attach(player, world);

  const beats = [];
  const unsub = EventBus.subscribe(NARRATIVE_ENGINE_EVENTS.PUBLISHED, (b) => beats.push(b));
  publishOpportunity(); // CONFLICT_POTENTIAL -> first listed form is DECLARATION
  unsub();
  engine.detach();

  assert.equal(beats.length, 1);
  assert.equal(beats[0].form, NARRATIVE_FORMS.DECLARATION);
  assert.equal(beats[0].tone, 'PROVOCATION');
  assert.ok(beats[0].headline.includes('Alpha'));
  assert.ok(beats[0].headline.includes('Beta'));

  assert.equal(player.socialFeed.length, 1);
  assert.equal(player.socialFeed[0].authorType, 'FIGHTER_STATEMENT');
  assert.equal(player.socialFeed[0].author, 'Alpha');
});

test('a high rng picks the last-listed form for the opportunity', () => {
  const player = new PlayerState({ gymName: 'Narrative Gym 2' });
  const world = new WorldState();
  const engine = new NarrativeEngine({ rng: () => 0.999 }).attach(player, world);

  const beats = [];
  const unsub = EventBus.subscribe(NARRATIVE_ENGINE_EVENTS.PUBLISHED, (b) => beats.push(b));
  publishOpportunity(); // CONFLICT_POTENTIAL -> last listed form is INCIDENT
  unsub();
  engine.detach();

  assert.equal(beats[0].form, NARRATIVE_FORMS.INCIDENT);
  assert.equal(player.socialFeed.length, 0, 'INCIDENT should not post to the social feed');
  assert.ok(world.globalEvents.some((e) => e.headline === beats[0].headline));
});

test('FINANCIAL_DISCONTENT is single-entity and its DECLARATION is never tagged as a provocation', () => {
  const player = new PlayerState({ gymName: 'Solo Gym' });
  const world = new WorldState();
  const engine = new NarrativeEngine({ rng: () => 0.999 }).attach(player, world); // last form for this opportunity is DECLARATION

  const beats = [];
  const unsub = EventBus.subscribe(NARRATIVE_ENGINE_EVENTS.PUBLISHED, (b) => beats.push(b));
  publishOpportunity({
    type: 'FINANCIAL_DISCONTENT',
    entities: ['f1'],
    context: { names: { f1: 'Solo Fighter' } },
  });
  unsub();
  engine.detach();

  assert.equal(beats[0].form, NARRATIVE_FORMS.DECLARATION);
  assert.equal(beats[0].tone, 'NEUTRAL', 'a single-entity beat cannot be a two-way provocation');
  assert.equal(player.socialFeed[0]?.authorType, 'FIGHTER_STATEMENT');
});

test('a VIRAL_POST form multiplies the base like count', () => {
  // UPSET_VICTORY's weights are { VIRAL_POST: 0.5, INTERVIEW: 0.5 } — a roll
  // of 0.1 lands (strictly) inside the first bucket, picking VIRAL_POST. The
  // same constant rng is then reused for the likes-base roll, keeping the
  // expected value easy to compute by hand.
  const playerLow = new PlayerState({ gymName: 'Low', hype: 0 });
  const worldLow = new WorldState();
  const engineLow = new NarrativeEngine({ rng: () => 0.1 }).attach(playerLow, worldLow);

  const beats = [];
  const unsub = EventBus.subscribe(NARRATIVE_ENGINE_EVENTS.PUBLISHED, (b) => beats.push(b));
  publishOpportunity({ type: 'UPSET_VICTORY', entities: ['f1', 'f2'], context: { names: { f1: 'A', f2: 'B' } } });
  unsub();
  engineLow.detach();

  assert.equal(beats[0].form, NARRATIVE_FORMS.VIRAL_POST);
  const viralLikes = playerLow.socialFeed[0]?.likes;
  assert.ok(viralLikes !== undefined);

  const cfg = BALANCE.SOCIAL_MEDIA.POST_LIKES;
  const base = cfg.BASE_MIN + 0.1 * (cfg.BASE_MAX - cfg.BASE_MIN);
  const expected = Math.round(base * BALANCE.NARRATIVE.VIRAL_POST_LIKES_MULTIPLIER);
  assert.equal(viralLikes, expected);
});

test('an unknown opportunity type is silently ignored, not an error', () => {
  const player = new PlayerState({ gymName: 'Unknown Gym' });
  const world = new WorldState();
  const engine = new NarrativeEngine({ rng: () => 0.5 }).attach(player, world);

  const beats = [];
  const unsub = EventBus.subscribe(NARRATIVE_ENGINE_EVENTS.PUBLISHED, (b) => beats.push(b));
  assert.doesNotThrow(() => publishOpportunity({ type: 'SOME_FUTURE_TYPE', entities: ['f1'], context: {} }));
  unsub();
  engine.detach();

  assert.equal(beats.length, 0);
});

test('detach() stops the engine from reacting to further opportunities', () => {
  const player = new PlayerState({ gymName: 'Detach Gym' });
  const world = new WorldState();
  const engine = new NarrativeEngine({ rng: () => 0.001 }).attach(player, world);
  engine.detach();

  publishOpportunity();

  assert.equal(player.socialFeed.length, 0);
});
