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

  _fighterGaugesHTML(label, live) {
    const health = Math.max(0, Math.min(100, Math.round(live.health)));
    const stamina = Math.max(0, Math.min(100, Math.round(live.stamina)));
    return (
      `<div class="fighter-gauges" data-corner="${label}">` +
      `<div class="corner-label">Coin ${label}</div>` +
      `<div class="gauge-row" data-kind="health">` +
      `<span class="gauge-label">Vie</span>` +
      `<div class="gauge-bar"><div class="gauge-fill gauge-health" style="width:${health}%"></div></div>` +
      `<span class="gauge-value">${health}</span>` +
      `</div>` +
      `<div class="gauge-row" data-kind="stamina">` +
      `<span class="gauge-label">Stamina</span>` +
      `<div class="gauge-bar"><div class="gauge-fill gauge-stamina" style="width:${stamina}%"></div></div>` +
      `<span class="gauge-value">${stamina}</span>` +
      `</div>` +
      `</div>`
    );
  }

  toHTML() {
    const v = this.viewModel;

    if (v.screen === 'IDLE') {
      return `<section class="combat" data-screen="IDLE"><p class="combat-idle">Aucun combat en cours.</p></section>`;
    }

    if (v.screen === 'RESULT' && v.resultBanner) {
      return (
        `<section class="combat" data-screen="RESULT">` +
        `<div class="result-banner reveal">` +
        `<div class="result-method">${v.resultBanner.method}</div>` +
        `<div class="result-headline">${v.resultBanner.headline}</div>` +
        `</div>` +
        `</section>`
      );
    }

    if (v.screen === 'WEIGH_IN') {
      return (
        `<section class="combat" data-screen="WEIGH_IN">` +
        `<div class="weighin-card">` +
        `<h3 class="section-title">Pesee</h3>` +
        `<p>Choisissez un profil de coupe de poids pour chaque coin.</p>` +
        `<div class="weighin-profiles">` +
        `<button class="btn btn-outline" data-action="weigh-in" data-fighter="A" data-profile="NATUREL">Naturel</button>` +
        `<button class="btn btn-outline" data-action="weigh-in" data-fighter="A" data-profile="MODERE">Modere</button>` +
        `<button class="btn btn-outline" data-action="weigh-in" data-fighter="A" data-profile="INTENSIF">Intensif</button>` +
        `<button class="btn btn-outline" data-action="weigh-in" data-fighter="A" data-profile="EXTREME">Extreme</button>` +
        `</div>` +
        `</div>` +
        `</section>`
      );
    }

    if (v.screen === 'GAMEPLAN') {
      return (
        `<section class="combat" data-screen="GAMEPLAN">` +
        `<div class="gameplan-selector">` +
        `<h3 class="section-title">Gameplan</h3>` +
        `<div class="gameplan-row"><span>Cible</span>` +
        `<button class="btn btn-outline" data-action="gameplan" data-field="target" data-value="HEAD">Tete</button>` +
        `<button class="btn btn-outline" data-action="gameplan" data-field="target" data-value="BODY">Corps</button>` +
        `<button class="btn btn-outline" data-action="gameplan" data-field="target" data-value="LEGS">Jambes</button>` +
        `</div>` +
        `<div class="gameplan-row"><span>Distance</span>` +
        `<button class="btn btn-outline" data-action="gameplan" data-field="distance" data-value="STRIKING">Frappe</button>` +
        `<button class="btn btn-outline" data-action="gameplan" data-field="distance" data-value="CLINCH">Clinch</button>` +
        `<button class="btn btn-outline" data-action="gameplan" data-field="distance" data-value="GROUND">Sol</button>` +
        `</div>` +
        `<div class="gameplan-row"><span>Tempo</span>` +
        `<button class="btn btn-outline" data-action="gameplan" data-field="tempo" data-value="CONSERVATIVE">Prudent</button>` +
        `<button class="btn btn-outline" data-action="gameplan" data-field="tempo" data-value="BALANCED">Equilibre</button>` +
        `<button class="btn btn-outline" data-action="gameplan" data-field="tempo" data-value="AGGRESSIVE">Agressif</button>` +
        `</div>` +
        `</div>` +
        `</section>`
      );
    }

    if (v.screen === 'CORNER_PAUSE') {
      return (
        `<section class="combat" data-screen="CORNER_PAUSE">` +
        `<div class="corner-pause-banner">Pause de coin — ajustez le gameplan du coin A avant le round ${v.currentRound + 1}.</div>` +
        this._fighterGaugesHTML('A', v.live.A) +
        this._fighterGaugesHTML('B', v.live.B) +
        `<button class="btn btn-gold" data-action="advance">Round suivant</button>` +
        `</section>`
      );
    }

    // ROUND / RESOLVING
    const roundLogHTML = v.lastRoundLog
      ? `<ul class="round-log">` +
        `<li>Degats A : ${v.lastRoundLog.damageDealt.A} — Degats B : ${v.lastRoundLog.damageDealt.B}</li>` +
        `</ul>`
      : '';

    return (
      `<section class="combat" data-screen="${v.screen}">` +
      `<header class="round-header">Round ${v.currentRound}/${v.maxRounds}</header>` +
      this._fighterGaugesHTML('A', v.live.A) +
      this._fighterGaugesHTML('B', v.live.B) +
      roundLogHTML +
      `</section>`
    );
  }
}

export default CombatRenderer;
