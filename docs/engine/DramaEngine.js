/**
 * engine/DramaEngine.js
 * ---------------------------------------------------------------------------
 * Phase 3.2 ("Simulation Drama Engine — Evenements Systemiques, Medias &
 * Sponsors"): resolves declarative weekly drama events (data/events.js —
 * Fighter Stories, Media Engine, Sponsors/Marche Noir, Rivalites, Gym Life)
 * against one roster fighter, applying whichever choice is picked. Pure
 * function over State + Models + data/events.js, driven entirely by
 * BALANCE.DRAMA and each event's own declarative conditions/weightSignals/
 * effects — no gameplay constant is hardcoded here.
 *
 * EventWeight = BaseChance * Context * FighterTraits * WorldState, per the
 * spec: each event's `weightSignals` names which of those three multiplier
 * families it draws from (see SIGNAL_EVALUATORS) — Context and WorldState
 * collapse into the same multiplier chain here since the spec didn't
 * distinguish them mechanically, only conceptually.
 *
 * Distinct from the pre-existing engine/EventEngine.js (a single,
 * low-frequency, no-choice "news ticker" — BALANCE.NARRATIVE_EVENTS): the
 * two run side by side, never replacing one another (see tools/SimRunner.js).
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import { DRAMA_EVENTS } from '../data/events.js';
import { computeCombinedModifiers } from './PersonalityEngine.js';

/** Event names published on EventBus by DramaEngine. Import instead of raw strings. */
export const DRAMA_ENGINE_EVENTS = Object.freeze({
  RESOLVED: 'drama:event_resolved',
});

function pickRandomFighter(rng, roster) {
  if (!roster || roster.length === 0) return null;
  return roster[Math.floor(rng() * roster.length)];
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** Each evaluator returns true/false given a condition descriptor and the resolution context. */
const CONDITION_EVALUATORS = Object.freeze({
  NOT_INJURED: (condition, ctx) => !ctx.fighter.isInjured(ctx.worldState.currentDay),
  MIN_MONEY: (condition, ctx) => ctx.playerState.money >= condition.amount,
  HAS_RIVAL_GYMS: (condition, ctx) => ctx.worldState.rivalGyms.length > 0,
  MIN_ROSTER_SIZE: (condition, ctx) => ctx.playerState.roster.length >= condition.amount,
  /** Phase 4.6: gates a trait-specific event to whichever fighter selectEligibleDramaEvent() already picked — the event simply isn't eligible that week for a fighter who doesn't carry the trait. */
  HAS_TRAIT: (condition, ctx) => ctx.fighter.psychology.personality.traits.includes(condition.trait),
});

function isEventEligible(event, ctx) {
  return event.conditions.every((condition) => {
    const evaluator = CONDITION_EVALUATORS[condition.type];
    return evaluator ? evaluator(condition, ctx) : true;
  });
}

/** Builds a SIGNAL_EVALUATORS entry that reads one of computeCombinedModifiers' 4 dimensions — the "FighterTraits" term of EventWeight. Multiplier = 1 + (dimensionValue - 1) * scale, so a neutral dimension (1) never changes the weight regardless of scale. */
function personalityDimensionSignal(dimension) {
  return (signal, ctx) => 1 + (ctx.personalityModifiers[dimension] - 1) * signal.scale;
}

/** Each evaluator returns a multiplier given a { signal, scale } descriptor and the resolution context — the "Context"/"WorldState" terms of EventWeight. */
const SIGNAL_EVALUATORS = Object.freeze({
  PERSONALITY_PROGRESSION: personalityDimensionSignal('progressionMultiplier'),
  PERSONALITY_MORALE_VOLATILITY: personalityDimensionSignal('moraleVolatility'),
  PERSONALITY_SALARY_DEMAND: personalityDimensionSignal('salaryDemandMultiplier'),
  HYPE: (signal, ctx) => 1 + (ctx.playerState.hype / BALANCE.GYM.HYPE.MAX) * signal.scale,
  MONEY_SCARCITY: (signal, ctx) => 1 + (1 - clamp01(ctx.playerState.money / BALANCE.ECONOMY.STARTING_GYM_FUNDS)) * signal.scale,
  RIVAL_GYM_COUNT: (signal, ctx) => 1 + Math.min(ctx.worldState.rivalGyms.length / 10, 1) * signal.scale,
  ROSTER_SIZE: (signal, ctx) => 1 + Math.min(ctx.playerState.roster.length / 20, 1) * signal.scale,
});

function computeEventWeight(event, ctx) {
  let weight = event.baseChance;
  for (const signal of event.weightSignals) {
    const evaluator = SIGNAL_EVALUATORS[signal.signal];
    if (evaluator) weight *= evaluator(signal, ctx);
  }
  return Math.max(0, weight);
}

function weightedPick(rng, weightedEntries, getWeight) {
  const total = weightedEntries.reduce((sum, entry) => sum + getWeight(entry), 0);
  if (total <= 0) return weightedEntries[0] ?? null;
  let roll = rng() * total;
  for (const entry of weightedEntries) {
    const weight = getWeight(entry);
    if (roll < weight) return entry;
    roll -= weight;
  }
  return weightedEntries[weightedEntries.length - 1];
}

/**
 * Picks which choice the headless bot AI takes for a resolved event:
 * a choice with a `personalityLean` gets weight = personalityModifiers[dim]^scale
 * (>1 if that dimension favors it, <1 if it doesn't); a choice without one
 * always carries a flat weight of 1. Never a scripted fixed pick.
 */
function pickChoice(rng, event, personalityModifiers) {
  return weightedPick(rng, event.choices, (choice) => {
    if (!choice.personalityLean) return 1;
    const { dimension, scale } = choice.personalityLean;
    return Math.max(0.01, personalityModifiers[dimension] ** scale);
  });
}

/** Each applier mutates State given an effect descriptor and { fighter, playerState, eventId }. */
const EFFECT_APPLIERS = Object.freeze({
  ADJUST_PHYSICAL_FATIGUE: (effect, ctx) => ctx.fighter.adjustPhysicalFatigue(effect.amount),
  ADJUST_MENTAL_FATIGUE: (effect, ctx) => ctx.fighter.adjustMentalFatigue(effect.amount),
  ADJUST_MORALE: (effect, ctx) => ctx.fighter.adjustMorale(effect.amount),
  /** Phase 4.6: adjusts the featured fighter's relationship/loyalty with the gym (see Fighter#adjustLoyalty). */
  ADJUST_LOYALTY: (effect, ctx) => ctx.fighter.adjustLoyalty(effect.amount),
  CHANGE_REPUTATION: (effect, ctx) => ctx.playerState.changeReputation(effect.amount, `DRAMA_ENGINE:${ctx.eventId}`),
  CHANGE_HYPE: (effect, ctx) => ctx.playerState.changeHype(effect.amount, `DRAMA_ENGINE:${ctx.eventId}`),
  CHANGE_MONEY: (effect, ctx) => ctx.playerState.changeMoney(effect.amount, `DRAMA_ENGINE:${ctx.eventId}`),
});

/**
 * Selects (fighter, event) via the same two weighted rolls resolveOneEvent
 * always used, WITHOUT picking or applying a choice — the seam Phase 4.3's
 * ui/WeeklyFlowController.js needs to show a human player the real choice
 * list before anything is applied, instead of the headless bot-AI's
 * immediate auto-pick (see applyEventChoice/pickChoice below). Returns null
 * under the exact same conditions resolveOneEvent used to return null (empty
 * roster, or no currently-eligible event).
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {() => number} rng
 * @returns {{ event: Object, fighter: Object, personalityModifiers: Object, playerState: Object, worldState: Object }|null}
 */
export function selectEligibleDramaEvent(playerState, worldState, rng) {
  const fighter = pickRandomFighter(rng, playerState.roster);
  if (!fighter) return null;

  const personalityModifiers = computeCombinedModifiers(fighter);
  const ctx = { fighter, playerState, worldState, personalityModifiers };

  const weighted = [];
  for (const event of DRAMA_EVENTS) {
    if (!isEventEligible(event, ctx)) continue;
    const weight = computeEventWeight(event, ctx);
    if (weight > 0) weighted.push({ event, weight });
  }
  if (weighted.length === 0) return null;

  const picked = weightedPick(rng, weighted, (entry) => entry.weight);
  return { event: picked.event, fighter, personalityModifiers, playerState, worldState };
}

/**
 * Applies one specific choice (by id) of a previously-selected event (see
 * selectEligibleDramaEvent), publishing the exact same
 * DRAMA_ENGINE_EVENTS.RESOLVED report shape resolveOneEvent always has —
 * shared by both the headless auto-pick path (resolveOneEvent below) and an
 * interactive caller applying a human-picked choice.
 *
 * @param {Object} selection - A selectEligibleDramaEvent() result.
 * @param {string} choiceId - One of selection.event.choices[*].id.
 * @returns {Object} The resolution report.
 */
export function applyDramaEventChoice(selection, choiceId) {
  const { event, fighter, playerState, worldState } = selection;
  const choice = event.choices.find((c) => c.id === choiceId);
  if (!choice) {
    throw new TypeError(`DramaEngine.applyDramaEventChoice: unknown choice "${choiceId}" for event "${event.id}".`);
  }

  for (const effect of choice.effects) {
    const applier = EFFECT_APPLIERS[effect.type];
    if (applier) applier(effect, { fighter, playerState, eventId: event.id });
  }

  const report = {
    eventId: event.id,
    category: event.category,
    fighterId: fighter.identity.id,
    choiceId: choice.id,
    day: worldState.currentDay,
  };
  EventBus.publish(DRAMA_ENGINE_EVENTS.RESOLVED, report);
  return report;
}

/**
 * Resolves (picks, applies) exactly one drama event against one randomly
 * featured roster fighter, or null if the roster is empty or no event is
 * currently eligible (e.g. every fighter injured and every remaining
 * event requires NOT_INJURED). Same rng call count/order as before this
 * was split into selectEligibleDramaEvent/applyDramaEventChoice (fighter
 * pick, event pick, choice pick — in that order), so processWeeklyDrama's
 * statistics are unchanged by this refactor.
 * @returns {Object|null}
 */
function resolveOneEvent(playerState, worldState, rng) {
  const selection = selectEligibleDramaEvent(playerState, worldState, rng);
  if (!selection) return null;

  const choice = pickChoice(rng, selection.event, selection.personalityModifiers);
  return applyDramaEventChoice(selection, choice.id);
}

/**
 * Processes one week of Drama Engine resolution: two independent rolls
 * (BALANCE.DRAMA.PRIMARY_EVENT_CHANCE + SECONDARY_EVENT_CHANCE), each
 * potentially resolving one event — targets an average of "0.8 a 1.2
 * evenement significatif par semaine" per the spec.
 *
 * @param {Object} playerState - A PlayerState instance.
 * @param {Object} worldState - A WorldState instance.
 * @param {Object} [options]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ events: Object[] }}
 */
export function processWeeklyDrama(playerState, worldState, options = {}) {
  const rng = options.rng ?? Math.random;
  const cfg = BALANCE.DRAMA;

  const events = [];
  if (rng() < cfg.PRIMARY_EVENT_CHANCE) {
    const result = resolveOneEvent(playerState, worldState, rng);
    if (result) events.push(result);
  }
  if (rng() < cfg.SECONDARY_EVENT_CHANCE) {
    const result = resolveOneEvent(playerState, worldState, rng);
    if (result) events.push(result);
  }

  return { events };
}
