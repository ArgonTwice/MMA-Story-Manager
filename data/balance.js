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
 *   BALANCE.LEGACY_ENGINE - Phase 4.2 retirement reconversion (engine/LegacyEngine.js): Hall of Fame induction bar, coach-hire cap, reconversion outcome weights
 *   BALANCE.RELATIONSHIP  - relationship-graph gauge bounds and event deltas
 *   BALANCE.STORY         - narrative-opportunity detection thresholds
 *   BALANCE.NARRATIVE      - narrative-form selection weights per opportunity
 *   BALANCE.TRANSFER_MARKET  - Phase V2.7 autonomous rival-gym roster management (engine/TransferMarket.js)
 *   BALANCE.PROSPECT_GENERATOR - Phase V2.7 themed prospect wave generation (engine/ProspectGenerator.js)
 *   BALANCE.TELEMETRY      - Phase Beta anonymous local behavioral telemetry thresholds (web/telemetry.js)
 *   BALANCE.UNDERGROUND    - Underground Circuit modes/rulesets/gym-stipulation coefficients (engine/UndergroundEngine.js, engine/GymStipulations.js, CombatEngine.js's setupMatch() rules param)
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
  VERSION: '1.11.0',

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

    /** Weekly recurring gym overhead, before facility upgrades add to it — V3.8: fixed at exactly 500$/week, the "Local Modeste" starting tier's own rent (equipLevel 0, see engine/EconomyEngine.js#processWeeklyExpenses: rent = BASE_WEEKLY_UPKEEP + equipLevel * UPKEEP_PER_FACILITY_LEVEL). */
    BASE_WEEKLY_UPKEEP: 500,
    /** Extra weekly upkeep added per facility (equipLevel) point. */
    UPKEEP_PER_FACILITY_LEVEL: 300,

    /** Passive weekly income from gym memberships/local sponsors, scaling with standing. */
    PASSIVE_INCOME: {
      BASE_WEEKLY: 100,
      PER_REPUTATION_POINT: 0.75,
      PER_HYPE_POINT: 0.5,
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

    /**
     * Facility upgrade cost curve: cost(level) = BASE * (GROWTH ^ level) —
     * the price to move FROM `level` to `level + 1`. Retuned for
     * GYM.TIERS' 4 narratively-named tiers (was a flatter 10-level climb):
     * Local Modeste->Salle Locale 8000$, ->Centre de Formation ~17600$,
     * ->Academie Elite ~38720$ — each upgrade is meant to absorb a real
     * chunk of a season's earnings (BOUCLE ANTI-SNOWBALL), not be an
     * incidental purchase.
     */
    FACILITY_UPGRADE: {
      BASE_COST: 8000,
      GROWTH: 2.2,
      MAX_LEVEL: 3,
    },
  },

  // ---------------------------------------------------------------------
  // EMERGENCY_FINANCE — engine/EmergencyFinanceEngine.js's 3 crisis levers,
  // offered in the Hub once treasury drops below TREASURY_CRISIS_THRESHOLD
  // (well before ECONOMY.INSOLVENCY.DEBT_THRESHOLD's automatic response
  // kicks in at -5000$ — this is the proactive, player-chosen escape hatch
  // that comes first). Every lever is a real trade-off, never a free
  // bailout: the loan costs real interest paid back over weeks (via the
  // pre-existing activeDeals weekly-deal mechanism, a negative weeklyAmount
  // — see PlayerState#addActiveDeal / engine/GymStipulations.js#processActiveDeals),
  // the fire-sale permanently loses the item and its bonuses for a fraction
  // of what it cost, and the underground fight (engine/UndergroundEngine.js's
  // pre-existing VALE_TUDO mode) already carries its own elevated injury risk.
  // ---------------------------------------------------------------------
  EMERGENCY_FINANCE: {
    TREASURY_CRISIS_THRESHOLD: 1000,

    PREDATORY_LOAN: {
      PRINCIPAL: 3000,
      /** Total repaid over the schedule — well above PRINCIPAL, the "usurier" part. */
      TOTAL_REPAYMENT: 4800,
      WEEKS_TO_REPAY: 6,
    },

    EQUIPMENT_FIRE_SALE: {
      /** Sale price = purchaseCost * this fraction — a real loss versus what it cost. */
      SALE_FRACTION_OF_PURCHASE: 0.35,
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
  // CONFIDENCE — ring/cage self-belief, distinct from MORALE (which reacts
  // to pay/injuries/drama events too). Only fight results move it (see
  // engine/CombatEngine.js#_processPostMatchRewards), and it nudges
  // initiative-taking mid-fight (see its momentum computation) rather than
  // training gains — a separate, narrower dial from MORALE by design.
  // ---------------------------------------------------------------------
  CONFIDENCE: {
    MIN: 0,
    MAX: 100,
    /** A fighter starts perfectly neutral — CombatEngine's confidence-driven momentum bonus is EXACTLY zero at this value (see MOMENTUM_BONUS_SCALE below), so an untested fighter's first fight is unaffected by this system. */
    STARTING_VALUE: 50,

    EVENTS: {
      WIN_FIGHT: 8,
      /** Extra bump on top of WIN_FIGHT for winning BY FINISH specifically ("la confiance augmente avec les victoires/finishs") — CombatEngine applies both together on a finish win. */
      WIN_FIGHT_FINISH_BONUS: 7,
      LOSE_FIGHT: -10,
    },

    /**
     * Momentum bonus per point of confidence above/below STARTING_VALUE,
     * folded additively into CombatEngine's momentumMultiplier (see
     * _computeRoundOffense) alongside the existing readiness-driven bonus —
     * a confident fighter presses the action a little harder, a shaken one
     * a little less. Deliberately small: at the THRESHOLDS-like extremes
     * (confidence 0 or 100), the swing is only +/-0.1, a fraction of
     * momentum's own 0-2 range.
     */
    MOMENTUM_BONUS_SCALE: 0.002,
  },

  // ---------------------------------------------------------------------
  // FIGHTER_HYPE — V4.2 "Migration Hype Individuelle": an athlete's OWN
  // buzz/popularity (0-100), distinct from the pre-existing gym-wide
  // BALANCE.GYM.HYPE (left untouched — still read by EconomyEngine's
  // passive income and the V4.1 one-time gym sponsor generator, just no
  // longer surfaced in the topbar UI). Updated by engine/CombatEngine.js
  // #_processPostMatchRewards after every resolved match, for BOTH
  // corners regardless of which gym they belong to (models/Fighter.js
  // #adjustHype), and read by that same file's per-corner purse
  // multiplier (Purse = BasePurse * (1 + FighterHype/100)), by
  // engine/SponsorEngine.js's individual sponsor-offer thresholds, and by
  // engine/LeagueEngine.js#evaluateLeagueOffers's own Hype trigger
  // (fighter.attributes.hype, replacing the old playerState.hype check).
  // ---------------------------------------------------------------------
  FIGHTER_HYPE: {
    MIN: 0,
    MAX: 100,
    STARTING_VALUE: 0,

    EVENTS: {
      WIN_DECISION: 10,
      /** KO/TKO/Submission/Doctor Stoppage — same "byFinish" bucket _processPostMatchRewards already computes for confidence/morale. */
      WIN_FINISH: 25,
      /** A LOSS multiplies current Hype by this factor rather than subtracting a flat amount — "-15% Hype", so a bigger name loses more raw points from one bad night than a nobody does. */
      LOSS_DECAY_PERCENT: 0.15,
    },

    /** "🔥 Hot Streak": a temporary status flag set when a single fight's ACTUAL Hype gain (post-clamp) exceeds GAIN_THRESHOLD — WIN_FINISH (25) alone clears it, WIN_DECISION (10) alone never does. */
    HOT_STREAK: {
      GAIN_THRESHOLD: 20,
      DURATION_DAYS: 14,
    },

    /** Hype thresholds engine/SponsorEngine.js's individual sponsor offers fire at (crossed upward) — each threshold notifies AT MOST ONCE per fighter's whole career (models/Fighter.js#markSponsorThresholdNotified), whether the offer it produced was accepted or declined. */
    SPONSOR_THRESHOLDS: [30, 60, 80],
    /** Caps how many pending sponsor offers (see MESSAGE_CATEGORIES.SPONSOR_OFFER) one fighter may hold at once — "evite le spam" — without limiting how many already-SIGNED sponsorships (models/Fighter.js#contracts.sponsorships) they can carry. */
    MAX_ACTIVE_SPONSOR_OFFERS: 2,

    /** Brand pool engine/SponsorEngine.js draws from for individual sponsor offers. */
    SPONSOR_BRANDS: Object.freeze(['Volt Athletics', 'Monster Energy', 'FightWear']),

    /** A sponsor contract's terms scale with the Hype threshold crossed — a Hype-80 offer pays far more than a Hype-30 one. */
    SPONSOR_CONTRACT: {
      FIGHTS_REQUIRED: 3,
      SIGNING_BONUS_PER_HYPE_POINT: 100,
      PURSE_PER_FIGHT_PER_HYPE_POINT: 40,
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

    /**
     * Reference decline-rate curve exposed by engine/BalanceConfig.js
     * (computeAgeDeclineMultiplier) for display/analysis — e.g. a fighter
     * profile's "projected decline" readout. Deliberately NOT wired into
     * ProgressionEngine's actual weekly attribute mutation, which keeps
     * using DECLINE_START_AGE/ANNUAL_DECLINE_PER_ATTRIBUTE above unchanged
     * (a flat rate past a single threshold, already tuned and tested) —
     * this is a finer-grained reference curve (2%/an des 28 ans,
     * accelerant a 5%/an des 35 ans) for anything that wants to SHOW a
     * smoother expectation, not a second decline mechanic actually applied
     * to fighters.
     */
    DECLINE_CURVE_REFERENCE: {
      EARLY_DECLINE_START_AGE: 28,
      EARLY_ANNUAL_RATE: 0.02,
      STEEP_DECLINE_START_AGE: 35,
      STEEP_ANNUAL_RATE: 0.05,
    },

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
    /**
     * 4 named facility tiers, indexed by PlayerState.equipLevel (0-3, see
     * ECONOMY.FACILITY_UPGRADE.MAX_LEVEL) — replaces the old flat
     * "STARTING_ROSTER_CAPACITY + equipLevel * ROSTER_SLOTS_PER_FACILITY_LEVEL"
     * linear formula with an explicit, narratively-named progression (see
     * engine/GymInfrastructure.js). PlayerState#getRosterCapacity() reads
     * TIERS[equipLevel].capacity directly — roster size is STRICTLY capped
     * by the current tier, no exceptions.
     */
    TIERS: [
      { id: 'LOCAL_MODESTE', label: 'Local Modeste', capacity: 4 },
      { id: 'SALLE_LOCALE', label: 'Salle Locale', capacity: 8 },
      { id: 'CENTRE_FORMATION', label: 'Centre de Formation', capacity: 15 },
      { id: 'ACADEMIE_ELITE', label: 'Academie Elite', capacity: 30 },
    ],

    /** V3.5: lowered from 20 — a brand-new gym starts essentially unknown, not already regionally recognized. */
    STARTING_REPUTATION: 0,
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
  // ACADEMY_DRAFT — free annual recruitment pool ("Draft Annuel de l'Academie")
  // ---------------------------------------------------------------------
  ACADEMY_DRAFT: {
    /** How many academy prospects are generated each year (inclusive range). */
    POOL_SIZE_MIN: 2,
    POOL_SIZE_MAX: 3,

    /** Free promotions the player may make from the pool per year — see engine/AcademyEngine.js. */
    FREE_PICKS_PER_YEAR: 1,

    MIN_AGE: 18,
    MAX_AGE: 22,

    /**
     * V3.8: the pre-spread skill mean now comes from
     * engine/FighterGenerator.js#computeAcademyOverallBase(reputation,
     * equipLevel) instead of a flat base + separate bonuses — a fresh gym's
     * very first prospects land genuinely raw (~25 Overall) rather than
     * already half-trained. Random +/- spread applied per skill around
     * that computed mean.
     */
    SKILL_SPREAD: 12,

    /**
     * Potential tiers rolled per prospect (highest tier whose minRoll the
     * roll clears wins) — a display/generation concept only, never
     * persisted on the Fighter itself (see engine/AcademyEngine.js).
     */
    POTENTIAL_TIERS: {
      PROMETTEUR: { label: 'Prometteur', minRoll: 0, skillMeanBonus: 0 },
      SOLIDE: { label: 'Solide', minRoll: 0.55, skillMeanBonus: 8 },
      ELITE: { label: 'Elite', minRoll: 0.88, skillMeanBonus: 16 },
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
      /** Phase 4.6: relationship/loyalty with the current gym, 0-100 — see Fighter#adjustLoyalty(). A new signing starts moderately, not blindly, loyal. */
      loyalty: 60,
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
    /** Max number of entries kept in WorldState.hallOfFame (oldest are trimmed) — see engine/HistoryEngine.js#induct. */
    HALL_OF_FAME_HISTORY_LIMIT: 200,

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
  // TRANSFER_MARKET — Phase V2.7: autonomous rival-gym roster management
  // (see engine/TransferMarket.js), run once per season.
  // ---------------------------------------------------------------------
  TRANSFER_MARKET: {
    /** Rival gyms recruit while under this roster size, and never recruit above it. */
    ROSTER_TARGET_SIZE: 6,
    /** Chance a rival gym under ROSTER_TARGET_SIZE actually recruits this season (not guaranteed every season). */
    RECRUIT_CHANCE: 0.6,

    /** New signings' contract length, in years, before an extend-or-release decision is rolled again. */
    NEW_CONTRACT_YEARS: 2,
    EXTEND_CONTRACT_YEARS: 2,
    /**
     * Base chance an expiring contract is released rather than extended,
     * before the age/rating modifiers below. Tuned to 0.85 (most rookies
     * DON'T pan out) after a real SimRunner measurement at 0.2 showed a
     * ~58-60% Prospect Success Rate ("extended at least once") — nowhere
     * near the spec's 10-20% target (see tools/BalanceReporter.js). Since
     * a rival gym's roster fighters never train/age while under contract
     * (only playerState.roster gets weekly training/birthday processing),
     * a signing's release odds stay CONSTANT at every renewal check for
     * their whole tenure — so this single base rate alone determines the
     * population-wide success rate, and needed to move a lot, not a little.
     */
    BASE_RELEASE_CHANCE: 0.65,
    /** Extra release chance for a fighter past BALANCE.AGE.DECLINE_START_AGE. */
    AGE_DECLINE_RELEASE_BONUS: 0.25,
    /** Extra release chance for a fighter whose getOverallRating() is below LOW_RATING_THRESHOLD. */
    LOW_RATING_RELEASE_BONUS: 0.2,
    LOW_RATING_THRESHOLD: 35,

    /** New recruit generation: baseline skill mean before the gym's own Reputation bonus, and per-skill random spread — same spirit as ACADEMY_DRAFT's own generation knobs. */
    RECRUIT_SKILL_MEAN_BASE: 30,
    RECRUIT_SKILL_SPREAD: 15,
    RECRUIT_REPUTATION_SKILL_MEAN_BONUS_PER_POINT: 0.15,
    RECRUIT_MIN_AGE: 19,
    RECRUIT_MAX_AGE: 29,
  },

  // ---------------------------------------------------------------------
  // PROSPECT_GENERATOR — Phase V2.7: periodic themed prospect waves
  // (see engine/ProspectGenerator.js), distributed into rival gym rosters.
  // ---------------------------------------------------------------------
  PROSPECT_GENERATOR: {
    /** A new "Cuvee" is generated every this-many in-world years. */
    WAVE_INTERVAL_YEARS: 3,
    WAVE_SIZE_MIN: 4,
    WAVE_SIZE_MAX: 8,

    SKILL_MEAN_BASE: 35,
    SKILL_SPREAD: 12,
    /** Bonus applied only to a theme's own associated skills (see THEMES[*].skills) — what makes a "Cuvee de Strikers" actually strike harder as a cohort. */
    THEME_SKILL_BONUS: 15,

    MIN_AGE: 18,
    MAX_AGE: 21,

    /**
     * One theme is picked per wave. `skills` are the Fighter.attributes.skills
     * keys THEME_SKILL_BONUS applies to; `styles` is the pool
     * identity.style is drawn from for this wave.
     */
    THEMES: {
      LUTTEURS: { label: 'Cuvee des Lutteurs', skills: ['sol', 'soumission'], styles: ['Lutte', 'Jiu-Jitsu Bresilien'] },
      STRIKERS: { label: 'Cuvee des Strikers', skills: ['boxe', 'jambes'], styles: ['Boxe', 'Kickboxing', 'Muay Thai'] },
      GRAPPLERS: { label: 'Cuvee des Grapplers', skills: ['sol', 'cardio'], styles: ['Lutte', 'Jiu-Jitsu Bresilien', 'Freestyle'] },
    },
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
     * PlayerState.equipment entries reference these by `id` and now also
     * carry their own `quality` (1.0 = 100%, see engine/GymInfrastructure.js).
     * Unknown ids (e.g. from a save made against an older BALANCE) are
     * silently ignored rather than erroring.
     *
     * trainingGainMultiplier   - applied to weekly skill gain, scaled by quality.
     * appliesToSkills          - null = applies to every skill; otherwise an
     *                            array of the skill keys it boosts.
     * formRecoveryMultiplier   - applied only to *positive* weekly form
     *                            changes (i.e. rest), never to training wear.
     * fatigueAccumulationMultiplier - applied to weekly Fatigue gain from
     *                            training (< 1 reduces it). Defaults to 1
     *                            (no effect) when omitted.
     * clinchOutputMultiplier   - applied to a player fighter's CLINCH-distance
     *                            output in CombatEngine, on top of the
     *                            existing per-style bonus. Defaults to 1.
     * staminaMaxBonusPercent   - added to a player fighter's Stamina Max at
     *                            weigh-in. Defaults to 0.
     * rosterCapacityCost       - roster slots this item consumes just by
     *                            being owned (space trade-off) — subtracted
     *                            from PlayerState#getRosterCapacity(),
     *                            floored so it can never go below 1.
     *                            Defaults to 0.
     * weeklyMaintenanceCost    - deducted every week by EconomyEngine.
     * purchaseCost             - one-time cost charged when buying it.
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
        label: 'Unite de Cryotherapie',
        trainingGainMultiplier: 1,
        appliesToSkills: null,
        formRecoveryMultiplier: 1.5,
        /** "-20% accumulation de fatigue" — this IS the "Unite de Cryotherapie" from the spec; its 200$/semaine electricity bill was already this item's own maintenance cost. */
        fatigueAccumulationMultiplier: 0.8,
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
        label: 'Tatamis de Grappling',
        /** "+10% gain en Sol" — appliesToSkills also includes soumission (the natural pairing every other skill-specific item already follows, e.g. WEIGHT_ROOM's boxe+jambes). */
        trainingGainMultiplier: 1.1,
        appliesToSkills: ['sol', 'soumission'],
        formRecoveryMultiplier: 1,
        weeklyMaintenanceCost: 90,
        purchaseCost: 3500,
      },
      HEAVY_BAGS: {
        label: 'Sacs de Frappe Lourds',
        trainingGainMultiplier: 1.08,
        appliesToSkills: ['boxe'],
        formRecoveryMultiplier: 1,
        weeklyMaintenanceCost: 60,
        purchaseCost: 2000,
      },
      COMPETITION_CAGE: {
        label: 'Cage de Competition',
        trainingGainMultiplier: 1,
        appliesToSkills: null,
        formRecoveryMultiplier: 1,
        /** "+15% efficacite du Clinch/Cage Control" — a real in-fight bonus, not a training-gain one, see engine/CombatEngine.js#_computeRoundOffense. */
        clinchOutputMultiplier: 1.15,
        /** "cout de maintenance eleve" — the priciest upkeep in the catalog. */
        weeklyMaintenanceCost: 350,
        purchaseCost: 15000,
      },
      CARDIO_ZONE: {
        label: 'Zone Cardio',
        trainingGainMultiplier: 1,
        appliesToSkills: null,
        formRecoveryMultiplier: 1,
        /** Boosts Stamina Max at weigh-in for the player's own fighters. */
        staminaMaxBonusPercent: 0.1,
        /** "consomme de la capacite d'espace" — a real trade-off against roster size. */
        rosterCapacityCost: 1,
        weeklyMaintenanceCost: 120,
        purchaseCost: 5000,
      },
    },

    /**
     * Owned equipment degrades with weekly use (see
     * engine/GymInfrastructure.js#degradeEquipmentWeekly) — quality 1.0 ->
     * 0.0 over roughly 1/DEGRADATION_PER_WEEK weeks (~12-13 weeks, one
     * season) of continuous use if never repaired.
     */
    DEGRADATION_PER_WEEK: 0.08,
    /** Below this quality, the item actively hurts: training injury risk rises (LOW_QUALITY_INJURY_RISK_MULTIPLIER) instead of just losing its bonus. */
    LOW_QUALITY_THRESHOLD: 0.4,
    LOW_QUALITY_INJURY_RISK_MULTIPLIER: 1.15,
    /** repairCost = purchaseCost * this fraction, restores quality to 1.0. */
    REPAIR_COST_FRACTION_OF_PURCHASE: 0.25,
  },

  // ---------------------------------------------------------------------
  // STAFF — engine/StaffEngine.js's 3 recruitable roles (Head Coach,
  // Striking/Grappling Coach, Physio), distinct from the pre-existing
  // Legacy Coach system (engine/LegacyEngine.js, a retired fighter hired
  // automatically — unpaid, no `role`) which keeps working unchanged.
  // Every effect is scaled around baselineSkill: a coach AT baseline
  // helps/hurts nothing, so hiring nobody (the pre-existing default)
  // remains exactly today's behavior.
  // ---------------------------------------------------------------------
  STAFF: {
    ROLES: {
      HEAD_COACH: {
        id: 'HEAD_COACH',
        label: 'Head Coach',
        baselineSkill: 50,
        /** Additive nudge to CombatEngine's momentumMultiplier per point of skill above/below baseline — same shape/scale as CONFIDENCE's own momentum bonus (see engine/CombatEngine.js). */
        momentumBonusPerSkillPoint: 0.0015,
        /** Weekly morale bump applied to every roster fighter per point of skill above baseline (see engine/StaffEngine.js#applyWeeklyStaffEffects). */
        weeklyMoraleBonusPerSkillPoint: 0.06,
        /** This role's skill IS the "CompetenceCoach" the Fog of War formula reads (see SCOUTING_FOG below / engine/ScoutingEngine.js). */
      },
      STRIKING_GRAPPLING_COACH: {
        id: 'STRIKING_GRAPPLING_COACH',
        label: 'Coach Frappe / Grappling',
        baselineSkill: 50,
        /** Output bonus to the specialty's own distance (STRIKING for a striking coach, GROUND for a grappling coach) per point of skill above baseline. */
        primaryBonusPerSkillPoint: 0.003,
        /** Malus to the OPPOSITE distance's output per point of skill above baseline — "boost les degats/soumissions, mais applique un malus secondaire sur la stat opposee." */
        secondaryMalusPerSkillPoint: 0.0015,
      },
      PHYSIO: {
        id: 'PHYSIO',
        label: 'Physio',
        baselineSkill: 50,
        /** Multiplicative reduction to post-fight/training injury chance per point of skill above baseline. */
        injuryRiskReductionPerSkillPoint: 0.004,
        /** Multiplicative bonus to CORNER_PAUSE stamina regen per point of skill above baseline. */
        staminaRegenBonusPerSkillPoint: 0.01,
      },
    },

    HIRING_POOL_SIZE: 4,

    /**
     * V3.5: which coach-skill tier the hiring pool draws from is gated by
     * the gym's current Reputation — an unknown gym can't attract elite
     * staff no matter how much it can pay. Ordered low-to-high; the
     * HIGHEST tier whose minReputation the gym's current reputation clears
     * applies (same "highest qualifying tier wins" pattern this file
     * already uses for POTENTIAL_TIERS elsewhere) — see
     * engine/StaffEngine.js#generateHiringPool.
     */
    REPUTATION_SKILL_TIERS: [
      { minReputation: 0, minSkill: 15, maxSkill: 40 },
      { minReputation: 20, minSkill: 25, maxSkill: 55 },
      { minReputation: 40, minSkill: 40, maxSkill: 70 },
      { minReputation: 70, minSkill: 60, maxSkill: 95 },
    ],

    SALARY_BASE_WEEKLY: 200,
    SALARY_PER_SKILL_POINT: 8,

    /**
     * Relationship/ego gauge (0-100) each hired staff member starts at and
     * carries for as long as they're on staff — see
     * engine/StaffEngine.js#rollStaffConflict ("avis divergeant sur l'etat
     * de sante d'un combattant").
     */
    STARTING_RELATIONSHIP: 60,
    CONFLICT: {
      BASE_WEEKLY_CHANCE: 0.06,
      LOW_RELATIONSHIP_THRESHOLD: 35,
      LOW_RELATIONSHIP_CHANCE_BONUS: 0.14,
      RELATIONSHIP_HIT: -10,
    },
  },

  // ---------------------------------------------------------------------
  // SCOUTING_FOG — Fog of War over un-scouted prospects' real stats, per
  // engine/ScoutingEngine.js#estimateFighterSkills. Distinct from that
  // same file's generateScoutingReport() (qualitative pre-fight opponent
  // notes) — this is the quantitative estimate shown for a PROSPECT before
  // (and for a while after) signing.
  // ---------------------------------------------------------------------
  SCOUTING_FOG: {
    /** StatEstimee = StatReelle +/- (100 - CompetenceCoach) * this factor — the spec's own formula, verbatim. */
    ERROR_PER_MISSING_COMPETENCE_POINT: 0.3,
    /** "CompetenceCoach" used when no Head Coach is hired — the player's own untrained eye. */
    NO_COACH_COMPETENCE: 20,
    /** The INITIAL error window shrinks by this fraction of itself per week a fighter has spent at the gym (not a flat additive decay) — "-5% d'erreur par semaine passee au Gym". Reaches effectively 0 (full reveal) well within a season. */
    WEEKLY_ERROR_REDUCTION_FRACTION: 0.05,
  },

  // ---------------------------------------------------------------------
  // LEAGUE_PYRAMID — the PLAYER's own 3-tier competitive progression (see
  // engine/LeagueEngine.js), promoted/relegated by Reputation + recent
  // winrate. Distinct from data/leagues.js's own 4-entry LEAGUES catalog:
  // that one only tags which purse tier a RIVAL gym's autonomous contracts
  // (engine/TransferMarket.js/engine/ProspectGenerator.js) are written
  // under by Reputation alone, with no promotion/relegation state at all —
  // the two systems never read each other.
  // ---------------------------------------------------------------------
  LEAGUE_PYRAMID: {
    TIERS: {
      LOCAL_UNDERGROUND: { id: 'LOCAL_UNDERGROUND', label: 'Local / Underground', tier: 1, purseMultiplier: 1, passiveIncomeMultiplier: 1 },
      NATIONAL: { id: 'NATIONAL', label: 'National', tier: 2, promotionReputationThreshold: 45, purseMultiplier: 3, passiveIncomeMultiplier: 2 },
      ELITE_MONDIALE: { id: 'ELITE_MONDIALE', label: 'Elite Mondiale', tier: 3, promotionReputationThreshold: 75, purseMultiplier: 8, passiveIncomeMultiplier: 4 },
    },
    /** Tier ids in ascending order — LOCAL_UNDERGROUND has no promotionReputationThreshold of its own (nothing promotes INTO the bottom tier). */
    TIER_ORDER: ['LOCAL_UNDERGROUND', 'NATIONAL', 'ELITE_MONDIALE'],

    FIGHT_HISTORY_WINDOW: 10,
    /** Guards against promoting/relegating off a tiny sample (e.g. 1 win in week 1). */
    MIN_FIGHTS_FOR_EVALUATION: 5,
    PROMOTION_WINRATE_THRESHOLD: 0.5,
    RELEGATION_WINRATE_THRESHOLD: 0.4,
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
    /**
     * How many rival gyms tools/SimRunner.js seeds at setup so RIVALRIES-
     * category events (and engine/ProgressionEngine.js#processRivalGyms
     * drift/fights) have something to read. Raised from 4 to 8 for Phase
     * V2.7's Gym Dominance Index (<30% target, see
     * tools/BalanceReporter.js): with only 4 gyms (2 pairings), even a
     * perfectly even split still hands each pairing's winner 50% — the
     * <30% target is mathematically unreachable below ~4 gyms even in the
     * best case, and 8 leaves enough headroom (12.5% each at perfect
     * balance) to absorb real variance and still clear the bar.
     */
    SEEDED_RIVAL_GYM_COUNT: 8,
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

      /**
       * Phase 4.6 ("Fighters with Soul"): 8 more traits, same symmetric
       * buff/malus philosophy as the 12 above — every gain on one dimension
       * is paid for on another, never a strict upgrade. Two of the user's
       * illustrative examples ("Showman", "Leader") already name existing
       * ARCHETYPES above; reusing them as trait keys too would let the same
       * fighter carry a "Showman" archetype AND a "Showman" trait badge,
       * which reads as a confusing duplicate label rather than two distinct
       * concepts. Frimeur/Meneur below carry the same narrative flavor
       * (show-off / natural leader) under names that don't collide.
       */
      Travailleur: {
        label: 'Travailleur',
        fatigueMultiplier: 0.85,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 1.15,
        progressionMultiplier: 1.15,
        activityWeights: { TECHNIQUE: 1.3, SPARRING: 1.2, VIDEO_PREP: 1.1, MEDIA_SPONSORS: 0.6, PHYSIO_REST: 0.9 },
      },
      Paresseux: {
        label: 'Paresseux',
        fatigueMultiplier: 0.9,
        salaryDemandMultiplier: 0.9,
        moraleVolatility: 0.85,
        progressionMultiplier: 0.8,
        activityWeights: { TECHNIQUE: 0.7, SPARRING: 0.6, VIDEO_PREP: 0.7, MEDIA_SPONSORS: 0.8, PHYSIO_REST: 1.8 },
      },
      Frimeur: {
        label: 'Frimeur',
        fatigueMultiplier: 1.05,
        salaryDemandMultiplier: 1.25,
        moraleVolatility: 1.2,
        progressionMultiplier: 0.9,
        activityWeights: { TECHNIQUE: 0.7, SPARRING: 0.9, VIDEO_PREP: 0.6, MEDIA_SPONSORS: 1.8, PHYSIO_REST: 0.9 },
      },
      Introverti: {
        label: 'Introverti',
        fatigueMultiplier: 1.0,
        salaryDemandMultiplier: 0.9,
        moraleVolatility: 0.75,
        progressionMultiplier: 1.05,
        activityWeights: { TECHNIQUE: 1.3, SPARRING: 0.9, VIDEO_PREP: 1.3, MEDIA_SPONSORS: 0.4, PHYSIO_REST: 1.0 },
      },
      Agressif: {
        label: 'Agressif',
        fatigueMultiplier: 1.2,
        salaryDemandMultiplier: 1.0,
        moraleVolatility: 1.15,
        progressionMultiplier: 1.1,
        activityWeights: { TECHNIQUE: 0.8, SPARRING: 1.7, VIDEO_PREP: 0.6, MEDIA_SPONSORS: 1.0, PHYSIO_REST: 0.6 },
      },
      Meneur: {
        label: 'Meneur',
        /**
         * Tuned post-launch: a 4000-season BalanceReporter run showed Meneur
         * persistently at -6.2 pts winrate vs 50% (outside the [45%, 55%]
         * target) even at large sample size — unlike every other trait's
         * deviation at smaller samples, which converged to neutral as noise
         * washed out. Its steadier moraleVolatility (0.8, shared with
         * Discipline, which lands neutral) wasn't enough to offset its own
         * mild fatigueMultiplier/progressionMultiplier and its
         * slightly-below-neutral PHYSIO_REST weight. Nudged both up to a
         * real, modest buff — in line with Discipline's own 0.88/1.1 pairing
         * — since a fighter who leads the room by example should also be
         * the one putting in the work.
         */
        fatigueMultiplier: 0.9,
        salaryDemandMultiplier: 1.1,
        moraleVolatility: 0.8,
        progressionMultiplier: 1.08,
        activityWeights: { TECHNIQUE: 1.1, SPARRING: 1.2, VIDEO_PREP: 1.1, MEDIA_SPONSORS: 1.1, PHYSIO_REST: 0.9 },
      },
      Toxique: {
        label: 'Toxique',
        fatigueMultiplier: 1.0,
        salaryDemandMultiplier: 1.2,
        moraleVolatility: 1.3,
        progressionMultiplier: 1.1,
      },
      Mentor: {
        label: 'Mentor',
        fatigueMultiplier: 0.95,
        salaryDemandMultiplier: 1.1,
        moraleVolatility: 0.75,
        progressionMultiplier: 0.9,
        activityWeights: { TECHNIQUE: 1.0, SPARRING: 1.0, VIDEO_PREP: 1.4, MEDIA_SPONSORS: 1.0, PHYSIO_REST: 1.0 },
      },
    },

    /** Reference magnitudes engine/PersonalityEngine.js scales its silent, post-hoc nudges by. */
    TRAINING_FATIGUE_REFERENCE: 2,
    MORALE_SWING_REFERENCE: 4,
    INSOLVENCY_MORALE_REFERENCE: 3,

    /** How many traits engine/FighterGenerator.js assigns to an automatically generated fighter — every fighter gets at least 2 visible traits (see web/app.js's Fighter Profile view). */
    GENERATION: {
      MIN_TRAITS: 2,
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
  // LEGACY_ENGINE — Phase 4.2 ("Memoire du Monde, Legacy Engine &
  // Attachement au Roster"): retirement-time Hall of Fame induction and
  // reconversion (engine/HistoryEngine.js#evaluateHallOfFameEligibility/
  // induct, engine/LegacyEngine.js#processRetirement).
  // ---------------------------------------------------------------------
  LEGACY_ENGINE: {
    /**
     * Career resume bar for Hall of Fame induction, checked at forced
     * retirement. Deliberately win-record-based rather than title-based
     * like Fighter#getLegacyStage()'s LEGENDE tier (LEGEND_MIN_TITLES) —
     * tools/SimRunner.js's headless coach-AI never books a title fight
     * (setupMatch's isTitle is always false there, a pre-existing,
     * documented limitation — see the report's own methodology notes), so
     * a title-gated bar would induct nobody in every simulated run. Both
     * numbers tuned empirically against the fully-wired system (20 seeds x
     * 1000 seasons, ~2,140 retirees sampled, tools/SimRunner.js's
     * runSimulation()#result.legacy.legendaryFighterRate read directly —
     * an earlier pass calibrated in isolation against raw career win/loss
     * counters read materially higher once engine/LegacyEngine.js's own
     * rng() consumption during retirement started reshuffling every
     * downstream matchmaking/fight roll, so only an end-to-end measurement
     * is trustworthy here) to land the "Legendary Fighter Rate" at ~4.6% of
     * all retirees, comfortably inside the spec's stated 3-6% target band.
     */
    HALL_OF_FAME_MIN_WINS: 125,
    HALL_OF_FAME_MIN_WIN_RATE: 0.76,

    /**
     * Roster coach slots this engine may ever occupy with a reconverted
     * champion at once. A real payroll cost applies to every hired coach
     * (see BALANCE.ECONOMY.SALARIES.COACH_BASE_WEEKLY, deducted weekly by
     * engine/EconomyEngine.js#processWeeklyExpenses) and an insolvency
     * crisis auto-fires the lowest-skill coach first — an unbounded
     * hiring spree across a 1000-season run (hundreds of retirements)
     * would silently drag the gym toward permanent insolvency. Once the
     * cap is reached, further COACH_IN_GYM outcomes are still recorded in
     * telemetry (the retiree's chosen path) but not actually hired.
     */
    MAX_LEGACY_COACHES: 3,

    /**
     * Base relative weights for engine/LegacyEngine.js's weighted-random
     * reconversion pick, before the archetype lean and Hall of Fame
     * multiplier below are applied. Flat (all equal) by design — every
     * lean comes from the fighter's own data, never a scripted default.
     */
    BASE_RECONVERSION_WEIGHTS: { COACH_IN_GYM: 1, PHYSIO: 1, RIVAL_GYM_OWNER: 1, RECRUITER: 1 },

    /**
     * Multiplies the base weights above for a fighter who *did* clear the
     * Hall of Fame bar — a proven champion is far more likely to be
     * courted as a coach or to bankroll their own rival gym than to fade
     * into a quiet Physio role.
     */
    HALL_OF_FAME_RECONVERSION_MULTIPLIER: { COACH_IN_GYM: 2.5, PHYSIO: 0.4, RIVAL_GYM_OWNER: 2, RECRUITER: 0.8 },

    /**
     * Per-archetype multipliers layered on top of BASE_RECONVERSION_WEIGHTS
     * (multiplicative, missing outcomes default to 1 — no lean). Grounded
     * in each archetype's existing BALANCE.PERSONALITY.ARCHETYPES flavor
     * rather than invented fresh: Genie/Leader's real activityWeights lean
     * hardest on VIDEO_PREP (tactical/analytical) -> COACH_IN_GYM; Veteran
     * leans hardest on PHYSIO_REST (understands recovery) -> PHYSIO;
     * Icone/Showman/Mercenaire lean hardest on MEDIA_SPONSORS
     * (networking/promotion-savvy) -> RECRUITER; Guerrier/Predateur lean
     * hardest on SPARRING (competitive drive) -> RIVAL_GYM_OWNER;
     * Phenomene (highest progressionMultiplier, natural talent) leans both
     * COACH_IN_GYM and RIVAL_GYM_OWNER; Cameleon (no strong lean anywhere
     * in its own activityWeights) gets none here either.
     */
    ARCHETYPE_RECONVERSION_LEAN: {
      Guerrier: { RIVAL_GYM_OWNER: 2 },
      Genie: { COACH_IN_GYM: 2.5 },
      Icone: { RECRUITER: 2 },
      Mercenaire: { RECRUITER: 2, RIVAL_GYM_OWNER: 1.5 },
      Leader: { COACH_IN_GYM: 2.5 },
      Showman: { RECRUITER: 2 },
      Predateur: { RIVAL_GYM_OWNER: 2 },
      Veteran: { PHYSIO: 2.5 },
      Phenomene: { COACH_IN_GYM: 1.5, RIVAL_GYM_OWNER: 1.5 },
      Cameleon: {},
    },

    /**
     * Reputation boost applied to an existing rival gym when a retiree
     * reconverts as its new RIVAL_GYM_OWNER (a no-op, still telemetered,
     * if WorldState has no rival gyms at all — see
     * tools/SimRunner.js#seedRivalGyms).
     */
    RIVAL_GYM_OWNER_REPUTATION_BOOST: 8,
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

  // ---------------------------------------------------------------------
  // TELEMETRY — Phase Beta ("Players First"): anonymous local behavioral
  // telemetry thresholds, web/telemetry.js
  // ---------------------------------------------------------------------
  TELEMETRY: {
    /** Fighter.attributes.moral (0-100 scale) below this value counts as "frustratingly low" — the spec's own literal "moral < 20%" threshold. */
    LOW_MORALE_THRESHOLD: 20,
    /** Consecutive resolved weeks a fighter must stay below LOW_MORALE_THRESHOLD before it's logged as a frustration signal — this module's own operationalization of the spec's qualitative "prolonge" (a single bad week is normal variance, not frustration), same spirit as tools/BalanceReporter.js's own CLINCH_TARGETS.STYLE_NEUTRALITY note about picking a reasonable floor when the spec gives no exact number. Edge-triggered: logs once when the streak crosses this bar, not once per week it stays there. */
    LOW_MORALE_STREAK_WEEKS_THRESHOLD: 3,
    /** Max raw entries kept per bounded log (dramaChoices/frustrationEvents) — oldest trimmed, same discipline as WORLD.GLOBAL_EVENT_HISTORY_LIMIT/RELATIONSHIP.HISTORY_LIMIT. */
    LOG_HISTORY_LIMIT: 300,
  },

  // ---------------------------------------------------------------------
  // UNDERGROUND — Underground Circuit, Special Rulesets & Gym-Stipulation
  // Matches (engine/UndergroundEngine.js, engine/GymStipulations.js,
  // engine/CombatEngine.js's optional 5th `rules` param on setupMatch()).
  // ---------------------------------------------------------------------
  UNDERGROUND: {
    ROUNDS: {
      /**
       * Engine-safety cap used whenever a mode/ruleset requests "no round
       * limit" (Vale Tudo) — CombatEngine's state machine and
       * simulateFullMatch()'s own step budget both derive from maxRounds,
       * so a literal Infinity would risk a runaway loop; this is generous
       * enough (3x a normal main event) to read as unlimited in practice
       * while keeping the engine's own safety guarantees intact.
       */
      NO_LIMIT_SAFETY_CAP: 15,
    },

    VALE_TUDO: {
      INJURY_RISK_MULTIPLIER: 3,
      PURSE_MULTIPLIER: 3,
      /**
       * Trait/archetype-driven morale reaction to fighting in an
       * unregulated brawl, applied post-fight to every participant
       * regardless of win/loss (see engine/CombatEngine.js's
       * _processPostMatchRewards). Two of the three concepts the spec
       * names map to real BALANCE.PERSONALITY entries; "Pacifiste" does
       * not exist as a trait or archetype anywhere in this codebase — the
       * closest existing proxy is the Calme trait (low moraleVolatility,
       * composed temperament), used here rather than inventing a new
       * trait outside this phase's scope. See
       * engine/UndergroundEngine.js's own note on this mapping.
       */
      TRAIT_MORALE_DELTA: {
        AGRESSIF: 6,
        SHOWMAN_ARCHETYPE: 6,
        CALME_PACIFISTE_PROXY: -6,
      },
    },

    GAUNTLET: {
      MIN_OPPONENTS: 3,
      MAX_OPPONENTS: 5,
      /** Fraction of the stamina DEFICIT (staminaMax - endingStamina) recovered between consecutive gauntlet fights — a partial breather, not a full reset. */
      STAMINA_RECOVERY_FRACTION: 0.2,
    },

    OPEN_WEIGHT: {
      /**
       * Purse bonus for a genuine underdog win (winner's pre-fight
       * getOverallRating() below the loser's) — the closest honest "David
       * vs Goliath" signal available: no Fighter carries a literal weight
       * stat (identity.weightClass is a display label only, never
       * enforced by matchmaking anywhere in this codebase — see
       * engine/CombatEngine.js's own note), so the rating gap already
       * used by engine/StoryAnalyzer.js's Upset of the Year trophy is
       * reused here rather than inventing a weight number with no
       * gameplay behind it.
       */
      UPSET_BONUS_PER_RATING_POINT: 0.03,
      UPSET_BONUS_MAX_MULTIPLIER: 2,
    },

    SUBMISSION_ONLY: {
      /** Bonus added directly to submission success chance per cumulative point of strike damage the DEFENDER has already taken this fight — "les degats de frappe reduisent la resistance au sol." Kept small: cumulative damage across a whole fight easily reaches 60-100+ points, and BALANCE.COMBAT.SUBMISSIONS.MAX_CHANCE still caps the total. */
      DAMAGE_TO_SUBMISSION_CHANCE_SCALING: 0.0015,
    },

    GYM_STIPULATIONS: {
      COACHS_HONOUR: {
        REPUTATION_WIN_BONUS: 8,
        LOYALTY_WIN_BONUS: 10,
        /** Applied multiplicatively to each roster fighter's CURRENT loyalty (a flat -20 would be disproportionate for a fighter already near 0). */
        LOYALTY_LOSS_FRACTION: 0.2,
      },
      SPONSORSHIP_RAID: {
        WEEKLY_AMOUNT: 2000,
        WEEKS: 10,
      },
    },
  },

  // ---------------------------------------------------------------------
  // RECRUITMENT_MARKET — the permanent, always-open recruitment pool the
  // player can browse from the Effectif tab any week (see
  // engine/DraftEngine.js#generateRecruitmentPool, web/app.js's
  // _showRecruitmentMarketModal) — distinct from ACADEMY_DRAFT's
  // once-a-year FREE pick and from TRANSFER_MARKET's autonomous rival-gym
  // activity: this is the player paying, on demand, any week. A brand new
  // gym starts with ZERO fighters and reaches the Hub directly (no more
  // mandatory "Initial Draft" step) — this market is the only way fighters
  // ever join the roster.
  // ---------------------------------------------------------------------
  RECRUITMENT_MARKET: {
    POOL_SIZE: 6,
    MIN_AGE: 19,
    MAX_AGE: 34,
    BASE_SKILL_MEAN: 30,
    SKILL_SPREAD: 15,
    /** Skill-mean bonus per point of GYM.reputation (0-100) — mirrors ACADEMY_DRAFT's own precedent: a bigger-name gym attracts sharper free-agent talent too. */
    REPUTATION_SKILL_MEAN_BONUS_PER_POINT: 0.15,

    /**
     * Rolled per candidate (highest tier whose minRoll the roll clears
     * wins), same shape/spirit as ACADEMY_DRAFT.POTENTIAL_TIERS — most
     * candidates stay plain PROSPECTs (cheap), a genuine "pepite" is rare
     * and priced accordingly (see COST_GROWTH_PER_RATING_POINT below).
     */
    POTENTIAL_TIERS: {
      PROSPECT: { label: 'Prospect', minRoll: 0, skillMeanBonus: 0 },
      CONFIRME: { label: 'Confirme', minRoll: 0.65, skillMeanBonus: 18 },
      PEPITE: { label: 'Pepite', minRoll: 0.92, skillMeanBonus: 35 },
    },

    /**
     * Signing cost = max(MIN_COST, COST_BASE * COST_GROWTH_PER_RATING_POINT
     * ** Fighter#getOverallRating() * ageMultiplier) — deliberately
     * EXPONENTIAL rather than linear in rating, so cost stays low and flat
     * across ordinary prospects but climbs steeply for a genuine standout:
     * a weak/average prospect (Overall ~15-25) lands around 800$-2000$, a
     * confirmed talent (Overall ~35) around 3000$, and a real pepite/prime
     * veteran (Overall ~50-70+) reaches 5000$-15000$+ — real transfer
     * markets show the same shape (a handful of elite signings cost far
     * more than proportionally to their rating, not a flat per-point rate).
     */
    COST_BASE: 500,
    COST_GROWTH_PER_RATING_POINT: 1.05,
    MIN_COST: 800,
    /** Weekly wage (Fighter#weeklySalary, deducted by engine/EconomyEngine.js) = signing cost * this ratio — scaled to this codebase's actual early-game economy (rent ~800$/week, coach ~300$/week baseline), see engine/EconomyEngine.js's own header note on why BALANCE.ECONOMY.SALARIES.FIGHTER_BASE_WEEKLY's much larger tiers are NOT reused here. */
    SALARY_RATIO_OF_COST: 0.045,
    /**
     * Reuses BALANCE.AGE's own PROSPECT/PEAK/VETERAN/DECLINING age bands
     * (see GROWTH_MULTIPLIER_BY_AGE) as the "potentiel lie a l'age" signal:
     * a young fighter still has room to grow (premium), a fighter past
     * DECLINE_START_AGE is priced as a fading asset (discount).
     */
    AGE_COST_MULTIPLIER: {
      PROSPECT: 1.15,
      PEAK: 1.0,
      VETERAN: 0.85,
      DECLINING: 0.65,
    },
  },

  // ---------------------------------------------------------------------
  // WIN_PROBABILITY — the logistic (Elo-style) pre-fight win estimate
  // exposed by engine/BalanceConfig.js#computeWinProbability, e.g. for a
  // pre-fight odds readout or a balance-validation script. Deliberately a
  // SEPARATE, display/analysis-only estimate — CombatEngine's actual
  // round-by-round simulation (skills/gameplan/stamina/momentum/variance)
  // remains the sole authority over what really happens in a fight; this
  // never feeds back into it.
  // ---------------------------------------------------------------------
  WIN_PROBABILITY: {
    /** P(A beats B) = 1 / (1 + 10 ^ ((OverallB - OverallA) / RATING_DIVISOR)) — the spec's own formula, verbatim (RATING_DIVISOR = 20). */
    RATING_DIVISOR: 20,
  },

  // ---------------------------------------------------------------------
  // PRESS_CONFERENCE — engine/PressConferenceEngine.js's pre-fight stance
  // choice, offered only ahead of a "big fight" (see IS_MAIN_EVENT below) —
  // an ordinary undercard bout never shows this. Applied once, immediately
  // before the fight actually starts.
  // ---------------------------------------------------------------------
  PRESS_CONFERENCE: {
    /** A fight is "Main Event"-eligible for a press conference once EITHER fighter already holds a title (career.titles.length > 0), or the opponent's gym reputation is at/above this GYM.PROMOTION_TIER_REPUTATION_REQUIREMENT tier — reusing the existing promotion-tier scale rather than inventing a parallel one. */
    MAIN_EVENT_REPUTATION_TIER: 'MAJOR_PROMOTION',
    STANCES: {
      RESPECTUEUX: {
        id: 'RESPECTUEUX',
        label: 'Respectueux',
        description: 'Eloges pour l\'adversaire, ton mesure — rien a gagner, rien a perdre.',
        purseMultiplier: 1,
        moraleDelta: 0,
        tensionDelta: 0,
      },
      PROVOCATEUR: {
        id: 'PROVOCATEUR',
        label: 'Provocateur',
        description: 'Trash-talk assume : plus de buzz et de prime, mais la rivalite s\'envenime.',
        /** "+20% la prime/ventes PPV" — applied to this fight's purse (both corners' gross), same shape as CombatEngine's other purse multipliers (League tier, Vale Tudo). */
        purseMultiplier: 1.2,
        moraleDelta: 8,
        /** Added to the WorldState relationship 'tension' gauge between the two fighters. */
        tensionDelta: 15,
      },
      TACTIQUE: {
        id: 'TACTIQUE',
        label: 'Tactique',
        description: "Analyse froide du gameplan adverse — prepare le combat plutot que le buzz.",
        purseMultiplier: 1,
        moraleDelta: 0,
        tensionDelta: 0,
        /** Grants the same pending tactical-prep bonus WEEKLY_PLANNING's own TACTICAL_PREP activity does — see Fighter#preparation.tacticalBonusPending. */
        grantsTacticalPrep: true,
      },
    },
  },

  // ---------------------------------------------------------------------
  // HALL_OF_FAME_BADGES — engine/HallOfFameEngine.js's 20 unlockable
  // achievement badges (BALANCE.HALL_OF_FAME_BADGES, keyed by id). This
  // catalog is DESIGN DATA ONLY (label/description/icon) — unlock
  // conditions themselves live in engine/HallOfFameEngine.js, split into:
  //   - threshold badges, re-evaluated periodically (any state that can be
  //     observed at any moment: money, reputation, roster, titles held...).
  //   - reactive badges, checked once at the moment of a specific
  //     'combat:finished' event (Premier Sang, Upset du Siecle...) since
  //     they depend on a fact only true in that instant (this exact fight's
  //     pre-fight rating gap), not on any lasting state.
  // Once unlocked, a badge is PERMANENT (PlayerState#unlockedBadges only
  // ever grows) — losing the money/roster/etc. that triggered it later
  // never revokes it, matching how real achievements work.
  // ---------------------------------------------------------------------
  HALL_OF_FAME_BADGES: {
    /** Minimum pre-fight OverallRating gap (opponent - own fighter) for a win to count as the reactive UPSET_DU_SIECLE badge — see engine/HallOfFameEngine.js's reactive class. */
    UPSET_RATING_GAP_THRESHOLD: 25,

    CATALOG: {
    PREMIER_SANG: { id: 'PREMIER_SANG', label: 'Premier Sang', description: 'Premiere victoire par finition (KO/TKO/Soumission).', icon: '\u{1FA78}' },
    PREMIERE_SIGNATURE: { id: 'PREMIERE_SIGNATURE', label: 'Premiere Signature', description: 'Premier combattant recrute dans le roster.', icon: '\u{270D}\u{FE0F}' },
    CHAMPION_DU_MONDE: { id: 'CHAMPION_DU_MONDE', label: 'Champion du Monde', description: "Un combattant du roster (ou de legende) a decroche un titre.", icon: '\u{1F451}' },
    DYNASTIE: { id: 'DYNASTIE', label: 'Dynastie', description: 'Un combattant a decroche 3 titres au cours de sa carriere.', icon: '\u{1F3F0}' },
    UPSET_DU_SIECLE: { id: 'UPSET_DU_SIECLE', label: 'Upset du Siecle', description: 'Victoire ecrasante contre un adversaire largement mieux note.', icon: '\u{1F4A5}' },
    MILLIONNAIRE: { id: 'MILLIONNAIRE', label: 'Millionnaire', description: 'Tresorerie de la salle a atteint 1 000 000$.', icon: '\u{1F4B0}' },
    ICONE_MEDIATIQUE: { id: 'ICONE_MEDIATIQUE', label: 'Icone Mediatique', description: 'Le Hype de la salle a atteint son maximum.', icon: '\u{1F4F8}' },
    RESEAU_ETABLI: { id: 'RESEAU_ETABLI', label: 'Reseau Etabli', description: 'Le fil Reseaux a accumule au moins 50 publications.', icon: '\u{1F4F1}' },
    EMPIRE_IMMOBILIER: { id: 'EMPIRE_IMMOBILIER', label: 'Empire Immobilier', description: "La salle a atteint le palier Academie Elite.", icon: '\u{1F3DB}\u{FE0F}' },
    ARSENAL_COMPLET: { id: 'ARSENAL_COMPLET', label: 'Arsenal Complet', description: "Tout le catalogue d'equipements est possede.", icon: '\u{1F6E0}\u{FE0F}' },
    ELITE_MONDIALE: { id: 'ELITE_MONDIALE', label: 'Elite Mondiale', description: 'La salle a atteint le sommet de la pyramide des ligues.', icon: '\u{1F30D}' },
    LEGENDE_VIVANTE: { id: 'LEGENDE_VIVANTE', label: 'Legende Vivante', description: 'Un premier combattant a rejoint le Hall of Fame.', icon: '\u{2728}' },
    DYNASTIE_DE_LEGENDES: { id: 'DYNASTIE_DE_LEGENDES', label: 'Dynastie de Legendes', description: 'Cinq combattants ont rejoint le Hall of Fame.', icon: '\u{1F3DB}\u{FE0F}' },
    PALMARES_DORE: { id: 'PALMARES_DORE', label: 'Palmares Dore', description: 'Un combattant du roster a remporte un trophee de fin de saison.', icon: '\u{1F396}\u{FE0F}' },
    REPUTATION_INTERNATIONALE: { id: 'REPUTATION_INTERNATIONALE', label: 'Reputation Internationale', description: 'Reputation de la salle au maximum.', icon: '\u{1F310}' },
    SALLE_COMBLE: { id: 'SALLE_COMBLE', label: 'Salle Comble', description: 'Effectif au complet par rapport a la capacite du palier actuel.', icon: '\u{1F465}' },
    VENERABLE: { id: 'VENERABLE', label: 'Venerable', description: 'Un combattant encore actif approche l\'age de la retraite forcee.', icon: '\u{1F9D3}' },
    STAFF_COMPLET: { id: 'STAFF_COMPLET', label: 'Staff au Complet', description: 'Les 3 postes de staff specialise sont pourvus.', icon: '\u{1F4CB}' },
    INVAINCU: { id: 'INVAINCU', label: 'Invaincu', description: 'Un combattant a atteint 10 victoires sans defaite.', icon: '\u{1F6E1}\u{FE0F}' },
    ROI_DE_LA_FINITION: { id: 'ROI_DE_LA_FINITION', label: 'Roi de la Finition', description: 'Un combattant a accumule 5 victoires par finition.', icon: '\u{1F94A}' },
    },
  },

  // ---------------------------------------------------------------------
  // GOLDEN_BOOK — WorldState.goldenBook, one auto-engraved recap phrase per
  // season-end (see engine/HallOfFameEngine.js#generateGoldenBookEntry,
  // called from web/app.js's season-boundary Gala flow alongside the
  // pre-existing StoryAnalyzer.analyzeSeason trophy pass).
  // ---------------------------------------------------------------------
  GOLDEN_BOOK: {
    HISTORY_LIMIT: 100,
  },

  // ---------------------------------------------------------------------
  // PHYSICAL — V3.5: real height/weight generation and gendered weight
  // classes (engine/FighterGenerator.js#generatePhysicalProfile), replacing
  // every generator's previous hardcoded `weightClass: 'Poids Welter'`.
  // Men's and women's divisions are kept separately (real MMA promotions
  // run separate weight-class ladders per gender) — see engine/Matchmaking.js
  // for the gender-matching rule this enables.
  // ---------------------------------------------------------------------
  PHYSICAL: {
    GENDERS: Object.freeze(['M', 'F']),

    HEIGHT_CM: {
      M: { MIN: 165, MAX: 200 },
      F: { MIN: 155, MAX: 185 },
    },

    /**
     * Each division's `maxKg` is the real weigh-in limit; `weightKg` is
     * generated a few kg under that cap (fighters walk around heavier than
     * their cut, but always weigh in under the limit) down to the previous
     * division's cap (or a sensible floor for the lightest class).
     */
    WEIGHT_CLASSES: {
      M: [
        { id: 'MOUCHE', label: 'Poids Mouche', maxKg: 56.7 },
        { id: 'COQ', label: 'Poids Coq', maxKg: 61.2 },
        { id: 'PLUME', label: 'Poids Plume', maxKg: 65.8 },
        { id: 'LEGER', label: 'Poids Leger', maxKg: 70.3 },
        { id: 'WELTER', label: 'Poids Welter', maxKg: 77.1 },
        { id: 'MOYEN', label: 'Poids Moyen', maxKg: 83.9 },
        { id: 'MI_LOURD', label: 'Poids Mi-Lourd', maxKg: 93.0 },
        { id: 'LOURD', label: 'Poids Lourd', maxKg: 120.2 },
      ],
      F: [
        { id: 'PAILLE', label: 'Poids Paille', maxKg: 52.2 },
        { id: 'MOUCHE', label: 'Poids Mouche', maxKg: 56.7 },
        { id: 'COQ', label: 'Poids Coq', maxKg: 61.2 },
        { id: 'PLUME', label: 'Poids Plume', maxKg: 65.8 },
      ],
    },

    /** How far under a division's maxKg a generated weigh-in can land. */
    WEIGHT_UNDER_CAP_KG: 6,
  },

  // ---------------------------------------------------------------------
  // MANAGER_BACKGROUNDS — V3.5: a one-time choice at game creation
  // (web/app.js's "Nouvelle Partie" flow), applied exactly once, right
  // after PlayerState is constructed. Each background hands out ONE kind
  // of starting bonus — never combined, the player picks exactly one.
  // ---------------------------------------------------------------------
  MANAGER_BACKGROUNDS: {
    SPONSOR: {
      id: 'SPONSOR',
      label: 'Ancien Sponsor',
      description: 'Un reseau d\'affaires solide : +10 000$ de capital de depart.',
      moneyBonus: 10000,
    },
    FIGHTER: {
      id: 'FIGHTER',
      label: 'Ancien Combattant',
      description: 'Un nom deja connu du public : +15 de Hype de depart.',
      hypeBonus: 15,
    },
    COACH: {
      id: 'COACH',
      label: 'Ancien Grand Coach',
      description: 'Une reputation batie sur des annees de coaching : +10 de Reputation de depart.',
      reputationBonus: 10,
    },
  },

  // ---------------------------------------------------------------------
  // REGIONAL_ORGS — V3.5: which sanctioned promotion the player's gym
  // competes in, picked automatically from the country typed at game
  // creation (see engine/LeagueEngine.js#resolveRegionalOrg). A THIRD,
  // independent orgId concept alongside two that already existed:
  //   - data/leagues.js's LEAGUES: rival-gym purse tiers, by Reputation.
  //   - this file's own LEAGUE_PYRAMID (engine/LeagueEngine.js): the
  //     player's Local/National/Elite promotion/relegation ladder.
  // REGIONAL_ORGS is neither of those — it's simply WHICH orgId string
  // (CombatEngine#setupMatch's 3rd argument, WorldState.orgRanks/
  // orgLadders/titleHolders keys) a sanctioned Combat-tab fight is booked
  // under, purely cosmetic/organizational. None of these three systems
  // read each other.
  // ---------------------------------------------------------------------
  REGIONAL_ORGS: {
    BRAZIL: {
      id: 'BFC',
      label: 'Brazil Fighting Championship',
      countryMatch: ['bresil', 'brésil', 'brazil', 'brasil'],
    },
    EUROPE: {
      id: 'EMC',
      label: 'Euro MMA Circuit',
      countryMatch: [
        'europe', 'france', 'allemagne', 'germany', 'espagne', 'spain', 'italie', 'italy',
        'angleterre', 'england', 'royaume-uni', 'royaume uni', 'uk', 'portugal',
        'pays-bas', 'pays bas', 'netherlands', 'belgique', 'belgium', 'suisse', 'switzerland',
        'irlande', 'ireland', 'pologne', 'poland', 'suede', 'suède', 'sweden',
      ],
    },
    USA: {
      id: 'WFC',
      label: 'World Fighting Championship',
      countryMatch: ['usa', 'etats-unis', 'états-unis', 'united states', 'america', 'us'],
    },
    /** Fallback when the typed country matches no known region — kept as 'WFC' for backward compatibility with every pre-V3.5 save/test fixture. */
    GLOBAL: {
      id: 'WFC',
      label: 'World Fighting Championship',
      countryMatch: [],
    },
  },

  // ---------------------------------------------------------------------
  // COMMUNITY_MANAGER — V3.5: engine/SocialFeedEngine.js's gym-wide
  // subscriber count (TikTok/YouTube-style) and its weekly merchandising
  // income, plus the "filmer les combattants" toggle. Deliberately
  // SEPARATE from this file's own dormant SOCIAL_MEDIA.STARTING_FOLLOWERS/
  // BASE_WEEKLY_GROWTH_PERCENT block above (a PER-FIGHTER follower concept
  // that was planned but never wired to any Fighter field or engine) —
  // COMMUNITY_MANAGER is intentionally GYM-wide instead, tracked on
  // PlayerState#subscribers, and is the only one of the two actually
  // implemented. SOCIAL_MEDIA.FEED_HISTORY_LIMIT/POST_LIKES (consumed by
  // the separate, reactive engine/SocialEngine.js) are untouched.
  // ---------------------------------------------------------------------
  COMMUNITY_MANAGER: {
    STARTING_SUBSCRIBERS: 0,

    /** Flat weekly subscriber growth baseline, before Hype/filming modifiers. */
    BASE_WEEKLY_GROWTH: 40,
    /** Additional weekly growth per point of the gym's current Hype (BALANCE.GYM.HYPE). */
    GROWTH_PER_HYPE_POINT: 6,
    /** Multiplies the WHOLE week's growth (base + Hype-driven) while filming is enabled. */
    FILMING_GROWTH_MULTIPLIER: 2.5,

    /** Weekly merchandising/monetization income per 1000 current subscribers. */
    INCOME_PER_1000_SUBSCRIBERS_WEEKLY: 15,

    /** Applied once per week, per roster fighter carrying the 'Introverti' trait, ONLY while filming is enabled — "fait perdre du moral aux combattants timides/introvertis." */
    FILMING_INTROVERT_MORALE_PENALTY: -6,
  },

  // ---------------------------------------------------------------------
  // MERCATO — V3.5: engine/MercatoEngine.js's three player/rival roster
  // interactions, distinct from the pre-existing autonomous
  // engine/TransferMarket.js (rival gyms managing THEIR OWN rosters, no
  // player or player-roster involvement at all):
  //   - SCOUT: pay to send a scout to a small (low-Reputation) rival club
  //     and unearth fresh rookie prospects to sign.
  //   - BUYOUT: pay a large transfer fee to poach a fighter directly off a
  //     rival gym's roster onto the player's own.
  //   - POACHING: the reverse risk — rival gyms may try to poach the
  //     player's OWN low-Loyalty fighters, weekly.
  // ---------------------------------------------------------------------
  MERCATO: {
    SCOUT: {
      COST: 800,
      /** Only rival gyms at/below this Reputation count as a "petit club" a scout can be sent to. */
      SMALL_CLUB_REPUTATION_MAX: 40,
      ROOKIE_COUNT_MIN: 1,
      ROOKIE_COUNT_MAX: 3,
      ROOKIE_MIN_AGE: 18,
      ROOKIE_MAX_AGE: 23,
      ROOKIE_SKILL_MEAN: 32,
      ROOKIE_SKILL_SPREAD: 14,
    },

    BUYOUT: {
      /** Same exponential shape as RECRUITMENT_MARKET's own signing cost, scaled up sharply — a buyout is a hostile purchase, not a normal signature. */
      MULTIPLIER_OF_RECRUITMENT_COST: 4,
      /** Stacks on top of the above for any fighter holding at least one title. */
      TITLE_HOLDER_EXTRA_MULTIPLIER: 3,
    },

    POACHING: {
      /** A roster fighter below this Loyalty is at risk of being poached each week. */
      LOYALTY_THRESHOLD: 30,
      BASE_WEEKLY_CHANCE: 0.04,
      /** Additional chance per point of Loyalty BELOW the threshold (the lower it is, the more likely). */
      CHANCE_PER_LOYALTY_POINT_BELOW_THRESHOLD: 0.006,
    },

    /**
     * "Debauchage Rival": weekly evaluation of the PLAYER'S OWN roster by
     * rival gyms (see engine/MercatoEngine.js#isRivalTransferTarget/
     * computeRivalTransferValue) — a fighter becomes a bid target once
     * their Hype, win streak, or a title clears one of these bars. Distinct
     * from POACHING above (an automatic Loyalty-driven departure with no
     * player choice) — a rival transfer bid is always a message the
     * manager can Accepter/Refuser/Contre-proposer (see
     * engine/InboxEngine.js's own TRANSFER_BID, BALANCE.INBOX.TRANSFER_BID).
     */
    RIVAL_TRANSFER_TARGET: {
      HYPE_THRESHOLD: 50,
      WIN_STREAK_THRESHOLD: 3,
      /** BaseValue = Overall*OVERALL_MULTIPLIER + Hype*HYPE_MULTIPLIER. */
      OVERALL_MULTIPLIER: 200,
      HYPE_MULTIPLIER: 150,
      /** The "Contre-proposition +25%" inbox action multiplies the original offer by this, with COUNTER_OFFER_ACCEPT_CHANCE odds the rival AI accepts it outright rather than walking away. */
      COUNTER_OFFER_MULTIPLIER: 1.25,
      COUNTER_OFFER_ACCEPT_CHANCE: 0.5,
    },
  },

  // ---------------------------------------------------------------------
  // FIGHT_WEEK — V3.6/V3.7: engine/FightWeekEngine.js's pre-fight-camp/
  // logistics layer, built around the "Fight Launch Contract" — a signed
  // Combat-tab fight is a booking, never simulated instantly. Its date
  // (fightDay) is no longer a random offset picked by this module — since
  // V3.7 it comes straight from whichever Gala the player registered for
  // (see BALANCE.GALA_CIRCUIT / engine/LeagueEngine.js#registerForGala).
  // Between signing and fight day, the gym plans for it week by week:
  //   - CAMP_ORIENTATIONS: a weekly training-camp direction choice for the
  //     booked fighter, applied by FightWeekEngine#applyWeeklyCampOrientation
  //     (called from engine/ProgressionEngine.js#advanceWeek) instead of
  //     the normal Planning-tab weekly slots for that one fighter.
  //   - WEIGHT_CUT_CHOICES: a friendlier 3-tier relabeling of 3 of
  //     BALANCE.WEIGH_IN.PROFILES's existing 4 keys (NATUREL/MODERE/EXTREME
  //     — INTENSIF stays reachable only as a WEIGH_IN profile, not exposed
  //     here) — the SAME underlying weigh-in/missed-weight mechanic
  //     CombatEngine already resolves, just chosen earlier (fight week)
  //     instead of at the old instant pre-fight screen.
  //   - LOGISTICS: a genuinely new one-off transport/hotel choice, paid
  //     for once during fight week, that nudges the booked fighter's
  //     Fatigue/Moral (and so their Readiness, see Fighter#getReadiness())
  //     going into the bout.
  // ---------------------------------------------------------------------
  FIGHT_WEEK: {
    CAMP_ORIENTATIONS: {
      SPARRING_INTENSIF: {
        label: 'Sparring Intensif',
        description: "Rounds intensifs contre les partenaires du gym — muscle la frappe et le sol, coute cher en fatigue physique.",
        skillKeys: ['boxe', 'jambes', 'sol'],
        skillGainPerWeek: 0.5,
        physicalFatiguePerWeek: 9,
        mentalFatiguePerWeek: 1,
      },
      ANALYSE_VIDEO: {
        label: 'Analyse Video',
        description: "Etude de l'adversaire et du gameplan — affute l'intelligence de combat, fatigue surtout mentalement.",
        skillKeys: ['intelligence'],
        skillGainPerWeek: 1.2,
        physicalFatiguePerWeek: 1,
        mentalFatiguePerWeek: 5,
      },
      CARDIO_FOCUS: {
        label: 'Cardio Focus',
        description: "Travail du souffle et de l'endurance — booste le cardio, fatigue modere.",
        skillKeys: ['cardio'],
        skillGainPerWeek: 1.2,
        physicalFatiguePerWeek: 5,
        mentalFatiguePerWeek: 2,
      },
    },
    /** Default orientation a freshly-scheduled fight starts with, until the player picks one. */
    DEFAULT_CAMP_ORIENTATION: 'ANALYSE_VIDEO',

    WEIGHT_CUT_CHOICES: {
      PRUDENT: { label: 'Prudent', profileKey: 'NATUREL', description: 'Pas de coupe de poids agressive — le plus sur, mais laisse le moins de marge de forme.' },
      MODERE: { label: 'Modere', profileKey: 'MODERE', description: 'Une coupe raisonnable — petit risque de pesee manquee, petit gain de forme.' },
      EXTREME: { label: 'Extreme', profileKey: 'EXTREME', description: 'Une coupe extreme — grosse prise de risque sur la pesee, mais le plus de marge de forme si elle passe.' },
    },

    LOGISTICS: {
      ECONOMIQUE: {
        label: 'Economique (low-cost / motel)',
        description: 'Vol low-cost et motel bas de gamme — le moins cher, mais fatigue le combattant et plombe son moral.',
        cost: 300,
        physicalFatigueDelta: 8,
        moraleDelta: -8,
      },
      STANDARD: {
        label: 'Standard (vol direct / hotel 3*)',
        description: 'Vol direct et hotel correct — cout modere, sans impact particulier.',
        cost: 900,
        physicalFatigueDelta: 0,
        moraleDelta: 0,
      },
      LUXE: {
        label: 'Luxe / VIP (vol business / hotel 5*)',
        description: 'Vol Business et hotel 5 etoiles — cher, mais le combattant arrive frais et confiant.',
        cost: 2500,
        physicalFatigueDelta: -8,
        moraleDelta: 10,
      },
    },
  },

  // ---------------------------------------------------------------------
  // GALA_CIRCUIT — V3.7 ("Refonte du Matchmaking par Calendrier de Galas"):
  // engine/LeagueEngine.js's Gala Calendar. Replaces the old "pick a rival
  // gym, hand-pick their fighter" flow — the player now registers a
  // fighter onto an OPEN WEIGHT-CLASS SLOT of an upcoming Gala, and the
  // opponent is drawn automatically from a global pool (a rival gym's
  // roster, or a freshly-generated independent fighter), exactly like a
  // real promotion books its card. A FOURTH, independent orgId concept —
  // same "never read the other three" rule as data/leagues.js's LEAGUES,
  // this file's own LEAGUE_PYRAMID, and REGIONAL_ORGS (see that block's
  // own header note): GALA_CIRCUIT only labels which promotion a booked
  // Combat-tab fight (engine/FightWeekEngine.js's Fight Launch Contract)
  // is fought under — purely organizational, never consulted by
  // resolveRegionalOrg()/getWeightClassRanking()'s own "Classements
  // Officiels" board, which stays tied to REGIONAL_ORGS/country as before.
  //
  // "Underground Circuit" is listed as one of the four organizations here
  // ONLY as a Gala-naming flavor choice for a normal, sanctioned-feeling
  // Fight Launch Contract — it is intentionally NOT wired to the separate,
  // pre-existing instant-challenge Underground Circuit tab/engine
  // (engine/UndergroundEngine.js), which keeps its own distinct identity
  // (no formalities, KO/Soumission only, resolved immediately) untouched.
  // ---------------------------------------------------------------------
  GALA_CIRCUIT: {
    /**
     * V4.0 "Suppression des Conditions de Ligues et Offres par
     * Recrutement": no organization gates entry on Reputation/Overall
     * anymore (V3.9's `eligibility` thresholds and manual "apply" flow are
     * both retired). LOCAL_FIGHTING and UNDERGROUND_CIRCUIT stay
     * unconditionally open (requiresContract: false — the "Circuit Local /
     * Independant" every fighter starts in). ECL/APEX (requiresContract:
     * true) instead reach out to the fighter FIRST: whenever
     * engine/LeagueEngine.js#evaluateLeagueOffers sees this fighter's
     * career.currentWinStreak or the gym's own Hype clear `offerTriggers`'
     * thresholds (either one alone is enough — see that function), the org
     * sends an unsolicited contract offer (models/Fighter.js
     * #receiveLeagueOffer) the manager can accept (acceptLeagueOffer, reads
     * `contract` for the exact terms — fights reserved, purse-per-fight,
     * signing bonus paid immediately, release-clause cost to break early)
     * or decline (declineLeagueOffer) — never something the manager applies
     * for. Once signed, engine/LeagueEngine.js#registerForGala still only
     * accepts that fighter onto ITS OWN organization's galas (any other
     * requiresContract org rejects with LEAGUE_CONTRACT_REQUIRED, any
     * DIFFERENT org the fighter is already bound to rejects with
     * EXCLUSIVITY_CONTRACT_VIOLATION) until FIGHTS_REQUIRED fights are
     * resolved (models/Fighter.js#consumeExclusivityFight auto-clears the
     * contract at 0 remaining) or the release clause is paid
     * (releaseGalaExclusivity/models/Fighter.js#releaseExclusivityContract).
     * `contract.pursePerFight` is a DISPLAY-ONLY figure shown in the offer
     * modal/fighter badge, describing what fighters at that league's level
     * are paid — CombatEngine's own purse math (_computePurses, driven by
     * BALANCE.LEAGUE_PYRAMID's purse multiplier) is deliberately left
     * untouched, preserving this file's long-standing "GALA_CIRCUIT is
     * purely organizational, the 4 orgId concepts never read each other"
     * convention (see this block's own V3.7 header note below).
     */
    ORGANIZATIONS: {
      /** "Circuit Local / Independant" — every fighter's starting standing: always open, no contract, no requirement. */
      LOCAL: { id: 'LOCAL_FIGHTING', label: 'Local Fighting', requiresContract: false },
      /** Same "always open" standing as LOCAL — flavor-only naming distinction, see the V3.7 header note below on Underground Circuit. */
      UNDERGROUND: { id: 'UNDERGROUND_CIRCUIT', label: 'Underground Circuit', requiresContract: false },
      ECL: {
        id: 'ECL',
        label: 'Elite Combat League',
        requiresContract: true,
        /** Sends a contract offer once EITHER threshold is cleared — see engine/LeagueEngine.js#evaluateLeagueOffers. */
        offerTriggers: { winStreak: 2, hype: 30 },
        contract: { fightsRequired: 4, pursePerFight: 8000, signingBonus: 5000, releaseClauseCost: 15000 },
      },
      APEX: {
        id: 'APEX',
        label: 'Apex Championship',
        requiresContract: true,
        offerTriggers: { winStreak: 3, hype: 60 },
        contract: { fightsRequired: 4, pursePerFight: 20000, signingBonus: 15000, releaseClauseCost: 40000 },
      },
    },

    // V3.7 ("Refonte du Matchmaking par Calendrier de Galas"):
    // engine/LeagueEngine.js's Gala Calendar. Replaces the old "pick a rival
    // gym, hand-pick their fighter" flow — the player now registers a
    // fighter onto an OPEN WEIGHT-CLASS SLOT of an upcoming Gala, and the
    // opponent is drawn automatically from a global pool (a rival gym's
    // roster, or a freshly-generated independent fighter), exactly like a
    // real promotion books its card. A FOURTH, independent orgId concept —
    // same "never read the other three" rule as data/leagues.js's LEAGUES,
    // this file's own LEAGUE_PYRAMID, and REGIONAL_ORGS (see that block's
    // own header note): GALA_CIRCUIT only labels which promotion a booked
    // Combat-tab fight (engine/FightWeekEngine.js's Fight Launch Contract)
    // is fought under — purely organizational, never consulted by
    // resolveRegionalOrg()/getWeightClassRanking()'s own "Classements
    // Officiels" board, which stays tied to REGIONAL_ORGS/country as before.
    //
    // "Underground Circuit" is listed as one of the four organizations here
    // ONLY as a Gala-naming flavor choice for a normal, sanctioned-feeling
    // Fight Launch Contract — it is intentionally NOT wired to the separate,
    // pre-existing instant-challenge Underground Circuit tab/engine
    // (engine/UndergroundEngine.js), which keeps its own distinct identity
    // (no formalities, KO/Soumission only, resolved immediately) untouched.

    /** How many upcoming galas the Calendar shows per organization at once. */
    UPCOMING_COUNT_PER_ORG: 3,
    /** Days between one organization's successive galas on the generated calendar. */
    GALA_INTERVAL_DAYS: 14,
    /** The soonest a freshly-listed gala can be, from "today" — gives a genuine "book ahead" feel, independent of BALANCE.FIGHT_WEEK's own camp-length knobs. */
    FIRST_GALA_MIN_DAYS_OUT: 14,

    /** Flavor-only fight-card size range shown per gala — the player only ever books the ONE slot their fighter registers for; the rest is descriptive "+N autres combats" text, never simulated. */
    CARD_SIZE_MIN: 4,
    CARD_SIZE_MAX: 8,

    OPPONENT_POOL: {
      /** Chance the drawn opponent is a freshly-generated "independent" fighter (no gym) rather than pulled from a rival gym's roster — see engine/LeagueEngine.js#drawGalaOpponent. */
      INDEPENDENT_CHANCE: 0.35,
      INDEPENDENT_SKILL_MEAN: 35,
      INDEPENDENT_SKILL_SPREAD: 15,
      INDEPENDENT_MIN_AGE: 20,
      INDEPENDENT_MAX_AGE: 33,
    },
  },

  // ---------------------------------------------------------------------
  // CORNER_COACHING — V3.8: engine/CombatEngine.js's between-round
  // directive system (see setCornerDirective/_getCornerDirectiveMultiplier).
  // Between R1->R2 and R2->R3 (any CORNER_PAUSE that isn't the final one),
  // the player picks one of 4 tactical directives for their own fighter
  // (corner A only — the opponent AI's corner is never player-controlled,
  // same convention as gameplan) that modifies exactly the NEXT round's
  // damage dealt/taken, fatigue cost, takedown chance, and submission
  // chance. A fighter whose Loyalty or Morale has fallen below threshold
  // may refuse the directive outright and keep their prior behavior
  // instead (see REFUSAL below) — every multiplier field mirrors an
  // existing PERKS.DEFINITIONS[*] field name 1:1 (damageMultiplier,
  // damageTakenMultiplier, staminaCostMultiplier, takedownChanceMultiplier,
  // submissionChanceMultiplier) so CombatEngine can read both through the
  // exact same call shape.
  // ---------------------------------------------------------------------
  CORNER_COACHING: {
    DIRECTIVES: {
      ATTAQUER_TOUT_PRIX: {
        label: 'Attaquer a tout prix',
        description: '+20% Degats, +30% Consommation Fatigue, -10% Defense',
        damageMultiplier: 1.2,
        staminaCostMultiplier: 1.3,
        damageTakenMultiplier: 1.1,
        takedownChanceMultiplier: 1,
        submissionChanceMultiplier: 1,
      },
      TRAVAILLER_GRAPPLING: {
        label: 'Travaille le grappling',
        description: '+40% Takedown, +20% Soumission, +10% Fatigue',
        damageMultiplier: 1,
        staminaCostMultiplier: 1.1,
        damageTakenMultiplier: 1,
        takedownChanceMultiplier: 1.4,
        submissionChanceMultiplier: 1.2,
      },
      DEFENDS_TOI: {
        label: 'Defends-toi / Gerer',
        description: '+30% Defense, -10% Consommation Fatigue, -20% Degats',
        damageMultiplier: 0.8,
        staminaCostMultiplier: 0.9,
        damageTakenMultiplier: 0.7,
        takedownChanceMultiplier: 1,
        submissionChanceMultiplier: 1,
      },
      GARDER_GAMEPLAN: {
        label: 'Garder le Gameplan',
        description: 'Aucun modificateur',
        damageMultiplier: 1,
        staminaCostMultiplier: 1,
        damageTakenMultiplier: 1,
        takedownChanceMultiplier: 1,
        submissionChanceMultiplier: 1,
      },
    },

    /**
     * A fighter below EITHER threshold may refuse the chosen directive
     * (rolled at REFUSAL_CHANCE) and keep their prior behavior instead —
     * "Si Loyalty < 35% ou Moral < 40%, appliquer une probabilite que le
     * combattant refuse la directive."
     */
    REFUSAL: {
      LOYALTY_THRESHOLD: 35,
      MORALE_THRESHOLD: 40,
      REFUSAL_CHANCE: 0.35,
    },
  },

  // ---------------------------------------------------------------------
  // INBOX — V4.1 "Centre de Messagerie": PlayerState#inbox, written
  // exclusively by engine/InboxEngine.js#createMessage. Four message
  // categories, three of which are new independent weekly-chance
  // generators added specifically for the inbox (SPONSOR_OFFER,
  // TRANSFER_BID, ROSTER_NEWS below) — deliberately NOT the same code
  // path as the pre-existing, untouched BALANCE.NARRATIVE_EVENTS
  // .SPONSOR_OFFER (engine/EventEngine.js, auto-applies with no player
  // choice) or BALANCE.DRAMA's own weighted-lottery SPONSOR_OFFER choice
  // (engine/DramaEngine.js) — this file's long-standing "never read the
  // other's independent concept" convention (see e.g. GALA_CIRCUIT's own
  // header note) applies here too: the inbox's own sponsor/transfer/roster
  // generators are a separate, additive channel. The fourth category,
  // CONTRACT_OFFER, has no config of its own here — it's created by
  // engine/LeagueEngine.js#evaluateLeagueOffers directly from
  // GALA_CIRCUIT.ORGANIZATIONS[*].offerTriggers/contract (V4.0), which
  // this block does not duplicate.
  // ---------------------------------------------------------------------
  INBOX: {
    /** Max number of messages kept in PlayerState.inbox (oldest entries are trimmed, archived or not) — same precedent as SOCIAL_MEDIA.FEED_HISTORY_LIMIT. */
    MESSAGE_HISTORY_LIMIT: 60,

    SPONSOR_OFFER: {
      WEEKLY_CHANCE: 0.12,
      MIN_AMOUNT: 800,
      MAX_AMOUNT: 4000,
      HYPE_BONUS: 4,
    },

    /** A rival gym proposing to buy one of the player's OWN fighters — the inverse of engine/MercatoEngine.js#buyoutRivalFighter (player buys FROM a rival). Eligibility and BaseValue now come from BALANCE.MERCATO.RIVAL_TRANSFER_TARGET (see engine/MercatoEngine.js#isRivalTransferTarget/computeRivalTransferValue) rather than a flat rating floor. Distinct from POACHING (BALANCE.MERCATO.POACHING, an automatic Loyalty-driven departure with no player choice) — a TRANSFER_BID is always a message the manager can Accepter/Refuser/Contre-proposer. */
    TRANSFER_BID: {
      /** Rolled once per eligible fighter per week. */
      WEEKLY_CHANCE_PER_FIGHTER: 0.03,
    },

    ROSTER_NEWS: {
      /** Below this Loyalty, a fighter's discontent becomes an inbox alert — mirrors CORNER_COACHING.REFUSAL's own LOYALTY_THRESHOLD precedent for "a fighter is unhappy" (35), reused here for consistency rather than inventing a second number. */
      LOW_LOYALTY_THRESHOLD: 35,
      /** "Envie de depart": a fighter whose own Hype (Fighter#attributes.hype, both 0-100) clears the gym's own Reputation by at least this many points has outgrown the gym — a second, independent "wants to leave" trigger alongside LOW_LOYALTY_THRESHOLD above (see engine/InboxEngine.js#evaluateRosterNews / engine/MercatoEngine.js#fighterWantsToLeave, which OR's the two). */
      HYPE_OUTGROWS_GYM_GAP: 30,
    },
  },
};

export default deepFreeze(BALANCE);
export { BALANCE };
