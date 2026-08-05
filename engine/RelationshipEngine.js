/**
 * engine/RelationshipEngine.js — Pyramide Emergente, Niveau 1 (moteur de base)
 * ---------------------------------------------------------------------------
 * Mechanically tracks the relationship graph between entities (fighters,
 * for now — the graph is entity-id-agnostic, so gyms could join later): five
 * gauges (relation, popularity, tension, respect, legacy) per pair, plus a
 * chronological history[] of the events that moved them.
 *
 * The graph itself lives on WorldState (worldState.relationships), not
 * inside this engine — see state/WorldState.js's header for why. This
 * engine is the *only* code that decides WHEN and BY HOW MUCH those gauges
 * move; StoryEngine/NarrativeEngine (Level 2) read the result straight off
 * WorldState, never through this module.
 *
 * Absolute decoupling: imports only core/EventBus.js and data/balance.js.
 * Event names from other engines (combat:finished, narrative:published) are
 * subscribed to as raw string literals — no import of CombatEngine.js or
 * NarrativeEngine.js.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

const DECISION_METHODS = Object.freeze([
  'UNANIMOUS_DECISION',
  'SPLIT_DECISION',
  'MAJORITY_DECISION',
  'DRAW',
]);

class RelationshipEngine {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.worldState] - A WorldState instance. Can
   *   also be supplied later via attach().
   */
  constructor(options = {}) {
    this.worldState = options.worldState ?? null;
    this._unsubs = [];
  }

  /**
   * @param {Object} [worldState] - Rebinds the target WorldState if provided.
   * @returns {RelationshipEngine} this, for chaining.
   */
  attach(worldState) {
    if (worldState) this.worldState = worldState;

    this._unsubs.push(EventBus.subscribe('combat:finished', (payload) => this._onCombatFinished(payload)));
    this._unsubs.push(EventBus.subscribe('narrative:published', (payload) => this._onNarrativePublished(payload)));

    return this;
  }

  /** Unsubscribes from every event this engine listens to. */
  detach() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
  }

  // ---- event handlers -----------------------------------------------------

  _onCombatFinished(payload) {
    if (!this.worldState) return;
    const { fighters, names, method, isTitle, titleOnTheLine } = payload;
    if (!fighters?.A || !fighters?.B) return;

    const wasFinish = !DECISION_METHODS.includes(method);
    const cfg = BALANCE.RELATIONSHIP.COMBAT_EFFECTS;
    const legacyDelta =
      cfg.LEGACY_DELTA_BASE +
      (wasFinish ? cfg.LEGACY_DELTA_FINISH_BONUS : 0) +
      (isTitle || titleOnTheLine ? cfg.LEGACY_DELTA_TITLE_BONUS : 0);

    this.worldState.upsertRelationship(
      fighters.A,
      fighters.B,
      {
        relation: cfg.RELATION_DELTA,
        tension: cfg.TENSION_DELTA,
        respect: cfg.RESPECT_DELTA,
        popularity: cfg.POPULARITY_DELTA,
        legacy: legacyDelta,
      },
      {
        type: 'COMBAT',
        description: `${names?.A ?? fighters.A} vs ${names?.B ?? fighters.B} : ${method}`,
        method,
      }
    );
  }

  _onNarrativePublished(payload) {
    if (!this.worldState) return;
    if (payload.tone !== 'PROVOCATION') return;

    const [entityAId, entityBId] = payload.entities ?? [];
    if (!entityAId || !entityBId) return;

    const cfg = BALANCE.RELATIONSHIP.PROVOCATION_EFFECTS;
    this.worldState.upsertRelationship(
      entityAId,
      entityBId,
      { relation: cfg.RELATION_DELTA, tension: cfg.TENSION_DELTA, popularity: cfg.POPULARITY_DELTA },
      { type: 'PROVOCATION', description: payload.headline }
    );
  }
}

const instance = new RelationshipEngine();
export default instance;
export { RelationshipEngine };
