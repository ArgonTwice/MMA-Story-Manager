/**
 * engine/StoryEngine.js — Pyramide Emergente, Niveau 2 (detecteur)
 * ---------------------------------------------------------------------------
 * Detects only THAT something narratively interesting is happening, by
 * combining ingredients already sitting in State/Models/BALANCE — e.g.
 * "Defeat + high Ego + high Tension -> potential conflict." It never
 * decides HOW to tell that story (that is NarrativeEngine's job, one level
 * up): it only publishes an opportunity with a type + the entities/context
 * involved.
 *
 * Absolute decoupling: imports only core/EventBus.js and data/balance.js.
 * Reacts to combat:finished/economy:insolvent as raw string literals (no
 * import of CombatEngine.js/EconomyEngine.js), and reads relationship
 * gauges straight off the injected WorldState (State data, not through
 * RelationshipEngine). The one BALANCE.PERSONALITY lookup below duplicates
 * a couple of lines from PersonalityEngine.computeCombinedModifiers on
 * purpose — deriving the same fact independently from shared Data is
 * exactly what decoupling asks for, rather than importing that engine.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

/** Event names published on EventBus by StoryEngine. Import instead of raw strings. */
export const STORY_ENGINE_EVENTS = Object.freeze({
  OPPORTUNITY_DETECTED: 'story:opportunity_detected',
});

/** Controlled vocabulary of opportunity types this detector can raise. */
export const OPPORTUNITY_TYPES = Object.freeze({
  CONFLICT_POTENTIAL: 'CONFLICT_POTENTIAL',
  RIVALRY_IGNITED: 'RIVALRY_IGNITED',
  UPSET_VICTORY: 'UPSET_VICTORY',
  FINANCIAL_DISCONTENT: 'FINANCIAL_DISCONTENT',
});

let idCounter = 0;
function generateId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * Independently derives just the salary-demand dimension of a fighter's
 * personality profile — see engine/PersonalityEngine.js#computeCombinedModifiers
 * for the full 4-dimension version. Duplicated on purpose (see file header).
 * @param {Object} fighter
 * @returns {number}
 */
function computeSalaryDemandMultiplier(fighter) {
  const { ARCHETYPES, TRAITS } = BALANCE.PERSONALITY;
  let multiplier = ARCHETYPES[fighter.psychology.personality.archetype].salaryDemandMultiplier;
  for (const trait of fighter.psychology.personality.traits) {
    multiplier *= TRAITS[trait]?.salaryDemandMultiplier ?? 1;
  }
  return multiplier;
}

class StoryEngine {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.playerState]
   * @param {Object|null} [options.worldState]
   */
  constructor(options = {}) {
    this.playerState = options.playerState ?? null;
    this.worldState = options.worldState ?? null;
    this._unsubs = [];
  }

  /**
   * @param {Object} [playerState] - Rebinds the target PlayerState if provided.
   * @param {Object} [worldState] - Rebinds the target WorldState if provided.
   * @returns {StoryEngine} this, for chaining.
   */
  attach(playerState, worldState) {
    if (playerState) this.playerState = playerState;
    if (worldState) this.worldState = worldState;

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

  _onCombatFinished(payload) {
    if (payload.winner === null) return; // draws don't feed these detectors

    const winnerKey = payload.winner;
    const loserKey = winnerKey === 'A' ? 'B' : 'A';
    const winnerId = payload.fighters[winnerKey];
    const loserId = payload.fighters[loserKey];
    // payload.names is keyed by corner ('A'/'B'), not by fighter id — remap it
    // so downstream context.names[entityId] lookups (see NarrativeEngine.resolveName) resolve.
    const names = {
      [winnerId]: payload.names?.[winnerKey],
      [loserId]: payload.names?.[loserKey],
    };

    const winner = this._findFighter(winnerId);
    const loser = this._findFighter(loserId);
    const relationship = this.worldState?.getRelationship(winnerId, loserId) ?? null;
    const gauges = relationship?.gauges ?? null;

    this._detectConflictPotential({ loser, loserId, winnerId, names, tension: gauges?.tension ?? 0, method: payload.method });
    this._detectRivalryIgnited({ relation: gauges?.relation ?? null, winnerId, loserId, names });
    this._detectUpsetVictory({ winner, loser, winnerId, loserId, names, method: payload.method, titleOnTheLine: payload.titleOnTheLine });
  }

  _onInsolvency() {
    if (!this.playerState) return;

    const cfg = BALANCE.STORY.FINANCIAL_DISCONTENT;
    for (const fighter of this.playerState.roster) {
      const salaryDemandMultiplier = computeSalaryDemandMultiplier(fighter);
      if (salaryDemandMultiplier < cfg.MIN_SALARY_DEMAND_MULTIPLIER) continue;

      this._publishOpportunity(OPPORTUNITY_TYPES.FINANCIAL_DISCONTENT, [fighter.identity.id], {
        salaryDemandMultiplier: Math.round(salaryDemandMultiplier * 1000) / 1000,
        names: { [fighter.identity.id]: fighter.identity.name },
      });
    }
  }

  // ---- detectors --------------------------------------------------------------

  _detectConflictPotential({ loser, loserId, winnerId, names, tension, method }) {
    if (!loser) return;
    const cfg = BALANCE.STORY.CONFLICT_POTENTIAL;
    if (loser.psychology.ego < cfg.MIN_LOSER_EGO || tension < cfg.MIN_TENSION) return;

    this._publishOpportunity(OPPORTUNITY_TYPES.CONFLICT_POTENTIAL, [loserId, winnerId], {
      loserEgo: loser.psychology.ego,
      tension,
      method,
      names,
    });
  }

  _detectRivalryIgnited({ relation, winnerId, loserId, names }) {
    if (relation === null) return;
    if (relation > BALANCE.STORY.RIVALRY_IGNITED.MAX_RELATION) return;

    this._publishOpportunity(OPPORTUNITY_TYPES.RIVALRY_IGNITED, [winnerId, loserId], { relation, names });
  }

  _detectUpsetVictory({ winner, loser, winnerId, loserId, names, method, titleOnTheLine }) {
    if (!winner || !loser) return;
    const gap = loser.getOverallRating() - winner.getOverallRating();
    if (gap < BALANCE.STORY.UPSET_VICTORY.MIN_RATING_GAP) return;

    this._publishOpportunity(OPPORTUNITY_TYPES.UPSET_VICTORY, [winnerId, loserId], {
      ratingGap: Math.round(gap * 10) / 10,
      method,
      titleImplications: Boolean(titleOnTheLine),
      names,
    });
  }

  // ---- internals ------------------------------------------------------------

  _findFighter(fighterId) {
    if (!fighterId) return null;
    return this.playerState?.roster.find((fighter) => fighter.identity.id === fighterId) ?? null;
  }

  _publishOpportunity(type, entities, context) {
    const opportunity = {
      id: generateId('story'),
      type,
      entities,
      context,
      day: this.worldState?.currentDay ?? null,
    };
    EventBus.publish(STORY_ENGINE_EVENTS.OPPORTUNITY_DETECTED, opportunity);
    return opportunity;
  }
}

const instance = new StoryEngine();
export default instance;
export { StoryEngine };
