/**
 * engine/PersonalityEngine.test.js
 * Run with: node --test engine/PersonalityEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import { PersonalityEngine, computeCombinedModifiers, computeActivityWeights, PERSONALITY_EVENTS } from './PersonalityEngine.js';

function makeFighter(name, overrides = {}) {
  return new Fighter({
    identity: { name, ...overrides.identity },
    attributes: {
      skills: { boxe: 40, jambes: 40, sol: 40, soumission: 40, cardio: 40, intelligence: 40 },
      forme: 80,
      moral: 65,
      ...overrides.attributes,
    },
    psychology: { personality: { archetype: 'Cameleon', traits: [] }, ...overrides.psychology },
  });
}

test('computeCombinedModifiers is neutral (all 1) for the default archetype with no traits', () => {
  const fighter = makeFighter('Neutral');
  const modifiers = computeCombinedModifiers(fighter);
  assert.deepEqual(modifiers, {
    fatigueMultiplier: 1,
    salaryDemandMultiplier: 1,
    moraleVolatility: 1,
    progressionMultiplier: 1,
  });
});

test('computeCombinedModifiers multiplies archetype and every trait together', () => {
  const fighter = makeFighter('Volatile', {
    psychology: { personality: { archetype: 'Showman', traits: ['Impulsif', 'Fetard'] } },
  });
  const modifiers = computeCombinedModifiers(fighter);

  const archetype = BALANCE.PERSONALITY.ARCHETYPES.Showman;
  const impulsif = BALANCE.PERSONALITY.TRAITS.Impulsif;
  const fetard = BALANCE.PERSONALITY.TRAITS.Fetard;

  const expected = (dim) => archetype[dim] * impulsif[dim] * fetard[dim];
  assert.ok(Math.abs(modifiers.fatigueMultiplier - expected('fatigueMultiplier')) < 1e-9);
  assert.ok(Math.abs(modifiers.moraleVolatility - expected('moraleVolatility')) < 1e-9);
  assert.ok(Math.abs(modifiers.progressionMultiplier - expected('progressionMultiplier')) < 1e-9);
  assert.ok(Math.abs(modifiers.salaryDemandMultiplier - expected('salaryDemandMultiplier')) < 1e-9);
});

test('computeActivityWeights (Phase 3.1 v2.1): PHYSIO_REST never drops below its minAttractionShare floor, for every archetype, with no traits', () => {
  const minShare = BALANCE.WEEKLY_PLANNING.ACTIVITIES.PHYSIO_REST.minAttractionShare;
  for (const archetype of Object.keys(BALANCE.PERSONALITY.ARCHETYPES)) {
    const fighter = makeFighter(archetype, { psychology: { personality: { archetype, traits: [] } } });
    const weights = computeActivityWeights(fighter);
    const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
    const share = weights.PHYSIO_REST / total;
    assert.ok(share >= minShare - 1e-9, `${archetype}: PHYSIO_REST share ${share} should be >= the ${minShare} floor`);
  }
});

test('computeActivityWeights (Phase 3.1 v2.1): the floor only raises PHYSIO_REST\'s weight, never the other 4 activities\' relative proportions to each other', () => {
  // Guerrier's base weights: TECHNIQUE 2, SPARRING 5, VIDEO_PREP 1, MEDIA_SPONSORS 1, PHYSIO_REST 1 (well under the floor).
  const fighter = makeFighter('Guerrier', { psychology: { personality: { archetype: 'Guerrier', traits: [] } } });
  const weights = computeActivityWeights(fighter);
  const base = BALANCE.PERSONALITY.ARCHETYPES.Guerrier.activityWeights;

  assert.equal(weights.TECHNIQUE, base.TECHNIQUE);
  assert.equal(weights.SPARRING, base.SPARRING);
  assert.equal(weights.VIDEO_PREP, base.VIDEO_PREP);
  assert.equal(weights.MEDIA_SPONSORS, base.MEDIA_SPONSORS);
  assert.ok(weights.PHYSIO_REST > base.PHYSIO_REST, 'the floor should have raised PHYSIO_REST above its base weight');
});

test('computeActivityWeights (Phase 3.1 v2.1): an archetype already at/above the floor (Cameleon, base 20%) is left untouched', () => {
  const fighter = makeFighter('Cameleon', { psychology: { personality: { archetype: 'Cameleon', traits: [] } } });
  const weights = computeActivityWeights(fighter);
  const base = BALANCE.PERSONALITY.ARCHETYPES.Cameleon.activityWeights;
  assert.deepEqual(weights, { ...base });
});

test('training:progression applies a silent extra skill/form nudge sized by the fighter personality', () => {
  const fighter = makeFighter('Trainee', {
    psychology: { personality: { archetype: 'Showman', traits: ['Impulsif', 'Fetard'] } },
  });
  const player = new PlayerState({ gymName: 'Personality Gym' });
  player.addFighter(fighter);
  const engine = new PersonalityEngine().attach(player);

  const modifiers = computeCombinedModifiers(fighter);
  const boxeBefore = fighter.attributes.skills.boxe;
  const formeBefore = fighter.attributes.forme;

  const events = [];
  const unsub = EventBus.subscribe(PERSONALITY_EVENTS.MODIFIER_APPLIED, (p) => events.push(p));
  EventBus.publish('training:progression', { fighterId: fighter.identity.id, focus: 'boxe', gain: 2, intensity: 'NORMAL' });
  unsub();
  engine.detach();

  const expectedExtraGain = 2 * (modifiers.progressionMultiplier - 1);
  const expectedExtraForm = -BALANCE.PERSONALITY.TRAINING_FATIGUE_REFERENCE * (modifiers.fatigueMultiplier - 1);

  assert.ok(Math.abs(fighter.attributes.skills.boxe - (boxeBefore + expectedExtraGain)) < 1e-9);
  assert.ok(Math.abs(fighter.attributes.forme - (formeBefore + expectedExtraForm)) < 1e-9);
  assert.equal(events.length, 1);
  assert.equal(events[0].fighterId, fighter.identity.id);
});

test('combat:finished amplifies morale swings for volatile personalities and dampens them for calm ones', () => {
  // Two fighters with an equally volatile/calm counterpart, so we can isolate
  // PersonalityEngine's *additional* nudge from CombatEngine's own base
  // WIN_FIGHT/LOSE_FIGHT morale adjustment (applied manually here, exactly as
  // CombatEngine.POST_MATCH_REWARDS does before publishing combat:finished).
  const volatileWinner = makeFighter('Volatile Winner', {
    psychology: { personality: { archetype: 'Showman', traits: ['Impulsif'] } },
  });
  const calmWinner = makeFighter('Calm Winner', {
    psychology: { personality: { archetype: 'Veteran', traits: ['Calme'] } },
  });
  const player = new PlayerState({ gymName: 'Morale Gym' });
  player.addFighter(volatileWinner);
  player.addFighter(calmWinner);
  const engine = new PersonalityEngine().attach(player);

  const volatileModifiers = computeCombinedModifiers(volatileWinner);
  const calmModifiers = computeCombinedModifiers(calmWinner);
  assert.ok(volatileModifiers.moraleVolatility > 1, 'sanity: volatile fighter should have volatility > 1');
  assert.ok(calmModifiers.moraleVolatility < 1, 'sanity: calm fighter should have volatility < 1');

  // Simulate CombatEngine's own base morale bump for a win, for both fighters.
  volatileWinner.adjustMorale(BALANCE.MORALE.EVENTS.WIN_FIGHT);
  calmWinner.adjustMorale(BALANCE.MORALE.EVENTS.WIN_FIGHT);
  const volatileAfterBase = volatileWinner.attributes.moral;
  const calmAfterBase = calmWinner.attributes.moral;

  EventBus.publish('combat:finished', { fighters: { A: volatileWinner.identity.id, B: 'outsider' }, winner: 'A' });
  EventBus.publish('combat:finished', { fighters: { A: calmWinner.identity.id, B: 'outsider' }, winner: 'A' });
  engine.detach();

  assert.ok(
    volatileWinner.attributes.moral > volatileAfterBase,
    "a volatile winner's PersonalityEngine nudge should add extra morale on top of the base win bonus"
  );
  assert.ok(
    calmWinner.attributes.moral < calmAfterBase,
    "a calm winner's PersonalityEngine nudge should shave some morale off the base win bonus (dampened enthusiasm)"
  );
});

test('economy:insolvent penalizes high-salary-demand personalities more than loyal/humble ones', () => {
  const highMaintenance = makeFighter('Diva', { psychology: { personality: { archetype: 'Mercenaire', traits: ['Arrogant'] } } });
  const lowMaintenance = makeFighter('Rock', { psychology: { personality: { archetype: 'Guerrier', traits: ['Loyal'] } } });
  const player = new PlayerState({ gymName: 'Insolvency Gym' });
  player.addFighter(highMaintenance);
  player.addFighter(lowMaintenance);
  const engine = new PersonalityEngine().attach(player);

  const highBefore = highMaintenance.attributes.moral;
  const lowBefore = lowMaintenance.attributes.moral;

  EventBus.publish('economy:insolvent', { balance: -6000, threshold: -5000 });
  engine.detach();

  assert.ok(highMaintenance.attributes.moral < highBefore, 'a high-maintenance personality should lose morale in a crisis');
  assert.ok(
    highBefore - highMaintenance.attributes.moral > Math.abs(lowMaintenance.attributes.moral - lowBefore),
    'the high-maintenance fighter should be hit harder than the loyal/low-maintenance one'
  );
});

test('detach() stops the engine from reacting to further events', () => {
  const fighter = makeFighter('Ghost', { psychology: { personality: { archetype: 'Showman', traits: ['Fetard'] } } });
  const player = new PlayerState({ gymName: 'Detach Gym' });
  player.addFighter(fighter);
  const engine = new PersonalityEngine().attach(player);
  engine.detach();

  const formeBefore = fighter.attributes.forme;
  EventBus.publish('training:progression', { fighterId: fighter.identity.id, focus: 'boxe', gain: 2, intensity: 'NORMAL' });

  assert.equal(fighter.attributes.forme, formeBefore, 'no nudge should be applied after detach()');
});
