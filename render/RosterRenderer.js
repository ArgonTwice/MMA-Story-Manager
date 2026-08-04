/**
 * render/RosterRenderer.js
 * ---------------------------------------------------------------------------
 * Fighter cards: stat gauges, training focus/intensity selector, and a
 * retirement action. Reacts to roster composition changes (add/remove) with
 * a full rebuild, and to per-fighter training/combat events with a single
 * targeted card update — never a full-roster re-render for a one-fighter change.
 * ---------------------------------------------------------------------------
 */

import { BaseRenderer } from './BaseRenderer.js';
import { PLAYER_EVENTS } from '../state/PlayerState.js';
import { TRAINING_EVENTS } from '../engine/TrainingEngine.js';
import { COMBAT_EVENTS } from '../engine/CombatEngine.js';

export class RosterRenderer extends BaseRenderer {
  /**
   * @param {Object} options
   * @param {Object} options.playerState - A PlayerState instance.
   * @param {Object} [options.mount]
   * @param {Function} [options.onRender]
   */
  constructor(options = {}) {
    super(options);
    this.playerState = options.playerState;
    this.viewModel = { capacity: 0, cards: [] };
  }

  /** @returns {RosterRenderer} this, for chaining. */
  attach() {
    this._subscribe(PLAYER_EVENTS.ROSTER_FIGHTER_ADDED, () => this.render());
    this._subscribe(PLAYER_EVENTS.ROSTER_FIGHTER_REMOVED, () => this.render());

    this._subscribe(TRAINING_EVENTS.PROGRESSION, ({ fighterId }) => this._updateCard(fighterId));
    this._subscribe(TRAINING_EVENTS.OVERTRAINED_INJURY, ({ fighterId }) => this._updateCard(fighterId));
    this._subscribe(TRAINING_EVENTS.DECLINE, ({ fighterId }) => this._updateCard(fighterId));

    this._subscribe(COMBAT_EVENTS.FINISHED, ({ fighters }) => {
      this._updateCard(fighters.A);
      this._updateCard(fighters.B);
    });

    this.render();
    return this;
  }

  /** Recomputes every fighter card from current state. */
  render() {
    this.viewModel = {
      capacity: this.playerState.getRosterCapacity(),
      cards: this.playerState.roster.map((fighter) => this._buildCard(fighter)),
    };
    return this._flush();
  }

  /**
   * Sets (part of) a fighter's weekly training plan. Thin, validated
   * pass-through to Fighter#setTrainingPlan — the model owns validation.
   * @param {string} fighterId
   * @param {Object} plan - { focus, intensity }
   * @returns {Object} The resulting training plan.
   */
  setFighterFocus(fighterId, plan) {
    const fighter = this.playerState.getFighter(fighterId);
    if (!fighter) {
      throw new Error(`RosterRenderer.setFighterFocus: no fighter with id "${fighterId}" in the roster.`);
    }
    const result = fighter.setTrainingPlan(plan);
    this._updateCard(fighterId);
    return result;
  }

  /**
   * Retires (releases) a fighter, but only once they're actually eligible —
   * this is a retirement button, not a generic release-anyone action.
   * @param {string} fighterId
   * @returns {boolean} True if the fighter was retired.
   */
  retireFighter(fighterId) {
    const fighter = this.playerState.getFighter(fighterId);
    if (!fighter) {
      throw new Error(`RosterRenderer.retireFighter: no fighter with id "${fighterId}" in the roster.`);
    }
    if (!fighter.isRetirementEligible()) {
      throw new Error(
        `RosterRenderer.retireFighter: ${fighter.identity.name} (age ${fighter.identity.age}) is not yet eligible for retirement.`
      );
    }
    return this.playerState.removeFighter(fighterId) !== null;
  }

  // ---- internals ------------------------------------------------------------

  _updateCard(fighterId) {
    const fighter = this.playerState.getFighter(fighterId);
    if (!fighter) return; // not one of ours (e.g. an opponent from combat:finished)

    const index = this.viewModel.cards.findIndex((card) => card.id === fighterId);
    const card = this._buildCard(fighter);
    const cards = [...this.viewModel.cards];
    if (index === -1) {
      cards.push(card);
    } else {
      cards[index] = card;
    }
    this.viewModel = { ...this.viewModel, cards };
    this._flush();
  }

  _buildCard(fighter) {
    return {
      id: fighter.identity.id,
      name: fighter.identity.name,
      age: fighter.identity.age,
      style: fighter.identity.style,
      weightClass: fighter.identity.weightClass,
      record: fighter.getRecordString(),
      overallRating: fighter.getOverallRating(),
      skills: { ...fighter.attributes.skills },
      formPercent: fighter.attributes.forme,
      moralePercent: fighter.attributes.moral,
      isInjured: fighter.medical.injuredUntil !== null,
      training: { ...fighter.training },
      perks: [...fighter.perks],
      eligibleForRetirement: fighter.isRetirementEligible(),
      forcedRetirement: fighter.isForcedRetirement(),
    };
  }

  toHTML() {
    const v = this.viewModel;
    const cardsHTML = v.cards
      .map(
        (c) =>
          `<li class="fighter-card" data-id="${c.id}">` +
          `<strong>${c.name}</strong> (${c.age} ans, ${c.style}, ${c.weightClass}) — ${c.record}` +
          `<div class="gauges">Forme ${Math.round(c.formPercent)} · Moral ${Math.round(c.moralePercent)} · Note ${c.overallRating}</div>` +
          `${c.isInjured ? '<span class="injured">BLESSE</span>' : ''}` +
          `${c.eligibleForRetirement ? '<button data-action="retire">Retraite</button>' : ''}` +
          `</li>`
      )
      .join('');
    return `<section class="roster">Effectif (${v.cards.length}/${v.capacity})<ul>${cardsHTML}</ul></section>`;
  }
}

export default RosterRenderer;
