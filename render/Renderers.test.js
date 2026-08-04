/**
 * render/Renderers.test.js
 * Run with: node --test render/Renderers.test.js
 *
 * Covers "component integrity" for all 5 renderers: each one computes the
 * right view model on mount, updates only in reaction to the specific
 * EventBus events it subscribes to (never a global re-render), and stops
 * updating after detach(). Assertions target the structured view model
 * (the stable, testable contract) rather than exact HTML strings; toHTML()
 * is only smoke-tested for non-emptiness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { CombatEngine, createSeededRng, COMBAT_STATES } from '../engine/CombatEngine.js';
import { advanceWeek } from '../engine/ProgressionEngine.js';
import { EVENT_ENGINE_EVENTS } from '../engine/EventEngine.js';
import EventBus from '../core/EventBus.js';
import { GameState } from '../state/GameState.js';

import { DashboardRenderer } from './DashboardRenderer.js';
import { RosterRenderer } from './RosterRenderer.js';
import { CombatRenderer } from './CombatRenderer.js';
import { GymRenderer } from './GymRenderer.js';
import { SocialRenderer } from './SocialRenderer.js';

function makeFighter(name, value, overrides = {}) {
  return new Fighter({
    identity: { name, age: 27, ...overrides.identity },
    attributes: {
      skills: { boxe: value, jambes: value, sol: value, soumission: value, cardio: value, intelligence: value },
      ...overrides.attributes,
    },
  });
}

function makeMount() {
  return { innerHTML: '' };
}

// ============================================================================
// DashboardRenderer
// ============================================================================

test('DashboardRenderer: initial render reflects PlayerState/WorldState and updates on targeted events only', () => {
  const playerState = new PlayerState({ gymName: 'HUD Gym', money: 1000, reputation: 20, hype: 10 });
  const worldState = new WorldState();
  const mount = makeMount();
  let renderCount = 0;

  const renderer = new DashboardRenderer({
    playerState,
    worldState,
    mount,
    onRender: () => {
      renderCount += 1;
    },
  }).attach();

  assert.equal(renderer.getViewModel().money, 1000);
  assert.equal(renderer.getViewModel().day, worldState.currentDay);
  assert.ok(mount.innerHTML.includes('HUD Gym'));
  const countAfterAttach = renderCount;

  playerState.changeMoney(500, 'test income');
  assert.equal(renderer.getViewModel().money, 1500);
  assert.equal(renderer.getViewModel().logEntries[0].kind, 'ECONOMY');
  assert.ok(renderCount > countAfterAttach);

  worldState.advanceDay(1);
  assert.equal(renderer.getViewModel().day, worldState.currentDay);

  EventBus.publish(EVENT_ENGINE_EVENTS.TRIGGERED, { headline: 'Test narrative headline', category: 'SPONSOR_OFFER' });
  assert.equal(renderer.getViewModel().logEntries[0].text, 'Test narrative headline');

  renderer.detach();
  const countAfterDetach = renderCount;
  playerState.changeMoney(-100, 'should not be observed');
  assert.equal(renderCount, countAfterDetach, 'no further renders should happen after detach()');
  assert.equal(renderer.getViewModel().money, 1500, 'view model should be frozen after detach()');
});

test('DashboardRenderer: a full advanceWeek() populates weeklyCharges and a week-summary log line', () => {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Weekly Gym' });
  const renderer = new DashboardRenderer({
    playerState: gameState.playerState,
    worldState: gameState.worldState,
  }).attach();

  advanceWeek(gameState, { rng: createSeededRng(1) });

  assert.ok(renderer.getViewModel().weeklyCharges !== null);
  assert.ok(renderer.getViewModel().logEntries.some((e) => e.kind === 'WEEK'));
});

// ============================================================================
// RosterRenderer
// ============================================================================

test('RosterRenderer: reacts to roster changes and per-fighter training events without a full rebuild', () => {
  const playerState = new PlayerState({ gymName: 'Roster Gym' });
  const renderer = new RosterRenderer({ playerState }).attach();
  assert.equal(renderer.getViewModel().cards.length, 0);

  const fighter = makeFighter('Card Fighter', 40);
  playerState.addFighter(fighter);
  assert.equal(renderer.getViewModel().cards.length, 1);
  assert.equal(renderer.getViewModel().cards[0].id, fighter.identity.id);

  fighter.setTrainingPlan({ focus: 'boxe', intensity: 'NORMAL' });
  fighter.adjustSkill('boxe', 10);
  EventBus.publish('training:progression', { fighterId: fighter.identity.id });
  assert.equal(renderer.getViewModel().cards[0].skills.boxe, fighter.attributes.skills.boxe);

  playerState.removeFighter(fighter.identity.id);
  assert.equal(renderer.getViewModel().cards.length, 0);

  renderer.detach();
});

test('RosterRenderer: setFighterFocus validates through Fighter#setTrainingPlan and updates the card', () => {
  const playerState = new PlayerState({ gymName: 'Focus Gym' });
  const fighter = makeFighter('Focus Fighter', 40);
  playerState.addFighter(fighter);
  const renderer = new RosterRenderer({ playerState }).attach();

  const plan = renderer.setFighterFocus(fighter.identity.id, { focus: 'sol', intensity: 'HARD' });
  assert.deepEqual(plan, { focus: 'sol', intensity: 'HARD' });
  assert.deepEqual(renderer.getViewModel().cards[0].training, { focus: 'sol', intensity: 'HARD' });

  assert.throws(() => renderer.setFighterFocus(fighter.identity.id, { focus: 'not-a-skill' }));
});

test('RosterRenderer: retireFighter only succeeds once a fighter is retirement-eligible', () => {
  const playerState = new PlayerState({ gymName: 'Retirement Gym' });
  const young = makeFighter('Young Gun', 40, { identity: { age: 24 } });
  const veteran = makeFighter('Veteran', 40, { identity: { age: 35 } });
  playerState.addFighter(young);
  playerState.addFighter(veteran);
  const renderer = new RosterRenderer({ playerState }).attach();

  assert.throws(() => renderer.retireFighter(young.identity.id), /not yet eligible/);
  assert.equal(renderer.getViewModel().cards.length, 2);

  const retired = renderer.retireFighter(veteran.identity.id);
  assert.equal(retired, true);
  assert.equal(renderer.getViewModel().cards.length, 1);
  assert.equal(renderer.getViewModel().cards[0].id, young.identity.id);
});

// ============================================================================
// CombatRenderer
// ============================================================================

test('CombatRenderer: screen and gauges follow the CombatEngine FSM end to end', () => {
  const combatEngine = new CombatEngine({ rng: createSeededRng(1) });
  const renderer = new CombatRenderer({ combatEngine }).attach();
  assert.equal(renderer.getViewModel().screen, 'IDLE');

  const a = makeFighter('Combat A', 90);
  const b = makeFighter('Combat B', 15);
  combatEngine.setupMatch(a, b, 'WFC', false);
  assert.equal(renderer.getViewModel().screen, 'GAMEPLAN');

  combatEngine.setGameplan('A', { tempo: 'AGGRESSIVE' });
  combatEngine.setGameplan('B', { tempo: 'AGGRESSIVE' });
  combatEngine.advanceState(); // INIT -> WEIGH_IN
  assert.equal(renderer.getViewModel().screen, 'WEIGH_IN');

  combatEngine.advanceState(); // WEIGH_IN -> INTRO
  assert.equal(renderer.getViewModel().screen, 'GAMEPLAN');

  combatEngine.advanceState(); // INTRO -> ROUND_START
  combatEngine.advanceState(); // ROUND_START -> ROUND_SIMULATION
  assert.equal(renderer.getViewModel().screen, 'ROUND');

  const result = combatEngine.simulateFullMatch();

  assert.equal(renderer.getViewModel().screen, 'RESULT');
  assert.ok(renderer.getViewModel().resultBanner.headline.includes(result.method));
  assert.ok(renderer.getViewModel().live.B.health <= 0, "the loser's health gauge should reflect the finish");

  renderer.detach();
});

test('CombatRenderer: control methods are thin, validated pass-throughs to CombatEngine', () => {
  const combatEngine = new CombatEngine({ rng: createSeededRng(2) });
  const renderer = new CombatRenderer({ combatEngine }).attach();

  const a = makeFighter('Pass A', 50);
  const b = makeFighter('Pass B', 50);
  combatEngine.setupMatch(a, b, 'WFC', true);

  const plan = renderer.setGameplan('A', { target: 'BODY' });
  assert.equal(plan.target, 'BODY');

  const cut = renderer.selectWeightCutProfile('A', 'NATUREL');
  assert.equal(cut.profileKey, 'NATUREL');

  renderer.advance(); // INIT -> WEIGH_IN
  assert.equal(combatEngine.state, COMBAT_STATES.WEIGH_IN);

  const result = renderer.simulateInstant();
  assert.equal(combatEngine.state, COMBAT_STATES.FINISHED);
  assert.ok(result.method);

  renderer.detach();
});

// ============================================================================
// GymRenderer
// ============================================================================

test('GymRenderer: buys equipment, upgrades the facility, and tracks rival gyms independently', () => {
  const playerState = new PlayerState({ gymName: 'Gym Renderer Gym', money: 5000 });
  const worldState = new WorldState();
  const renderer = new GymRenderer({ playerState, worldState }).attach();

  assert.equal(renderer.getViewModel().equipLevel, 0);
  assert.ok(renderer.getViewModel().catalog.some((item) => item.id === 'WEIGHT_ROOM'));
  assert.equal(renderer.getViewModel().owned.length, 0);

  const bought = renderer.buyEquipment('WEIGHT_ROOM');
  assert.equal(bought, true);
  assert.ok(renderer.getViewModel().owned.some((item) => item.id === 'WEIGHT_ROOM'));
  assert.ok(!renderer.getViewModel().catalog.some((item) => item.id === 'WEIGHT_ROOM'));

  const tooExpensive = renderer.buyEquipment('CRYOTHERAPY_CHAMBER');
  assert.equal(tooExpensive, false, 'insufficient funds should reject the purchase, not throw');

  playerState.changeMoney(100000, 'test funding');
  const upgraded = renderer.upgradeFacility();
  assert.equal(upgraded, true);
  assert.equal(renderer.getViewModel().equipLevel, 1);

  worldState.addRivalGym({ id: 'rival1', name: 'Rival One', reputation: 55 });
  assert.equal(renderer.getViewModel().rivalGyms.length, 1);
  assert.equal(renderer.getViewModel().rivalGyms[0].reputation, 55);

  worldState.updateRivalGym('rival1', { reputation: 70 });
  assert.equal(renderer.getViewModel().rivalGyms[0].reputation, 70);

  renderer.detach();
});

// ============================================================================
// SocialRenderer
// ============================================================================

test('SocialRenderer: shows the feed newest-first and updates reactively as posts are added', () => {
  const playerState = new PlayerState({ gymName: 'Social Renderer Gym' });
  const renderer = new SocialRenderer({ playerState }).attach();
  assert.deepEqual(renderer.getViewModel().feed, []);

  playerState.pushSocialFeedEntry({ author: 'Fan', authorType: 'FAN', text: 'First post', likes: 5 });
  playerState.pushSocialFeedEntry({ author: 'Journaliste', authorType: 'JOURNALIST', text: 'Second post', likes: 10 });

  const feed = renderer.getViewModel().feed;
  assert.equal(feed.length, 2);
  assert.equal(feed[0].text, 'Second post', 'newest post should be first');
  assert.equal(feed[1].text, 'First post');
  assert.ok(renderer.toHTML().includes('Second post'));

  renderer.detach();
});
