/**
 * ui/FightNightView.js — Phase 4.3 ("Player Experience & Vertical Slice")
 * ---------------------------------------------------------------------------
 * The presentation layer over a fight: a pre-fight "card" (Readiness,
 * nicknames, records — the head-to-head comparison the spec asks for), a
 * round-by-round summary as the match plays out, and a final result banner.
 *
 * FightNightView never invents a consequence itself — CombatEngine already
 * applies every one (money, reputation, hype, injuries, career stats,
 * perks), and the reactive Pyramide Emergente engines (WorldMemory,
 * HistoryEngine, StoryEngine, NarrativeEngine, SocialEngine...), once
 * attached to the session, already react to 'combat:finished' on their own —
 * this module only reads CombatEngine's own return values/snapshot to
 * describe what just happened for a human to read.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import { COMBAT_STATES } from '../engine/CombatEngine.js';

/** Sensible default gameplan for a fighter whose corner didn't explicitly choose one — leans on their own style's primary distance/target affinity (see BALANCE.COMBAT.STYLE_BONUSES), same spirit as tools/SimRunner.js's headless gameplanForStyle but without that file's coach-AI randomness (a human corner can always override via setGameplans before simulating). */
function defaultGameplanForFighter(fighter) {
  const styleBonus = BALANCE.COMBAT.STYLE_BONUSES[fighter.identity.style] ?? BALANCE.COMBAT.STYLE_BONUSES.DEFAULT;
  const distance = styleBonus.distance ?? 'STRIKING';

  let target = 'HEAD';
  if (styleBonus.targetMultipliers) {
    target = Object.keys(styleBonus.targetMultipliers).reduce((best, candidate) =>
      styleBonus.targetMultipliers[candidate] > (styleBonus.targetMultipliers[best] ?? 0) ? candidate : best
    );
  }

  return { target, distance, tempo: 'BALANCED' };
}

export class FightNightView {
  /**
   * @param {Object} options
   * @param {Object} options.combatEngine - A CombatEngine instance, already
   *   attached to the session's PlayerState/WorldState if fight consequences
   *   (purses, reputation) should apply to a real gym.
   */
  constructor({ combatEngine }) {
    this.combatEngine = combatEngine;
    this._roundLogs = [];
    this._fighterA = null;
    this._fighterB = null;
    this._orgId = null;
    this._isTitle = false;
  }

  /**
   * Books the match and returns the pre-fight comparison card.
   * @param {Object} fighterA
   * @param {Object} fighterB
   * @param {string} orgId
   * @param {boolean} [isTitle=false]
   * @returns {Object} The fight card view model.
   */
  presentMatchup(fighterA, fighterB, orgId, isTitle = false) {
    this.combatEngine.setupMatch(fighterA, fighterB, orgId, isTitle);
    this._roundLogs = [];
    this._fighterA = fighterA;
    this._fighterB = fighterB;
    this._orgId = orgId;
    this._isTitle = isTitle;
    return this._buildFightCard(orgId, isTitle);
  }

  /**
   * Sets both corners' gameplans, defaulting to defaultGameplanForFighter()
   * for whichever corner isn't explicitly provided.
   * @param {Object} [plans]
   * @param {Object} [plans.A] - { target, distance, tempo }
   * @param {Object} [plans.B]
   */
  setGameplans({ A, B } = {}) {
    this.combatEngine.setGameplan('A', A ?? defaultGameplanForFighter(this._fighterA));
    this.combatEngine.setGameplan('B', B ?? defaultGameplanForFighter(this._fighterB));
  }

  /**
   * Advances the fight exactly one simulated round (driving past whichever
   * FSM phases precede ROUND_SIMULATION), or resolves the final decision if
   * the match just ended.
   * @returns {{ finished: boolean, round: Object|null, resultBanner: Object|null }}
   */
  advanceOneRound() {
    let stepResult;
    do {
      stepResult = this.combatEngine.executeNextStep();
    } while (!('log' in stepResult) && this.combatEngine.state !== COMBAT_STATES.FINISHED);

    if ('log' in stepResult) {
      const roundSummary = this._buildRoundSummary(stepResult.log);
      this._roundLogs.push(roundSummary);
      return { finished: false, round: roundSummary, resultBanner: null };
    }

    // The match ended without one more 'log' step surfacing here (e.g. the
    // engine reached FINISHED while resolving the decision/rewards phases
    // this same call) — drive it the rest of the way and report the result.
    while (this.combatEngine.state !== COMBAT_STATES.FINISHED) {
      this.combatEngine.executeNextStep();
    }
    return { finished: true, round: null, resultBanner: this._buildResultBanner() };
  }

  /**
   * Runs the entire fight to completion in one call (no round-by-round
   * pause) — useful for a "simulate instantly" shortcut. Still populates
   * the round-by-round log for getRoundLogs()/toRoundsText().
   * @returns {Object} The result banner view model.
   */
  simulateToCompletion() {
    while (this.combatEngine.state !== COMBAT_STATES.FINISHED) {
      const stepResult = this.combatEngine.executeNextStep();
      if ('log' in stepResult) this._roundLogs.push(this._buildRoundSummary(stepResult.log));
    }
    return this._buildResultBanner();
  }

  /** @returns {Object[]} Every round summary collected so far this fight. */
  getRoundLogs() {
    return [...this._roundLogs];
  }

  // ---- view-model builders ----------------------------------------------------

  _buildFighterCardEntry(fighter) {
    return {
      id: fighter.identity.id,
      name: fighter.identity.name,
      nickname: fighter.identity.nickname,
      style: fighter.identity.style,
      age: fighter.identity.age,
      record: fighter.getRecordString(),
      legacyStage: fighter.getLegacyStage(),
      readiness: Math.round(fighter.getReadiness()),
      overallRating: fighter.getOverallRating(),
    };
  }

  _buildFightCard(orgId, isTitle) {
    return {
      orgId,
      isTitle,
      fighterA: this._buildFighterCardEntry(this._fighterA),
      fighterB: this._buildFighterCardEntry(this._fighterB),
    };
  }

  _buildRoundSummary(log) {
    return {
      round: log.round,
      damageDealt: { ...log.damageDealt },
      healthAfter: { ...log.healthAfter },
      staminaAfter: { ...log.staminaAfter },
      finish: log.finish ? { ...log.finish } : null,
    };
  }

  _buildResultBanner() {
    const snapshot = this.combatEngine.getSnapshot();
    const result = snapshot.result;
    if (!result) return null;

    const winnerEntry = result.winner ? (result.winner === 'A' ? this._fighterA : this._fighterB) : null;
    return {
      winner: result.winner,
      winnerName: winnerEntry?.identity.name ?? null,
      winnerNickname: winnerEntry?.identity.nickname ?? null,
      method: result.method,
      round: result.round,
      timeLabel: result.timeLabel,
      isTitle: result.isTitle,
      titleOnTheLine: result.titleOnTheLine,
      purses: result.purses,
      injuries: result.injuries,
      readiness: { A: result.combatMetrics.A.readiness, B: result.combatMetrics.B.readiness },
      headline: result.winner
        ? `${winnerEntry?.identity.name ?? `Coin ${result.winner}`} l'emporte par ${result.method} (round ${result.round}, ${result.timeLabel}).`
        : `Match nul par ${result.method}.`,
    };
  }

  // ---- text rendering ---------------------------------------------------------

  /** @returns {string} The pre-fight card, as plain text. */
  toCardText() {
    const card = this._buildFightCard(this._orgId, this._isTitle);
    const line = (f) =>
      `${f.name}${f.nickname ? ` "${f.nickname}"` : ''} (${f.style}, ${f.age} ans, ${f.record}, ${f.legacyStage}) — ` +
      `Readiness ${f.readiness}, Overall ${f.overallRating}`;
    return [
      `=== ${card.fighterA.name} vs ${card.fighterB.name}${card.isTitle ? ' — COMBAT DE TITRE' : ''} ===`,
      line(card.fighterA),
      line(card.fighterB),
    ].join('\n');
  }

  /** @returns {string} Every round collected so far, as plain text. */
  toRoundsText() {
    return this._roundLogs
      .map(
        (r) =>
          `Round ${r.round} — Degats A ${r.damageDealt.A} / B ${r.damageDealt.B} — Vie A ${Math.round(r.healthAfter.A)} / B ${Math.round(r.healthAfter.B)}` +
          (r.finish ? ` — FIN (${r.finish.method})` : '')
      )
      .join('\n');
  }

  /** @returns {string} The final result banner, as plain text (empty string if the fight isn't finished yet). */
  toResultText() {
    const banner = this._buildResultBanner();
    return banner ? banner.headline : '';
  }
}

export default FightNightView;
