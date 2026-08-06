/**
 * ui/GymHub.js — Phase 4.3 ("Player Experience & Vertical Slice")
 * ---------------------------------------------------------------------------
 * The central dashboard controller: one call (getSnapshot()) synthesizes
 * everything a player needs to see at a glance before deciding what to do
 * this week — roster health (Readiness/Fatigue), the currently scheduled
 * fight (if any), any Drama Engine decision waiting on them, and the gym's
 * finances/reputation.
 *
 * Deliberately headless and framework-agnostic, unlike render/BaseRenderer.js's
 * EventBus-reactive push model: a Kairosoft-style weekly loop (see
 * ui/WeeklyFlowController.js) is pull-based by nature — the player asks "what
 * does my gym look like right now?" at specific moments (start of a week,
 * after a fight), not continuously. GymHub only reads State/Models; it never
 * mutates anything itself. tools/play-vertical-slice.js is its first real
 * consumer, but nothing here assumes a CLI — a future DOM renderer could
 * wrap the exact same getSnapshot() output.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

/** Physical/Mental Fatigue level at/above which GymHub flags a fighter as needing rest — this UI's own reasonable threshold, not a BALANCE-owned gameplay concept (mirrors tools/SimRunner.js's own MASSIVE_OVERHEAT_FATIGUE_THRESHOLD precedent for "this implementation's own operationalization"). */
const FATIGUE_WARNING_THRESHOLD = 70;

export class GymHub {
  /**
   * @param {Object} options
   * @param {Object} options.playerState - A PlayerState instance.
   * @param {Object} options.worldState - A WorldState instance.
   */
  constructor({ playerState, worldState }) {
    this.playerState = playerState;
    this.worldState = worldState;
    /** Set via setScheduledFight()/clearScheduledFight() by whoever books a match (e.g. tools/play-vertical-slice.js) — GymHub only mirrors it, never books a fight itself. */
    this._scheduledFight = null;
    /** Set via setPendingDramaChoice()/clearPendingDramaChoice() by ui/WeeklyFlowController.js when a Drama Engine event is awaiting a human decision. */
    this._pendingDramaChoice = null;
  }

  /**
   * @param {Object} fight - { fighterAId, fighterBId, orgId, isTitle }
   */
  setScheduledFight(fight) {
    this._scheduledFight = fight;
  }

  clearScheduledFight() {
    this._scheduledFight = null;
  }

  /**
   * @param {Object} selection - A DramaEngine#selectEligibleDramaEvent() result.
   */
  setPendingDramaChoice(selection) {
    this._pendingDramaChoice = selection;
  }

  clearPendingDramaChoice() {
    this._pendingDramaChoice = null;
  }

  /**
   * @returns {Object} A fresh, structured snapshot of the gym's current state.
   */
  getSnapshot() {
    return {
      gym: this._buildGymSummary(),
      roster: this.playerState.roster.map((fighter) => this._buildFighterSummary(fighter)),
      scheduledFight: this._buildScheduledFightSummary(),
      pendingDramaChoice: this._buildPendingDramaChoiceSummary(),
      alerts: this._buildAlerts(),
    };
  }

  _buildGymSummary() {
    return {
      name: this.playerState.gymName,
      money: this.playerState.money,
      reputation: this.playerState.reputation,
      hype: this.playerState.hype,
      day: this.worldState.currentDay,
      season: this.worldState.season,
      year: this.worldState.year,
      coaches: this.playerState.coaches.map((coach) => ({
        name: coach.name ?? coach.id,
        skill: coach.skill ?? 0,
        specialty: coach.specialty ?? null,
        isLegacyCoach: Boolean(coach.isLegacyCoach),
      })),
    };
  }

  _buildFighterSummary(fighter) {
    return {
      id: fighter.identity.id,
      name: fighter.identity.name,
      nickname: fighter.identity.nickname,
      style: fighter.identity.style,
      age: fighter.identity.age,
      record: fighter.getRecordString(),
      legacyStage: fighter.getLegacyStage(),
      readiness: Math.round(fighter.getReadiness()),
      physicalFatigue: Math.round(fighter.attributes.physicalFatigue),
      mentalFatigue: Math.round(fighter.attributes.mentalFatigue),
      moral: Math.round(fighter.attributes.moral),
      needsRest:
        fighter.attributes.physicalFatigue >= FATIGUE_WARNING_THRESHOLD || fighter.attributes.mentalFatigue >= FATIGUE_WARNING_THRESHOLD,
      injured: fighter.isInjured(this.worldState.currentDay),
      weeklyPlan: [...fighter.weeklyPlan.slots],
    };
  }

  _buildScheduledFightSummary() {
    if (!this._scheduledFight) return null;
    const { fighterAId, fighterBId, orgId, isTitle } = this._scheduledFight;
    const fighterA = this.playerState.getFighter(fighterAId);
    const fighterB = this.playerState.getFighter(fighterBId);
    return {
      orgId,
      isTitle,
      fighterA: fighterA ? { id: fighterA.identity.id, name: fighterA.identity.name, nickname: fighterA.identity.nickname } : null,
      fighterB: fighterB ? { id: fighterB.identity.id, name: fighterB.identity.name, nickname: fighterB.identity.nickname } : null,
    };
  }

  _buildPendingDramaChoiceSummary() {
    if (!this._pendingDramaChoice) return null;
    const { event, fighter } = this._pendingDramaChoice;
    return {
      eventId: event.id,
      category: event.category,
      fighterId: fighter.identity.id,
      fighterName: fighter.identity.name,
      choices: event.choices.map((choice) => ({ id: choice.id, label: choice.label })),
    };
  }

  /** Short, actionable headlines — the "what needs my attention" strip a Kairosoft-style hub leads with. */
  _buildAlerts() {
    const alerts = [];

    if (this._pendingDramaChoice) {
      alerts.push({ kind: 'DRAMA_CHOICE', text: `${this._pendingDramaChoice.event.id} attend une decision.` });
    }

    for (const fighter of this.playerState.roster) {
      if (fighter.isInjured(this.worldState.currentDay)) {
        alerts.push({ kind: 'INJURY', text: `${fighter.identity.name} est blesse(e).` });
      } else if (
        fighter.attributes.physicalFatigue >= FATIGUE_WARNING_THRESHOLD ||
        fighter.attributes.mentalFatigue >= FATIGUE_WARNING_THRESHOLD
      ) {
        alerts.push({ kind: 'FATIGUE', text: `${fighter.identity.name} a besoin de repos.` });
      }
    }

    if (this.playerState.money < BALANCE.ECONOMY.INSOLVENCY.DEBT_THRESHOLD) {
      alerts.push({ kind: 'INSOLVENCY', text: `Tresorerie critique : ${this.playerState.money}$.` });
    }

    return alerts;
  }

  /**
   * @returns {string} A compact, human-readable text rendering of getSnapshot() — the CLI's primary display.
   */
  toText() {
    const v = this.getSnapshot();
    const lines = [];
    lines.push(`=== ${v.gym.name} — Jour ${v.gym.day} (${v.gym.season}, an ${v.gym.year}) ===`);
    lines.push(`Tresorerie : ${v.gym.money}$  |  Reputation : ${v.gym.reputation}  |  Hype : ${v.gym.hype}`);
    if (v.gym.coaches.length > 0) {
      lines.push(`Coachs : ${v.gym.coaches.map((c) => `${c.name} (${c.specialty ?? 'generaliste'}, skill ${c.skill})`).join(', ')}`);
    }

    if (v.alerts.length > 0) {
      lines.push('');
      lines.push('ALERTES :');
      for (const alert of v.alerts) lines.push(`  ! ${alert.text}`);
    }

    lines.push('');
    lines.push('ROSTER :');
    for (const fighter of v.roster) {
      const tag = fighter.nickname ? ` "${fighter.nickname}"` : '';
      const rest = fighter.injured ? ' [BLESSE]' : fighter.needsRest ? ' [FATIGUE]' : '';
      lines.push(
        `  ${fighter.name}${tag} (${fighter.style}, ${fighter.age} ans, ${fighter.record}) — ` +
          `Readiness ${fighter.readiness} | Fatigue P/M ${fighter.physicalFatigue}/${fighter.mentalFatigue} | Moral ${fighter.moral}${rest}`
      );
    }

    if (v.scheduledFight) {
      lines.push('');
      lines.push(
        `PROCHAIN COMBAT : ${v.scheduledFight.fighterA?.name ?? '?'} vs ${v.scheduledFight.fighterB?.name ?? '?'}` +
          `${v.scheduledFight.isTitle ? ' (combat de titre)' : ''}`
      );
    }

    if (v.pendingDramaChoice) {
      lines.push('');
      lines.push(`DECISION EN ATTENTE (${v.pendingDramaChoice.fighterName}) : ${v.pendingDramaChoice.eventId}`);
    }

    return lines.join('\n');
  }
}

export default GymHub;
