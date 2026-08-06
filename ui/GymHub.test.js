/**
 * ui/GymHub.test.js
 * Run with: node --test ui/GymHub.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import { GymHub } from './GymHub.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'Tester', age: 27, ...overrides.identity },
    attributes: overrides.attributes,
  });
}

test('getSnapshot reports the gym\'s money/reputation/hype/calendar and an empty roster/alerts for a fresh gym', () => {
  const playerState = new PlayerState({ gymName: 'Hub Gym', money: 12000, reputation: 40, hype: 20 });
  const worldState = new WorldState();
  const hub = new GymHub({ playerState, worldState });

  const snapshot = hub.getSnapshot();

  assert.equal(snapshot.gym.name, 'Hub Gym');
  assert.equal(snapshot.gym.money, 12000);
  assert.equal(snapshot.gym.reputation, 40);
  assert.equal(snapshot.gym.hype, 20);
  assert.deepEqual(snapshot.roster, []);
  assert.deepEqual(snapshot.alerts, []);
  assert.equal(snapshot.scheduledFight, null);
  assert.equal(snapshot.pendingDramaChoice, null);
});

test('getSnapshot flags an injured fighter and a heavily-fatigued fighter as alerts', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const injured = makeFighter({ identity: { name: 'Hurt Fighter' } });
  injured.applyInjury({ severity: 'MINOR', bodyPart: 'Genou', occurredOnDay: 1, injuredUntilDay: worldState.currentDay + 30 });
  const fatigued = makeFighter({ identity: { name: 'Tired Fighter' }, attributes: { physicalFatigue: 90 } });
  playerState.addFighter(injured);
  playerState.addFighter(fatigued);

  const hub = new GymHub({ playerState, worldState });
  const snapshot = hub.getSnapshot();

  const injuredEntry = snapshot.roster.find((f) => f.name === 'Hurt Fighter');
  const fatiguedEntry = snapshot.roster.find((f) => f.name === 'Tired Fighter');
  assert.equal(injuredEntry.injured, true);
  assert.equal(fatiguedEntry.needsRest, true);

  const alertKinds = snapshot.alerts.map((a) => a.kind);
  assert.ok(alertKinds.includes('INJURY'));
  assert.ok(alertKinds.includes('FATIGUE'));
});

test('setScheduledFight/clearScheduledFight mirror into the snapshot without booking anything themselves', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const fighterA = makeFighter({ identity: { name: 'Corner A' } });
  const fighterB = makeFighter({ identity: { name: 'Corner B' } });
  playerState.addFighter(fighterA);
  playerState.addFighter(fighterB);

  const hub = new GymHub({ playerState, worldState });
  hub.setScheduledFight({ fighterAId: fighterA.identity.id, fighterBId: fighterB.identity.id, orgId: 'WFC', isTitle: true });

  const snapshot = hub.getSnapshot();
  assert.equal(snapshot.scheduledFight.fighterA.name, 'Corner A');
  assert.equal(snapshot.scheduledFight.fighterB.name, 'Corner B');
  assert.equal(snapshot.scheduledFight.isTitle, true);

  hub.clearScheduledFight();
  assert.equal(hub.getSnapshot().scheduledFight, null);
});

test('setPendingDramaChoice/clearPendingDramaChoice mirror a Drama Engine selection and its alert', () => {
  const playerState = new PlayerState();
  const worldState = new WorldState();
  const hub = new GymHub({ playerState, worldState });

  const fighter = makeFighter({ identity: { name: 'Featured Fighter' } });
  const selection = {
    event: { id: 'SOME_EVENT', category: 'GYM_LIFE', choices: [{ id: 'A', label: 'Option A' }, { id: 'B', label: 'Option B' }] },
    fighter,
  };
  hub.setPendingDramaChoice(selection);

  const snapshot = hub.getSnapshot();
  assert.equal(snapshot.pendingDramaChoice.eventId, 'SOME_EVENT');
  assert.equal(snapshot.pendingDramaChoice.fighterName, 'Featured Fighter');
  assert.equal(snapshot.pendingDramaChoice.choices.length, 2);
  assert.ok(snapshot.alerts.some((a) => a.kind === 'DRAMA_CHOICE'));

  hub.clearPendingDramaChoice();
  assert.equal(hub.getSnapshot().pendingDramaChoice, null);
});

test('toText renders a non-empty, readable summary that includes the roster and any alerts', () => {
  const playerState = new PlayerState({ gymName: 'Text Gym' });
  const worldState = new WorldState();
  playerState.addFighter(makeFighter({ identity: { name: 'Roster Fighter' } }));
  const hub = new GymHub({ playerState, worldState });

  const text = hub.toText();

  assert.ok(text.includes('Text Gym'));
  assert.ok(text.includes('Roster Fighter'));
});
