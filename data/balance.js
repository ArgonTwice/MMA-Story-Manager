/**
 * data/balance.js
 * ---------------------------------------------------------------------------
 * Single source of truth for every tunable number in the game.
 *
 * RULE: no gameplay module (Engine, Models, State) may hardcode a ratio,
 * cost, damage value, cooldown, probability or threshold. If a number
 * affects balance, it lives here — and only here. This lets design
 * iteration happen by editing this file, without touching engine logic,
 * and lets save-game migrations diff behavior across BALANCE.VERSION.
 *
 * Structure:
 *   BALANCE.VERSION      - semantic version of this balance dataset itself
 *                           (bump when values change enough to affect
 *                           existing saves / stats comparisons).
 *   BALANCE.PROGRESSION  - fighter leveling, XP, attribute growth
 *   BALANCE.COMBAT       - fight simulation math (damage, stamina, odds)
 *     BALANCE.COMBAT.CLINCH - Phase 4.1 Clinch position mechanics (Clinch->Sol transition rate, damage weight, fatigue cost, per-style bonuses)
 *   BALANCE.ECONOMY      - money, prices, salaries, gym running costs
 *   BALANCE.INJURIES     - injury chance, severity, recovery time
 *   BALANCE.MORALE       - morale gain/loss events and thresholds
 *   BALANCE.TRAINING     - training camps, drills, gains per session
 *   BALANCE.CONTRACTS    - fighter/staff contract rules
 *   BALANCE.SOCIAL_MEDIA - follower growth, engagement, virality
 *   BALANCE.SPONSORS     - sponsorship offers, payouts, requirements
 *   BALANCE.AGE          - aging curve, peak years, decline
 *   BALANCE.GYM          - facilities, capacity, upgrades
 *   BALANCE.FORM         - fighter physical condition ("forme") bounds/decay
 *   BALANCE.MOMENTUM     - fight-local rhythm/confidence meter (reset every match)
 *   BALANCE.PHYSICAL_FATIGUE - weekly-persisted physical load (Phase 3.1 v1/v2)
 *   BALANCE.MENTAL_FATIGUE  - weekly-persisted cognitive/promotional load (Phase 3.1 v2)
 *   BALANCE.READINESS    - the CombatEngine-facing gauge derived from both Fatigue gauges/Moral/prep/injury-risk
 *   BALANCE.WEEKLY_PLANNING - the 3-slot weekly activity picker feeding both Fatigue gauges/skills/prep
 *   BALANCE.PSYCHOLOGY   - personality-driven stat bounds/starting values
 *   BALANCE.CALENDAR     - day/week/season/year length definitions
 *   BALANCE.WORLD        - world-state bookkeeping limits (history caps...)
 *   BALANCE.WEIGH_IN     - weight-cut profiles, miss chance, form impact
 *   BALANCE.PERKS        - unlockable trait definitions and unlock thresholds
 *   BALANCE.EQUIPMENT    - gym equipment catalog (training/form/upkeep/purchase)
 *   BALANCE.DRAMA          - Phase 3.2 Simulation Drama Engine weekly-resolution rates (see data/events.js)
 *   BALANCE.NARRATIVE_EVENTS - weekly random story events (sponsors, media, morale...)
 *   BALANCE.PERSONALITY  - archetype/trait definitions and their silent modifiers
 *   BALANCE.LEGACY        - Fighter#getLegacyStage() classification thresholds
 *   BALANCE.RELATIONSHIP  - relationship-graph gauge bounds and event deltas
 *   BALANCE.STORY         - narrative-opportunity detection thresholds
 *   BALANCE.NARRATIVE      - narrative-form selection weights per opportunity
 *
 *   (COMBAT additionally carries GAMEPLAN, STYLE_BONUSES and TAKEDOWN_RISK
 *   sub-sections consumed by engine/CombatEngine.js: per-target/distance/
 *   tempo coefficients, per-fighting-style bonuses, and the Test A3
 *   takedown-contest risk/reward coefficients. TRAINING additionally
 *   carries INTENSITY_MODIFIERS, OVERTRAINING and COUNTRY_BONUSES consumed
 *   by engine/TrainingEngine.js. ECONOMY additionally carries PASSIVE_INCOME
 *   and INSOLVENCY consumed by engine/EconomyEngine.js. WORLD additionally
 *   carries the RIVAL_GYM_* coefficients consumed by engine/ProgressionEngine.js.)
 *
 * The object is deep-frozen before export: nothing downstream may mutate
 * balance data at runtime, which keeps it safe to treat as static config
 * and share by reference across State/Engine/Render without defensive
 * copies.
 * ---------------------------------------------------------------------------
 */

/**
 * Recursively freezes an object graph so BALANCE (and every nested section)
 * is immutable at runtime, in dev and prod alike.
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.getOwnPropertyNames(obj).forEach((key) => deepFreeze(obj[key]));
  return Object.freeze(obj);
}

const BALANCE = {
  /** Bump on any numeric change that could invalidate stat comparisons. */
  VERSION: '1.10.0',

  // ---------------------------------------------------------------------
  // PROGRESSION — fighter XP, levels, attribute growth
  // ---------------------------------------------------------------------
  PROGRESSION: {
    /** XP required for level N = BASE_XP * (N ^ XP_CURVE_EXPONENT). */
    BASE_XP: 100,
    XP_CURVE_EXPONENT: 1.55,

    MAX_LEVEL: 50,

    /** Attribute points granted per level-up, before allocation modifiers. */
    ATTRIBUTE_POINTS_PER_LEVEL: 3,

    /** XP awarded per source event. */
    XP_REWARDS: {
      WIN_FIGHT: 250,
      LOSE_FIGHT: 60,
      DRAW_FIGHT: 120,
      TRAINING_SESSION: 40,
      SPARRING_SESSION: 55,
      TITLE_WIN_BONUS: 500,
    },

    /** Multiplier applied to XP gain based on the opponent's tier relative to the fighter. */
    XP_OPPONENT_TIER_MULTIPLIER: {
      MUCH_WEAKER: 0.5,
      WEAKER: 0.8,
      EVEN: 1.0,
      STRONGER: 1.3,
      MUCH_STRONGER: 1.6,
    },

    /** Attribute soft cap: points beyond this value cost double to allocate. */
    ATTRIBUTE_SOFT_CAP: 85,
    ATTRIBUTE_HARD_CAP: 99,
    SOFT_CAP_COST_MULTIPLIER: 2,

    /** Bounds for Fighter.attributes.skills.* (boxe, jambes, sol, soumission, cardio, intelligence). */
    SKILL_MIN: 0,
    SKILL_MAX: 100,
    /** Value newly created fighters start with for any skill not explicitly provided. */
    DEFAULT_STARTING_SKILL_VALUE: 30,

    /**
     * Weights used by Fighter#getOverallRating() to combine the six skills
     * into a single 0-100 rating. Must sum to 1.
     */
    OVERALL_RATING_WEIGHTS: {
      boxe: 0.22,
      jambes: 0.18,
      sol: 0.2,
      soumission: 0.15,
      cardio: 0.15,
      intelligence: 0.1,
    },
  },

  // ---------------------------------------------------------------------
  // COMBAT — fight simulation formulas
  // ---------------------------------------------------------------------
  COMBAT: {
    /** Fight length in simulated rounds/turns. */
    ROUNDS_PER_FIGHT: {
      MAIN_EVENT: 5,
      CO_MAIN: 3,
      UNDERCARD: 3,
    },
    ROUND_DURATION_SECONDS: 300,

    /** Base stamina pool consumed by an average exchange. */
    STAMINA: {
      MAX: 100,
      COST_PER_STRIKE_EXCHANGE: 4,
      COST_PER_TAKEDOWN_ATTEMPT: 9,
      COST_PER_GRAPPLE_EXCHANGE: 6,
      REGEN_PER_ROUND_REST: 15,
      LOW_STAMINA_THRESHOLD: 25,
      /** Below LOW_STAMINA_THRESHOLD, all offensive stats are multiplied by this. */
      LOW_STAMINA_PENALTY_MULTIPLIER: 0.6,
    },

    /** Base damage-per-successful-action, scaled by attribute deltas. */
    DAMAGE: {
      STRIKE_BASE: 6,
      POWER_STRIKE_BASE: 14,
      TAKEDOWN_LANDED_BASE: 5,
      GROUND_AND_POUND_BASE: 8,
      SUBMISSION_PROGRESS_BASE: 10,
      /** Damage multiplier per point of attribute advantage over the opponent. */
      ATTRIBUTE_ADVANTAGE_SCALING: 0.015,
    },

    /** Health pool and finish thresholds. */
    HEALTH: {
      MAX: 100,
      KO_THRESHOLD: 0,
      /**
       * A round counts as "dominant" for TKO-streak purposes when the
       * attacker's damage that round is at least this many times the
       * defender's damage that round (e.g. 3 = attacker did 3x the damage).
       */
      TKO_DAMAGE_STREAK_THRESHOLD: 3,
      /** Consecutive dominant rounds needed before a TKO stoppage is even checked for. */
      TKO_CHECK_STREAK_LENGTH: 3,
      TKO_CHANCE_PER_CHECK: 0.35,
      /** Cumulative face damage (see CombatEngine damageTally.face) that triggers a cut/doctor stoppage. */
      DOCTOR_STOPPAGE_FACE_DAMAGE_THRESHOLD: 55,
    },

    /** Submission attempt resolution. */
    SUBMISSIONS: {
      BASE_SUCCESS_CHANCE: 0.12,
      /** Added per point of (attacker.grappling - defender.grappling defense). */
      SKILL_DELTA_CHANCE_SCALING: 0.01,
      MIN_CHANCE: 0.02,
      MAX_CHANCE: 0.75,
    },

    /** Base probability an action attempt lands, before attribute deltas. */
    ACCURACY: {
      STRIKE_BASE_HIT_CHANCE: 0.55,
      /**
       * Test A3.4c (v0.34c): 0.55 -> 0.59, seule variable modifiee vs Test
       * A3.4b (methodologie A/B atomique) — A3.1/A3.2/A3.3
       * (COMBAT.TAKEDOWN_RISK ci-dessous) restent intacts. Historique :
       * Test A3 avait branche ce taux reserve a 0.4 (Grappling 41.6%) ;
       * A3.4a l'a remonte a 0.5 (Grappling 45.5%) ; A3.4b a 0.55 (Grappling
       * 47.9%, juste sous la fourchette Mistral) ; ce reglage final vise
       * 50-52% de Winrate Grappling.
       */
      TAKEDOWN_BASE_SUCCESS_CHANCE: 0.59,
      SKILL_DELTA_CHANCE_SCALING: 0.012,
      MIN_HIT_CHANCE: 0.1,
      MAX_HIT_CHANCE: 0.92,
    },

    /** Judge scoring weights when a fight goes to decision. */
    SCORING: {
      WEIGHT_EFFECTIVE_STRIKES: 0.45,
      WEIGHT_TAKEDOWNS: 0.25,
      /**
       * Test A2 (v0.32, see tools/BalanceReporter.js's Version History
       * Tracker): 0.2 -> 0.14, the single new variable for this test — the
       * literal "valeur des gains de position/controle au sol" from the
       * test brief (WEIGHT_TAKEDOWNS and WEIGHT_SUBMISSION_ATTEMPTS are
       * untouched, and so is A1's NON_STRIKE_METRIC_SCALE). Two effects
       * from this one change: it pulls Grappling's overall round EV back
       * toward the ~8.8 target (passive control was over-rewarded relative
       * to actually landing a finish attempt), and — since
       * WEIGHT_SUBMISSION_ATTEMPTS stays fixed while this shrinks — it
       * raises submission attempts' *relative* share of ground/control
       * scoring versus passive position-holding, without separately
       * touching WEIGHT_SUBMISSION_ATTEMPTS itself. Value chosen
       * empirically (multi-seed simulation, not hand-derived from the
       * formula alone — see the Version History Tracker's own notes: this
       * single lever lands the EV target but does not, by itself, bring
       * Grappling Winrate or the weakest style's winrate into their target
       * windows). Previous value: 0.2.
       */
      WEIGHT_CONTROL_TIME: 0.14,
      WEIGHT_SUBMISSION_ATTEMPTS: 0.1,
      ROUND_WIN_POINTS: 10,
      ROUND_LOSE_POINTS: 9,
      EVEN_ROUND_POINTS: 10,

      /** Number of judges scoring the fight (also the size of the scorecards array). */
      NUM_JUDGES: 3,
      /** Composite score gap (fraction) below which a judge scores the round even (10-10). */
      EVEN_ROUND_MARGIN: 0.05,
      /** Per-judge perception noise applied to each judge's read of a round, enabling split/majority cards. */
      JUDGE_VARIANCE: 0.08,
      /**
       * Damage-equivalent points a binary metric (takedown/control/submission
       * attempt) is worth in the composite round score. This is the single
       * lever that scales every non-strike (ground/control) contribution to
       * judges' scoring at once — WEIGHT_EFFECTIVE_STRIKES is untouched.
       *
       * Test A1 (v0.31, see tools/BalanceReporter.js's Version History
       * Tracker): 10 -> 7.5 (x0.75), matching the Phase 3.0.3 telemetry
       * finding that judges' scoring leaned ~76% Degats / ~24% Controle Sol
       * — intent is to rebalance toward ~82% / ~18%. Previous value: 10.
       */
      NON_STRIKE_METRIC_SCALE: 7.5,
    },

    /** Randomness envelope applied to every roll to avoid deterministic outcomes. */
    VARIANCE: {
      MIN_ROLL_MULTIPLIER: 0.85,
      MAX_ROLL_MULTIPLIER: 1.15,
      /** Chance of a rare "upset" swing event per round. */
      UPSET_EVENT_CHANCE: 0.05,
      UPSET_EVENT_MULTIPLIER: 1.8,
    },

    /**
     * GAMEPLAN — coefficients for the player-chosen target/distance/tempo
     * combination resolved each round by CombatEngine. Object keys here
     * (HEAD/BODY/LEGS, STRIKING/CLINCH/GROUND, CONSERVATIVE/BALANCED/
     * AGGRESSIVE) are the canonical, only valid gameplan values — engine
     * code derives its validation lists from these keys rather than
     * duplicating them.
     */
    GAMEPLAN: {
      /** Per-target damage multiplier, KO-chance influence, and where damage lands. */
      TARGET_EFFECTS: {
        HEAD: { damageMultiplier: 1.1, koChanceMultiplier: 1.3 },
        BODY: { damageMultiplier: 1.0, koChanceMultiplier: 0.9 },
        LEGS: { damageMultiplier: 0.85, koChanceMultiplier: 0.7 },
      },

      /** Share of a round's total damage that lands on the chosen target vs the other two body parts. */
      TARGET_DAMAGE_SPLIT: {
        PRIMARY: 0.7,
        SECONDARY_EACH: 0.15,
      },

      /**
       * Weight of each of the six Fighter skills toward this round's offense
       * rating, per chosen distance. Each row must sum to 1.
       */
      DISTANCE_SKILL_WEIGHTS: {
        STRIKING: { boxe: 0.5, jambes: 0.3, sol: 0, soumission: 0, cardio: 0.1, intelligence: 0.1 },
        CLINCH: { boxe: 0.2, jambes: 0.1, sol: 0.35, soumission: 0.15, cardio: 0.1, intelligence: 0.1 },
        GROUND: { boxe: 0.05, jambes: 0, sol: 0.45, soumission: 0.35, cardio: 0.05, intelligence: 0.1 },
      },

      /** Stamina cost per round for the chosen distance, before tempo/perk modifiers (see COMBAT.STAMINA). */
      DISTANCE_STAMINA_COST_KEY: {
        STRIKING: 'COST_PER_STRIKE_EXCHANGE',
        CLINCH: 'COST_PER_GRAPPLE_EXCHANGE',
        GROUND: 'COST_PER_TAKEDOWN_ATTEMPT',
      },

      /** How aggressively a fighter presses the action, trading output for stamina and durability. */
      TEMPO_MODIFIERS: {
        CONSERVATIVE: {
          outputMultiplier: 0.75,
          staminaCostMultiplier: 0.7,
          damageTakenMultiplier: 0.85,
        },
        BALANCED: {
          outputMultiplier: 1.0,
          staminaCostMultiplier: 1.0,
          damageTakenMultiplier: 1.0,
        },
        AGGRESSIVE: {
          outputMultiplier: 1.3,
          staminaCostMultiplier: 1.35,
          damageTakenMultiplier: 1.15,
        },
      },

      /** Converts a fighter's composite round-offense rating into raw round damage. */
      ROUND_DAMAGE_SCALING: 0.35,
    },

    /**
     * STYLE_BONUSES — bonus applied to a fighter's round output based on
     * Fighter.identity.style. Unrecognized/custom style strings fall back
     * to DEFAULT (no bonus, no penalty).
     */
    STYLE_BONUSES: {
      Boxe: { distance: 'STRIKING', outputMultiplier: 1.15 },
      Kickboxing: { distance: 'STRIKING', outputMultiplier: 1.1, targetMultipliers: { LEGS: 1.15 } },
      'Muay Thai': { distance: 'STRIKING', outputMultiplier: 1.05, targetMultipliers: { LEGS: 1.25, BODY: 1.1 } },
      Lutte: { distance: 'GROUND', outputMultiplier: 1.15 },
      'Jiu-Jitsu Bresilien': { distance: 'GROUND', outputMultiplier: 1.05, submissionChanceMultiplier: 1.3 },
      Freestyle: { outputMultiplier: 1.0 },
      DEFAULT: { outputMultiplier: 1.0 },
    },

    /**
     * CLINCH — Phase 4.1 ("Integration du Moteur de Clinch & Trinite des
     * Styles"): the intermediate position between STRIKING and GROUND.
     * CLINCH already existed as a third GAMEPLAN.distance choice (its own
     * skill weights/stamina-cost key/unconditional judge control-time
     * credit) since Phase 3.0 — this section adds the position's own
     * mechanics on top: a real Clinch->Sol transition contest
     * (CombatEngine#_computeClinchTakedownChance, same shape as the
     * existing GROUND takedown contest but its own base rate), a damage
     * weight (knees/elbows read as denser than a stalled hold but less
     * clean than open striking), an extra per-round fatigue cost, and
     * style-specific output bonuses layered on top of STYLE_BONUSES above
     * (Muay Thai/Lutte's own *primary* distance affinity stays
     * STRIKING/GROUND respectively — these are a supplementary clinch-only
     * multiplier, not a redefinition of their primary style).
     */
    CLINCH: {
      /** Base chance a CLINCH round's grappling exchange transitions into a landed takedown/trip (Clinch -> Sol), before the same sol skill-delta scaling and cumulative sprawl defenseBonus the GROUND contest already uses. */
      TAKEDOWN_CLINCH_SUCCESS_CHANCE: 0.6,
      /** Multiplier on a CLINCH round's raw damage output (applied at the same point styleDistanceMultiplier is, in CombatEngine#_computeRoundOffense). */
      CLINCH_DAMAGE_WEIGHT: 0.75,
      /** Extra stamina cost per CLINCH round, on top of the existing STAMINA.COST_PER_GRAPPLE_EXCHANGE base — fight-local Stamina, distinct from Phase 3.1's weekly-persisted PHYSICAL_FATIGUE gauge (never touched mid-fight). */
      CLINCH_FATIGUE_PER_ROUND: 15,
      /** Supplementary output multiplier for a CLINCH round specifically, keyed by Fighter.identity.style — styles without an entry here get no bonus (multiplier 1). */
      STYLE_CLINCH_MULTIPLIERS: {
        'Muay Thai': 1.2,
        Lutte: 1.15,
      },
    },

    /**
     * Test A3 (v0.33, see tools/BalanceReporter.js's Version History
     * Tracker): "Risque Decisionnel & Sprawl" — introduces a real takedown
     * *contest* (see CombatEngine#_computeTakedownChance, which finally
     * wires up ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE — reserved since an
     * earlier phase but never read until now) instead of a GROUND gameplan
     * choice always landing unopposed. These are the punishment/reward
     * coefficients for a *failed* (defended) takedown attempt specifically;
     * A1/A2's judge-scoring weights (SCORING section above) are untouched.
     */
    TAKEDOWN_RISK: {
      /** A3.1: extra stamina burned by the wrestler on a failed/defended takedown, on top of the normal COST_PER_TAKEDOWN_ATTEMPT. */
      FAILURE_STAMINA_PENALTY: 3,
      /** A3.1: MOMENTUM points lost by the wrestler on a failed/defended takedown (see the new top-level MOMENTUM section). */
      FAILURE_MOMENTUM_PENALTY: 5,
      /** A3.2: precision/damage bonus granted to the defender for their next round's offense only, then consumed. */
      COUNTER_WINDOW_ACCURACY_BONUS: 0.2,
      COUNTER_WINDOW_DAMAGE_BONUS: 0.15,
      /** A3.3: additional takedown-defense chance the defender gains per successfully stuffed attempt, cumulative for the rest of the match (anti-spam). */
      SPRAWL_DEFENSE_BONUS_PER_STUFF: 0.05,
      /** Safety ceiling on A3.3's stacking bonus, so a defense chance can never be driven to a near-certainty by spam alone. */
      SPRAWL_DEFENSE_BONUS_MAX: 0.3,
    },
  },

  // ---------------------------------------------------------------------
  // MOMENTUM — fight-local "rhythm/confidence" meter (Test A3), reset every match
  // ---------------------------------------------------------------------
  MOMENTUM: {
    MIN: 0,
    MAX: 100,
    /** Every fighter starts a match at full momentum; it only ever drops in the current model (see COMBAT.TAKEDOWN_RISK.FAILURE_MOMENTUM_PENALTY). */
    STARTING_VALUE: 100,
  },

  // ---------------------------------------------------------------------
  // PHYSICAL_FATIGUE — Phase 3.1 v1/v2, weekly-persisted physical load
  // (0-100%), reset only by rest. Distinct from COMBAT.STAMINA (a
  // fight-local pool that resets every match) and FORM (long-run condition
  // drifting from other events). Phase 3.1 v2 split the single v1 "Fatigue"
  // gauge into this (physical wear — Technique/Sparring drilling) and
  // MENTAL_FATIGUE below (cognitive/promotional load — Video prep, Media &
  // Sponsors) so getReadiness() can weigh them differently. CombatEngine
  // never reads either directly; it only reads the derived READINESS gauge
  // (see Fighter#getReadiness).
  // ---------------------------------------------------------------------
  PHYSICAL_FATIGUE: {
    MIN: 0,
    MAX: 100,
    STARTING_VALUE: 0,
  },

  // ---------------------------------------------------------------------
  // MENTAL_FATIGUE — Phase 3.1 v2's "Charge Mentale" companion gauge to
  // PHYSICAL_FATIGUE above — same bounds/shape, fed by cognitively/
  // promotionally taxing activities (VIDEO_PREP, MEDIA_SPONSORS) rather
  // than physically taxing ones.
  // ---------------------------------------------------------------------
  MENTAL_FATIGUE: {
    MIN: 0,
    MAX: 100,
    STARTING_VALUE: 0,
  },

  // ---------------------------------------------------------------------
  // READINESS — Phase 3.1 v1/v2, the single gauge CombatEngine reads
  // instead of either Fatigue gauge directly. Phase 3.1 v2's formula:
  //   Readiness = 100 - (PHYSICAL_FATIGUE_WEIGHT * PhysicalFatigue +
  //                       MENTAL_FATIGUE_WEIGHT * MentalFatigue)
  //               + MoralModifier + TacticalBonus - RisqueBlessure
  // clamped to [MIN, MAX] (see Fighter#getReadiness). The two Fatigue
  // weights are spec-given (60%/40%); MORAL_MODIFIER_SCALE/
  // TACTICAL_BONUS_POINTS/INJURY_RISK_PER_CHARGE_POINT remain this
  // implementation's own chosen coefficients, carried over unchanged from
  // v1 (the spec described the formula's *shape*, not these three
  // sub-terms' exact numbers).
  // ---------------------------------------------------------------------
  READINESS: {
    MIN: 0,
    MAX: 100,
    /** Phase 3.1 v2: relative weight of Physical vs Mental Fatigue in the blended Fatigue term below. Spec-given (60%/40%). */
    PHYSICAL_FATIGUE_WEIGHT: 0.6,
    MENTAL_FATIGUE_WEIGHT: 0.4,
    /** Readiness points gained/lost per point of Moral above/below MORALE.NEUTRAL_VALUE (50). At Moral=100 -> +10, at Moral=0 -> -10. */
    MORAL_MODIFIER_SCALE: 0.2,
    /** Flat Readiness bonus while a VIDEO_PREP tactical bonus is pending (consumed at the fighter's next weigh-in — see Fighter#clearTacticalPrep). Matches VIDEO_PREP's own "+5%" framing below. */
    TACTICAL_BONUS_POINTS: 5,
    /** Readiness penalty per point of this week's total Charge (see WEEKLY_PLANNING.ACTIVITIES[*].charge) — a heavy training week leaves a fighter sorer/more exposed even before any injury is actually rolled. */
    INJURY_RISK_PER_CHARGE_POINT: 1,
    /**
     * Piecewise-linear curve mapping Readiness -> combat multipliers, at
     * exactly the 5 calibration points the spec gives. Flat-extrapolated
     * outside [10, 100] (readiness <=10 uses the 10-point row's values,
     * >=100 uses the 100-point row's) rather than extrapolated further past
     * the given anchors, since no additional points were specified. See
     * CombatEngine#_computeReadinessCombatModifiers.
     */
    CURVE: [
      { readiness: 10, staminaMaxMultiplier: -0.1, momentumBonus: -0.08 },
      { readiness: 30, staminaMaxMultiplier: -0.04, momentumBonus: -0.03 },
      { readiness: 50, staminaMaxMultiplier: 0, momentumBonus: 0 },
      { readiness: 80, staminaMaxMultiplier: 0.03, momentumBonus: 0.01 },
      { readiness: 100, staminaMaxMultiplier: 0.05, momentumBonus: 0.03 },
    ],
  },

  // ---------------------------------------------------------------------
  // WEEKLY_PLANNING — Phase 3.1 v1/v2, the 3-slot weekly activity picker
  // (see Fighter#setWeeklyPlanSlot / engine/WeeklyPlanningEngine.js). Every
  // activity's `charge` feeds READINESS.INJURY_RISK_PER_CHARGE_POINT above.
  // physicalFatigueCost/mentalFatigueCost (and their *Delta recovery
  // counterparts) are scaled by that fighter's own PERSONALITY
  // fatigueMultiplier (engine/PersonalityEngine.js's computeCombinedModifiers
  // — the "wear a training/fight session leaves" dimension) for every
  // activity except PHYSIO_REST's recovery, which isn't wear.
  // TECHNIQUE/SPARRING both train the fighter's current weakest skill
  // (mirroring tools/SimRunner.js's existing coach-AI heuristic).
  // reputationGain/hypeGain/moneyGain are this implementation's own chosen
  // defaults (order-of-magnitude matched to GYM.REPUTATION_EVENTS/
  // HYPE.EVENTS and ECONOMY's weekly cashflow) since the spec named these
  // effects but didn't give exact figures. Phase 3.1 v2 split each
  // activity's single fatigueCost into physical vs mental (VIDEO_PREP and
  // MEDIA_SPONSORS are cognitive/promotional load, not physical exertion —
  // MEDIA_SPONSORS' v1 spec text itself already called it "fatigue
  // mentale"), and gated SPARRING's injury roll behind a causal Physical
  // Fatigue threshold instead of v1's unconditional flat chance (see
  // causalInjuryFatigueThreshold). Phase 3.1 v2.1 ("Test A/B") raised
  // PHYSIO_REST's recovery (-25% -> -30% on both gauges) and gave it
  // minAttractionShare — see engine/PersonalityEngine.js#computeActivityWeights,
  // which enforces this floor on every archetype's *combined* (archetype x
  // trait) activity weights, not just the base archetype table — a v2
  // regression showed Average Readiness on fight day collapsing to ~51-53
  // (well under the ~65-70 healthy zone) once v2 removed v1's scripted
  // forced-rest override in favor of "non-scriptees" archetype-driven
  // probabilities: some archetypes (e.g. Guerrier) had such a low
  // PHYSIO_REST weight relative to their other 4 activities that they
  // essentially never chose to rest. The floor keeps that choice
  // probabilistic (never forced), just guarantees it is never negligible.
  // ---------------------------------------------------------------------
  WEEKLY_PLANNING: {
    SLOTS_PER_WEEK: 3,
    ACTIVITIES: {
      TECHNIQUE: { charge: 1, skillGain: 0.008, physicalFatigueCost: 5 },
      SPARRING: {
        charge: 3,
        skillGain: 0.02,
        physicalFatigueCost: 18,
        /** Phase 3.1 v2: the injury roll only happens at all once the fighter enters this slot at/above this Physical Fatigue level — "causale", not a flat chance regardless of condition like v1's. */
        causalInjuryFatigueThreshold: 75,
        injuryChance: 0.05,
      },
      VIDEO_PREP: { charge: 1, tacticalBonus: 0.05, mentalFatigueCost: 5 },
      MEDIA_SPONSORS: { charge: 1, mentalFatigueCost: 8, reputationGain: 1, hypeGain: 3, moneyGain: 250 },
      PHYSIO_REST: {
        charge: 0,
        physicalFatigueDelta: -30,
        mentalFatigueDelta: -30,
        /** Phase 3.1 v2.1: minimum share of a fighter's combined (archetype x trait) activity-attraction weight that PHYSIO_REST must hold onto, enforced by computeActivityWeights — see this section's doc comment above. */
        minAttractionShare: 0.2,
      },
    },
  },

  // ---------------------------------------------------------------------
  // ECONOMY — currency, prices, salaries, running costs
  // ---------------------------------------------------------------------
  ECONOMY: {
    STARTING_GYM_FUNDS: 25000,

    /** Weekly recurring gym overhead, before facility upgrades add to it. */
    BASE_WEEKLY_UPKEEP: 800,
    /** Extra weekly upkeep added per facility (equipLevel) point. */
    UPKEEP_PER_FACILITY_LEVEL: 100,

    /** Passive weekly income from gym memberships/local sponsors, scaling with standing. */
    PASSIVE_INCOME: {
      BASE_WEEKLY: 100,
      PER_REPUTATION_POINT: 3,
      PER_HYPE_POINT: 2,
    },

    /** Financial crisis handling when the gym's treasury collapses. */
    INSOLVENCY: {
      /** Money below this (negative) balance triggers a crisis response. */
      DEBT_THRESHOLD: -5000,
      REPUTATION_PENALTY: -10,
      MAX_STAFF_LAYOFFS_PER_WEEK: 1,
    },

    SALARIES: {
      FIGHTER_BASE_WEEKLY: {
        AMATEUR: 150,
        PRO_LOW_TIER: 400,
        PRO_MID_TIER: 1200,
        PRO_TOP_TIER: 5000,
        CHAMPION: 15000,
      },
      COACH_BASE_WEEKLY: 300,
      STAFF_BASE_WEEKLY: 120,
    },

    /** Fight purse split. Sums to 1.0. */
    PURSE_SPLIT: {
      FIGHTER_SHARE: 0.6,
      GYM_SHARE: 0.3,
      MANAGER_SHARE: 0.1,
    },

    /** Purse scaling by event tier, in currency units for the base fighter payout. */
    BASE_FIGHT_PURSE: {
      LOCAL_SHOW: 500,
      REGIONAL: 2000,
      NATIONAL: 8000,
      MAJOR_PROMOTION: 30000,
      TITLE_FIGHT: 100000,
    },

    /** Win bonus is a multiplier applied on top of the base purse. */
    WIN_BONUS_MULTIPLIER: 1.5,
    /** Performance-of-the-night style bonus chance and multiplier. */
    PERFORMANCE_BONUS_CHANCE: 0.15,
    PERFORMANCE_BONUS_MULTIPLIER: 2,

    TAXES: {
      INCOME_TAX_RATE: 0.22,
    },

    /** Facility upgrade cost curve: cost(level) = BASE * (GROWTH ^ level). */
    FACILITY_UPGRADE: {
      BASE_COST: 5000,
      GROWTH: 1.35,
      MAX_LEVEL: 10,
    },
  },

  // ---------------------------------------------------------------------
  // INJURIES — occurrence, severity, recovery
  // ---------------------------------------------------------------------
  INJURIES: {
    /** Base chance an injury occurs, rolled once per fight and per hard sparring session. */
    BASE_CHANCE_PER_FIGHT: 0.08,
    BASE_CHANCE_PER_SPARRING: 0.03,

    /** Multiplier applied to injury chance based on fighter fatigue level (0-1). */
    FATIGUE_RISK_MULTIPLIER_MAX: 2.5,

    SEVERITY_WEIGHTS: {
      MINOR: 0.6,
      MODERATE: 0.28,
      SEVERE: 0.1,
      CAREER_THREATENING: 0.02,
    },

    RECOVERY_DAYS: {
      MINOR: 7,
      MODERATE: 21,
      SEVERE: 60,
      CAREER_THREATENING: 180,
    },

    /** Shared flavor list for injury narration, used by both CombatEngine and TrainingEngine. */
    BODY_PARTS: ['Genou', 'Coude', 'Arcade sourciliere', 'Cheville', 'Cotes', 'Epaule'],

    /** Attribute penalty applied while injured (fraction of attribute value removed). */
    ATTRIBUTE_PENALTY_WHILE_INJURED: {
      MINOR: 0.05,
      MODERATE: 0.15,
      SEVERE: 0.3,
      CAREER_THREATENING: 0.5,
    },

    /** Permanent attribute loss chance/amount after a severe or worse injury heals. */
    PERMANENT_DECLINE_CHANCE: {
      SEVERE: 0.25,
      CAREER_THREATENING: 0.6,
    },
    PERMANENT_DECLINE_AMOUNT: 3,

    /** Re-injury risk multiplier for the same body part within this many days of clearance. */
    REAGGRAVATION_WINDOW_DAYS: 30,
    REAGGRAVATION_RISK_MULTIPLIER: 3,
  },

  // ---------------------------------------------------------------------
  // MORALE — fighter/staff morale gain and loss
  // ---------------------------------------------------------------------
  MORALE: {
    MIN: 0,
    MAX: 100,
    /** Phase 3.1 v2: 65 -> 50, aligned with NEUTRAL_VALUE below (a fighter now starts perfectly neutral rather than already upbeat) — the "Systeme dynamique de Moral" spec's explicit baseline. */
    STARTING_VALUE: 50,

    EVENTS: {
      WIN_FIGHT: 15,
      LOSE_FIGHT: -18,
      WIN_TITLE: 30,
      LOSE_TITLE: -25,
      CONTRACT_RENEWED: 10,
      CONTRACT_DISPUTE: -12,
      PAY_CUT: -20,
      PAY_RAISE: 12,
      MISSED_TRAINING: -4,
      SPONSOR_DEAL_SIGNED: 8,
      INJURY_SUSTAINED: -10,
      TEAMMATE_TITLE_WIN_ENVY: -5,
      PUBLIC_CALLOUT_WON: 6,
      PUBLIC_CALLOUT_LOST: -8,
    },

    /** Weekly passive morale drift toward NEUTRAL_VALUE when no events occur. */
    NEUTRAL_VALUE: 50,
    WEEKLY_DRIFT_TOWARD_NEUTRAL: 2,

    THRESHOLDS: {
      /** At/under this morale, training gains and fight performance are penalized. */
      LOW: 30,
      /** At/over this morale, training gains and fight performance are boosted. */
      HIGH: 80,
      LOW_PERFORMANCE_MULTIPLIER: 0.8,
      HIGH_PERFORMANCE_MULTIPLIER: 1.15,
      /** Below this, a fighter may request a trade or refuse a fight. */
      REVOLT_RISK: 15,
    },
  },

  // ---------------------------------------------------------------------
  // TRAINING — camps, drills, attribute gains
  // ---------------------------------------------------------------------
  TRAINING: {
    /** Sessions available per in-game week. */
    SESSIONS_PER_WEEK: 5,

    /** Base attribute gain per session, before coach/facility/age modifiers. */
    BASE_ATTRIBUTE_GAIN_PER_SESSION: 0.6,

    /** Multiplier applied per coach skill point (coach skill is 0-100). */
    COACH_SKILL_GAIN_MULTIPLIER_PER_POINT: 0.01,

    /** Multiplier applied per facility level (0-10, see ECONOMY.FACILITY_UPGRADE). */
    FACILITY_GAIN_MULTIPLIER_PER_LEVEL: 0.05,

    /** Diminishing returns as the trained attribute approaches its cap. */
    DIMINISHING_RETURNS_START_AT_PERCENT_OF_CAP: 0.8,
    DIMINISHING_RETURNS_MULTIPLIER: 0.4,

    /**
     * Object keys here (REST/NORMAL/HARD) are the only valid
     * Fighter.training.intensity values — TrainingEngine validates against
     * Object.keys(BALANCE.TRAINING.INTENSITY_MODIFIERS) rather than a
     * separate list.
     *
     * gainMultiplier - applied to this week's skill gain (0 = no training).
     * formDelta      - change to attributes.forme from this week's session
     *                   (positive = recovery, negative = wear and tear).
     */
    INTENSITY_MODIFIERS: {
      REST: { gainMultiplier: 0, formDelta: 8 },
      NORMAL: { gainMultiplier: 1.0, formDelta: -2 },
      HARD: { gainMultiplier: 1.4, formDelta: -6 },
    },

    /** Weekly training-focused injury risk when a fighter pushes through low form. */
    OVERTRAINING: {
      /** Below this fraction of FORM.MAX, training while not resting risks an injury. */
      FORME_THRESHOLD_PERCENT: 0.4,
      BASE_INJURY_CHANCE: 0.06,
      /** Multiplies BASE_INJURY_CHANCE; REST is never checked (no active session). */
      INTENSITY_RISK_MULTIPLIER: { NORMAL: 1, HARD: 2.2 },
    },

    /** Bonus applied to a fighter's training gain based on Fighter.identity.origin. Unlisted origins get no bonus. */
    COUNTRY_BONUSES: {
      Bresil: { soumission: 0.15, sol: 0.1 },
      Thailande: { jambes: 0.15 },
      'Etats-Unis': { boxe: 0.1, cardio: 0.05 },
      Russie: { sol: 0.1, cardio: 0.05 },
      Japon: { intelligence: 0.1, soumission: 0.05 },
      France: { boxe: 0.05, intelligence: 0.05 },
      DEFAULT: {},
    },

    /**
     * A coach with a matching specialty applies their full skill bonus
     * (see COACH_SKILL_GAIN_MULTIPLIER_PER_POINT). Without a specialist,
     * the best available generalist coach still helps, but at this
     * fraction of their skill's usual effectiveness.
     */
    GENERALIST_COACH_EFFECTIVENESS: 0.4,
  },

  // ---------------------------------------------------------------------
  // CONTRACTS — fighters and staff
  // ---------------------------------------------------------------------
  CONTRACTS: {
    MIN_DURATION_WEEKS: 12,
    MAX_DURATION_WEEKS: 208, // 4 years

    /** Weeks before expiry a renewal negotiation window opens. */
    RENEWAL_NEGOTIATION_WINDOW_WEEKS: 8,

    /** Buyout cost = remaining weekly salary sum * this multiplier. */
    EARLY_TERMINATION_BUYOUT_MULTIPLIER: 1.75,

    /** Base chance a fighter accepts an offer at parity with their expectation. */
    BASE_ACCEPT_CHANCE: 0.5,
    /** Added/removed per 1% the offer is above/below the fighter's salary expectation. */
    ACCEPT_CHANCE_PER_PERCENT_ABOVE_EXPECTATION: 0.015,

    /** Reputation-driven salary expectation growth per fight win streak entry. */
    WIN_STREAK_SALARY_EXPECTATION_BUMP_PERCENT: 0.08,

    /** Signing bonus as a fraction of first-year total salary. */
    SIGNING_BONUS_PERCENT_OF_FIRST_YEAR: 0.1,

    FREE_AGENCY: {
      /** Weeks a fighter stays a free agent before AI gyms start bidding on them. */
      AI_BID_DELAY_WEEKS: 2,
    },
  },

  // ---------------------------------------------------------------------
  // SOCIAL_MEDIA — followers, engagement, virality
  // ---------------------------------------------------------------------
  SOCIAL_MEDIA: {
    STARTING_FOLLOWERS: {
      AMATEUR: 200,
      PRO_LOW_TIER: 1500,
      PRO_MID_TIER: 15000,
      PRO_TOP_TIER: 150000,
      CHAMPION: 800000,
    },

    /** Base follower growth (%) per week, before event modifiers. */
    BASE_WEEKLY_GROWTH_PERCENT: 0.015,

    EVENTS: {
      WIN_FIGHT_PERCENT: 0.08,
      IMPRESSIVE_FINISH_PERCENT: 0.15,
      LOSE_FIGHT_PERCENT: -0.03,
      TITLE_WIN_PERCENT: 0.35,
      CONTROVERSY_PERCENT_MIN: -0.1,
      CONTROVERSY_PERCENT_MAX: 0.2,
      VIRAL_CALLOUT_PERCENT: 0.25,
    },

    /** Chance per week a fighter's post/clip goes viral, rolled per fighter. */
    VIRAL_EVENT_BASE_CHANCE: 0.02,
    /** Personality trait "charisma" (0-100) scales viral chance up to this factor at 100. */
    CHARISMA_VIRAL_CHANCE_MAX_MULTIPLIER: 4,

    /** Engagement rate drives sponsor interest score; see SPONSORS.MIN_ENGAGEMENT_RATE. */
    BASE_ENGAGEMENT_RATE: 0.03,
    ENGAGEMENT_RATE_PER_CHARISMA_POINT: 0.0006,

    /** Max number of entries kept in PlayerState.socialFeed (oldest entries are trimmed). */
    FEED_HISTORY_LIMIT: 200,

    /** Like-count generation for auto-authored posts, consumed by engine/SocialEngine.js. */
    POST_LIKES: {
      BASE_MIN: 5,
      BASE_MAX: 40,
      /** Extra likes granted per point of PlayerState.hype. */
      HYPE_MULTIPLIER: 8,
      /** Multiplier applied when the post is about a fight that ended in a finish. */
      FINISH_BONUS_MULTIPLIER: 1.5,
      /** Multiplier applied per author type — trash talk and hot takes travel further than plain fan chatter. */
      POST_TYPE_LIKE_MULTIPLIER: {
        FAN: 1,
        JOURNALIST: 1.3,
        RIVAL: 1.6,
        FIGHTER_STATEMENT: 1.4,
      },
    },
  },

  // ---------------------------------------------------------------------
  // SPONSORS — deals, payouts, requirements
  // ---------------------------------------------------------------------
  SPONSORS: {
    /** Minimum follower count to be eligible for each sponsor tier. */
    TIER_FOLLOWER_REQUIREMENT: {
      LOCAL: 1000,
      REGIONAL: 10000,
      NATIONAL: 100000,
      GLOBAL: 500000,
    },

    MIN_ENGAGEMENT_RATE: {
      LOCAL: 0.01,
      REGIONAL: 0.015,
      NATIONAL: 0.02,
      GLOBAL: 0.025,
    },

    /** Base weekly payout by tier, before follower/engagement scaling. */
    BASE_WEEKLY_PAYOUT: {
      LOCAL: 50,
      REGIONAL: 400,
      NATIONAL: 3000,
      GLOBAL: 20000,
    },

    /** Extra payout scaling per 10,000 followers above the tier requirement. */
    PAYOUT_SCALING_PER_10K_FOLLOWERS: 0.01,

    /** Bonus payout for wearing sponsor branding into a nationally televised fight. */
    PPV_APPEARANCE_BONUS_MULTIPLIER: 3,

    /** Deal length range in weeks. */
    MIN_DEAL_DURATION_WEEKS: 8,
    MAX_DEAL_DURATION_WEEKS: 52,

    /** Chance a sponsor terminates the deal early after a major controversy event. */
    CONTROVERSY_TERMINATION_CHANCE: 0.3,
  },

  // ---------------------------------------------------------------------
  // AGE — aging curve, physical peak, decline
  // ---------------------------------------------------------------------
  AGE: {
    DEBUT_MIN_AGE: 18,
    DEBUT_MAX_AGE: 35,

    PEAK_AGE_RANGE: { MIN: 27, MAX: 32 },

    /** Attribute growth multiplier by age band, applied on top of TRAINING gains. */
    GROWTH_MULTIPLIER_BY_AGE: {
      PROSPECT: 1.3, // < PEAK_AGE_RANGE.MIN
      PEAK: 1.0, // within PEAK_AGE_RANGE
      VETERAN: 0.6, // PEAK_AGE_RANGE.MAX < age <= DECLINE_START_AGE
      DECLINING: 0.25, // > DECLINE_START_AGE
    },

    DECLINE_START_AGE: 34,
    /** Physical attributes lost per year once past DECLINE_START_AGE. */
    ANNUAL_DECLINE_PER_ATTRIBUTE: 1.5,
    /** IQ/experience-based attributes are exempt from decline below this age. */
    MENTAL_ATTRIBUTE_DECLINE_IMMUNITY_AGE: 38,

    RETIREMENT: {
      /** Age at which retirement becomes a possibility each year-end. */
      MIN_CONSIDERATION_AGE: 33,
      BASE_CHANCE_PER_YEAR_PAST_MIN: 0.05,
      /** Additional retirement chance per lost fight past MIN_CONSIDERATION_AGE. */
      CHANCE_PER_LOSS_AFTER_MIN_AGE: 0.08,
      FORCED_RETIREMENT_AGE: 45,
    },
  },

  // ---------------------------------------------------------------------
  // GYM — facilities, roster capacity, upgrades
  // ---------------------------------------------------------------------
  GYM: {
    STARTING_ROSTER_CAPACITY: 8,
    /** Extra roster slots granted per facility level (see ECONOMY.FACILITY_UPGRADE). */
    ROSTER_SLOTS_PER_FACILITY_LEVEL: 2,

    STARTING_REPUTATION: 20,
    MAX_REPUTATION: 100,

    /** Player-facing "buzz" meter, separate from long-term REPUTATION. */
    HYPE: {
      MIN: 0,
      MAX: 100,
      STARTING_VALUE: 10,

      /** Hype delta applied after a fight resolves, based on the player's fighter's outcome. */
      EVENTS: {
        WIN: 5,
        LOSS: -2,
        TITLE_WIN: 15,
        FINISH_BONUS: 5,
      },
    },

    REPUTATION_EVENTS: {
      FIGHTER_TITLE_WIN: 15,
      FIGHTER_WIN: 2,
      FIGHTER_LOSS: -1,
      SCANDAL: -20,
      SUCCESSFUL_EVENT_HOSTED: 5,
    },

    /** Reputation required to unlock each promotion tier for fight bookings. */
    PROMOTION_TIER_REPUTATION_REQUIREMENT: {
      LOCAL_SHOW: 0,
      REGIONAL: 15,
      NATIONAL: 40,
      MAJOR_PROMOTION: 70,
      TITLE_FIGHT: 90,
    },
  },

  // ---------------------------------------------------------------------
  // FORM — fighter physical condition ("forme"), distinct from TRAINING.FATIGUE
  // ---------------------------------------------------------------------
  FORM: {
    MIN: 0,
    MAX: 100,
    STARTING_VALUE: 75,
    /** Passive weekly loss while a fighter has no training/fight activity. */
    DECAY_PER_WEEK_INACTIVE: 3,
    /** Gain from a completed training session, before coach/facility modifiers. */
    GAIN_PER_TRAINING_SESSION: 2,
  },

  // ---------------------------------------------------------------------
  // PSYCHOLOGY — personality-driven mental stats (ego, discipline, motivation)
  // ---------------------------------------------------------------------
  PSYCHOLOGY: {
    MIN: 0,
    MAX: 100,
    STARTING_VALUES: {
      ego: 50,
      discipline: 50,
      motivation: 60,
    },
  },

  // ---------------------------------------------------------------------
  // CALENDAR — day/week/season/year length definitions for WorldState
  // ---------------------------------------------------------------------
  CALENDAR: {
    START_DAY: 1,
    DAYS_PER_WEEK: 7,
    WEEKS_PER_SEASON: 13,
    SEASONS_PER_YEAR: 4,
    SEASON_NAMES: ['Hiver', 'Printemps', 'Ete', 'Automne'],
  },

  // ---------------------------------------------------------------------
  // WORLD — world-state bookkeeping limits
  // ---------------------------------------------------------------------
  WORLD: {
    /** Max number of entries kept in WorldState.globalEvents (oldest are trimmed). */
    GLOBAL_EVENT_HISTORY_LIMIT: 500,

    /** Passive weekly reputation walk applied to every rival gym, fight or not. */
    RIVAL_GYM_REPUTATION_DRIFT: { MIN: -3, MAX: 3 },

    /** Rival gym "buzz" meter, independent of reputation. */
    RIVAL_GYM_ACTIVITY: {
      MIN: 0,
      MAX: 100,
      STARTING_VALUE: 50,
      WEEKLY_DRIFT_MIN: -5,
      WEEKLY_DRIFT_MAX: 5,
    },

    /** Chance a given pair of rival gyms books a headless bout against each other this week. */
    RIVAL_GYM_FIGHT_CHANCE_PER_WEEK: 0.3,
    /** Reputation swing for rival gyms that actually fought this week, on top of the passive drift. */
    RIVAL_GYM_FIGHT_REPUTATION_DELTA: { WIN: 4, LOSS: -2 },
  },

  // ---------------------------------------------------------------------
  // WEIGH_IN — weight-cut profiles resolved by CombatEngine's WEIGH_IN phase
  // ---------------------------------------------------------------------
  WEIGH_IN: {
    /**
     * Object keys here (NATUREL/MODERE/INTENSIF/EXTREME) are the only
     * valid weight-cut profile keys — CombatEngine validates against
     * Object.keys(BALANCE.WEIGH_IN.PROFILES) rather than a separate list.
     *
     * missChance          - probability the fighter fails to make weight.
     * formModifier        - fractional change applied to the fighter's
     *                        fight-local "forme" for this bout only
     *                        (does not mutate the persistent Fighter).
     * staminaModifier     - fractional change applied to the fighter's
     *                        starting stamina pool for this bout only.
     */
    PROFILES: {
      NATUREL: { missChance: 0.005, formModifier: 0.02, staminaModifier: 0.01 },
      MODERE: { missChance: 0.02, formModifier: -0.03, staminaModifier: 0 },
      INTENSIF: { missChance: 0.08, formModifier: -0.08, staminaModifier: -0.03 },
      EXTREME: { missChance: 0.2, formModifier: -0.15, staminaModifier: -0.08 },
    },

    /** Fraction of the missed-weight fighter's purse transferred to their opponent. */
    MISSED_WEIGHT_PURSE_PENALTY_PERCENT: 0.2,
  },

  // ---------------------------------------------------------------------
  // PERKS — unlockable fighter traits and the combat bonuses they grant
  // ---------------------------------------------------------------------
  PERKS: {
    DEFINITIONS: {
      IRON_CHIN: { label: 'Iron Chin', damageTakenMultiplier: 0.85 },
      HEAVY_HANDS: { label: 'Heavy Hands', damageMultiplier: 1.15 },
      CARDIO_MACHINE: { label: 'Cardio Machine', staminaCostMultiplier: 0.85 },
      SUBMISSION_HUNTER: { label: 'Submission Hunter', submissionChanceMultiplier: 1.3 },
      FINISHER: { label: 'Finisher', koChanceMultiplier: 1.15 },
      TITLE_HOLDER: { label: 'Title Holder', hypeMultiplier: 1.1 },
    },

    /** Career milestones that automatically grant a perk in POST_MATCH_REWARDS. */
    UNLOCK_THRESHOLDS: {
      FINISHER_CAREER_FINISHES: 5,
    },
  },

  // ---------------------------------------------------------------------
  // EQUIPMENT — gym equipment catalog consumed by TrainingEngine/EconomyEngine
  // ---------------------------------------------------------------------
  EQUIPMENT: {
    /**
     * PlayerState.equipment entries reference these by `id`. Unknown ids
     * (e.g. from a save made against an older BALANCE) are silently
     * ignored rather than erroring.
     *
     * trainingGainMultiplier - applied to weekly skill gain.
     * appliesToSkills        - null = applies to every skill; otherwise an
     *                           array of the skill keys it boosts.
     * formRecoveryMultiplier - applied only to *positive* weekly form
     *                          changes (i.e. rest), never to training wear.
     * weeklyMaintenanceCost  - deducted every week by EconomyEngine.
     * purchaseCost           - one-time cost charged by GymRenderer.buyEquipment().
     */
    DEFINITIONS: {
      OCTAGON_PRO: {
        label: 'Octogone Pro',
        trainingGainMultiplier: 1.12,
        appliesToSkills: null,
        formRecoveryMultiplier: 1,
        weeklyMaintenanceCost: 150,
        purchaseCost: 8000,
      },
      VIDEO_LAB: {
        label: 'Labo Video',
        trainingGainMultiplier: 1.08,
        appliesToSkills: ['intelligence'],
        formRecoveryMultiplier: 1,
        weeklyMaintenanceCost: 100,
        purchaseCost: 4000,
      },
      CRYOTHERAPY_CHAMBER: {
        label: 'Chambre de Cryotherapie',
        trainingGainMultiplier: 1,
        appliesToSkills: null,
        formRecoveryMultiplier: 1.5,
        weeklyMaintenanceCost: 200,
        purchaseCost: 12000,
      },
      WEIGHT_ROOM: {
        label: 'Salle de Musculation',
        trainingGainMultiplier: 1.1,
        appliesToSkills: ['boxe', 'jambes'],
        formRecoveryMultiplier: 1,
        weeklyMaintenanceCost: 90,
        purchaseCost: 3000,
      },
      GRAPPLING_MATS_PRO: {
        label: 'Tapis de Grappling Pro',
        trainingGainMultiplier: 1.1,
        appliesToSkills: ['sol', 'soumission'],
        formRecoveryMultiplier: 1,
        weeklyMaintenanceCost: 90,
        purchaseCost: 3500,
      },
    },
  },

  // ---------------------------------------------------------------------
  // DRAMA — Phase 3.2 ("Simulation Drama Engine"), consumed by
  // engine/DramaEngine.js. Distinct from NARRATIVE_EVENTS below (which
  // stays a single, low-frequency, no-choice "news ticker" — see
  // engine/EventEngine.js): DRAMA_EVENTS (data/events.js) are richer,
  // choice-driven, 5-category events resolved at a much higher weekly
  // rate specifically to close the Dead Week Rate gap Phase 3.1's own
  // telemetry surfaced (Fun sub-score stuck ~68/100 since Phase 3.1 v1).
  // PRIMARY_EVENT_CHANCE + SECONDARY_EVENT_CHANCE = the target "0.8 a 1.2
  // evenement significatif par semaine" from the spec (two independent
  // rolls rather than a single non-uniform distribution, for simplicity).
  // ---------------------------------------------------------------------
  DRAMA: {
    PRIMARY_EVENT_CHANCE: 0.85,
    SECONDARY_EVENT_CHANCE: 0.15,
    /** How many rival gyms tools/SimRunner.js seeds at setup so RIVALRIES-category events (and the pre-existing but previously-dormant engine/ProgressionEngine.js#processRivalGyms drift/fights) have something to read — the headless sim never called WorldState#addRivalGym before this test. */
    SEEDED_RIVAL_GYM_COUNT: 4,
  },

  // ---------------------------------------------------------------------
  // NARRATIVE_EVENTS — weekly random story beats, consumed by engine/EventEngine.js
  // ---------------------------------------------------------------------
  NARRATIVE_EVENTS: {
    /** Chance ANY narrative event fires in a given week. */
    WEEKLY_TRIGGER_CHANCE: 0.35,

    /** Which category fires when a week rolls an event. Must sum to 1. */
    CATEGORY_WEIGHTS: {
      SPONSOR_OFFER: 0.2,
      SPARRING_INJURY: 0.15,
      MEDIA_CLASH: 0.15,
      DOPING_CONTROL: 0.05,
      MORALE_SWING: 0.3,
      ALUMNI_DONATION: 0.15,
    },

    SPONSOR_OFFER: { MIN_AMOUNT: 500, MAX_AMOUNT: 3000, HYPE_BONUS: 3 },

    MEDIA_CLASH: {
      MORALE_DELTA_MIN: -8,
      MORALE_DELTA_MAX: 4,
      REPUTATION_DELTA_MIN: -5,
      REPUTATION_DELTA_MAX: 3,
    },

    DOPING_CONTROL: {
      FAIL_CHANCE: 0.04,
      REPUTATION_PENALTY: -15,
      MORALE_PENALTY: -25,
    },

    MORALE_SWING: { MIN_DELTA: -6, MAX_DELTA: 8 },

    ALUMNI_DONATION: { MIN_AMOUNT: 200, MAX_AMOUNT: 1500, REPUTATION_BONUS: 1 },
  },

  // ---------------------------------------------------------------------
  // PERSONALITY — archetype/trait catalog consumed by models/Fighter.js
  // and engine/PersonalityEngine.js
  // ---------------------------------------------------------------------
  PERSONALITY: {
    /**
     * Object keys are the only valid values for
     * Fighter.psychology.personality.archetype — set once at creation and
     * immutable thereafter (see models/Fighter.js). Every archetype/trait
     * below shares the same four silent-modifier dimensions so
     * PersonalityEngine can combine them multiplicatively:
     *   fatigueMultiplier      - scales the wear a training/fight session leaves.
     *   salaryDemandMultiplier - scales how "high-maintenance" the fighter is.
     *   moraleVolatility       - scales the size of morale swings (< 1 = steadier).
     *   progressionMultiplier  - scales skill-gain speed.
     *
     * Phase 3.1 v2 ("Emergence, Moral & Personnalites Vibrantes") adds a
     * 5th dimension, activityWeights — raw base weights (not multipliers)
     * over WEEKLY_PLANNING.ACTIVITIES' 5 keys, "probabilites d'attraction"
     * an archetype has toward each weekly activity, fed into
     * engine/PersonalityEngine.js#computeActivityWeights and consumed by
     * tools/SimRunner.js's coach-AI (weighted random pick, not a scripted
     * fixed sequence — "non-scriptees" per the spec). Only ARCHETYPES
     * define a full activityWeights table (guaranteed present on every
     * Fighter); a handful of thematically train-relevant TRAITS below add
     * a *multiplicative* activityWeights modulation on top — traits
     * without one default to no modulation (all 1) when combined, this
     * implementation's own deliberate scope choice rather than giving
     * every one of the 12 traits its own table.
     */
    ARCHETYPES: {
      Guerrier: {
        label: 'Guerrier',
        fatigueMultiplier: 0.9,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 0.9,
        progressionMultiplier: 1.0,
        activityWeights: { TECHNIQUE: 2, SPARRING: 5, VIDEO_PREP: 1, MEDIA_SPONSORS: 1, PHYSIO_REST: 1 },
      },
      Genie: {
        label: 'Genie',
        fatigueMultiplier: 1.0,
        salaryDemandMultiplier: 1.05,
        moraleVolatility: 0.85,
        progressionMultiplier: 1.2,
        activityWeights: { TECHNIQUE: 4, SPARRING: 1, VIDEO_PREP: 3, MEDIA_SPONSORS: 1, PHYSIO_REST: 1 },
      },
      Icone: {
        label: 'Icone',
        fatigueMultiplier: 1.0,
        salaryDemandMultiplier: 1.3,
        moraleVolatility: 1.1,
        progressionMultiplier: 0.95,
        activityWeights: { TECHNIQUE: 1, SPARRING: 1, VIDEO_PREP: 1, MEDIA_SPONSORS: 5, PHYSIO_REST: 1 },
      },
      Mercenaire: {
        label: 'Mercenaire',
        fatigueMultiplier: 0.95,
        salaryDemandMultiplier: 1.4,
        moraleVolatility: 0.8,
        progressionMultiplier: 0.95,
        activityWeights: { TECHNIQUE: 2, SPARRING: 1, VIDEO_PREP: 1, MEDIA_SPONSORS: 4, PHYSIO_REST: 1 },
      },
      Leader: {
        label: 'Leader',
        fatigueMultiplier: 0.95,
        salaryDemandMultiplier: 1.1,
        moraleVolatility: 0.85,
        progressionMultiplier: 1.0,
        activityWeights: { TECHNIQUE: 2, SPARRING: 2, VIDEO_PREP: 4, MEDIA_SPONSORS: 1, PHYSIO_REST: 1 },
      },
      Showman: {
        label: 'Showman',
        fatigueMultiplier: 1.05,
        salaryDemandMultiplier: 1.2,
        moraleVolatility: 1.15,
        progressionMultiplier: 0.95,
        activityWeights: { TECHNIQUE: 1, SPARRING: 2, VIDEO_PREP: 1, MEDIA_SPONSORS: 5, PHYSIO_REST: 1 },
      },
      Predateur: {
        label: 'Predateur',
        fatigueMultiplier: 0.9,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 1.05,
        progressionMultiplier: 1.05,
        activityWeights: { TECHNIQUE: 2, SPARRING: 5, VIDEO_PREP: 1, MEDIA_SPONSORS: 1, PHYSIO_REST: 1 },
      },
      Veteran: {
        label: 'Veteran',
        fatigueMultiplier: 1.1,
        salaryDemandMultiplier: 1.1,
        moraleVolatility: 0.7,
        progressionMultiplier: 0.8,
        activityWeights: { TECHNIQUE: 2, SPARRING: 1, VIDEO_PREP: 2, MEDIA_SPONSORS: 1, PHYSIO_REST: 4 },
      },
      Phenomene: {
        label: 'Phenomene',
        fatigueMultiplier: 0.95,
        salaryDemandMultiplier: 1.15,
        moraleVolatility: 1.0,
        progressionMultiplier: 1.3,
        activityWeights: { TECHNIQUE: 3, SPARRING: 3, VIDEO_PREP: 2, MEDIA_SPONSORS: 1, PHYSIO_REST: 1 },
      },
      Cameleon: {
        label: 'Cameleon',
        fatigueMultiplier: 1.0,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 1.0,
        progressionMultiplier: 1.0,
        activityWeights: { TECHNIQUE: 2, SPARRING: 2, VIDEO_PREP: 2, MEDIA_SPONSORS: 2, PHYSIO_REST: 2 },
      },
    },
    /** Used when a Fighter is created without an explicit archetype. */
    DEFAULT_ARCHETYPE: 'Cameleon',

    /**
     * Object keys are the only valid entries inside
     * Fighter.psychology.personality.traits[]. Unlike the archetype, traits
     * may be gained/lost over a career (see Fighter#addTrait/removeTrait).
     */
    TRAITS: {
      Professionnel: {
        label: 'Professionnel',
        fatigueMultiplier: 0.92,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 0.85,
        progressionMultiplier: 1.08,
        activityWeights: { TECHNIQUE: 1.3, SPARRING: 1.0, VIDEO_PREP: 1.2, MEDIA_SPONSORS: 0.8, PHYSIO_REST: 1.0 },
      },
      Fetard: {
        label: 'Fetard',
        fatigueMultiplier: 1.15,
        salaryDemandMultiplier: 0.95,
        moraleVolatility: 1.2,
        progressionMultiplier: 0.9,
        activityWeights: { TECHNIQUE: 0.8, SPARRING: 0.9, VIDEO_PREP: 0.8, MEDIA_SPONSORS: 1.6, PHYSIO_REST: 1.0 },
      },
      Impulsif: {
        label: 'Impulsif',
        fatigueMultiplier: 1.05,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 1.3,
        progressionMultiplier: 1.0,
        activityWeights: { TECHNIQUE: 0.8, SPARRING: 1.5, VIDEO_PREP: 0.7, MEDIA_SPONSORS: 1.1, PHYSIO_REST: 0.8 },
      },
      Provocateur: { label: 'Provocateur', fatigueMultiplier: 1.0, salaryDemandMultiplier: 1.05, moraleVolatility: 1.15, progressionMultiplier: 1.0 },
      Discipline: {
        label: 'Discipline',
        fatigueMultiplier: 0.88,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 0.8,
        progressionMultiplier: 1.1,
        activityWeights: { TECHNIQUE: 1.3, SPARRING: 1.1, VIDEO_PREP: 1.2, MEDIA_SPONSORS: 0.7, PHYSIO_REST: 1.0 },
      },
      Loyal: { label: 'Loyal', fatigueMultiplier: 1.0, salaryDemandMultiplier: 0.85, moraleVolatility: 0.85, progressionMultiplier: 1.0 },
      Arrogant: {
        label: 'Arrogant',
        fatigueMultiplier: 1.0,
        salaryDemandMultiplier: 1.25,
        moraleVolatility: 1.2,
        progressionMultiplier: 1.0,
        activityWeights: { TECHNIQUE: 0.8, SPARRING: 1.1, VIDEO_PREP: 0.8, MEDIA_SPONSORS: 1.5, PHYSIO_REST: 0.9 },
      },
      Humble: { label: 'Humble', fatigueMultiplier: 1.0, salaryDemandMultiplier: 0.8, moraleVolatility: 0.85, progressionMultiplier: 1.0 },
      Genereux: { label: 'Genereux', fatigueMultiplier: 1.0, salaryDemandMultiplier: 0.9, moraleVolatility: 0.9, progressionMultiplier: 1.0 },
      Intense: {
        label: 'Intense',
        fatigueMultiplier: 1.2,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 1.05,
        progressionMultiplier: 1.15,
        activityWeights: { TECHNIQUE: 1.1, SPARRING: 1.5, VIDEO_PREP: 0.9, MEDIA_SPONSORS: 0.9, PHYSIO_REST: 0.7 },
      },
      Calme: {
        label: 'Calme',
        fatigueMultiplier: 0.9,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 0.7,
        progressionMultiplier: 1.0,
        activityWeights: { TECHNIQUE: 1.1, SPARRING: 0.8, VIDEO_PREP: 1.2, MEDIA_SPONSORS: 0.9, PHYSIO_REST: 1.3 },
      },
      Ambitieux: { label: 'Ambitieux', fatigueMultiplier: 1.05, salaryDemandMultiplier: 1.15, moraleVolatility: 1.1, progressionMultiplier: 1.1 },
    },

    /** Reference magnitudes engine/PersonalityEngine.js scales its silent, post-hoc nudges by. */
    TRAINING_FATIGUE_REFERENCE: 2,
    MORALE_SWING_REFERENCE: 4,
    INSOLVENCY_MORALE_REFERENCE: 3,

    /** How many traits engine/FighterGenerator.js assigns to an automatically generated fighter. */
    GENERATION: {
      MIN_TRAITS: 1,
      MAX_TRAITS: 3,
    },
  },

  // ---------------------------------------------------------------------
  // LEGACY — Fighter#getLegacyStage() classification thresholds
  // ---------------------------------------------------------------------
  LEGACY: {
    /** Ordered narrative maturity stages, weakest to strongest. Purely descriptive. */
    STAGES: ['ESPOIR', 'PROSPECT', 'VETERAN', 'CHAMPION', 'LEGENDE', 'HALL_OF_FAME'],

    /** Total career fights (wins+losses+draws) needed to leave ESPOIR. */
    PROSPECT_MIN_FIGHTS: 5,
    /** Total career fights, OR identity.age, that qualify a non-champion as a VETERAN. */
    VETERAN_MIN_FIGHTS: 20,
    VETERAN_MIN_AGE: 32,
    /** Career titles ever won + total wins needed to reach LEGENDE (once CHAMPION). */
    LEGEND_MIN_TITLES: 2,
    LEGEND_MIN_WINS: 30,
  },

  // ---------------------------------------------------------------------
  // RELATIONSHIP — relationship-graph gauges consumed by engine/RelationshipEngine.js
  // ---------------------------------------------------------------------
  RELATIONSHIP: {
    MIN_RELATION: -100,
    MAX_RELATION: 100,
    MIN_GAUGE: 0,
    MAX_GAUGE: 100,

    STARTING_RELATION: 0,
    STARTING_POPULARITY: 0,
    STARTING_TENSION: 0,
    /** Two professional athletes start with a small baseline of mutual respect. */
    STARTING_RESPECT: 15,
    STARTING_LEGACY: 0,

    /** Applied to both entities whenever they share a resolved combat:finished. */
    COMBAT_EFFECTS: {
      RELATION_DELTA: -8,
      TENSION_DELTA: 12,
      RESPECT_DELTA: 10,
      POPULARITY_DELTA: 6,
      LEGACY_DELTA_BASE: 4,
      LEGACY_DELTA_FINISH_BONUS: 4,
      LEGACY_DELTA_TITLE_BONUS: 8,
    },

    /** Applied when a PROVOCATION-toned narrative beat lands between two entities. */
    PROVOCATION_EFFECTS: {
      RELATION_DELTA: -10,
      TENSION_DELTA: 15,
      POPULARITY_DELTA: 4,
    },

    /** Max entries kept in a relationship's history[] (oldest trimmed). */
    HISTORY_LIMIT: 25,
  },

  // ---------------------------------------------------------------------
  // STORY — narrative-opportunity detection thresholds, engine/StoryEngine.js
  // ---------------------------------------------------------------------
  STORY: {
    /** "Defeat + Ego + Tension -> potential conflict." */
    CONFLICT_POTENTIAL: {
      MIN_LOSER_EGO: 65,
      MIN_TENSION: 40,
    },
    /** A fight ending with relation already this low signals a real rivalry. */
    RIVALRY_IGNITED: {
      MAX_RELATION: -30,
    },
    /** The winner's overall rating was at least this many points below the loser's. */
    UPSET_VICTORY: {
      MIN_RATING_GAP: 15,
    },
    /** A roster fighter this "high-maintenance" resents a financial crisis more. */
    FINANCIAL_DISCONTENT: {
      MIN_SALARY_DEMAND_MULTIPLIER: 1.15,
    },
  },

  // ---------------------------------------------------------------------
  // NARRATIVE — narrative-form selection, engine/NarrativeEngine.js
  // ---------------------------------------------------------------------
  NARRATIVE: {
    /**
     * Weighted choice of narrative form per story:opportunity_detected type.
     * Object keys of each row are the only valid narrative forms.
     */
    FORM_WEIGHTS_BY_OPPORTUNITY: {
      CONFLICT_POTENTIAL: { DECLARATION: 0.5, INTERVIEW: 0.3, INCIDENT: 0.2 },
      RIVALRY_IGNITED: { DECLARATION: 0.4, INTERVIEW: 0.4, VIRAL_POST: 0.2 },
      UPSET_VICTORY: { VIRAL_POST: 0.5, INTERVIEW: 0.5 },
      FINANCIAL_DISCONTENT: { INCIDENT: 0.4, CONTRACT_BREACH: 0.3, DECLARATION: 0.3 },
    },
    /** Extra like multiplier applied when a VIRAL_POST narrative form lands on the social feed. */
    VIRAL_POST_LIKES_MULTIPLIER: 3,
  },
};

export default deepFreeze(BALANCE);
export { BALANCE };
