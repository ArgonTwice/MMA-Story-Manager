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
import { NICKNAME_RULES } from '../data/nicknames.js';

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
 * @typedef {Object} FighterPersonality
 * @property {string} archetype - One of Object.keys(BALANCE.PERSONALITY.ARCHETYPES).
 *   Set once at creation and immutable thereafter — there is no setter.
 * @property {string[]} traits - Zero or more of Object.keys(BALANCE.PERSONALITY.TRAITS).
 *   Unlike archetype, may change over a career (see addTrait/removeTrait).
 */

/**
 * @typedef {Object} FighterPsychology
 * @property {FighterPersonality} personality
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
 * @property {number} koWins - Phase 4.2: wins by KO specifically (subset of finishes).
 * @property {number} tkoWins - Phase 4.2: wins by TKO or doctor stoppage (subset of finishes).
 * @property {number} submissionWins - Phase 4.2: wins by submission (subset of finishes).
 * @property {number} decisionWins - Phase 4.2: wins by judges' decision (wins - finishes).
 * @property {number} comebackWins - Phase 4.2: wins where this fighter was out-struck on
 *   raw damage yet still won (see CombatEngine#_processPostMatchRewards's comeback flag).
 * @property {number} currentWinStreak - Phase 4.2: consecutive wins, reset by a loss or draw.
 * @property {number} longestWinStreak - Phase 4.2: this career's best currentWinStreak ever reached.
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

function clampPhysicalFatigue(value) {
  return Math.min(BALANCE.PHYSICAL_FATIGUE.MAX, Math.max(BALANCE.PHYSICAL_FATIGUE.MIN, value));
}

function clampMentalFatigue(value) {
  return Math.min(BALANCE.MENTAL_FATIGUE.MAX, Math.max(BALANCE.MENTAL_FATIGUE.MIN, value));
}

function clampReadiness(value) {
  return Math.min(BALANCE.READINESS.MAX, Math.max(BALANCE.READINESS.MIN, value));
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
      /** Phase 4.2: emergent nickname, earned automatically from career deeds. See evaluateNickname()/data/nicknames.js. Null until earned. */
      nickname: config.identity?.nickname ?? null,
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
      /** Phase 3.1 v1/v2: weekly-persisted physical load, spent/recovered by WEEKLY_PLANNING activities. See getReadiness(). */
      physicalFatigue: clampPhysicalFatigue(config.attributes?.physicalFatigue ?? BALANCE.PHYSICAL_FATIGUE.STARTING_VALUE),
      /** Phase 3.1 v2: weekly-persisted cognitive/promotional load — "Charge Mentale", spent by VIDEO_PREP/MEDIA_SPONSORS. See getReadiness(). */
      mentalFatigue: clampMentalFatigue(config.attributes?.mentalFatigue ?? BALANCE.MENTAL_FATIGUE.STARTING_VALUE),
    };

    const archetype = config.psychology?.personality?.archetype ?? BALANCE.PERSONALITY.DEFAULT_ARCHETYPE;
    if (!(archetype in BALANCE.PERSONALITY.ARCHETYPES)) {
      throw new TypeError(`Fighter: invalid personality archetype "${archetype}".`);
    }
    const traits = config.psychology?.personality?.traits ?? [];
    for (const trait of traits) {
      if (!(trait in BALANCE.PERSONALITY.TRAITS)) {
        throw new TypeError(`Fighter: invalid personality trait "${trait}".`);
      }
    }

    /** Mental profile driving training gains and narrative events. */
    this.psychology = {
      personality: {
        // Immutable by convention: no method on this class ever reassigns it.
        archetype,
        traits: [...new Set(traits)],
      },
      ego: clampPsychology(config.psychology?.ego ?? BALANCE.PSYCHOLOGY.STARTING_VALUES.ego),
      discipline: clampPsychology(
        config.psychology?.discipline ?? BALANCE.PSYCHOLOGY.STARTING_VALUES.discipline
      ),
      motivation: clampPsychology(
        config.psychology?.motivation ?? BALANCE.PSYCHOLOGY.STARTING_VALUES.motivation
      ),
      /** Phase 4.6: relationship/loyalty with the current gym, 0-100 — see adjustLoyalty(). Mutable, unlike ego/discipline/motivation which are set once at creation. */
      loyalty: clampPsychology(config.psychology?.loyalty ?? BALANCE.PSYCHOLOGY.STARTING_VALUES.loyalty),
    };

    /** Career record. */
    this.career = {
      wins: config.career?.wins ?? 0,
      losses: config.career?.losses ?? 0,
      draws: config.career?.draws ?? 0,
      finishes: config.career?.finishes ?? 0,
      /** Phase 4.2: finish-method breakdown, subsets of finishes (koWins + tkoWins + submissionWins === finishes). Feeds evaluateNickname(). */
      koWins: config.career?.koWins ?? 0,
      tkoWins: config.career?.tkoWins ?? 0,
      submissionWins: config.career?.submissionWins ?? 0,
      /** Phase 4.2: wins - finishes, tracked directly rather than derived on read. */
      decisionWins: config.career?.decisionWins ?? 0,
      /** Phase 4.2: see evaluateNickname()'s PHOENIX rule / CombatEngine's comeback flag. */
      comebackWins: config.career?.comebackWins ?? 0,
      currentWinStreak: config.career?.currentWinStreak ?? 0,
      longestWinStreak: config.career?.longestWinStreak ?? 0,
      titles: config.career?.titles ? [...config.career.titles] : [],
      hallOfFameStatus: config.career?.hallOfFameStatus ?? 'none',
      /** Phase 4.6: one row per (year, orgId) this fighter fought in — see recordFightResult()'s seasonContext param. Empty until this fighter's first tracked fight. */
      seasonHistory: config.career?.seasonHistory ? config.career.seasonHistory.map((row) => ({ ...row })) : [],
      /** Phase V2.6 ("Story Analyzer"): permanent record of every end-of-season Gala trophy this fighter has ever won — see addTrophy()/engine/StoryAnalyzer.js. */
      trophies: config.career?.trophies ? config.career.trophies.map((trophy) => ({ ...trophy })) : [],
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

    /**
     * Phase 3.1 v1: this week's 3-slot weekly plan, consumed by
     * engine/WeeklyPlanningEngine.js#processWeeklyPlan. Each entry is one of
     * Object.keys(BALANCE.WEEKLY_PLANNING.ACTIVITIES), or null (empty slot,
     * no-op). Independent of the legacy training.focus/intensity field
     * above — TrainingEngine.js and this field are two separate weekly
     * resolution paths that are never both driven for the same fighter in
     * the same run (see tools/SimRunner.js).
     */
    this.weeklyPlan = {
      slots: config.weeklyPlan?.slots
        ? [...config.weeklyPlan.slots]
        : new Array(BALANCE.WEEKLY_PLANNING.SLOTS_PER_WEEK).fill(null),
    };

    /**
     * Phase 3.1 v1: inputs to getReadiness() that aren't the raw Fatigue
     * gauge itself. tacticalBonusPending is set by a resolved VIDEO_PREP
     * slot and consumed (cleared) at this fighter's next weigh-in (see
     * clearTacticalPrep() / CombatEngine#_processWeighIn). weeklyCharge is
     * a plain snapshot of this week's total Charge (see
     * WEEKLY_PLANNING.ACTIVITIES[*].charge), overwritten every week by
     * processWeeklyPlan — not a consume-once flag like tacticalBonusPending.
     */
    this.preparation = {
      tacticalBonusPending: config.preparation?.tacticalBonusPending ?? false,
      weeklyCharge: config.preparation?.weeklyCharge ?? 0,
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
   * Weighted composite of the six skills for a given combat distance, using
   * the exact same weights CombatEngine itself uses to resolve a round at
   * that distance (see BALANCE.COMBAT.GAMEPLAN.DISTANCE_SKILL_WEIGHTS) — a
   * genuine technical-profile reading, not an invented stat. Unlike
   * getOverallRating(), this is NOT adjusted by current form/moral: it
   * describes trained ability, not momentary condition (already covered
   * separately by getReadiness()).
   * @param {('STRIKING'|'CLINCH'|'GROUND')} distanceKey
   * @returns {number} 0-100, rounded to the nearest integer.
   */
  getDistanceRating(distanceKey) {
    const weights = BALANCE.COMBAT.GAMEPLAN.DISTANCE_SKILL_WEIGHTS[distanceKey];
    if (!weights) {
      throw new TypeError(`Fighter.getDistanceRating: invalid distance "${distanceKey}".`);
    }
    const { skills } = this.attributes;
    const rating = Object.keys(weights).reduce((total, skillKey) => total + skills[skillKey] * weights[skillKey], 0);
    return Math.round(Math.min(BALANCE.PROGRESSION.SKILL_MAX, rating));
  }

  /**
   * Phase 3.1 v1/v2: the single combat-readiness gauge CombatEngine reads
   * instead of either Fatigue gauge directly (see BALANCE.READINESS's doc
   * comment for the formula's rationale and which coefficients are this
   * implementation's own chosen defaults vs. spec-given).
   *
   * Readiness = 100 - (PHYSICAL_FATIGUE_WEIGHT * PhysicalFatigue +
   *                     MENTAL_FATIGUE_WEIGHT * MentalFatigue)
   *             + MoralModifier + TacticalBonus - InjuryRisk,
   * clamped to [READINESS.MIN, READINESS.MAX].
   *
   * @returns {number}
   */
  getReadiness() {
    const r = BALANCE.READINESS;
    const blendedFatigue =
      r.PHYSICAL_FATIGUE_WEIGHT * this.attributes.physicalFatigue + r.MENTAL_FATIGUE_WEIGHT * this.attributes.mentalFatigue;
    const moralModifier = (this.attributes.moral - BALANCE.MORALE.NEUTRAL_VALUE) * r.MORAL_MODIFIER_SCALE;
    const tacticalBonus = this.preparation.tacticalBonusPending ? r.TACTICAL_BONUS_POINTS : 0;
    const injuryRisk = this.preparation.weeklyCharge * r.INJURY_RISK_PER_CHARGE_POINT;
    const raw = 100 - blendedFatigue + moralModifier + tacticalBonus - injuryRisk;
    return clampReadiness(raw);
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

  /**
   * @param {string} trait - One of Object.keys(BALANCE.PERSONALITY.TRAITS).
   * @returns {boolean}
   */
  hasTrait(trait) {
    return this.psychology.personality.traits.includes(trait);
  }

  /**
   * Narrative maturity classification, computed fresh from current career
   * data every call (never stored) — see BALANCE.LEGACY for thresholds.
   * Monotonic in spirit: once a fighter has won a title their legacy never
   * reads back below CHAMPION, even if they later lose the belt.
   *
   * @returns {('ESPOIR'|'PROSPECT'|'VETERAN'|'CHAMPION'|'LEGENDE'|'HALL_OF_FAME')}
   */
  getLegacyStage() {
    const legacy = BALANCE.LEGACY;
    const totalFights = this.career.wins + this.career.losses + this.career.draws;

    if (this.career.hallOfFameStatus === 'inducted') return 'HALL_OF_FAME';

    if (
      this.career.titles.length >= legacy.LEGEND_MIN_TITLES &&
      this.career.wins >= legacy.LEGEND_MIN_WINS
    ) {
      return 'LEGENDE';
    }

    if (this.career.titles.length > 0) return 'CHAMPION';

    if (totalFights >= legacy.VETERAN_MIN_FIGHTS || this.identity.age >= legacy.VETERAN_MIN_AGE) {
      return 'VETERAN';
    }

    if (totalFights >= legacy.PROSPECT_MIN_FIGHTS) return 'PROSPECT';

    return 'ESPOIR';
  }

  // ---- mutations (deterministic, no RNG) -----------------------------------

  /**
   * Records the outcome of a completed fight in the career stats.
   * The caller (Engine) is responsible for resolving the fight itself;
   * this method only updates bookkeeping — including, since Phase 4.2,
   * refreshing the fighter's emergent nickname (see evaluateNickname()).
   *
   * @param {Object} result
   * @param {('win'|'loss'|'draw')} result.outcome
   * @param {boolean} [result.byFinish=false] - KO/TKO/Submission rather than decision.
   * @param {string} [result.finishMethod] - Phase 4.2: the raw finish method string
   *   (e.g. CombatEngine's FINISH_METHODS.KO/TKO/SUBMISSION/DOCTOR_STOPPAGE) when
   *   byFinish is true, used only to classify koWins/tkoWins/submissionWins — plain
   *   string comparison rather than importing CombatEngine's enum (Models never
   *   depend on Engine, see this file's header).
   * @param {string} [result.titleWon] - Title name, if this win captured a title.
   * @param {boolean} [result.comeback=false] - Phase 4.2: true if this win came
   *   despite this fighter being out-struck on raw damage (see
   *   CombatEngine#_processPostMatchRewards) — feeds the PHOENIX nickname rule.
   * @param {Object} [result.seasonContext] - Phase 4.6: when provided, also
   *   upserts a career.seasonHistory row for { year, orgId } — omitted by
   *   most call sites (e.g. direct model tests) that don't care about the
   *   season-by-season career table, so this stays fully backward-compatible.
   * @param {number} [result.seasonContext.year] - WorldState.year at fight time.
   * @param {string} [result.seasonContext.orgId] - The promotion the fight was booked under.
   */
  recordFightResult({ outcome, byFinish = false, finishMethod, titleWon, comeback = false, seasonContext = null }) {
    if (outcome === 'win') {
      this.career.wins += 1;
      if (byFinish) {
        this.career.finishes += 1;
        if (finishMethod === 'KO') this.career.koWins += 1;
        else if (finishMethod === 'TKO' || finishMethod === 'DOCTOR_STOPPAGE') this.career.tkoWins += 1;
        else if (finishMethod === 'SUBMISSION') this.career.submissionWins += 1;
      } else {
        this.career.decisionWins += 1;
      }
      if (comeback) this.career.comebackWins += 1;
      this.career.currentWinStreak += 1;
      this.career.longestWinStreak = Math.max(this.career.longestWinStreak, this.career.currentWinStreak);
      if (titleWon && !this.career.titles.includes(titleWon)) {
        this.career.titles.push(titleWon);
      }
    } else if (outcome === 'loss') {
      this.career.losses += 1;
      this.career.currentWinStreak = 0;
    } else if (outcome === 'draw') {
      this.career.draws += 1;
      this.career.currentWinStreak = 0;
    } else {
      throw new TypeError(`Fighter.recordFightResult: unknown outcome "${outcome}".`);
    }

    if (seasonContext) {
      this._recordSeasonHistory(seasonContext, { outcome, byFinish, finishMethod });
    }

    this.evaluateNickname();
  }

  /**
   * Upserts the career.seasonHistory row for { year, orgId }, creating it on
   * this fighter's first tracked fight of that year/org. Groups KO/TKO/
   * Doctor Stoppage together as "koWins" (mirrors the lifetime koWins+tkoWins
   * grouping evaluateNickname() and the mobile profile's KO/Subs column both
   * use) and Submission separately as "subWins".
   * @param {{ year: number, orgId: string }} seasonContext
   * @param {{ outcome: string, byFinish: boolean, finishMethod: string|undefined }} result
   */
  _recordSeasonHistory({ year, orgId }, { outcome, byFinish, finishMethod }) {
    let row = this.career.seasonHistory.find((entry) => entry.year === year && entry.orgId === orgId);
    if (!row) {
      row = { year, orgId, wins: 0, losses: 0, draws: 0, koWins: 0, subWins: 0 };
      this.career.seasonHistory.push(row);
    }

    if (outcome === 'win') {
      row.wins += 1;
      if (byFinish) {
        if (finishMethod === 'KO' || finishMethod === 'TKO' || finishMethod === 'DOCTOR_STOPPAGE') row.koWins += 1;
        else if (finishMethod === 'SUBMISSION') row.subWins += 1;
      }
    } else if (outcome === 'loss') {
      row.losses += 1;
    } else if (outcome === 'draw') {
      row.draws += 1;
    }
  }

  /**
   * Phase V2.6 ("Story Analyzer & Gala de Fin de Saison"): permanently
   * records an end-of-season trophy this fighter won, so it keeps showing
   * up in their profile's Palmares in every future season, not just the
   * one it was awarded — see engine/StoryAnalyzer.js.
   * @param {Object} trophy
   * @param {string} trophy.category - One of engine/StoryAnalyzer.js's TROPHY_CATEGORIES.
   * @param {string} trophy.label - Display label, e.g. "Upset de l'Annee".
   * @param {number} trophy.year - The WorldState.year it was awarded for.
   */
  addTrophy(trophy) {
    this.career.trophies.push({ ...trophy });
  }

  /**
   * Phase 4.2 ("Surnoms Emergents"): re-checks every rule in
   * data/nicknames.js#NICKNAME_RULES against this fighter's current career
   * counters, and adopts the highest-priority matching rule's label. Since
   * every counter NICKNAME_RULES reads is monotonically non-decreasing over
   * a career (see recordFightResult), a nickname is never un-earned — this
   * can only ever replace it with a higher-priority one, or leave it as-is.
   * Called automatically at the end of recordFightResult(); exposed
   * publicly for tests/tools that want to force a re-check without another
   * fight (e.g. after directly restoring career counters from a save).
   *
   * @returns {string|null} The resulting nickname (unchanged if no rule matches).
   */
  evaluateNickname() {
    let best = null;
    for (const rule of NICKNAME_RULES) {
      if ((this.career[rule.statKey] ?? 0) >= rule.minValue) {
        if (!best || rule.priority > best.priority) best = rule;
      }
    }
    if (best) this.identity.nickname = best.label;
    return this.identity.nickname;
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
   * Adds a personality trait gained over the course of a career (e.g. a
   * narrative beat turning a fighter into a Provocateur). The archetype
   * itself is never touched — only traits[] is mutable.
   *
   * @param {string} trait - One of Object.keys(BALANCE.PERSONALITY.TRAITS).
   * @returns {boolean} True if newly added, false if already present.
   */
  addTrait(trait) {
    if (!(trait in BALANCE.PERSONALITY.TRAITS)) {
      throw new TypeError(`Fighter.addTrait: invalid trait "${trait}".`);
    }
    if (this.hasTrait(trait)) return false;
    this.psychology.personality.traits.push(trait);
    return true;
  }

  /**
   * @param {string} trait
   * @returns {boolean} True if the trait was present and removed.
   */
  removeTrait(trait) {
    const index = this.psychology.personality.traits.indexOf(trait);
    if (index === -1) return false;
    this.psychology.personality.traits.splice(index, 1);
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
   * Phase 4.6: adjusts this fighter's relationship/loyalty with the gym
   * (e.g. a Drama Engine choice reaffirming or straining the bond — see
   * engine/DramaEngine.js's ADJUST_LOYALTY effect).
   * @param {number} delta
   */
  adjustLoyalty(delta) {
    this.psychology.loyalty = clampPsychology(this.psychology.loyalty + delta);
  }

  /**
   * @param {number} delta
   */
  adjustPhysicalFatigue(delta) {
    this.attributes.physicalFatigue = clampPhysicalFatigue(this.attributes.physicalFatigue + delta);
  }

  /**
   * @param {number} delta
   */
  adjustMentalFatigue(delta) {
    this.attributes.mentalFatigue = clampMentalFatigue(this.attributes.mentalFatigue + delta);
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

  /**
   * Sets one slot of this week's weekly plan (Phase 3.1 v1), consumed by
   * engine/WeeklyPlanningEngine.js#processWeeklyPlan.
   *
   * @param {number} index - 0-based, must be < BALANCE.WEEKLY_PLANNING.SLOTS_PER_WEEK.
   * @param {string|null} activityKey - One of Object.keys(BALANCE.WEEKLY_PLANNING.ACTIVITIES), or null to clear the slot.
   * @returns {string[]} The resulting slots array.
   */
  setWeeklyPlanSlot(index, activityKey) {
    if (!Number.isInteger(index) || index < 0 || index >= this.weeklyPlan.slots.length) {
      throw new TypeError(`Fighter.setWeeklyPlanSlot: invalid slot index "${index}".`);
    }
    if (activityKey !== null && !(activityKey in BALANCE.WEEKLY_PLANNING.ACTIVITIES)) {
      throw new TypeError(`Fighter.setWeeklyPlanSlot: invalid activity "${activityKey}".`);
    }
    this.weeklyPlan.slots[index] = activityKey;
    return [...this.weeklyPlan.slots];
  }

  /**
   * Consumes a pending VIDEO_PREP tactical bonus (Phase 3.1 v1), called by
   * CombatEngine at weigh-in right after reading getReadiness() for this
   * fight — the bonus applied to this match, so it shouldn't still count
   * toward next week's Readiness.
   *
   * @returns {boolean} True if a bonus was pending and just got cleared.
   */
  clearTacticalPrep() {
    const wasPending = this.preparation.tacticalBonusPending;
    this.preparation.tacticalBonusPending = false;
    return wasPending;
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
        physicalFatigue: this.attributes.physicalFatigue,
        mentalFatigue: this.attributes.mentalFatigue,
      },
      psychology: {
        ...this.psychology,
        personality: {
          archetype: this.psychology.personality.archetype,
          traits: [...this.psychology.personality.traits],
        },
      },
      career: {
        ...this.career,
        titles: [...this.career.titles],
        seasonHistory: this.career.seasonHistory.map((row) => ({ ...row })),
        trophies: this.career.trophies.map((trophy) => ({ ...trophy })),
      },
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
      weeklyPlan: { slots: [...this.weeklyPlan.slots] },
      preparation: { ...this.preparation },
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
