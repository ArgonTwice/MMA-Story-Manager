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
 *   BALANCE.ECONOMY      - money, prices, salaries, gym running costs
 *   BALANCE.INJURIES     - injury chance, severity, recovery time
 *   BALANCE.MORALE       - morale gain/loss events and thresholds
 *   BALANCE.TRAINING     - training camps, drills, gains per session
 *   BALANCE.CONTRACTS    - fighter/staff contract rules
 *   BALANCE.SOCIAL_MEDIA - follower growth, engagement, virality
 *   BALANCE.SPONSORS     - sponsorship offers, payouts, requirements
 *   BALANCE.AGE          - aging curve, peak years, decline
 *   BALANCE.GYM          - facilities, capacity, upgrades
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
  VERSION: '1.0.0',

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
      TKO_DAMAGE_STREAK_THRESHOLD: 3,
      /** Consecutive unanswered power strikes needed to trigger a TKO check. */
      TKO_CHECK_STREAK_LENGTH: 3,
      TKO_CHANCE_PER_CHECK: 0.35,
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
      TAKEDOWN_BASE_SUCCESS_CHANCE: 0.4,
      SKILL_DELTA_CHANCE_SCALING: 0.012,
      MIN_HIT_CHANCE: 0.1,
      MAX_HIT_CHANCE: 0.92,
    },

    /** Judge scoring weights when a fight goes to decision. */
    SCORING: {
      WEIGHT_EFFECTIVE_STRIKES: 0.45,
      WEIGHT_TAKEDOWNS: 0.25,
      WEIGHT_CONTROL_TIME: 0.2,
      WEIGHT_SUBMISSION_ATTEMPTS: 0.1,
      ROUND_WIN_POINTS: 10,
      ROUND_LOSE_POINTS: 9,
      EVEN_ROUND_POINTS: 10,
    },

    /** Randomness envelope applied to every roll to avoid deterministic outcomes. */
    VARIANCE: {
      MIN_ROLL_MULTIPLIER: 0.85,
      MAX_ROLL_MULTIPLIER: 1.15,
      /** Chance of a rare "upset" swing event per round. */
      UPSET_EVENT_CHANCE: 0.05,
      UPSET_EVENT_MULTIPLIER: 1.8,
    },
  },

  // ---------------------------------------------------------------------
  // ECONOMY — currency, prices, salaries, running costs
  // ---------------------------------------------------------------------
  ECONOMY: {
    STARTING_GYM_FUNDS: 25000,

    /** Weekly recurring gym overhead, before facility upgrades add to it. */
    BASE_WEEKLY_UPKEEP: 800,

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
    STARTING_VALUE: 65,

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

    CAMP_TYPES: {
      STRIKING: { primaryAttributes: ['striking', 'accuracy'], intensityFatigueCost: 12 },
      GRAPPLING: { primaryAttributes: ['grappling', 'takedownDefense'], intensityFatigueCost: 12 },
      CARDIO: { primaryAttributes: ['stamina', 'recovery'], intensityFatigueCost: 8 },
      STRENGTH: { primaryAttributes: ['power', 'durability'], intensityFatigueCost: 14 },
      TECHNIQUE: { primaryAttributes: ['iq', 'accuracy'], intensityFatigueCost: 6 },
    },

    /** Fatigue accumulated per training session, recovered via REST. */
    FATIGUE_PER_SESSION_BASE: 10,
    FATIGUE_MAX: 100,
    /** Above this fatigue, injury risk multiplier from INJURIES kicks in at max. */
    OVERTRAINING_FATIGUE_THRESHOLD: 80,

    REST_DAY_FATIGUE_RECOVERY: 25,
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
};

export default deepFreeze(BALANCE);
export { BALANCE };
