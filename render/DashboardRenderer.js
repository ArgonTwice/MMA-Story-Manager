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
   * @param {Object} [options.mount] - The Dashboard tab panel (#p-dash): full journal + stats.
   * @param {Object} [options.hudMount] - The persistent top bar (#hud): compact stats only,
   *   visible across every tab. Optional — this renderer works fine with only `mount`.
   * @param {Function} [options.onRender]
   */
  constructor(options = {}) {
    super(options);
    this.playerState = options.playerState;
    this.worldState = options.worldState;
    this.hudMount = options.hudMount ?? null;
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

  /**
   * Also mirrors a compact stats strip into hudMount (if any), in addition
   * to the base flush that writes the full panel into mount.
   * @override
   */
  _flush() {
    super._flush();
    if (this.hudMount) {
      this.hudMount.innerHTML = this._toHUDHTML();
    }
    return this.viewModel;
  }

  _toHUDHTML() {
    const v = this.viewModel;
    return (
      `<div class="hud-stat hud-day">Jour ${v.day} <span class="hud-sub">${v.season}, an ${v.year}</span></div>` +
      `<div class="hud-stat hud-money gold">${v.money}$</div>` +
      `<div class="hud-stat hud-rep">Reputation <strong>${v.reputation}</strong></div>` +
      `<div class="hud-stat hud-hype">Hype <strong>${v.hype}</strong></div>`
    );
  }

  toHTML() {
    const v = this.viewModel;
    const logHTML = v.logEntries
      .map(
        (e) =>
          `<li class="journal-entry" data-kind="${e.kind}"><span class="journal-day">J${e.day}</span>${e.text}</li>`
      )
      .join('');
    const charges = v.weeklyCharges;
    const chargesHTML = charges
      ? `<ul class="charges-breakdown">` +
        `<li>Loyer : ${Math.round(charges.rent)}$</li>` +
        `<li>Salaires coachs : ${Math.round(charges.coachPayroll)}$</li>` +
        `<li>Entretien equipements : ${Math.round(charges.equipmentMaintenance)}$</li>` +
        `<li>Revenus passifs : +${Math.round(charges.passiveIncome)}$</li>` +
        `</ul>`
      : `<p class="charges-empty">Aucune semaine ecoulee pour l'instant.</p>`;

    return (
      `<section class="dashboard">` +
      `<header class="dashboard-header">${v.gymName} <span class="dashboard-sub">Jour ${v.day} (${v.season}, an ${v.year})</span></header>` +
      `<ul class="stats stat-grid">` +
      `<li class="stat-tile"><span class="stat-label">Tresorerie</span><span class="stat-value gold">${v.money}$</span></li>` +
      `<li class="stat-tile"><span class="stat-label">Reputation</span><span class="stat-value">${v.reputation}</span></li>` +
      `<li class="stat-tile"><span class="stat-label">Hype</span><span class="stat-value">${v.hype}</span></li>` +
      `</ul>` +
      `<h3 class="section-title">Charges de la semaine</h3>` +
      chargesHTML +
      `<h3 class="section-title">Journal de bord</h3>` +
      `<ol class="logbook">${logHTML}</ol>` +
      `</section>`
    );
  }
}

export default DashboardRenderer;
