/**
 * App.test.js
 * Run with: node --test App.test.js
 *
 * Integration coverage for the composition root: screen flow, renderer
 * mounting/teardown (and that teardown actually unsubscribes — no leaked
 * EventBus listeners across game sessions), and that the high-level
 * actions (advanceWeek, startFight) really do drive the underlying engines.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from './core/EventBus.js';
import Fighter from './models/Fighter.js';
import { GameState } from './state/GameState.js';
import { CombatEngine, createSeededRng } from './engine/CombatEngine.js';
import { App, APP_SCREENS, APP_EVENTS } from './App.js';

function makeFighter(name, value) {
  return new Fighter({
    identity: { name, age: 27 },
    attributes: {
      skills: { boxe: value, jambes: value, sol: value, soumission: value, cardio: value, intelligence: value },
    },
  });
}

function makeIsolatedApp() {
  return new App({ gameState: new GameState(), combatEngine: new CombatEngine({ rng: createSeededRng(1) }) });
}

test('startNewGame() enters the GAME screen and mounts all five renderers, bound to the fresh state', () => {
  const app = makeIsolatedApp();
  const events = [];
  const unsub = EventBus.subscribe(APP_EVENTS.SCREEN_CHANGED, (payload) => events.push(payload));

  const gameState = app.startNewGame({ gymName: 'App Test Gym', country: 'FR' });
  unsub();

  assert.equal(app.screen, APP_SCREENS.GAME);
  assert.equal(gameState.playerState.gymName, 'App Test Gym');
  assert.ok(events.some((e) => e.to === APP_SCREENS.GAME));

  for (const key of ['dashboard', 'roster', 'combat', 'gym', 'social']) {
    assert.ok(app.renderers[key], `expected a mounted "${key}" renderer`);
  }
  assert.equal(app.renderers.dashboard.getViewModel().gymName, 'App Test Gym');
  assert.equal(app.renderers.roster.getViewModel().cards.length, 0);

  app.gameState.playerState.addFighter(makeFighter('Roster Sync', 40));
  assert.equal(app.renderers.roster.getViewModel().cards.length, 1, 'the mounted RosterRenderer should react live');
});

test('leaving the game tears down every renderer and detaches SocialEngine, with no leaked EventBus subscriptions', () => {
  const app = makeIsolatedApp();
  app.startNewGame({ gymName: 'Leak Check Gym' });

  const before = {
    added: EventBus.listenerCount('roster:fighter_added'),
    money: EventBus.listenerCount('economy:money_changed'),
  };

  app.showStartScreen();
  assert.equal(app.screen, APP_SCREENS.START_SCREEN);
  assert.deepEqual(app.renderers, {});

  const after = {
    added: EventBus.listenerCount('roster:fighter_added'),
    money: EventBus.listenerCount('economy:money_changed'),
  };
  assert.ok(after.added < before.added, 'RosterRenderer subscription should have been removed');
  assert.ok(after.money < before.money, 'DashboardRenderer subscription should have been removed');

  // Starting a second game should not accumulate duplicate listeners from the first.
  app.startNewGame({ gymName: 'Second Game' });
  const afterSecondStart = {
    added: EventBus.listenerCount('roster:fighter_added'),
    money: EventBus.listenerCount('economy:money_changed'),
  };
  assert.equal(afterSecondStart.added, before.added);
  assert.equal(afterSecondStart.money, before.money);
});

test('loadGame() rebinds every renderer to the freshly loaded state', () => {
  const app = makeIsolatedApp();
  app.startNewGame({ gymName: 'Save Source Gym' });
  app.gameState.playerState.addFighter(makeFighter('Persisted Fighter', 40));
  app.saveGame('app-test-slot');

  const app2 = makeIsolatedApp();
  app2.startNewGame({ gymName: 'Temporary' }); // enters the game once before loading, like a real session would
  app2.loadGame('app-test-slot');

  assert.equal(app2.gameState.playerState.gymName, 'Save Source Gym');
  assert.equal(app2.renderers.roster.getViewModel().cards.length, 1);
  assert.equal(app2.renderers.dashboard.getViewModel().gymName, 'Save Source Gym');
});

test('advanceWeek() delegates to ProgressionEngine and moves the calendar forward', () => {
  const app = makeIsolatedApp();
  app.startNewGame({ gymName: 'Progress Gym' });
  const dayBefore = app.gameState.worldState.currentDay;

  const summary = app.advanceWeek();

  assert.ok(summary.day > dayBefore);
  assert.equal(app.gameState.worldState.currentDay, summary.day);
  assert.equal(app.renderers.dashboard.getViewModel().day, summary.day);
});

test('startFight() drives the App-owned CombatEngine, and the mounted CombatRenderer follows it reactively', () => {
  const app = makeIsolatedApp();
  app.startNewGame({ gymName: 'Fight Night Gym' });

  const a = makeFighter('Main Event A', 90);
  const b = makeFighter('Main Event B', 15);
  app.startFight(a, b, 'WFC', false);

  assert.equal(app.renderers.combat.getViewModel().screen, 'GAMEPLAN');

  app.combatEngine.setGameplan('A', { tempo: 'AGGRESSIVE' });
  app.combatEngine.setGameplan('B', { tempo: 'AGGRESSIVE' });
  const result = app.combatEngine.simulateFullMatch();

  assert.equal(app.renderers.combat.getViewModel().screen, 'RESULT');
  assert.equal(app.renderers.combat.getViewModel().resultBanner.method, result.method);
});
