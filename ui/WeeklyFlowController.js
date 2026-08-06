/**
 * ui/WeeklyFlowController.js — Phase 4.3 ("Player Experience & Vertical Slice")
 * ---------------------------------------------------------------------------
 * Structures one in-world week into the "Kairosoft" beat the spec asks for:
 *
 *   PLANNING (assign each fighter's 3 weekly-plan slots)
 *     -> RESOLUTION (engine/WeeklyPlanningEngine.js#processWeeklyPlan)
 *     -> DRAMA_CHOICE (if engine/DramaEngine.js selects an eligible event —
 *        the player answers it themselves, unlike the headless bot-AI's
 *        auto-pick; see engine/DramaEngine.js#selectEligibleDramaEvent/
 *        applyDramaEventChoice, the Phase 4.3 seam added specifically for
 *        this) — skipped entirely if no event is eligible this week
 *     -> SUMMARY (engine/ProgressionEngine.js#advanceWeek: calendar, legacy
 *        Training/Economy engines, EventEngine's news ticker, birthdays,
 *        retirements + Legacy Engine reconversion, rival gyms)
 *
 * This is a pure orchestration layer: every actual rule/roll lives in the
 * engines it calls, in the exact same call sequence
 * tools/SimRunner.js's own headless loop already uses and has validated
 * (processWeeklyPlan then advanceWeek) — WeeklyFlowController only adds the
 * pause for a human decision that a headless bot-AI doesn't need.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import { processWeeklyPlan } from '../engine/WeeklyPlanningEngine.js';
import { selectEligibleDramaEvent, applyDramaEventChoice } from '../engine/DramaEngine.js';
import { advanceWeek } from '../engine/ProgressionEngine.js';
import { computeActivityWeights } from '../engine/PersonalityEngine.js';

/** The controller's own tiny state machine — mirrors the 4-beat flow described above (RESOLUTION is not itself a phase name; it's the transition resolveWeek() performs). */
export const WEEKLY_FLOW_PHASES = Object.freeze({
  PLANNING: 'PLANNING',
  DRAMA_CHOICE: 'DRAMA_CHOICE',
});

/** Same weighted-random pick shape used throughout this codebase's Engine layer (see e.g. engine/WeeklyPlanningEngine.js#rollWeightedSeverity) — kept local rather than imported, matching the established convention of not cross-importing these small helpers between modules. */
function weightedPick(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    if (roll < weight) return key;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

export class WeeklyFlowController {
  /**
   * @param {Object} options
   * @param {Object} options.gameState - A GameState instance.
   * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
   */
  constructor({ gameState, rng }) {
    this.gameState = gameState;
    this.rng = rng ?? Math.random;
    this.phase = WEEKLY_FLOW_PHASES.PLANNING;
    this._weeklyPlanReport = null;
    this._dramaSelection = null;
  }

  /** @returns {string} One of WEEKLY_FLOW_PHASES. */
  getPhase() {
    return this.phase;
  }

  /**
   * @returns {Object[]} One entry per roster fighter, for a planning UI to
   *   present: current slots, and whether they're injured (PHYSIO_REST-only
   *   in practice, same real-game constraint the headless coach-AI respects).
   */
  getPlanningOptions() {
    const { playerState, worldState } = this.gameState;
    return playerState.roster.map((fighter) => ({
      fighterId: fighter.identity.id,
      name: fighter.identity.name,
      archetype: fighter.psychology.personality.archetype,
      injured: fighter.isInjured(worldState.currentDay),
      slots: [...fighter.weeklyPlan.slots],
      activityKeys: Object.keys(BALANCE.WEEKLY_PLANNING.ACTIVITIES),
    }));
  }

  /**
   * Assigns one weekly-plan slot for one fighter (see
   * Fighter#setWeeklyPlanSlot). Only valid during the PLANNING phase.
   * @param {string} fighterId
   * @param {number} slotIndex
   * @param {string|null} activityKey
   */
  setSlot(fighterId, slotIndex, activityKey) {
    this._assertPhase(WEEKLY_FLOW_PHASES.PLANNING);
    const fighter = this.gameState.playerState.getFighter(fighterId);
    if (!fighter) {
      throw new TypeError(`WeeklyFlowController.setSlot: unknown fighter "${fighterId}".`);
    }
    fighter.setWeeklyPlanSlot(slotIndex, activityKey);
  }

  /**
   * Auto-fills every roster fighter's plan using their own archetype/trait
   * activity-attraction weights — the exact mechanism
   * tools/SimRunner.js's headless coach-AI already uses (see
   * engine/PersonalityEngine.js#computeActivityWeights), offered here as a
   * one-click default for a player who wants to skip manual planning some
   * weeks. Only valid during the PLANNING phase.
   */
  autoFillPlan() {
    this._assertPhase(WEEKLY_FLOW_PHASES.PLANNING);
    const { playerState, worldState } = this.gameState;
    const slotCount = BALANCE.WEEKLY_PLANNING.SLOTS_PER_WEEK;

    for (const fighter of playerState.roster) {
      const injured = fighter.isInjured(worldState.currentDay);
      const weights = injured ? null : computeActivityWeights(fighter);
      for (let slot = 0; slot < slotCount; slot += 1) {
        const activityKey = injured ? 'PHYSIO_REST' : weightedPick(this.rng, weights);
        fighter.setWeeklyPlanSlot(slot, activityKey);
      }
    }
  }

  /**
   * Resolves the weekly plan every fighter is currently carrying, then
   * checks Drama Engine for an eligible event this week. If one exists, the
   * flow pauses (phase -> DRAMA_CHOICE) for the player to answer via
   * resolveDramaChoice(); otherwise the week completes immediately. Return
   * shape is always the same 5 keys regardless of which branch is taken
   * (dramaPrompt/dramaReport/weekSummary are simply null on whichever side
   * doesn't apply yet) so callers never have to special-case which fields
   * exist.
   *
   * @returns {{ phase: string, weeklyPlanReport: Object, dramaPrompt: Object|null, dramaReport: Object|null, weekSummary: Object|null }}
   */
  resolveWeek() {
    this._assertPhase(WEEKLY_FLOW_PHASES.PLANNING);
    const { playerState, worldState } = this.gameState;

    this._weeklyPlanReport = processWeeklyPlan(playerState, worldState, { rng: this.rng });
    this._dramaSelection = selectEligibleDramaEvent(playerState, worldState, this.rng);

    if (this._dramaSelection) {
      this.phase = WEEKLY_FLOW_PHASES.DRAMA_CHOICE;
      return {
        phase: this.phase,
        weeklyPlanReport: this._weeklyPlanReport,
        dramaPrompt: this._buildDramaPrompt(),
        dramaReport: null,
        weekSummary: null,
      };
    }

    return this._completeWeek(null);
  }

  /**
   * @returns {Object|null} The pending Drama Engine decision (event +
   *   choices) if the flow is currently paused on one, else null.
   */
  getPendingDramaPrompt() {
    return this._dramaSelection ? this._buildDramaPrompt() : null;
  }

  /**
   * Answers the pending Drama Engine choice and completes the week. Only
   * valid during the DRAMA_CHOICE phase.
   *
   * @param {string} choiceId - One of getPendingDramaPrompt().choices[*].id.
   * @returns {{ phase: string, weeklyPlanReport: Object, dramaPrompt: null, dramaReport: Object, weekSummary: Object }}
   */
  resolveDramaChoice(choiceId) {
    this._assertPhase(WEEKLY_FLOW_PHASES.DRAMA_CHOICE);
    const dramaReport = applyDramaEventChoice(this._dramaSelection, choiceId);
    return this._completeWeek(dramaReport);
  }

  // ---- internals ------------------------------------------------------------

  _buildDramaPrompt() {
    const { event, fighter } = this._dramaSelection;
    return {
      eventId: event.id,
      title: event.title,
      description: event.description,
      category: event.category,
      fighterId: fighter.identity.id,
      fighterName: fighter.identity.name,
      choices: event.choices.map((choice) => ({ id: choice.id, label: choice.label })),
    };
  }

  _completeWeek(dramaReport) {
    const weekSummary = advanceWeek(this.gameState, { rng: this.rng });

    const result = {
      phase: WEEKLY_FLOW_PHASES.PLANNING,
      weeklyPlanReport: this._weeklyPlanReport,
      dramaPrompt: null,
      dramaReport,
      weekSummary,
    };

    this.phase = WEEKLY_FLOW_PHASES.PLANNING;
    this._weeklyPlanReport = null;
    this._dramaSelection = null;
    return result;
  }

  _assertPhase(expected) {
    if (this.phase !== expected) {
      throw new Error(`WeeklyFlowController: expected phase "${expected}" but currently in "${this.phase}".`);
    }
  }
}

export default WeeklyFlowController;
