/**
 * engine/CombatEngine.js
 * ---------------------------------------------------------------------------
 * CombatEngine — the fight simulator, modeled as a self-contained Finite
 * State Machine (FSM). This is the reference example of an "Engine" module
 * in the V2 architecture: it reads Models (Fighter) and Data (balance.js),
 * mutates State (PlayerState, via injected references) through their own
 * public methods, and announces everything it does on EventBus. It never
 * imports Render, and never imports the State *modules* themselves — only
 * instances handed to it — so it has zero compile-time coupling to how
 * PlayerState/WorldState are constructed.
 *
 * FSM phases (see COMBAT_STATES):
 *   IDLE                -> waiting for setupMatch().
 *   INIT                -> fighters received, corners/rounds organized.
 *   WEIGH_IN            -> weight-cut profiles resolved (miss chance, form impact).
 *   INTRO               -> round/score bookkeeping initialized.
 *   ROUND_START         -> round counter incremented.
 *   ROUND_SIMULATION    -> the round is actually fought (damage, stamina, finish checks).
 *   CORNER_PAUSE        -> between-rounds recovery; fighter A's gameplan may be adjusted.
 *   DECISION_STOPPAGE   -> a finish already occurred, or judges' scorecards are tallied.
 *   POST_MATCH_REWARDS  -> purses, reputation/hype, perks, injuries, career records.
 *   FINISHED            -> terminal; match summary available on read, runtime cleaned up.
 *
 * Every transition publishes 'combat:state_changed'. Every simulated round
 * publishes 'combat:round_completed'. The final summary is published once
 * on 'combat:finished'. See COMBAT_EVENTS for exact names.
 *
 * Determinism: all randomness goes through this.rng (defaults to
 * Math.random). Inject a seeded function (see createSeededRng) to get
 * fully reproducible fights — used heavily by this file's own tests.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';

/** FSM phase names. */
export const COMBAT_STATES = Object.freeze({
  IDLE: 'IDLE',
  INIT: 'INIT',
  WEIGH_IN: 'WEIGH_IN',
  INTRO: 'INTRO',
  ROUND_START: 'ROUND_START',
  ROUND_SIMULATION: 'ROUND_SIMULATION',
  CORNER_PAUSE: 'CORNER_PAUSE',
  DECISION_STOPPAGE: 'DECISION_STOPPAGE',
  POST_MATCH_REWARDS: 'POST_MATCH_REWARDS',
  FINISHED: 'FINISHED',
});

/** Event names published on EventBus by CombatEngine. Import instead of raw strings. */
export const COMBAT_EVENTS = Object.freeze({
  STATE_CHANGED: 'combat:state_changed',
  ROUND_COMPLETED: 'combat:round_completed',
  FINISHED: 'combat:finished',
});

/** Finish/decision method labels used in finish/result payloads. */
export const FINISH_METHODS = Object.freeze({
  KO: 'KO',
  TKO: 'TKO',
  SUBMISSION: 'SUBMISSION',
  DOCTOR_STOPPAGE: 'DOCTOR_STOPPAGE',
  UNANIMOUS_DECISION: 'UNANIMOUS_DECISION',
  SPLIT_DECISION: 'SPLIT_DECISION',
  MAJORITY_DECISION: 'MAJORITY_DECISION',
  DRAW: 'DRAW',
});

// Valid gameplan/weight-cut keys are derived from BALANCE itself so the
// engine can never drift out of sync with the coefficients it reads.
const VALID_TARGETS = Object.freeze(Object.keys(BALANCE.COMBAT.GAMEPLAN.TARGET_EFFECTS));
const VALID_DISTANCES = Object.freeze(Object.keys(BALANCE.COMBAT.GAMEPLAN.DISTANCE_SKILL_WEIGHTS));
const VALID_TEMPOS = Object.freeze(Object.keys(BALANCE.COMBAT.GAMEPLAN.TEMPO_MODIFIERS));
const VALID_WEIGHT_CUT_PROFILES = Object.freeze(Object.keys(BALANCE.WEIGH_IN.PROFILES));

const DEFAULT_GAMEPLAN = Object.freeze({ target: 'HEAD', distance: 'STRIKING', tempo: 'BALANCED' });
const OTHER_FIGHTER_KEY = Object.freeze({ A: 'B', B: 'A' });
const TARGET_TO_TALLY_KEY = Object.freeze({ HEAD: 'face', BODY: 'body', LEGS: 'legs' });
const DECISION_METHODS = Object.freeze([
  FINISH_METHODS.UNANIMOUS_DECISION,
  FINISH_METHODS.SPLIT_DECISION,
  FINISH_METHODS.MAJORITY_DECISION,
  FINISH_METHODS.DRAW,
]);
const INJURY_BODY_PARTS = Object.freeze([
  'Genou',
  'Coude',
  'Arcade sourciliere',
  'Cheville',
  'Cotes',
  'Epaule',
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

let idCounter = 0;
function generateId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * Tiny seeded PRNG (mulberry32) for fully reproducible simulations —
 * useful for tests and for "replay this exact fight" features later.
 * @param {number} seed
 * @returns {() => number} A function producing floats in [0, 1).
 */
export function createSeededRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CombatEngine {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.playerState] - A PlayerState instance; enables
   *   crediting purses/reputation/hype to the player's gym when one of the
   *   fighters belongs to playerState.roster. Optional — omit for headless,
   *   informational-only simulations (e.g. simulating rival-gym fights).
   * @param {Object|null} [options.worldState] - A WorldState instance; used
   *   only to anchor injury dates to WorldState.currentDay. Optional.
   * @param {Object|null} [options.runtimeState] - GameState.runtimeState (or
   *   any plain object); if provided, isSimulationRunning is cleared when
   *   the match reaches FINISHED. Optional.
   * @param {() => number} [options.rng] - Random source in [0, 1). Defaults
   *   to Math.random; pass createSeededRng(seed) for determinism.
   */
  constructor(options = {}) {
    this.playerState = options.playerState ?? null;
    this.worldState = options.worldState ?? null;
    this.runtimeState = options.runtimeState ?? null;
    this.rng = options.rng ?? Math.random;

    /** @type {string} */
    this.state = COMBAT_STATES.IDLE;
    /** @type {Object|null} */
    this.context = null;
  }

  /**
   * Binds/rebinds optional collaborators after construction (e.g. once
   * GameState has been created). Only provided keys are updated.
   * @param {Object} refs
   * @returns {CombatEngine} this, for chaining.
   */
  attachContext({ playerState, worldState, runtimeState } = {}) {
    if (playerState !== undefined) this.playerState = playerState;
    if (worldState !== undefined) this.worldState = worldState;
    if (runtimeState !== undefined) this.runtimeState = runtimeState;
    return this;
  }

  // ==========================================================================
  // Control methods
  // ==========================================================================

  /**
   * Starts a new match: receives both fighters, organizes corners, and
   * determines round count/title status. Moves IDLE/FINISHED -> INIT.
   * Call executeNextStep()/advanceState() to actually process INIT.
   *
   * @param {Fighter} fighterA
   * @param {Fighter} fighterB
   * @param {string} orgId
   * @param {boolean} [isTitle=false]
   * @returns {CombatEngine} this, for chaining.
   */
  setupMatch(fighterA, fighterB, orgId, isTitle = false) {
    if (this.state !== COMBAT_STATES.IDLE && this.state !== COMBAT_STATES.FINISHED) {
      throw new Error(
        `CombatEngine.setupMatch: cannot start a new match while a match is in progress (state "${this.state}"). Call reset() first if you intend to abort it.`
      );
    }
    if (!(fighterA instanceof Fighter) || !(fighterB instanceof Fighter)) {
      throw new TypeError('CombatEngine.setupMatch: fighterA and fighterB must be Fighter instances.');
    }
    if (fighterA.identity.id === fighterB.identity.id) {
      throw new TypeError('CombatEngine.setupMatch: a fighter cannot be matched against themselves.');
    }

    const maxRounds = isTitle
      ? BALANCE.COMBAT.ROUNDS_PER_FIGHT.MAIN_EVENT
      : BALANCE.COMBAT.ROUNDS_PER_FIGHT.UNDERCARD;

    const redCornerKey = this._organizeCorners(fighterA, fighterB);

    this.context = {
      matchId: generateId('match'),
      orgId,
      originalIsTitle: isTitle,
      isTitle,
      titleForfeitedBy: null,
      maxRounds,
      currentRound: 0,
      fighters: { A: fighterA, B: fighterB },
      corners: { red: redCornerKey, blue: OTHER_FIGHTER_KEY[redCornerKey] },
      gameplans: { A: { ...DEFAULT_GAMEPLAN }, B: { ...DEFAULT_GAMEPLAN } },
      weightCut: { A: null, B: null },
      live: {
        A: this._createLiveState(fighterA),
        B: this._createLiveState(fighterB),
      },
      damageTally: { A: { face: 0, body: 0, legs: 0 }, B: { face: 0, body: 0, legs: 0 } },
      roundLogs: [],
      scorecards: [],
      finish: null,
      result: null,
    };

    this._transition(COMBAT_STATES.INIT);
    return this;
  }

  /**
   * Sets (part of) a fighter's gameplan. Valid any time after setupMatch()
   * and before the match is resolved. During CORNER_PAUSE specifically,
   * only fighter "A" (the player's corner) may be adjusted — the opponent's
   * corner is not player-controlled between rounds.
   *
   * @param {('A'|'B')} fighterKey
   * @param {Object} plan
   * @param {string} [plan.target] - One of Object.keys(BALANCE.COMBAT.GAMEPLAN.TARGET_EFFECTS).
   * @param {string} [plan.distance] - One of Object.keys(BALANCE.COMBAT.GAMEPLAN.DISTANCE_SKILL_WEIGHTS).
   * @param {string} [plan.tempo] - One of Object.keys(BALANCE.COMBAT.GAMEPLAN.TEMPO_MODIFIERS).
   * @returns {Object} The fighter's resulting gameplan.
   */
  setGameplan(fighterKey, { target, distance, tempo } = {}) {
    this._assertActiveMatch();
    this._assertFighterKey(fighterKey);
    this._assertMatchNotResolved('setGameplan');

    if (this.state === COMBAT_STATES.CORNER_PAUSE && fighterKey !== 'A') {
      throw new Error(
        'CombatEngine.setGameplan: during CORNER_PAUSE only fighter "A" (the player\'s corner) may adjust its gameplan.'
      );
    }

    const plan = this.context.gameplans[fighterKey];
    if (target !== undefined) {
      if (!VALID_TARGETS.includes(target)) {
        throw new TypeError(`CombatEngine.setGameplan: invalid target "${target}".`);
      }
      plan.target = target;
    }
    if (distance !== undefined) {
      if (!VALID_DISTANCES.includes(distance)) {
        throw new TypeError(`CombatEngine.setGameplan: invalid distance "${distance}".`);
      }
      plan.distance = distance;
    }
    if (tempo !== undefined) {
      if (!VALID_TEMPOS.includes(tempo)) {
        throw new TypeError(`CombatEngine.setGameplan: invalid tempo "${tempo}".`);
      }
      plan.tempo = tempo;
    }

    return { ...plan };
  }

  /**
   * Chooses a fighter's weight-cut profile. Must be called before the
   * WEIGH_IN phase resolves (i.e. while state is INIT or WEIGH_IN).
   *
   * @param {('A'|'B')} fighterKey
   * @param {string} profileKey - One of Object.keys(BALANCE.WEIGH_IN.PROFILES)
   *   (NATUREL, MODERE, INTENSIF, EXTREME).
   * @returns {Object} The stored (unresolved) weight-cut choice.
   */
  selectWeightCutProfile(fighterKey, profileKey) {
    this._assertActiveMatch();
    this._assertFighterKey(fighterKey);

    if (this.state !== COMBAT_STATES.INIT && this.state !== COMBAT_STATES.WEIGH_IN) {
      throw new Error(
        `CombatEngine.selectWeightCutProfile: weight cut must be chosen before the WEIGH_IN phase resolves (current state "${this.state}").`
      );
    }
    if (!VALID_WEIGHT_CUT_PROFILES.includes(profileKey)) {
      throw new TypeError(`CombatEngine.selectWeightCutProfile: invalid profile "${profileKey}".`);
    }

    this.context.weightCut[fighterKey] = { profileKey, resolved: false, missedWeight: false };
    return { ...this.context.weightCut[fighterKey] };
  }

  /**
   * Executes the current FSM phase's work and transitions to the next
   * phase. This is the engine's single stepping primitive.
   * @returns {Object} A small summary of what just happened.
   */
  executeNextStep() {
    if (!this.context) {
      throw new Error('CombatEngine.executeNextStep: no active match. Call setupMatch() first.');
    }

    switch (this.state) {
      case COMBAT_STATES.INIT:
        return this._processInit();
      case COMBAT_STATES.WEIGH_IN:
        return this._processWeighIn();
      case COMBAT_STATES.INTRO:
        return this._processIntro();
      case COMBAT_STATES.ROUND_START:
        return this._processRoundStart();
      case COMBAT_STATES.ROUND_SIMULATION:
        return this._processRoundSimulation();
      case COMBAT_STATES.CORNER_PAUSE:
        return this._processCornerPause();
      case COMBAT_STATES.DECISION_STOPPAGE:
        return this._processDecisionStoppage();
      case COMBAT_STATES.POST_MATCH_REWARDS:
        return this._processPostMatchRewards();
      case COMBAT_STATES.FINISHED:
        throw new Error('CombatEngine.executeNextStep: match is already FINISHED; nothing left to execute.');
      default:
        throw new Error(`CombatEngine.executeNextStep: unhandled state "${this.state}".`);
    }
  }

  /**
   * Alias for executeNextStep(), offered for readability at call sites
   * that only care about "move the FSM forward" rather than the result.
   * @returns {Object}
   */
  advanceState() {
    return this.executeNextStep();
  }

  /**
   * Headless acceleration mode: runs executeNextStep() in a loop, with no
   * pause at CORNER_PAUSE, until the match reaches FINISHED. Useful for
   * simulating background league fights or an instant-sim option for the
   * player's own bout.
   * @returns {Object} The final match result (same shape as the
   *   'combat:finished' event payload).
   */
  simulateFullMatch() {
    if (!this.context) {
      throw new Error('CombatEngine.simulateFullMatch: no active match. Call setupMatch() first.');
    }

    // Generous but finite cap: guards against ever spinning forever if a
    // future change to the FSM introduces a transition cycle bug.
    const safetyStepLimit = this.context.maxRounds * 4 + 20;
    let steps = 0;

    while (this.state !== COMBAT_STATES.FINISHED) {
      this.executeNextStep();
      steps += 1;
      if (steps > safetyStepLimit) {
        throw new Error('CombatEngine.simulateFullMatch: exceeded safety step limit; likely an FSM transition bug.');
      }
    }

    return this.context.result;
  }

  /**
   * Aborts whatever match is in progress (if any) and returns to IDLE.
   * @returns {CombatEngine} this, for chaining.
   */
  reset() {
    const previous = this.state;
    this.context = null;
    this.state = COMBAT_STATES.IDLE;
    if (previous !== COMBAT_STATES.IDLE) {
      EventBus.publish(COMBAT_EVENTS.STATE_CHANGED, { from: previous, to: COMBAT_STATES.IDLE, round: 0 });
    }
    return this;
  }

  /**
   * Read-only, plain-object snapshot of the current match for Render/UI
   * consumption without exposing internal Fighter references.
   * @returns {Object}
   */
  getSnapshot() {
    if (!this.context) {
      return { state: this.state, context: null };
    }
    const c = this.context;
    return {
      state: this.state,
      matchId: c.matchId,
      orgId: c.orgId,
      isTitle: c.isTitle,
      currentRound: c.currentRound,
      maxRounds: c.maxRounds,
      corners: { ...c.corners },
      gameplans: { A: { ...c.gameplans.A }, B: { ...c.gameplans.B } },
      live: { A: { ...c.live.A }, B: { ...c.live.B } },
      damageTally: { A: { ...c.damageTally.A }, B: { ...c.damageTally.B } },
      finish: c.finish ? { ...c.finish } : null,
      result: c.result ? { ...c.result } : null,
    };
  }

  // ==========================================================================
  // Phase processors (private)
  // ==========================================================================

  _processInit() {
    // Corner/round organization already happened in setupMatch(); INIT's
    // remaining job is simply to hand off to weight management.
    this._transition(COMBAT_STATES.WEIGH_IN);
    return { state: this.state };
  }

  _processWeighIn() {
    const c = this.context;

    for (const key of ['A', 'B']) {
      if (!c.weightCut[key]) {
        // No explicit choice made: default to the safest cut.
        c.weightCut[key] = { profileKey: 'NATUREL', resolved: false, missedWeight: false };
      }

      const cut = c.weightCut[key];
      const profile = BALANCE.WEIGH_IN.PROFILES[cut.profileKey];
      const fighter = c.fighters[key];
      const live = c.live[key];

      cut.missedWeight = this.rng() < profile.missChance;
      cut.resolved = true;

      live.forme = clamp(
        fighter.attributes.forme * (1 + profile.formModifier),
        BALANCE.FORM.MIN,
        BALANCE.FORM.MAX
      );
      live.stamina = clamp(
        BALANCE.COMBAT.STAMINA.MAX * (1 + profile.staminaModifier),
        0,
        BALANCE.COMBAT.STAMINA.MAX
      );

      if (cut.missedWeight) {
        cut.purseForfeitPercent = BALANCE.WEIGH_IN.MISSED_WEIGHT_PURSE_PENALTY_PERCENT;
        if (c.isTitle) {
          c.isTitle = false;
          c.titleForfeitedBy = key;
        }
      }
    }

    this._transition(COMBAT_STATES.INTRO);
    return { state: this.state, weightCut: { A: { ...c.weightCut.A }, B: { ...c.weightCut.B } } };
  }

  _processIntro() {
    const c = this.context;
    c.currentRound = 0;
    c.roundLogs = [];
    c.scorecards = [];
    c.damageTally = { A: { face: 0, body: 0, legs: 0 }, B: { face: 0, body: 0, legs: 0 } };

    this._transition(COMBAT_STATES.ROUND_START);
    return { state: this.state };
  }

  _processRoundStart() {
    const c = this.context;
    c.currentRound += 1;

    this._transition(COMBAT_STATES.ROUND_SIMULATION);
    return { state: this.state, round: c.currentRound };
  }

  _processRoundSimulation() {
    const c = this.context;
    const round = c.currentRound;

    const offenseA = this._computeRoundOffense('A', 'B');
    const offenseB = this._computeRoundOffense('B', 'A');

    // Both fighters' damage is computed from pre-round stats above, then
    // applied together, so neither fighter gets an order-of-evaluation edge.
    this._applyDamage('B', offenseA);
    this._applyDamage('A', offenseB);

    c.live.A.stamina = clamp(c.live.A.stamina - offenseA.staminaCost, 0, BALANCE.COMBAT.STAMINA.MAX);
    c.live.B.stamina = clamp(c.live.B.stamina - offenseB.staminaCost, 0, BALANCE.COMBAT.STAMINA.MAX);

    const finish = this._checkFinishConditions(round, offenseA, offenseB);
    if (finish) {
      c.finish = finish;
    }

    const roundScore = this._scoreRound(round, offenseA, offenseB);
    c.scorecards.push(roundScore);

    const log = {
      round,
      gameplans: { A: { ...c.gameplans.A }, B: { ...c.gameplans.B } },
      damageDealt: {
        A: Math.round(offenseA.rawDamage * 10) / 10,
        B: Math.round(offenseB.rawDamage * 10) / 10,
      },
      damageTally: { A: { ...c.damageTally.A }, B: { ...c.damageTally.B } },
      healthAfter: { A: c.live.A.health, B: c.live.B.health },
      staminaAfter: { A: c.live.A.stamina, B: c.live.B.stamina },
      roundScore: { compositeA: roundScore.compositeA, compositeB: roundScore.compositeB, judgeCards: roundScore.judgeCards },
      finish: finish ? { ...finish } : null,
    };
    c.roundLogs.push(log);

    EventBus.publish(COMBAT_EVENTS.ROUND_COMPLETED, { round, log });

    if (finish || round >= c.maxRounds) {
      this._transition(COMBAT_STATES.DECISION_STOPPAGE);
    } else {
      this._transition(COMBAT_STATES.CORNER_PAUSE);
    }

    return { state: this.state, round, log };
  }

  _processCornerPause() {
    const c = this.context;
    for (const key of ['A', 'B']) {
      const live = c.live[key];
      live.stamina = clamp(
        live.stamina + BALANCE.COMBAT.STAMINA.REGEN_PER_ROUND_REST,
        0,
        BALANCE.COMBAT.STAMINA.MAX
      );
    }

    this._transition(COMBAT_STATES.ROUND_START);
    return { state: this.state };
  }

  _processDecisionStoppage() {
    const c = this.context;

    if (!c.finish) {
      c.finish = this._computeJudgesDecision();
    }

    this._transition(COMBAT_STATES.POST_MATCH_REWARDS);
    return { state: this.state, finish: { ...c.finish } };
  }

  _processPostMatchRewards() {
    const c = this.context;
    const finish = c.finish;
    const isDraw = finish.method === FINISH_METHODS.DRAW;
    const byFinish = !DECISION_METHODS.includes(finish.method);

    const titleOnTheLine = c.isTitle;
    const titleWinnerKey = titleOnTheLine && !isDraw ? finish.winnerKey : null;

    const purses = this._computePurses(finish, isDraw, byFinish);
    const perksUnlocked = { A: [], B: [] };
    const injuries = { A: null, B: null };
    const reputationDeltas = { A: 0, B: 0 };
    const hypeDeltas = { A: 0, B: 0 };

    for (const key of ['A', 'B']) {
      const fighter = c.fighters[key];
      const outcome = isDraw ? 'draw' : finish.winnerKey === key ? 'win' : 'loss';
      const wonTitle = titleWinnerKey === key;

      fighter.recordFightResult({
        outcome,
        byFinish: byFinish && outcome === 'win',
        titleWon: wonTitle ? `${c.orgId} ${fighter.identity.weightClass}` : undefined,
      });

      if (outcome === 'win') {
        fighter.adjustMorale(wonTitle ? BALANCE.MORALE.EVENTS.WIN_TITLE : BALANCE.MORALE.EVENTS.WIN_FIGHT);
      } else if (outcome === 'loss') {
        fighter.adjustMorale(BALANCE.MORALE.EVENTS.LOSE_FIGHT);
      }

      if (
        outcome === 'win' &&
        fighter.career.finishes >= BALANCE.PERKS.UNLOCK_THRESHOLDS.FINISHER_CAREER_FINISHES &&
        fighter.addPerk('FINISHER')
      ) {
        perksUnlocked[key].push('FINISHER');
      }
      if (wonTitle && fighter.addPerk('TITLE_HOLDER')) {
        perksUnlocked[key].push('TITLE_HOLDER');
      }

      const injury = this._rollPostFightInjury(key);
      if (injury) {
        injuries[key] = injury;
        fighter.applyInjury(injury);
        fighter.adjustMorale(BALANCE.MORALE.EVENTS.INJURY_SUSTAINED);
      }

      if (this._isPlayerFighter(fighter)) {
        let repDelta = 0;
        if (outcome === 'win') {
          repDelta = wonTitle
            ? BALANCE.GYM.REPUTATION_EVENTS.FIGHTER_TITLE_WIN
            : BALANCE.GYM.REPUTATION_EVENTS.FIGHTER_WIN;
        } else if (outcome === 'loss') {
          repDelta = BALANCE.GYM.REPUTATION_EVENTS.FIGHTER_LOSS;
        }
        reputationDeltas[key] = repDelta;

        let hypeDelta = 0;
        if (outcome === 'win') {
          hypeDelta = wonTitle ? BALANCE.GYM.HYPE.EVENTS.TITLE_WIN : BALANCE.GYM.HYPE.EVENTS.WIN;
          if (byFinish) hypeDelta += BALANCE.GYM.HYPE.EVENTS.FINISH_BONUS;
        } else if (outcome === 'loss') {
          hypeDelta = BALANCE.GYM.HYPE.EVENTS.LOSS;
        }
        hypeDeltas[key] = hypeDelta;

        if (repDelta !== 0) this.playerState.changeReputation(repDelta, `FIGHT_RESULT:${finish.method}`);
        if (hypeDelta !== 0) this.playerState.changeHype(hypeDelta, `FIGHT_RESULT:${finish.method}`);
        if (purses[key].gymShare !== 0) {
          this.playerState.changeMoney(purses[key].gymShare, `FIGHT_PURSE:${fighter.identity.name}`);
        }
      }
    }

    c.result = {
      matchId: c.matchId,
      orgId: c.orgId,
      isTitle: c.originalIsTitle,
      titleOnTheLine,
      titleForfeitedBy: c.titleForfeitedBy,
      winner: isDraw ? null : finish.winnerKey,
      method: finish.method,
      round: finish.round,
      timeLabel: finish.timeLabel,
      fighters: { A: c.fighters.A.identity.id, B: c.fighters.B.identity.id },
      names: { A: c.fighters.A.identity.name, B: c.fighters.B.identity.name },
      purses,
      reputationDeltas,
      hypeDeltas,
      perksUnlocked,
      injuries,
      damageTally: { A: { ...c.damageTally.A }, B: { ...c.damageTally.B } },
      scorecards: c.scorecards.map((s) => ({ round: s.round, judgeCards: s.judgeCards })),
    };

    this._transition(COMBAT_STATES.FINISHED);
    if (this.runtimeState) {
      this.runtimeState.isSimulationRunning = false;
    }

    EventBus.publish(COMBAT_EVENTS.FINISHED, { ...c.result });

    return { state: this.state, result: c.result };
  }

  // ==========================================================================
  // Round math (private)
  // ==========================================================================

  _organizeCorners(fighterA, fighterB) {
    if (fighterA.isChampion() !== fighterB.isChampion()) {
      return fighterA.isChampion() ? 'A' : 'B';
    }
    return fighterA.career.wins >= fighterB.career.wins ? 'A' : 'B';
  }

  _createLiveState(fighter) {
    return {
      health: BALANCE.COMBAT.HEALTH.MAX,
      stamina: BALANCE.COMBAT.STAMINA.MAX,
      forme: fighter.attributes.forme,
      tkoStreak: 0,
    };
  }

  _getStyleBonus(fighter) {
    return BALANCE.COMBAT.STYLE_BONUSES[fighter.identity.style] ?? BALANCE.COMBAT.STYLE_BONUSES.DEFAULT;
  }

  /**
   * Aggregates every perk the fighter holds that defines the given
   * multiplier field (e.g. 'damageMultiplier'), multiplying them together.
   * @param {Fighter} fighter
   * @param {string} field
   * @returns {number}
   */
  _getPerkMultiplier(fighter, field) {
    let multiplier = 1;
    for (const perkId of fighter.perks) {
      const def = BALANCE.PERKS.DEFINITIONS[perkId];
      if (def && typeof def[field] === 'number') {
        multiplier *= def[field];
      }
    }
    return multiplier;
  }

  _computeMoraleMultiplier(moral) {
    const { LOW, HIGH, LOW_PERFORMANCE_MULTIPLIER, HIGH_PERFORMANCE_MULTIPLIER } = BALANCE.MORALE.THRESHOLDS;
    if (moral <= LOW) return LOW_PERFORMANCE_MULTIPLIER;
    if (moral >= HIGH) return HIGH_PERFORMANCE_MULTIPLIER;
    return 1;
  }

  _rollVarianceMultiplier() {
    const v = BALANCE.COMBAT.VARIANCE;
    let multiplier = v.MIN_ROLL_MULTIPLIER + this.rng() * (v.MAX_ROLL_MULTIPLIER - v.MIN_ROLL_MULTIPLIER);
    if (this.rng() < v.UPSET_EVENT_CHANCE) {
      multiplier *= v.UPSET_EVENT_MULTIPLIER;
    }
    return multiplier;
  }

  _computeHitChance(attacker, defender) {
    const acc = BALANCE.COMBAT.ACCURACY;
    const raw =
      acc.STRIKE_BASE_HIT_CHANCE +
      acc.SKILL_DELTA_CHANCE_SCALING *
        (attacker.attributes.skills.intelligence - defender.attributes.skills.intelligence);
    return clamp(raw, acc.MIN_HIT_CHANCE, acc.MAX_HIT_CHANCE);
  }

  /**
   * Resolves one fighter's offensive output for the current round: raw
   * damage, stamina cost, KO-chance influence, and submission attempt/result.
   * Reads only pre-round state so A and B can be computed independently and
   * applied simultaneously.
   *
   * @param {('A'|'B')} attackerKey
   * @param {('A'|'B')} defenderKey
   * @returns {Object}
   */
  _computeRoundOffense(attackerKey, defenderKey) {
    const c = this.context;
    const attacker = c.fighters[attackerKey];
    const defender = c.fighters[defenderKey];
    const attackerLive = c.live[attackerKey];
    const plan = c.gameplans[attackerKey];

    const skillWeights = BALANCE.COMBAT.GAMEPLAN.DISTANCE_SKILL_WEIGHTS[plan.distance];
    const offenseRaw = Object.keys(skillWeights).reduce(
      (total, skillKey) => total + attacker.attributes.skills[skillKey] * skillWeights[skillKey],
      0
    );

    const styleBonus = this._getStyleBonus(attacker);
    const styleDistanceMultiplier = styleBonus.distance === plan.distance ? styleBonus.outputMultiplier ?? 1 : 1;
    const styleTargetMultiplier = styleBonus.targetMultipliers?.[plan.target] ?? 1;

    const tempoMods = BALANCE.COMBAT.GAMEPLAN.TEMPO_MODIFIERS[plan.tempo];
    const formMultiplier = attackerLive.forme / BALANCE.FORM.MAX;
    const moraleMultiplier = this._computeMoraleMultiplier(attacker.attributes.moral);
    const staminaMultiplier =
      attackerLive.stamina <= BALANCE.COMBAT.STAMINA.LOW_STAMINA_THRESHOLD
        ? BALANCE.COMBAT.STAMINA.LOW_STAMINA_PENALTY_MULTIPLIER
        : 1;
    const perkDamageMultiplier = this._getPerkMultiplier(attacker, 'damageMultiplier');
    const varianceMultiplier = this._rollVarianceMultiplier();
    const hitChance = this._computeHitChance(attacker, defender);

    const output =
      offenseRaw *
      styleDistanceMultiplier *
      styleTargetMultiplier *
      tempoMods.outputMultiplier *
      formMultiplier *
      moraleMultiplier *
      staminaMultiplier *
      perkDamageMultiplier *
      varianceMultiplier *
      hitChance;

    const targetEffects = BALANCE.COMBAT.GAMEPLAN.TARGET_EFFECTS[plan.target];
    const overallGap = attacker.getOverallRating() - defender.getOverallRating();
    const advantageMultiplier = 1 + overallGap * BALANCE.COMBAT.DAMAGE.ATTRIBUTE_ADVANTAGE_SCALING;
    const defenderDamageTakenMultiplier = this._getPerkMultiplier(defender, 'damageTakenMultiplier');

    const rawDamage = Math.max(
      0,
      output *
        BALANCE.COMBAT.GAMEPLAN.ROUND_DAMAGE_SCALING *
        targetEffects.damageMultiplier *
        advantageMultiplier *
        tempoMods.damageTakenMultiplier *
        defenderDamageTakenMultiplier
    );

    const staminaCostKey = BALANCE.COMBAT.GAMEPLAN.DISTANCE_STAMINA_COST_KEY[plan.distance];
    const staminaCostBase = BALANCE.COMBAT.STAMINA[staminaCostKey];
    const perkStaminaMultiplier = this._getPerkMultiplier(attacker, 'staminaCostMultiplier');
    const staminaCost = staminaCostBase * tempoMods.staminaCostMultiplier * perkStaminaMultiplier;

    let submissionAttempted = false;
    let submissionSuccess = false;
    if (plan.distance === 'GROUND') {
      submissionAttempted = true;
      const sub = BALANCE.COMBAT.SUBMISSIONS;
      const attackerGrappling = (attacker.attributes.skills.sol + attacker.attributes.skills.soumission) / 2;
      const defenderGrappling = (defender.attributes.skills.sol + defender.attributes.skills.soumission) / 2;
      const styleSubMultiplier = styleBonus.submissionChanceMultiplier ?? 1;
      const perkSubMultiplier = this._getPerkMultiplier(attacker, 'submissionChanceMultiplier');
      const chance = clamp(
        (sub.BASE_SUCCESS_CHANCE + sub.SKILL_DELTA_CHANCE_SCALING * (attackerGrappling - defenderGrappling)) *
          styleSubMultiplier *
          perkSubMultiplier,
        sub.MIN_CHANCE,
        sub.MAX_CHANCE
      );
      submissionSuccess = this.rng() < chance;
    }

    const perkKoMultiplier = this._getPerkMultiplier(attacker, 'koChanceMultiplier');

    return {
      target: plan.target,
      distance: plan.distance,
      rawDamage,
      staminaCost,
      koChanceMultiplier: targetEffects.koChanceMultiplier * perkKoMultiplier,
      submissionAttempted,
      submissionSuccess,
    };
  }

  /**
   * Applies one fighter's offense output to their opponent: reduces health
   * and distributes the damage across the face/body/legs tally.
   * @param {('A'|'B')} targetKey
   * @param {Object} offense
   */
  _applyDamage(targetKey, offense) {
    const c = this.context;
    const split = BALANCE.COMBAT.GAMEPLAN.TARGET_DAMAGE_SPLIT;
    const tally = c.damageTally[targetKey];

    for (const target of VALID_TARGETS) {
      const share = target === offense.target ? split.PRIMARY : split.SECONDARY_EACH;
      tally[TARGET_TO_TALLY_KEY[target]] += offense.rawDamage * share;
    }

    c.live[targetKey].health = clamp(c.live[targetKey].health - offense.rawDamage, 0, BALANCE.COMBAT.HEALTH.MAX);
  }

  /**
   * Checks every finish condition in priority order (KO > SUBMISSION > TKO
   * > DOCTOR_STOPPAGE), for both fighters, and returns the first one found.
   * @returns {Object|null}
   */
  _checkFinishConditions(round, offenseA, offenseB) {
    const c = this.context;
    const pairs = [
      ['A', 'B', offenseA, offenseB],
      ['B', 'A', offenseB, offenseA],
    ];

    for (const [attackerKey, defenderKey] of pairs) {
      if (c.live[defenderKey].health <= BALANCE.COMBAT.HEALTH.KO_THRESHOLD) {
        return this._buildFinish(FINISH_METHODS.KO, round, attackerKey, defenderKey);
      }
    }

    for (const [attackerKey, defenderKey, offenseAttacker] of pairs) {
      if (offenseAttacker.submissionAttempted && offenseAttacker.submissionSuccess) {
        return this._buildFinish(FINISH_METHODS.SUBMISSION, round, attackerKey, defenderKey);
      }
    }

    let tkoFinish = null;
    for (const [attackerKey, defenderKey, offenseAttacker, offenseDefender] of pairs) {
      const dominant =
        offenseAttacker.rawDamage >= offenseDefender.rawDamage * BALANCE.COMBAT.HEALTH.TKO_DAMAGE_STREAK_THRESHOLD;
      c.live[defenderKey].tkoStreak = dominant ? c.live[defenderKey].tkoStreak + 1 : 0;

      if (!tkoFinish && c.live[defenderKey].tkoStreak >= BALANCE.COMBAT.HEALTH.TKO_CHECK_STREAK_LENGTH) {
        const chance = BALANCE.COMBAT.HEALTH.TKO_CHANCE_PER_CHECK * offenseAttacker.koChanceMultiplier;
        if (this.rng() < chance) {
          tkoFinish = this._buildFinish(FINISH_METHODS.TKO, round, attackerKey, defenderKey);
        }
      }
    }
    if (tkoFinish) return tkoFinish;

    for (const [attackerKey, defenderKey] of pairs) {
      if (c.damageTally[defenderKey].face >= BALANCE.COMBAT.HEALTH.DOCTOR_STOPPAGE_FACE_DAMAGE_THRESHOLD) {
        return this._buildFinish(FINISH_METHODS.DOCTOR_STOPPAGE, round, attackerKey, defenderKey);
      }
    }

    return null;
  }

  _buildFinish(method, round, winnerKey, loserKey) {
    const timeSeconds = Math.floor(this.rng() * BALANCE.COMBAT.ROUND_DURATION_SECONDS);
    return {
      method,
      round,
      timeSeconds,
      timeLabel: this._formatTime(timeSeconds),
      winnerKey,
      loserKey,
    };
  }

  _formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  /**
   * Converts one fighter's round offense into a composite score usable by
   * judges, blending damage (effective strikes proxy), takedowns/control
   * time (derived from the chosen distance) and submission attempts.
   * @param {Object} offenseSelf
   * @returns {number}
   */
  _computeCompositeRoundScore(offenseSelf) {
    const scoring = BALANCE.COMBAT.SCORING;
    const scale = scoring.NON_STRIKE_METRIC_SCALE;
    const takedowns = offenseSelf.distance === 'GROUND' ? 1 : 0;
    const controlTime = offenseSelf.distance !== 'STRIKING' ? 1 : 0;
    const submissionAttempts = offenseSelf.submissionAttempted ? 1 : 0;

    return (
      offenseSelf.rawDamage * scoring.WEIGHT_EFFECTIVE_STRIKES +
      takedowns * scoring.WEIGHT_TAKEDOWNS * scale +
      controlTime * scoring.WEIGHT_CONTROL_TIME * scale +
      submissionAttempts * scoring.WEIGHT_SUBMISSION_ATTEMPTS * scale
    );
  }

  /**
   * Scores one round across all judges, adding independent per-judge
   * perception noise so scorecards can legitimately disagree.
   * @returns {Object}
   */
  _scoreRound(round, offenseA, offenseB) {
    const scoring = BALANCE.COMBAT.SCORING;
    const compositeA = this._computeCompositeRoundScore(offenseA);
    const compositeB = this._computeCompositeRoundScore(offenseB);
    const total = compositeA + compositeB;
    const shareA = total > 0 ? compositeA / total : 0.5;

    const judgeCards = [];
    for (let judgeIndex = 0; judgeIndex < scoring.NUM_JUDGES; judgeIndex += 1) {
      const noise = (this.rng() - 0.5) * 2 * scoring.JUDGE_VARIANCE;
      const perceivedShareA = clamp(shareA + noise, 0, 1);
      const diff = perceivedShareA - 0.5;

      let aPoints = scoring.EVEN_ROUND_POINTS;
      let bPoints = scoring.EVEN_ROUND_POINTS;
      if (Math.abs(diff) > scoring.EVEN_ROUND_MARGIN / 2) {
        if (diff > 0) {
          aPoints = scoring.ROUND_WIN_POINTS;
          bPoints = scoring.ROUND_LOSE_POINTS;
        } else {
          aPoints = scoring.ROUND_LOSE_POINTS;
          bPoints = scoring.ROUND_WIN_POINTS;
        }
      }
      judgeCards.push({ judgeIndex, aPoints, bPoints });
    }

    return { round, compositeA, compositeB, judgeCards };
  }

  /**
   * Aggregates every judge's per-round cards into a final decision once
   * the match has gone the full scheduled distance without a stoppage.
   * @returns {Object}
   */
  _computeJudgesDecision() {
    const c = this.context;
    const scoring = BALANCE.COMBAT.SCORING;

    const judgeTotals = [];
    for (let judgeIndex = 0; judgeIndex < scoring.NUM_JUDGES; judgeIndex += 1) {
      let totalA = 0;
      let totalB = 0;
      for (const roundScore of c.scorecards) {
        const card = roundScore.judgeCards[judgeIndex];
        totalA += card.aPoints;
        totalB += card.bPoints;
      }
      const winner = totalA > totalB ? 'A' : totalB > totalA ? 'B' : null;
      judgeTotals.push({ judgeIndex, totalA, totalB, winner });
    }

    const winsA = judgeTotals.filter((j) => j.winner === 'A').length;
    const winsB = judgeTotals.filter((j) => j.winner === 'B').length;
    const draws = judgeTotals.filter((j) => j.winner === null).length;

    let method = FINISH_METHODS.DRAW;
    let winnerKey = null;
    let loserKey = null;

    if (winsA === scoring.NUM_JUDGES) {
      method = FINISH_METHODS.UNANIMOUS_DECISION;
      winnerKey = 'A';
      loserKey = 'B';
    } else if (winsB === scoring.NUM_JUDGES) {
      method = FINISH_METHODS.UNANIMOUS_DECISION;
      winnerKey = 'B';
      loserKey = 'A';
    } else if (winsA >= 2 && winsB >= 1) {
      method = FINISH_METHODS.SPLIT_DECISION;
      winnerKey = 'A';
      loserKey = 'B';
    } else if (winsB >= 2 && winsA >= 1) {
      method = FINISH_METHODS.SPLIT_DECISION;
      winnerKey = 'B';
      loserKey = 'A';
    } else if (winsA === 2 && draws === 1) {
      method = FINISH_METHODS.MAJORITY_DECISION;
      winnerKey = 'A';
      loserKey = 'B';
    } else if (winsB === 2 && draws === 1) {
      method = FINISH_METHODS.MAJORITY_DECISION;
      winnerKey = 'B';
      loserKey = 'A';
    }

    return {
      method,
      round: c.maxRounds,
      timeSeconds: BALANCE.COMBAT.ROUND_DURATION_SECONDS,
      timeLabel: this._formatTime(BALANCE.COMBAT.ROUND_DURATION_SECONDS),
      winnerKey,
      loserKey,
      judgeTotals,
    };
  }

  // ==========================================================================
  // Post-match resolution (private)
  // ==========================================================================

  _computePurses(finish, isDraw, byFinish) {
    const c = this.context;
    const econ = BALANCE.ECONOMY;
    const tierKey = c.originalIsTitle ? 'TITLE_FIGHT' : 'REGIONAL';
    const basePurse = econ.BASE_FIGHT_PURSE[tierKey];

    const gross = { A: basePurse, B: basePurse };

    if (!isDraw) {
      gross[finish.winnerKey] *= econ.WIN_BONUS_MULTIPLIER;
      if (byFinish && this.rng() < econ.PERFORMANCE_BONUS_CHANCE) {
        gross[finish.winnerKey] *= econ.PERFORMANCE_BONUS_MULTIPLIER;
      }
    }

    for (const key of ['A', 'B']) {
      const cut = c.weightCut[key];
      if (cut?.missedWeight) {
        const otherKey = OTHER_FIGHTER_KEY[key];
        const forfeited = gross[key] * cut.purseForfeitPercent;
        gross[key] -= forfeited;
        gross[otherKey] += forfeited;
      }
    }

    const purses = {};
    for (const key of ['A', 'B']) {
      const net = gross[key] * (1 - econ.TAXES.INCOME_TAX_RATE);
      purses[key] = {
        gross: Math.round(gross[key]),
        net: Math.round(net),
        fighterShare: Math.round(net * econ.PURSE_SPLIT.FIGHTER_SHARE),
        gymShare: Math.round(net * econ.PURSE_SPLIT.GYM_SHARE),
        managerShare: Math.round(net * econ.PURSE_SPLIT.MANAGER_SHARE),
      };
    }
    return purses;
  }

  _rollPostFightInjury(key) {
    const c = this.context;
    const inj = BALANCE.INJURIES;
    const live = c.live[key];

    const staminaFraction = live.stamina / BALANCE.COMBAT.STAMINA.MAX;
    const fatigueMultiplier = 1 + (1 - staminaFraction) * (inj.FATIGUE_RISK_MULTIPLIER_MAX - 1);
    const chance = inj.BASE_CHANCE_PER_FIGHT * fatigueMultiplier;

    if (this.rng() >= chance) return null;

    const severity = this._rollWeightedSeverity(inj.SEVERITY_WEIGHTS);
    const bodyPart = INJURY_BODY_PARTS[Math.floor(this.rng() * INJURY_BODY_PARTS.length)];
    const dayAnchor = this.worldState ? this.worldState.currentDay : 0;

    return {
      severity,
      bodyPart,
      occurredOnDay: dayAnchor,
      injuredUntilDay: dayAnchor + inj.RECOVERY_DAYS[severity],
    };
  }

  _rollWeightedSeverity(weights) {
    const entries = Object.entries(weights);
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.rng() * total;
    for (const [severity, weight] of entries) {
      if (roll < weight) return severity;
      roll -= weight;
    }
    return entries[entries.length - 1][0];
  }

  _isPlayerFighter(fighter) {
    if (!this.playerState) return false;
    return this.playerState.roster.some((rostered) => rostered.identity.id === fighter.identity.id);
  }

  // ==========================================================================
  // Guards & transition plumbing (private)
  // ==========================================================================

  _assertActiveMatch() {
    if (!this.context) {
      throw new Error('CombatEngine: no active match. Call setupMatch() first.');
    }
  }

  _assertFighterKey(key) {
    if (key !== 'A' && key !== 'B') {
      throw new TypeError(`CombatEngine: fighterKey must be "A" or "B", got "${key}".`);
    }
  }

  _assertMatchNotResolved(methodName) {
    const resolvedStates = [COMBAT_STATES.DECISION_STOPPAGE, COMBAT_STATES.POST_MATCH_REWARDS, COMBAT_STATES.FINISHED];
    if (resolvedStates.includes(this.state)) {
      throw new Error(`CombatEngine.${methodName}: match is already resolved (state "${this.state}").`);
    }
  }

  _transition(nextState) {
    const previous = this.state;
    this.state = nextState;
    EventBus.publish(COMBAT_EVENTS.STATE_CHANGED, {
      from: previous,
      to: nextState,
      round: this.context ? this.context.currentRound : 0,
    });
  }
}

// Default singleton for the player's "live" fight. Instantiate the class
// directly (new CombatEngine(...)) for parallel/headless simulations that
// must not disturb this shared instance.
const instance = new CombatEngine();
export default instance;
