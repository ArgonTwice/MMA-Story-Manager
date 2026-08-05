/**
 * engine/WorldMemory.js — Pyramide Emergente, Niveau 2 (memoire du monde)
 * ---------------------------------------------------------------------------
 * A persistent registry of the save's historical bests: fastest KO, longest
 * title reign, most career titles, biggest fight (by combined purse). The
 * records themselves live on WorldState.records (see its header) — this
 * engine is the code that decides, on every combat:finished, whether a new
 * result beats the current best, and if so, updates it via
 * WorldState.trySetRecord().
 *
 * Absolute decoupling: imports only core/EventBus.js and data/balance.js.
 * combat:finished is subscribed to as a raw string literal (no import of
 * CombatEngine.js). Every fact this engine needs (fighter names, weight
 * classes, career title counts, purses) already rides along on that
 * event's payload — see engine/CombatEngine.js's result shape — so this
 * engine never needs a PlayerState/roster lookup to do its job.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

const FINISH_METHODS_TRACKED = Object.freeze(['KO', 'TKO']);

class WorldMemory {
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
   * @returns {WorldMemory} this, for chaining.
   */
  attach(worldState) {
    if (worldState) this.worldState = worldState;
    this._unsubs.push(EventBus.subscribe('combat:finished', (payload) => this._onCombatFinished(payload)));
    return this;
  }

  /** Unsubscribes from every event this engine listens to. */
  detach() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
  }

  // ---- event handler ----------------------------------------------------------

  _onCombatFinished(payload) {
    if (!this.worldState) return;

    this._checkFastestKO(payload);
    this._checkBiggestFight(payload);
    this._checkTitleRecords(payload);
  }

  // ---- record checks ----------------------------------------------------------

  _checkFastestKO(payload) {
    if (!FINISH_METHODS_TRACKED.includes(payload.method)) return;
    if (typeof payload.timeSeconds !== 'number') return;

    const totalElapsedSeconds = (payload.round - 1) * BALANCE.COMBAT.ROUND_DURATION_SECONDS + payload.timeSeconds;
    const winnerName = payload.names?.[payload.winner] ?? payload.fighters[payload.winner];

    this.worldState.trySetRecord('fastestKO', totalElapsedSeconds, {
      betterIf: 'LOWER',
      detail: `${winnerName} termine le combat par ${payload.method} en ${payload.timeLabel} du round ${payload.round}.`,
      meta: { fighterId: payload.fighters[payload.winner] },
    });
  }

  _checkBiggestFight(payload) {
    const combinedPurse = (payload.purses?.A?.gross ?? 0) + (payload.purses?.B?.gross ?? 0);
    if (combinedPurse <= 0) return;

    const nameA = payload.names?.A ?? payload.fighters.A;
    const nameB = payload.names?.B ?? payload.fighters.B;

    this.worldState.trySetRecord('biggestFight', combinedPurse, {
      betterIf: 'HIGHER',
      detail: `${nameA} vs ${nameB} : bourse combinee de ${combinedPurse}$.`,
      meta: { fighterAId: payload.fighters.A, fighterBId: payload.fighters.B },
    });
  }

  _checkTitleRecords(payload) {
    if (!payload.titleOnTheLine || payload.winner === null) return;

    const winnerKey = payload.winner;
    const winnerId = payload.fighters[winnerKey];
    const winnerName = payload.names?.[winnerKey] ?? winnerId;
    const weightClass = payload.weightClasses?.[winnerKey] ?? 'Inconnu';
    const titleKey = `${payload.orgId}:${weightClass}`;

    const previousHolder = this.worldState.getTitleHolder(titleKey);
    if (previousHolder && previousHolder.fighterId !== winnerId) {
      const reignDays = this.worldState.currentDay - previousHolder.sinceDay;
      this.worldState.trySetRecord('longestTitleReign', reignDays, {
        betterIf: 'HIGHER',
        detail: `${previousHolder.fighterName} a regne ${reignDays} jours sur le titre ${weightClass}.`,
        meta: { fighterId: previousHolder.fighterId, titleKey },
      });
    }

    this.worldState.setTitleHolder(titleKey, {
      fighterId: winnerId,
      fighterName: winnerName,
      sinceDay: this.worldState.currentDay,
    });

    const winnerTitles = payload.careerTitlesCount?.[winnerKey] ?? 0;
    this.worldState.trySetRecord('mostTitles', winnerTitles, {
      betterIf: 'HIGHER',
      detail: `${winnerName} totalise ${winnerTitles} titre(s) en carriere.`,
      meta: { fighterId: winnerId },
    });
  }
}

const instance = new WorldMemory();
export default instance;
export { WorldMemory };
