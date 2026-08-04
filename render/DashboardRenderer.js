/**
 * render/DashboardRenderer.js
 * ---------------------------------------------------------------------------
 * The HUD: calendar (day/season/year), treasury, reputation, hype, and last
 * week's charges — plus a running "log book" of notable events. Every field
 * updates independently, in reaction to the specific event that changed it;
 * there is no periodic full refresh.
 * ---------------------------------------------------------------------------
 */

import { BaseRenderer } from './BaseRenderer.js';
import { WORLD_EVENTS } from '../state/WorldState.js';
import { PLAYER_EVENTS } from '../state/PlayerState.js';
import { PROGRESSION_EVENTS } from '../engine/ProgressionEngine.js';
import { EVENT_ENGINE_EVENTS } from '../engine/EventEngine.js';

/** Display-only concern (not gameplay balance): how many log lines the HUD keeps on screen. */
const LOG_DISPLAY_LIMIT = 20;

export class DashboardRenderer extends BaseRenderer {
  /**
   * @param {Object} options
   * @param {Object} options.playerState - A PlayerState instance.
   * @param {Object} options.worldState - A WorldState instance.
   * @param {Object} [options.mount]
   * @param {Function} [options.onRender]
   */
  constructor(options = {}) {
    super(options);
    this.playerState = options.playerState;
    this.worldState = options.worldState;
    this.viewModel = { ...this._buildStats(), logEntries: [] };
  }

  /** @returns {DashboardRenderer} this, for chaining. */
  attach() {
    this._subscribe(WORLD_EVENTS.DAY_ADVANCED, () => this._updateStats());
    this._subscribe(WORLD_EVENTS.SEASON_CHANGED, ({ season }) => {
      this._updateStats();
      this._pushLog(`Nouvelle saison : ${season}.`, 'WORLD');
    });
    this._subscribe(WORLD_EVENTS.YEAR_CHANGED, ({ year }) => {
      this._updateStats();
      this._pushLog(`Bienvenue en annee ${year}.`, 'WORLD');
    });

    this._subscribe(PLAYER_EVENTS.ECONOMY_MONEY_CHANGED, ({ delta, reason }) => {
      this._updateStats();
      this._pushLog(`${delta >= 0 ? '+' : ''}${delta}$ (${reason || 'transaction'}).`, 'ECONOMY');
    });
    this._subscribe(PLAYER_EVENTS.GYM_REPUTATION_CHANGED, ({ delta, reason }) => {
      this._updateStats();
      this._pushLog(`Reputation ${delta >= 0 ? '+' : ''}${delta} (${reason || 'evenement'}).`, 'GYM');
    });
    this._subscribe(PLAYER_EVENTS.GYM_HYPE_CHANGED, ({ delta, reason }) => {
      this._updateStats();
      this._pushLog(`Hype ${delta >= 0 ? '+' : ''}${delta} (${reason || 'evenement'}).`, 'GYM');
    });

    this._subscribe(PROGRESSION_EVENTS.WEEK_ADVANCED, ({ day, economyReport }) => {
      this._updateStats();
      this.viewModel = { ...this.viewModel, weeklyCharges: this._extractCharges(economyReport) };
      this._pushLog(
        `Semaine ecoulee (jour ${day}) : charges ${Math.round(
          economyReport.rent + economyReport.coachPayroll + economyReport.equipmentMaintenance
        )}$, revenus passifs +${Math.round(economyReport.passiveIncome)}$.`,
        'WEEK'
      );
    });

    this._subscribe(EVENT_ENGINE_EVENTS.TRIGGERED, (event) => {
      this._pushLog(event.headline, 'NARRATIVE');
    });

    this.render();
    return this;
  }

  /** Recomputes the full view model from current state. */
  render() {
    this.viewModel = { ...this.viewModel, ...this._buildStats() };
    return this._flush();
  }

  _buildStats() {
    return {
      day: this.worldState.currentDay,
      season: this.worldState.season,
      year: this.worldState.year,
      gymName: this.playerState.gymName,
      money: this.playerState.money,
      reputation: this.playerState.reputation,
      hype: this.playerState.hype,
      weeklyCharges: this.viewModel?.weeklyCharges ?? null,
    };
  }

  _updateStats() {
    this.viewModel = { ...this.viewModel, ...this._buildStats() };
    this._flush();
  }

  _extractCharges(economyReport) {
    return {
      rent: economyReport.rent,
      coachPayroll: economyReport.coachPayroll,
      equipmentMaintenance: economyReport.equipmentMaintenance,
      passiveIncome: economyReport.passiveIncome,
      netChange: economyReport.netChange,
    };
  }

  _pushLog(text, kind) {
    const entry = { day: this.worldState.currentDay, kind, text };
    const logEntries = [entry, ...this.viewModel.logEntries].slice(0, LOG_DISPLAY_LIMIT);
    this.viewModel = { ...this.viewModel, logEntries };
    this._flush();
  }

  toHTML() {
    const v = this.viewModel;
    const logHTML = v.logEntries.map((e) => `<li data-kind="${e.kind}">J${e.day} — ${e.text}</li>`).join('');
    return (
      `<section class="dashboard">` +
      `<header>${v.gymName} — Jour ${v.day} (${v.season}, an ${v.year})</header>` +
      `<ul class="stats">` +
      `<li>Tresorerie: ${v.money}$</li>` +
      `<li>Reputation: ${v.reputation}</li>` +
      `<li>Hype: ${v.hype}</li>` +
      `</ul>` +
      `<ol class="logbook">${logHTML}</ol>` +
      `</section>`
    );
  }
}

export default DashboardRenderer;
