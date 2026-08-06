/**
 * engine/PersonalityEngine.js — Pyramide Emergente, Niveau 1 (moteur de base)
 * ---------------------------------------------------------------------------
 * Deterministic engine that turns a Fighter's Personality (archetype +
 * traits, see models/Fighter.js) into silent, mechanical nudges on top of
 * whatever TrainingEngine/CombatEngine/EconomyEngine already did — never a
 * narrative consequence of its own (that is StoryEngine/NarrativeEngine's
 * job, two levels up the pyramid).
 *
 * Absolute decoupling: this file imports only core/EventBus.js and
 * data/balance.js. It does not import CombatEngine.js, TrainingEngine.js or
 * EconomyEngine.js — it listens for their event *names* as plain string
 * literals, which is the minimum coupling any pub/sub subscriber needs to
 * a channel, not a dependency on those modules' code. Fighter instances are
 * State/Models data, reached through the injected PlayerState, not through
 * another engine.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

/** Event names published on EventBus by PersonalityEngine. Import instead of raw strings. */
export const PERSONALITY_EVENTS = Object.freeze({
  /** Technical/telemetry signal (not narrative) — fired after every nudge, mainly for tests/inspection. */
  MODIFIER_APPLIED: 'personality:modifier_applied',
});

const MODIFIER_DIMENSIONS = Object.freeze([
  'fatigueMultiplier',
  'salaryDemandMultiplier',
  'moraleVolatility',
  'progressionMultiplier',
]);

/**
 * Combines a fighter's archetype and every trait into one multiplier
 * profile. Pure and deterministic — no RNG, no side effects — so it can be
 * called from anywhere that only knows BALANCE and a Fighter (Models data),
 * exactly matching the decoupling rule. Exported so other Level 1/2 engines
 * (e.g. StoryEngine) can derive the same facts independently, without ever
 * importing this module's reactive class.
 *
 * @param {Object} fighter - A Fighter instance (duck-typed: needs psychology.personality).
 * @returns {{ fatigueMultiplier: number, salaryDemandMultiplier: number, moraleVolatility: number, progressionMultiplier: number }}
 */
export function computeCombinedModifiers(fighter) {
  const { ARCHETYPES, TRAITS } = BALANCE.PERSONALITY;
  const profile = Object.fromEntries(MODIFIER_DIMENSIONS.map((dim) => [dim, 1]));

  const archetypeProfile = ARCHETYPES[fighter.psychology.personality.archetype];
  for (const dim of MODIFIER_DIMENSIONS) {
    profile[dim] *= archetypeProfile[dim];
  }

  for (const trait of fighter.psychology.personality.traits) {
    const traitProfile = TRAITS[trait];
    if (!traitProfile) continue;
    for (const dim of MODIFIER_DIMENSIONS) {
      profile[dim] *= traitProfile[dim];
    }
  }

  return profile;
}

/**
 * Phase 3.1 v2 ("Emergence, Moral & Personnalites Vibrantes"): combines a
 * fighter's archetype (base weight per WEEKLY_PLANNING.ACTIVITIES key) and
 * every trait that defines its own activityWeights (a multiplicative
 * modulation on top, default 1 = no change for both traits without an
 * activityWeights table and for any archetype/trait entry silently missing
 * one of the 5 activity keys) into one weighted-pick profile. Pure and
 * deterministic, same shape/rationale as computeCombinedModifiers above —
 * consumed by tools/SimRunner.js's coach-AI for a weighted-random (not
 * scripted) activity choice per weekly slot.
 *
 * Phase 3.1 v2.1 ("Test A/B"): after combining, enforces
 * WEEKLY_PLANNING.ACTIVITIES.PHYSIO_REST.minAttractionShare as a floor on
 * PHYSIO_REST's *share* of the total (not a fixed weight, so it scales with
 * however extreme the other 4 activities' combined pull is) — raising
 * PHYSIO_REST's own weight just enough to hit the floor, never touching the
 * other 4 activities' relative weights against each other. This is a soft,
 * algorithmic floor applied identically to every archetype/trait
 * combination, not a per-archetype scripted override: a fighter can still
 * probabilistically go many slots without resting, just never because their
 * personality mathematically assigned resting a near-zero chance.
 *
 * @param {Object} fighter - A Fighter instance (duck-typed: needs psychology.personality).
 * @returns {Object} { [activityKey]: weight } over Object.keys(BALANCE.WEEKLY_PLANNING.ACTIVITIES).
 */
export function computeActivityWeights(fighter) {
  const { ARCHETYPES, TRAITS } = BALANCE.PERSONALITY;
  const activityKeys = Object.keys(BALANCE.WEEKLY_PLANNING.ACTIVITIES);

  const archetypeWeights = ARCHETYPES[fighter.psychology.personality.archetype].activityWeights;
  const weights = {};
  for (const key of activityKeys) weights[key] = archetypeWeights?.[key] ?? 1;

  for (const trait of fighter.psychology.personality.traits) {
    const traitWeights = TRAITS[trait]?.activityWeights;
    if (!traitWeights) continue;
    for (const key of activityKeys) weights[key] *= traitWeights[key] ?? 1;
  }

  const minShare = BALANCE.WEEKLY_PLANNING.ACTIVITIES.PHYSIO_REST.minAttractionShare;
  if (minShare) {
    const otherWeightSum = activityKeys
      .filter((key) => key !== 'PHYSIO_REST')
      .reduce((sum, key) => sum + weights[key], 0);
    const minPhysioRestWeight = (minShare * otherWeightSum) / (1 - minShare);
    weights.PHYSIO_REST = Math.max(weights.PHYSIO_REST, minPhysioRestWeight);
  }

  return weights;
}

class PersonalityEngine {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.playerState] - A PlayerState instance. Can
   *   also be supplied later via attach().
   */
  constructor(options = {}) {
    this.playerState = options.playerState ?? null;
    this._unsubs = [];
  }

  /**
   * @param {Object} [playerState] - Rebinds the target PlayerState if provided.
   * @returns {PersonalityEngine} this, for chaining.
   */
  attach(playerState) {
    if (playerState) this.playerState = playerState;

    this._unsubs.push(EventBus.subscribe('training:progression', (payload) => this._onTrainingProgression(payload)));
    this._unsubs.push(EventBus.subscribe('combat:finished', (payload) => this._onCombatFinished(payload)));
    this._unsubs.push(EventBus.subscribe('economy:insolvent', () => this._onInsolvency()));

    return this;
  }

  /** Unsubscribes from every event this engine listens to. */
  detach() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
  }

  // ---- event handlers -----------------------------------------------------

  _onTrainingProgression({ fighterId, focus, gain }) {
    const fighter = this._findFighter(fighterId);
    if (!fighter || !focus || typeof gain !== 'number') return;

    const modifiers = computeCombinedModifiers(fighter);
    const ref = BALANCE.PERSONALITY;

    const extraGain = gain * (modifiers.progressionMultiplier - 1);
    if (extraGain !== 0) fighter.adjustSkill(focus, extraGain);

    const extraFormDelta = -ref.TRAINING_FATIGUE_REFERENCE * (modifiers.fatigueMultiplier - 1);
    if (extraFormDelta !== 0) fighter.adjustForm(extraFormDelta);

    this._announce(fighter, { source: 'training', extraGain, extraFormDelta });
  }

  _onCombatFinished(payload) {
    for (const key of ['A', 'B']) {
      const fighter = this._findFighter(payload.fighters?.[key]);
      if (!fighter) continue;

      const modifiers = computeCombinedModifiers(fighter);
      const isDraw = payload.winner === null;
      const baseSwing = isDraw ? 0 : payload.winner === key ? 1 : -1;
      const extraMorale = BALANCE.PERSONALITY.MORALE_SWING_REFERENCE * baseSwing * (modifiers.moraleVolatility - 1);
      if (extraMorale !== 0) fighter.adjustMorale(extraMorale);

      this._announce(fighter, { source: 'combat', extraMorale });
    }
  }

  _onInsolvency() {
    if (!this.playerState) return;

    for (const fighter of this.playerState.roster) {
      const modifiers = computeCombinedModifiers(fighter);
      const extraMorale = -BALANCE.PERSONALITY.INSOLVENCY_MORALE_REFERENCE * (modifiers.salaryDemandMultiplier - 1);
      if (extraMorale !== 0) fighter.adjustMorale(extraMorale);

      this._announce(fighter, { source: 'economy', extraMorale });
    }
  }

  // ---- internals ------------------------------------------------------------

  _findFighter(fighterId) {
    if (!fighterId) return null;
    return this.playerState?.roster.find((fighter) => fighter.identity.id === fighterId) ?? null;
  }

  _announce(fighter, effects) {
    EventBus.publish(PERSONALITY_EVENTS.MODIFIER_APPLIED, { fighterId: fighter.identity.id, ...effects });
  }
}

const instance = new PersonalityEngine();
export default instance;
export { PersonalityEngine };
