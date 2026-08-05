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

test('the Pyramide Emergente engines are live for the whole GAME session, with no leaked subscriptions across sessions', () => {
  const app = makeIsolatedApp();

  const before = EventBus.listenerCount('combat:finished');
  app.startNewGame({ gymName: 'Pyramid Session Gym' });
  const duringGame = EventBus.listenerCount('combat:finished');
  // CombatRenderer + PersonalityEngine + RelationshipEngine + StoryEngine + WorldMemory all listen to combat:finished.
  assert.ok(duringGame >= before + 5, `expected at least 5 new combat:finished subscribers, went from ${before} to ${duringGame}`);

  app.showStartScreen();
  assert.equal(EventBus.listenerCount('combat:finished'), before, 'every Pyramide Emergente subscription should be released on showStartScreen()');

  app.startNewGame({ gymName: 'Second Pyramid Session' });
  assert.equal(
    EventBus.listenerCount('combat:finished'),
    duringGame,
    'starting a second game should not accumulate duplicate Pyramide Emergente subscriptions'
  );
});

test('repeated real fights during a session build the relationship graph and produce narrative content in the social feed / world journal', () => {
  const app = makeIsolatedApp();
  app.startNewGame({ gymName: 'Emergent Session Gym' });

  const proud = new Fighter({
    identity: { name: 'Le Fier', age: 27 },
    attributes: { skills: { boxe: 45, jambes: 45, sol: 45, soumission: 45, cardio: 45, intelligence: 45 } },
    psychology: { ego: 85 },
  });
  const nemesis = new Fighter({
    identity: { name: 'Nemesis', age: 27 },
    attributes: { skills: { boxe: 60, jambes: 60, sol: 60, soumission: 60, cardio: 60, intelligence: 60 } },
  });
  app.gameState.playerState.addFighter(proud);
  app.gameState.playerState.addFighter(nemesis);

  for (let i = 0; i < 4; i += 1) {
    app.startFight(proud, nemesis, 'WFC', false);
    app.renderers.combat.setGameplan('A', { target: 'BODY', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
    app.renderers.combat.setGameplan('B', { target: 'BODY', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
    app.combatEngine.simulateFullMatch();
  }

  const relationship = app.gameState.worldState.getRelationship(proud.identity.id, nemesis.identity.id);
  assert.ok(relationship, 'RelationshipEngine should have built a relationship record from 4 real fights');
  // At least one COMBAT history entry per fight; the emergent feedback loop
  // (a PROVOCATION-toned narrative beat feeding back into the relationship)
  // can add more on top, so this is a floor, not an exact count.
  assert.ok(relationship.history.length >= 4, `expected at least 4 history entries, got ${relationship.history.length}`);
  assert.ok(relationship.gauges.tension > 0);

  const socialPostCount = app.gameState.playerState.socialFeed.length;
  const journalIncidentCount = app.gameState.worldState.globalEvents.filter((e) => e.type === 'NARRATIVE_INCIDENT').length;
  assert.ok(
    socialPostCount > 0 || journalIncidentCount > 0,
    'StoryEngine + NarrativeEngine should have produced at least one narrative beat somewhere'
  );

  assert.ok(app.gameState.worldState.getRecord('biggestFight').value > 0, 'WorldMemory should have recorded a biggest-fight value');
});
