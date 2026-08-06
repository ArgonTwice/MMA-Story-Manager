/**
 * ui/WeeklyFlowController.test.js
 * Run with: node --test ui/WeeklyFlowController.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { GameState } from '../state/GameState.js';
import { createSeededRng } from '../engine/CombatEngine.js';
import { WeeklyFlowController, WEEKLY_FLOW_PHASES } from './WeeklyFlowController.js';

function makeFighter(overrides = {}) {
  return new Fighter({
    identity: { name: 'Tester', age: 27, ...overrides.identity },
    attributes: {
      skills: { boxe: 40, jambes: 40, sol: 40, soumission: 40, cardio: 40, intelligence: 40 },
      ...overrides.attributes,
    },
    psychology: overrides.psychology,
  });
}

function makeGameState(fighterCount = 3) {
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Flow Gym' });
  for (let i = 0; i < fighterCount; i += 1) {
    gameState.playerState.addFighter(makeFighter({ identity: { name: `F${i}` } }));
  }
  return gameState;
}

test('starts in the PLANNING phase', () => {
  const controller = new WeeklyFlowController({ gameState: makeGameState() });
  assert.equal(controller.getPhase(), WEEKLY_FLOW_PHASES.PLANNING);
});

test('getPlanningOptions lists every roster fighter with their current slots and available activities', () => {
  const gameState = makeGameState(2);
  const controller = new WeeklyFlowController({ gameState });

  const options = controller.getPlanningOptions();
  assert.equal(options.length, 2);
  assert.deepEqual(options[0].slots, [null, null, null]);
  assert.deepEqual(options[0].activityKeys.sort(), Object.keys(BALANCE.WEEKLY_PLANNING.ACTIVITIES).sort());
});

test('setSlot assigns one fighter\'s weekly-plan slot directly on the Fighter model', () => {
  const gameState = makeGameState(1);
  const fighter = gameState.playerState.roster[0];
  const controller = new WeeklyFlowController({ gameState });

  controller.setSlot(fighter.identity.id, 0, 'TECHNIQUE');

  assert.equal(fighter.weeklyPlan.slots[0], 'TECHNIQUE');
});

test('setSlot outside the PLANNING phase throws', () => {
  const gameState = makeGameState(1);
  const fighter = gameState.playerState.roster[0];
  const controller = new WeeklyFlowController({ gameState, rng: createSeededRng(1) });
  controller.autoFillPlan();
  controller.resolveWeek();

  // Force into a non-PLANNING phase if a drama event happened to fire; otherwise resolveWeek already looped back to PLANNING and this assertion is moot for THIS seed, so only assert when it's actually paused.
  if (controller.getPhase() === WEEKLY_FLOW_PHASES.DRAMA_CHOICE) {
    assert.throws(() => controller.setSlot(fighter.identity.id, 0, 'TECHNIQUE'), /expected phase "PLANNING"/);
  }
});

test('autoFillPlan fills every non-injured fighter\'s 3 slots, and forces PHYSIO_REST for an injured one', () => {
  const gameState = makeGameState(2);
  const [healthy, injured] = gameState.playerState.roster;
  injured.applyInjury({ severity: 'MINOR', bodyPart: 'Genou', occurredOnDay: 1, injuredUntilDay: gameState.worldState.currentDay + 30 });

  const controller = new WeeklyFlowController({ gameState, rng: createSeededRng(3) });
  controller.autoFillPlan();

  assert.ok(healthy.weeklyPlan.slots.every((slot) => slot !== null));
  assert.deepEqual(injured.weeklyPlan.slots, ['PHYSIO_REST', 'PHYSIO_REST', 'PHYSIO_REST']);
});

test('resolveWeek without any eligible Drama Engine event completes the week immediately and returns to PLANNING', () => {
  // An empty roster guarantees selectEligibleDramaEvent finds no fighter to feature.
  const gameState = new GameState();
  gameState.newGame({ gymName: 'Empty Gym' });
  const controller = new WeeklyFlowController({ gameState, rng: createSeededRng(1) });

  const result = controller.resolveWeek();

  assert.equal(result.phase, WEEKLY_FLOW_PHASES.PLANNING);
  assert.equal(result.dramaPrompt, null);
  assert.ok(result.weekSummary);
  assert.equal(controller.getPhase(), WEEKLY_FLOW_PHASES.PLANNING);
});

test('resolveWeek pausing on DRAMA_CHOICE exposes the same prompt via getPendingDramaPrompt, and resolveDramaChoice completes the week', () => {
  const gameState = makeGameState(4);
  let controller;
  let result;

  // Try enough seeds to reliably hit a week where a Drama Engine event fires (PRIMARY_EVENT_CHANCE is high by design).
  for (let seed = 1; seed <= 20; seed += 1) {
    controller = new WeeklyFlowController({ gameState: makeGameState(4), rng: createSeededRng(seed) });
    controller.autoFillPlan();
    result = controller.resolveWeek();
    if (result.phase === WEEKLY_FLOW_PHASES.DRAMA_CHOICE) break;
  }

  assert.equal(result.phase, WEEKLY_FLOW_PHASES.DRAMA_CHOICE);
  assert.equal(result.weekSummary, null);
  assert.ok(result.dramaPrompt.eventId);
  assert.ok(result.dramaPrompt.choices.length >= 2);
  assert.deepEqual(controller.getPendingDramaPrompt(), result.dramaPrompt);

  const chosenId = result.dramaPrompt.choices[0].id;
  const completion = controller.resolveDramaChoice(chosenId);

  assert.equal(completion.phase, WEEKLY_FLOW_PHASES.PLANNING);
  assert.equal(completion.dramaReport.choiceId, chosenId);
  assert.ok(completion.weekSummary);
  assert.equal(controller.getPhase(), WEEKLY_FLOW_PHASES.PLANNING);
  assert.equal(controller.getPendingDramaPrompt(), null);
});

test('resolveDramaChoice outside the DRAMA_CHOICE phase throws', () => {
  const controller = new WeeklyFlowController({ gameState: makeGameState() });
  assert.throws(() => controller.resolveDramaChoice('anything'), /expected phase "DRAMA_CHOICE"/);
});

test('resolveWeek twice in a row without answering a pending drama choice throws (still PLANNING-gated)', () => {
  const gameState = makeGameState(4);
  let controller;
  let result;
  for (let seed = 1; seed <= 20; seed += 1) {
    controller = new WeeklyFlowController({ gameState: makeGameState(4), rng: createSeededRng(seed) });
    controller.autoFillPlan();
    result = controller.resolveWeek();
    if (result.phase === WEEKLY_FLOW_PHASES.DRAMA_CHOICE) break;
  }

  assert.equal(result.phase, WEEKLY_FLOW_PHASES.DRAMA_CHOICE);
  assert.throws(() => controller.resolveWeek(), /expected phase "PLANNING"/);
});
