/**
 * models/Fighter.js
 * ---------------------------------------------------------------------------
 * Fighter model — a pure data container with deterministic utility methods.
 *
 * Architectural rules this file follows:
 *   - Models depend on Data (balance.js) for every threshold/weight/default
 *     it uses, never on hardcoded numbers ("zero magic numbers").
 *   - Models NEVER depend on EventBus, SaveManager, or any State/Engine
 *     module. A Fighter has no idea it is being saved, rendered, or
 *     simulated. That decoupling is what lets it be unit-tested in
 *     isolation and reused by both PlayerState.roster and rival-gym data.
 *   - Methods here are either pure getters/derived stats (e.g.
 *     getOverallRating) or plain deterministic mutations of this fighter's
 *     own fields (e.g. recordFightResult, applyInjury). Randomness,
 *     matchmaking, and game-rule decisions belong to Engine, which reads
 *     Fighter state and BALANCE, rolls dice, and then calls these setters
 *     with the *result* of that decision.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

/**
 * @typedef {Object} FighterSkills
 * @property {number} boxe
 * @property {number} jambes
 * @property {number} sol
 * @property {number} soumission
 * @property {number} cardio
 * @property {number} intelligence
 */

/**
 * @typedef {Object} FighterAttributes
 * @property {FighterSkills} skills
 * @property {number} forme - Current physical condition (0-100).
 * @property {number} moral - Current morale (0-100).
 */

/**
 * @typedef {Object} FighterPsychology
 * @property {string} personality - Free-form archetype label (e.g. "Showman", "Silent Killer").
 * @property {number} ego
 * @property {number} discipline
 * @property {number} motivation
 */

/**
 * @typedef {Object} FighterCareer
 * @property {number} wins
 * @property {number} losses
 * @property {number} draws
 * @property {number} finishes - Wins by KO/TKO/Submission (subset of wins).
 * @property {string[]} titles - Titles held/won, e.g. ["WFC Lightweight"].
 * @property {('none'|'eligible'|'inducted')} hallOfFameStatus
 */

/**
 * @typedef {Object} FighterContracts
 * @property {Object|null} currentContract - Shape owned by the Contracts system; opaque here.
 * @property {string[]} blacklist - Gym/org ids this fighter refuses to sign with.
 * @property {Object[]} scoutOffers - Pending offers from other gyms/orgs.
 */

/**
 * @typedef {Object} InjuryRecord
 * @property {string} severity - One of BALANCE.INJURIES.RECOVERY_DAYS keys.
 * @property {string} bodyPart
 * @property {number} occurredOnDay
 * @property {number} injuredUntilDay
 */

/**
 * @typedef {Object} FighterMedical
 * @property {number|null} injuredUntil - World day this fighter is clear to compete/train again.
 * @property {InjuryRecord[]} injuriesHistory
 * @property {string[]} chronicIssues - Permanent conditions (e.g. "Bad Left Knee").
 */

let idCounter = 0;
/**
 * Generates a reasonably unique, human-readable id. Not cryptographically
 * unique — fine for a single-player save's in-memory entities.
 * @param {string} prefix
 * @returns {string}
 */
function generateId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * Clamps a numeric attribute to the shared skill bounds defined in BALANCE.
 * @param {number} value
 * @returns {number}
 */
function clampSkill(value) {
  return Math.min(BALANCE.PROGRESSION.SKILL_MAX, Math.max(BALANCE.PROGRESSION.SKILL_MIN, value));
}

function clampMorale(value) {
  return Math.min(BALANCE.MORALE.MAX, Math.max(BALANCE.MORALE.MIN, value));
}

function clampForm(value) {
  return Math.min(BALANCE.FORM.MAX, Math.max(BALANCE.FORM.MIN, value));
}

function clampPsychology(value) {
  return Math.min(BALANCE.PSYCHOLOGY.MAX, Math.max(BALANCE.PSYCHOLOGY.MIN, value));
}

export class Fighter {
  /**
   * @param {Object} [config]
   * @param {Object} [config.identity]
   * @param {Object} [config.attributes]
   * @param {Object} [config.psychology]
   * @param {Object} [config.career]
   * @param {Object} [config.contracts]
   * @param {Object} [config.medical]
   * @param {string[]} [config.perks]
   */
  constructor(config = {}) {
    const skillDefault = BALANCE.PROGRESSION.DEFAULT_STARTING_SKILL_VALUE;

    /** Immutable identity block: who this fighter is. */
    this.identity = {
      id: config.identity?.id ?? generateId('fighter'),
      name: config.identity?.name ?? 'Unnamed Fighter',
      age: config.identity?.age ?? BALANCE.AGE.DEBUT_MIN_AGE,
      style: config.identity?.style ?? 'Freestyle',
      weightClass: config.identity?.weightClass ?? 'Lightweight',
      bio: config.identity?.bio ?? '',
      origin: config.identity?.origin ?? '',
    };

    /** Combat skills + current condition/morale. */
    this.attributes = {
      skills: {
        boxe: clampSkill(config.attributes?.skills?.boxe ?? skillDefault),
        jambes: clampSkill(config.attributes?.skills?.jambes ?? skillDefault),
        sol: clampSkill(config.attributes?.skills?.sol ?? skillDefault),
        soumission: clampSkill(config.attributes?.skills?.soumission ?? skillDefault),
        cardio: clampSkill(config.attributes?.skills?.cardio ?? skillDefault),
        intelligence: clampSkill(config.attributes?.skills?.intelligence ?? skillDefault),
      },
      forme: clampForm(config.attributes?.forme ?? BALANCE.FORM.STARTING_VALUE),
      moral: clampMorale(config.attributes?.moral ?? BALANCE.MORALE.STARTING_VALUE),
    };

    /** Mental profile driving training gains and narrative events. */
    this.psychology = {
      personality: config.psychology?.personality ?? 'Balanced',
      ego: clampPsychology(config.psychology?.ego ?? BALANCE.PSYCHOLOGY.STARTING_VALUES.ego),
      discipline: clampPsychology(
        config.psychology?.discipline ?? BALANCE.PSYCHOLOGY.STARTING_VALUES.discipline
      ),
      motivation: clampPsychology(
        config.psychology?.motivation ?? BALANCE.PSYCHOLOGY.STARTING_VALUES.motivation
      ),
    };

    /** Career record. */
    this.career = {
      wins: config.career?.wins ?? 0,
      losses: config.career?.losses ?? 0,
      draws: config.career?.draws ?? 0,
      finishes: config.career?.finishes ?? 0,
      titles: config.career?.titles ? [...config.career.titles] : [],
      hallOfFameStatus: config.career?.hallOfFameStatus ?? 'none',
    };

    /** Business relationships. */
    this.contracts = {
      currentContract: config.contracts?.currentContract ?? null,
      blacklist: config.contracts?.blacklist ? [...config.contracts.blacklist] : [],
      scoutOffers: config.contracts?.scoutOffers ? [...config.contracts.scoutOffers] : [],
    };

    /** Health record. */
    this.medical = {
      injuredUntil: config.medical?.injuredUntil ?? null,
      injuriesHistory: config.medical?.injuriesHistory ? [...config.medical.injuriesHistory] : [],
      chronicIssues: config.medical?.chronicIssues ? [...config.medical.chronicIssues] : [],
    };

    /** Unlocked traits (e.g. "Iron Chin", "Killer Instinct"). Plain id strings. */
    this.perks = config.perks ? [...config.perks] : [];

    /**
     * This week's training plan, consumed by engine/TrainingEngine.js.
     * focus is one of attributes.skills' keys (or null = not configured,
     * treated as resting). intensity is one of
     * Object.keys(BALANCE.TRAINING.INTENSITY_MODIFIERS).
     */
    this.training = {
      focus: config.training?.focus ?? null,
      intensity: config.training?.intensity ?? 'NORMAL',
    };
  }

  // ---- derived stats ------------------------------------------------------

  /**
   * Weighted composite of the six skills (0-100), then adjusted by the
   * fighter's current form/morale using the same thresholds combat/training
   * use, so a burnt-out or demoralized fighter reads as weaker everywhere.
   * @returns {number} Rounded to 1 decimal place.
   */
  getOverallRating() {
    const { skills } = this.attributes;
    const weights = BALANCE.PROGRESSION.OVERALL_RATING_WEIGHTS;

    const base = Object.keys(weights).reduce(
      (total, skillKey) => total + skills[skillKey] * weights[skillKey],
      0
    );

    const { LOW, HIGH, LOW_PERFORMANCE_MULTIPLIER, HIGH_PERFORMANCE_MULTIPLIER } =
      BALANCE.MORALE.THRESHOLDS;

    let performanceMultiplier = 1;
    if (this.attributes.moral <= LOW) {
      performanceMultiplier = LOW_PERFORMANCE_MULTIPLIER;
    } else if (this.attributes.moral >= HIGH) {
      performanceMultiplier = HIGH_PERFORMANCE_MULTIPLIER;
    }

    const formMultiplier = this.attributes.forme / BALANCE.FORM.MAX;

    const rating = base * performanceMultiplier * formMultiplier;
    return Math.round(Math.min(BALANCE.PROGRESSION.SKILL_MAX, rating) * 10) / 10;
  }

  /**
   * Win/Loss/Draw as a compact record string, e.g. "12-3-1".
   * @returns {string}
   */
  getRecordString() {
    return `${this.career.wins}-${this.career.losses}-${this.career.draws}`;
  }

  /**
   * @returns {number} Win rate in [0, 1]. Returns 0 if no fights recorded.
   */
  getWinRate() {
    const total = this.career.wins + this.career.losses + this.career.draws;
    return total === 0 ? 0 : this.career.wins / total;
  }

  /**
   * @returns {boolean} True once the fighter has voluntarily reached the
   * age where retirement becomes a possibility (see BALANCE.AGE.RETIREMENT).
   * This does not mean they WILL retire — Engine rolls that chance yearly.
   */
  isRetirementEligible() {
    return this.identity.age >= BALANCE.AGE.RETIREMENT.MIN_CONSIDERATION_AGE;
  }

  /**
   * @returns {boolean} True once the fighter must retire regardless of
   * player/AI choice.
   */
  isForcedRetirement() {
    return this.identity.age >= BALANCE.AGE.RETIREMENT.FORCED_RETIREMENT_AGE;
  }

  /**
   * @param {number} currentDay - WorldState.currentDay to check against.
   * @returns {boolean} True if the fighter is currently out injured.
   */
  isInjured(currentDay) {
    return this.medical.injuredUntil !== null && currentDay < this.medical.injuredUntil;
  }

  /**
   * @returns {boolean} True if the fighter currently holds at least one title.
   */
  isChampion() {
    return this.career.titles.length > 0;
  }

  /**
   * @param {string} perkId
   * @returns {boolean}
   */
  hasPerk(perkId) {
    return this.perks.includes(perkId);
  }

  // ---- mutations (deterministic, no RNG) -----------------------------------

  /**
   * Records the outcome of a completed fight in the career stats.
   * The caller (Engine) is responsible for resolving the fight itself;
   * this method only updates bookkeeping.
   *
   * @param {Object} result
   * @param {('win'|'loss'|'draw')} result.outcome
   * @param {boolean} [result.byFinish=false] - KO/TKO/Submission rather than decision.
   * @param {string} [result.titleWon] - Title name, if this win captured a title.
   */
  recordFightResult({ outcome, byFinish = false, titleWon }) {
    if (outcome === 'win') {
      this.career.wins += 1;
      if (byFinish) this.career.finishes += 1;
      if (titleWon && !this.career.titles.includes(titleWon)) {
        this.career.titles.push(titleWon);
      }
    } else if (outcome === 'loss') {
      this.career.losses += 1;
    } else if (outcome === 'draw') {
      this.career.draws += 1;
    } else {
      throw new TypeError(`Fighter.recordFightResult: unknown outcome "${outcome}".`);
    }
  }

  /**
   * Records an injury already resolved by Engine (severity/duration rolled
   * against BALANCE.INJURIES there). Pure bookkeeping — no dice rolled here.
   *
   * @param {Object} injury
   * @param {string} injury.severity - Matches a BALANCE.INJURIES.RECOVERY_DAYS key.
   * @param {string} injury.bodyPart
   * @param {number} injury.occurredOnDay
   * @param {number} injury.injuredUntilDay
   * @param {boolean} [injury.isChronic=false]
   */
  applyInjury({ severity, bodyPart, occurredOnDay, injuredUntilDay, isChronic = false }) {
    this.medical.injuriesHistory.push({ severity, bodyPart, occurredOnDay, injuredUntilDay });
    this.medical.injuredUntil = injuredUntilDay;
    if (isChronic && !this.medical.chronicIssues.includes(bodyPart)) {
      this.medical.chronicIssues.push(bodyPart);
    }
  }

  /**
   * Clears the current injury (e.g. fully healed, or a medical exemption).
   */
  clearInjury() {
    this.medical.injuredUntil = null;
  }

  /**
   * @param {string} perkId
   * @returns {boolean} True if the perk was newly added, false if already present.
   */
  addPerk(perkId) {
    if (this.hasPerk(perkId)) return false;
    this.perks.push(perkId);
    return true;
  }

  /**
   * Applies a raw delta to one skill, clamped to BALANCE bounds. Used by
   * Engine after computing a training/decline amount from BALANCE.TRAINING
   * or BALANCE.AGE — this method never invents the amount itself.
   *
   * @param {keyof FighterSkills} skillKey
   * @param {number} delta
   */
  adjustSkill(skillKey, delta) {
    if (!(skillKey in this.attributes.skills)) {
      throw new TypeError(`Fighter.adjustSkill: unknown skill "${skillKey}".`);
    }
    this.attributes.skills[skillKey] = clampSkill(this.attributes.skills[skillKey] + delta);
  }

  /**
   * @param {number} delta
   */
  adjustMorale(delta) {
    this.attributes.moral = clampMorale(this.attributes.moral + delta);
  }

  /**
   * @param {number} delta
   */
  adjustForm(delta) {
    this.attributes.forme = clampForm(this.attributes.forme + delta);
  }

  /**
   * Advances the fighter's age, e.g. on their in-world birthday
   * (see engine/ProgressionEngine.js). Physical decline itself is handled
   * weekly by engine/TrainingEngine.js based on the resulting age.
   *
   * @param {number} [years=1]
   * @returns {number} The fighter's new age.
   */
  incrementAge(years = 1) {
    this.identity.age += years;
    return this.identity.age;
  }

  /**
   * Sets (part of) this week's training plan, consumed by
   * engine/TrainingEngine.js. Only provided fields are changed.
   *
   * @param {Object} plan
   * @param {string|null} [plan.focus] - One of attributes.skills' keys, or
   *   null to clear it (treated as resting).
   * @param {string} [plan.intensity] - One of
   *   Object.keys(BALANCE.TRAINING.INTENSITY_MODIFIERS).
   * @returns {Object} The resulting training plan.
   */
  setTrainingPlan({ focus, intensity } = {}) {
    if (focus !== undefined) {
      if (focus !== null && !(focus in this.attributes.skills)) {
        throw new TypeError(`Fighter.setTrainingPlan: invalid focus "${focus}".`);
      }
      this.training.focus = focus;
    }
    if (intensity !== undefined) {
      if (!(intensity in BALANCE.TRAINING.INTENSITY_MODIFIERS)) {
        throw new TypeError(`Fighter.setTrainingPlan: invalid intensity "${intensity}".`);
      }
      this.training.intensity = intensity;
    }
    return { ...this.training };
  }

  // ---- serialization --------------------------------------------------------

  /**
   * @returns {Object} A plain, JSON-serializable snapshot of this fighter.
   */
  toJSON() {
    return {
      identity: { ...this.identity },
      attributes: {
        skills: { ...this.attributes.skills },
        forme: this.attributes.forme,
        moral: this.attributes.moral,
      },
      psychology: { ...this.psychology },
      career: { ...this.career, titles: [...this.career.titles] },
      contracts: {
        currentContract: this.contracts.currentContract,
        blacklist: [...this.contracts.blacklist],
        scoutOffers: [...this.contracts.scoutOffers],
      },
      medical: {
        injuredUntil: this.medical.injuredUntil,
        injuriesHistory: [...this.medical.injuriesHistory],
        chronicIssues: [...this.medical.chronicIssues],
      },
      perks: [...this.perks],
      training: { ...this.training },
    };
  }

  /**
   * Rebuilds a Fighter instance from a toJSON() snapshot (or any
   * plain object with the same shape, e.g. loaded from SaveManager).
   * @param {Object} data
   * @returns {Fighter}
   */
  static fromJSON(data) {
    return new Fighter(data ?? {});
  }
}

export default Fighter;
