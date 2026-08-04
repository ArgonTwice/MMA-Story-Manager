/**
 * render/CombatRenderer.js
 * ---------------------------------------------------------------------------
 * The dedicated fight-screen façade over a CombatEngine instance: weigh-in,
 * gameplan selector, live health/stamina gauges during round simulation,
 * corner pause, and the final result banner. Every field is driven purely
 * by CombatEngine's own events (combat:state_changed / round_completed /
 * finished) — this renderer never polls the engine.
 * ---------------------------------------------------------------------------
 */

import { BaseRenderer } from './BaseRenderer.js';
import { COMBAT_EVENTS, COMBAT_STATES } from '../engine/CombatEngine.js';

/** Maps CombatEngine FSM phases to the 5 screens this UI actually shows. */
const PHASE_TO_SCREEN = Object.freeze({
  [COMBAT_STATES.IDLE]: 'IDLE',
  [COMBAT_STATES.INIT]: 'GAMEPLAN',
  [COMBAT_STATES.WEIGH_IN]: 'WEIGH_IN',
  [COMBAT_STATES.INTRO]: 'GAMEPLAN',
  [COMBAT_STATES.ROUND_START]: 'ROUND',
  [COMBAT_STATES.ROUND_SIMULATION]: 'ROUND',
  [COMBAT_STATES.CORNER_PAUSE]: 'CORNER_PAUSE',
  [COMBAT_STATES.DECISION_STOPPAGE]: 'RESOLVING',
  [COMBAT_STATES.POST_MATCH_REWARDS]: 'RESOLVING',
  [COMBAT_STATES.FINISHED]: 'RESULT',
});

function emptyLiveGauges() {
  return {
    A: { health: 100, stamina: 100 },
    B: { health: 100, stamina: 100 },
  };
}

export class CombatRenderer extends BaseRenderer {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.combatEngine] - A CombatEngine instance.
   *   Can also be supplied later via attach().
   * @param {Object} [options.mount]
   * @param {Function} [options.onRender]
   */
  constructor(options = {}) {
    super(options);
    this.combatEngine = options.combatEngine ?? null;
    this.viewModel = this._buildIdleViewModel();
  }

  /**
   * @param {Object} [combatEngine] - Rebinds the target CombatEngine if provided.
   * @returns {CombatRenderer} this, for chaining.
   */
  attach(combatEngine) {
    if (combatEngine) this.combatEngine = combatEngine;

    this._subscribe(COMBAT_EVENTS.STATE_CHANGED, (payload) => this._onStateChanged(payload));
    this._subscribe(COMBAT_EVENTS.ROUND_COMPLETED, (payload) => this._onRoundCompleted(payload));
    this._subscribe(COMBAT_EVENTS.FINISHED, (payload) => this._onFinished(payload));

    this.render();
    return this;
  }

  /** Recomputes the view model from the engine's current snapshot. */
  render() {
    this.viewModel = this.combatEngine ? this._buildViewModelFromSnapshot() : this._buildIdleViewModel();
    return this._flush();
  }

  // ---- control pass-through (thin wrappers over CombatEngine) ---------------

  selectWeightCutProfile(fighterKey, profileKey) {
    return this.combatEngine.selectWeightCutProfile(fighterKey, profileKey);
  }

  setGameplan(fighterKey, plan) {
    return this.combatEngine.setGameplan(fighterKey, plan);
  }

  advance() {
    return this.combatEngine.advanceState();
  }

  simulateInstant() {
    return this.combatEngine.simulateFullMatch();
  }

  // ---- event handlers -----------------------------------------------------

  _onStateChanged({ to }) {
    if (!this.combatEngine) return;
    const snapshot = this.combatEngine.getSnapshot();
    this.viewModel = {
      ...this.viewModel,
      phase: to,
      screen: PHASE_TO_SCREEN[to] ?? 'IDLE',
      currentRound: snapshot.currentRound,
      maxRounds: snapshot.maxRounds,
      live: snapshot.live ?? emptyLiveGauges(),
      gameplans: snapshot.gameplans ?? this.viewModel.gameplans,
    };
    this._flush();
  }

  _onRoundCompleted({ round, log }) {
    this.viewModel = {
      ...this.viewModel,
      lastRoundLog: log,
      live: {
        A: { health: log.healthAfter.A, stamina: log.staminaAfter.A },
        B: { health: log.healthAfter.B, stamina: log.staminaAfter.B },
      },
    };
    this._flush();
  }

  _onFinished(result) {
    this.viewModel = {
      ...this.viewModel,
      screen: 'RESULT',
      resultBanner: this._buildResultBanner(result),
    };
    this._flush();
  }

  // ---- internals ------------------------------------------------------------

  _buildIdleViewModel() {
    return {
      screen: 'IDLE',
      phase: COMBAT_STATES.IDLE,
      currentRound: 0,
      maxRounds: 0,
      live: emptyLiveGauges(),
      gameplans: null,
      lastRoundLog: null,
      resultBanner: null,
    };
  }

  _buildViewModelFromSnapshot() {
    const snapshot = this.combatEngine.getSnapshot();
    return {
      screen: PHASE_TO_SCREEN[snapshot.state] ?? 'IDLE',
      phase: snapshot.state,
      currentRound: snapshot.currentRound,
      maxRounds: snapshot.maxRounds,
      live: snapshot.live ?? emptyLiveGauges(),
      gameplans: snapshot.gameplans,
      lastRoundLog: this.viewModel?.lastRoundLog ?? null,
      resultBanner: snapshot.result ? this._buildResultBanner(snapshot.result) : this.viewModel?.resultBanner ?? null,
    };
  }

  _buildResultBanner(result) {
    const winnerLabel = result.winner
      ? `Vainqueur : coin ${result.winner}`
      : 'Match nul';
    return {
      winner: result.winner,
      method: result.method,
      round: result.round,
      timeLabel: result.timeLabel,
      headline: `${winnerLabel} par ${result.method} (round ${result.round}, ${result.timeLabel}).`,
    };
  }

  toHTML() {
    const v = this.viewModel;
    if (v.screen === 'RESULT' && v.resultBanner) {
      return `<section class="combat result-banner">${v.resultBanner.headline}</section>`;
    }
    const gauge = (label, live) =>
      `<div class="gauge" data-fighter="${label}">Vie ${Math.round(live.health)} / Stamina ${Math.round(live.stamina)}</div>`;
    return (
      `<section class="combat" data-screen="${v.screen}">` +
      `<header>Round ${v.currentRound}/${v.maxRounds}</header>` +
      gauge('A', v.live.A) +
      gauge('B', v.live.B) +
      `</section>`
    );
  }
}

export default CombatRenderer;
