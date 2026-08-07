/**
 * state/WorldState.js
 * ---------------------------------------------------------------------------
 * The simulated world surrounding the player: the calendar, organization
 * rankings/ladders, rival gyms, a rolling log of global events, the
 * relationship graph between entities (fighters, gyms...), and the
 * all-time records registry.
 *
 * relationships/records exist here — not inside RelationshipEngine or
 * WorldMemory — specifically so those Level 1/2 engines never need to know
 * about each other: every engine that cares about relationship gauges or
 * historical records reads/writes them as plain State data, exactly like
 * any other WorldState field. That is what "Découplage absolu" (engines
 * only know EventBus + BALANCE + State/Models) requires in practice.
 *
 * Same rules as PlayerState.js:
 *   - Depends only on Data (balance.js) and EventBus, never on Engine/Render.
 *   - Every mutation publishes an event; Engine drives this state forward
 *     (advancing days, updating rankings), Render only ever reads it.
 *   - Purely serializable game data — no UI/runtime concerns.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

/** Event names published on EventBus by WorldState. Import instead of raw strings. */
export const WORLD_EVENTS = Object.freeze({
  DAY_ADVANCED: 'world:day_advanced',
  SEASON_CHANGED: 'world:season_changed',
  YEAR_CHANGED: 'world:year_changed',
  RANKINGS_UPDATED: 'world:rankings_updated',
  LADDER_UPDATED: 'world:ladder_updated',
  RIVAL_GYM_ADDED: 'world:rival_gym_added',
  RIVAL_GYM_UPDATED: 'world:rival_gym_updated',
  RIVAL_GYM_REMOVED: 'world:rival_gym_removed',
  GLOBAL_EVENT_ADDED: 'world:global_event_added',
  RELATIONSHIP_UPDATED: 'world:relationship_updated',
  RECORD_BROKEN: 'world:record_broken',
  HALL_OF_FAME_INDUCTED: 'world:hall_of_fame_inducted',
  GOLDEN_BOOK_ENTRY_ADDED: 'world:golden_book_entry_added',
});

/** The five relationship gauges tracked per entity pair. */
const RELATIONSHIP_GAUGES = Object.freeze(['relation', 'popularity', 'tension', 'respect', 'legacy']);

function clampGauge(key, value) {
  const r = BALANCE.RELATIONSHIP;
  const [min, max] = key === 'relation' ? [r.MIN_RELATION, r.MAX_RELATION] : [r.MIN_GAUGE, r.MAX_GAUGE];
  return Math.min(max, Math.max(min, value));
}

function defaultRelationshipGauges() {
  const r = BALANCE.RELATIONSHIP;
  return {
    relation: r.STARTING_RELATION,
    popularity: r.STARTING_POPULARITY,
    tension: r.STARTING_TENSION,
    respect: r.STARTING_RESPECT,
    legacy: r.STARTING_LEGACY,
  };
}

function defaultRecords() {
  const blank = () => ({ value: null, day: null, detail: null, meta: null });
  return {
    fastestKO: blank(),
    longestTitleReign: blank(),
    mostTitles: { value: 0, day: null, detail: null, meta: null },
    biggestFight: blank(),
    /** Phase 4.2: lowest identity.age at a fighter's FIRST title win (see engine/HistoryEngine.js). Structurally N/A in a headless sim run that never books title fights (isTitle always false) — see tools/SimRunner.js's own documented limitation. */
    youngestChampion: blank(),
    /** Phase 4.2: highest Fighter.career.longestWinStreak ever observed across every fighter (see engine/HistoryEngine.js). */
    longestWinStreak: { value: 0, day: null, detail: null, meta: null },
    /** Phase Beta: largest preFightRatings gap ever overcome by a winner (loser's rating minus winner's), across every combat:finished — see engine/WorldMemory.js. The same "biggest upset" concept engine/StoryAnalyzer.js computes per-season from transient fightResultsThisYear, kept here as a persistent career-wide record so web/StoryExporter.js can report it honestly outside the Week-52 gala window (e.g. from a retired legend's Hall of Fame profile, long after that season's transient data is gone). */
    biggestUpset: blank(),
  };
}

let idCounter = 0;
function generateId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * @param {number} day - 1-indexed world day.
 * @returns {{ seasonIndex: number, seasonName: string, year: number }}
 */
function resolveCalendarPosition(day) {
  const { DAYS_PER_WEEK, WEEKS_PER_SEASON, SEASONS_PER_YEAR, SEASON_NAMES } = BALANCE.CALENDAR;
  const daysPerSeason = DAYS_PER_WEEK * WEEKS_PER_SEASON;
  const daysPerYear = daysPerSeason * SEASONS_PER_YEAR;

  const dayIndex = Math.max(0, day - 1);
  const year = Math.floor(dayIndex / daysPerYear) + 1;
  const dayWithinYear = dayIndex % daysPerYear;
  const seasonIndex = Math.floor(dayWithinYear / daysPerSeason);

  return { seasonIndex, seasonName: SEASON_NAMES[seasonIndex], year };
}

export class WorldState {
  /**
   * @param {Object} [config]
   * @param {number} [config.currentDay]
   * @param {Object} [config.orgRanks] - { [orgId]: { [weightClass]: fighterId[] } }
   * @param {Object} [config.orgLadders] - { [orgId]: { [weightClass]: fighterId[] } }
   * @param {Object[]} [config.rivalGyms]
   * @param {Object[]} [config.globalEvents]
   * @param {Object} [config.relationships] - { [pairKey]: RelationshipRecord }
   * @param {Object} [config.records] - Historical bests (see defaultRecords()).
   * @param {Object} [config.titleHolders] - { [titleKey]: { fighterId, fighterName, sinceDay } }
   * @param {Object[]} [config.hallOfFame] - Phase 4.2: retired legends registry (see engine/HistoryEngine.js#induct).
   * @param {number|null} [config.lastProspectWaveYear] - Phase V2.7: last year a prospect wave was generated.
   */
  constructor(config = {}) {
    this.currentDay = config.currentDay ?? BALANCE.CALENDAR.START_DAY;

    const position = resolveCalendarPosition(this.currentDay);
    this.season = config.season ?? position.seasonName;
    this.year = config.year ?? position.year;

    this.orgRanks = config.orgRanks ? structuredCloneOrCopy(config.orgRanks) : {};
    this.orgLadders = config.orgLadders ? structuredCloneOrCopy(config.orgLadders) : {};
    this.rivalGyms = config.rivalGyms ? structuredCloneOrCopy(config.rivalGyms) : [];
    this.globalEvents = config.globalEvents
      ? config.globalEvents.map((event) => ({ ...event }))
      : [];

    this.relationships = config.relationships ? structuredCloneOrCopy(config.relationships) : {};
    this.records = config.records ? structuredCloneOrCopy(config.records) : defaultRecords();
    this.titleHolders = config.titleHolders ? structuredCloneOrCopy(config.titleHolders) : {};
    /** Phase 4.2: retired legends registry, see engine/HistoryEngine.js#induct/addHallOfFameEntry. */
    this.hallOfFame = config.hallOfFame ? config.hallOfFame.map((entry) => ({ ...entry })) : [];
    /** Phase V2.7: last year a "Cuvee de Prospects" wave was generated — see engine/ProspectGenerator.js#isProspectWaveDue. null before the first wave. */
    this.lastProspectWaveYear = config.lastProspectWaveYear ?? null;
    /** "Livre d'Or": one auto-engraved recap phrase per season-end, see engine/HallOfFameEngine.js#generateGoldenBookEntry/addGoldenBookEntry below. */
    this.goldenBook = config.goldenBook ? config.goldenBook.map((entry) => ({ ...entry })) : [];
  }

  // ---- calendar -----------------------------------------------------------

  /**
   * Advances the world calendar by the given number of days, updating
   * season/year and publishing the relevant events.
   *
   * @param {number} [days=1]
   * @returns {{ currentDay: number, season: string, year: number }}
   */
  advanceDay(days = 1) {
    if (!Number.isInteger(days) || days <= 0) {
      throw new TypeError('WorldState.advanceDay: days must be a positive integer.');
    }

    const previousSeason = this.season;
    const previousYear = this.year;

    this.currentDay += days;
    const position = resolveCalendarPosition(this.currentDay);
    this.season = position.seasonName;
    this.year = position.year;

    EventBus.publish(WORLD_EVENTS.DAY_ADVANCED, {
      currentDay: this.currentDay,
      delta: days,
    });

    if (this.season !== previousSeason) {
      EventBus.publish(WORLD_EVENTS.SEASON_CHANGED, {
        season: this.season,
        previousSeason,
      });
    }

    if (this.year !== previousYear) {
      EventBus.publish(WORLD_EVENTS.YEAR_CHANGED, {
        year: this.year,
        previousYear,
      });
    }

    return { currentDay: this.currentDay, season: this.season, year: this.year };
  }

  // ---- organizations --------------------------------------------------------

  /**
   * Replaces the ranking order for a given org/weight class.
   *
   * @param {string} orgId
   * @param {string} weightClass
   * @param {string[]} orderedFighterIds - Ranked from #1 downward.
   */
  setOrgRanking(orgId, weightClass, orderedFighterIds) {
    if (!this.orgRanks[orgId]) this.orgRanks[orgId] = {};
    this.orgRanks[orgId][weightClass] = [...orderedFighterIds];

    EventBus.publish(WORLD_EVENTS.RANKINGS_UPDATED, {
      orgId,
      weightClass,
      ranking: this.orgRanks[orgId][weightClass],
    });
  }

  /**
   * @param {string} orgId
   * @param {string} weightClass
   * @returns {string[]} The current ranking, or an empty array if unset.
   */
  getOrgRanking(orgId, weightClass) {
    return this.orgRanks[orgId]?.[weightClass] ?? [];
  }

  /**
   * Replaces the title-contention ladder (challenger queue) for a given
   * org/weight class.
   *
   * @param {string} orgId
   * @param {string} weightClass
   * @param {string[]} orderedContenderIds
   */
  setLadder(orgId, weightClass, orderedContenderIds) {
    if (!this.orgLadders[orgId]) this.orgLadders[orgId] = {};
    this.orgLadders[orgId][weightClass] = [...orderedContenderIds];

    EventBus.publish(WORLD_EVENTS.LADDER_UPDATED, {
      orgId,
      weightClass,
      ladder: this.orgLadders[orgId][weightClass],
    });
  }

  /**
   * @param {string} orgId
   * @param {string} weightClass
   * @returns {string[]}
   */
  getLadder(orgId, weightClass) {
    return this.orgLadders[orgId]?.[weightClass] ?? [];
  }

  // ---- rival gyms -------------------------------------------------------------

  /**
   * @param {Object} gym
   * @returns {Object} The stored gym record, with an id assigned if missing.
   */
  addRivalGym(gym) {
    const record = { id: gym.id ?? generateId('rivalgym'), ...gym };
    this.rivalGyms.push(record);
    EventBus.publish(WORLD_EVENTS.RIVAL_GYM_ADDED, { gymId: record.id });
    return record;
  }

  /**
   * Shallow-merges `changes` into an existing rival gym record (e.g. weekly
   * reputation/activity drift, or a fight result). No-ops if the gym isn't
   * found rather than throwing, since rival gyms may be pruned independently.
   *
   * @param {string} gymId
   * @param {Object} changes
   * @returns {Object|null} The updated gym record, or null if not found.
   */
  updateRivalGym(gymId, changes) {
    const gym = this.rivalGyms.find((entry) => entry.id === gymId);
    if (!gym) return null;

    Object.assign(gym, changes);
    EventBus.publish(WORLD_EVENTS.RIVAL_GYM_UPDATED, { gymId, changes: { ...changes } });
    return { ...gym };
  }

  /**
   * @param {string} gymId
   * @returns {boolean} True if a gym was removed.
   */
  removeRivalGym(gymId) {
    const index = this.rivalGyms.findIndex((gym) => gym.id === gymId);
    if (index === -1) return false;

    this.rivalGyms.splice(index, 1);
    EventBus.publish(WORLD_EVENTS.RIVAL_GYM_REMOVED, { gymId });
    return true;
  }

  // ---- global events log ------------------------------------------------------

  /**
   * Appends an entry to the world's global event log, trimming the oldest
   * entries past BALANCE.WORLD.GLOBAL_EVENT_HISTORY_LIMIT.
   *
   * @param {Object} event
   * @returns {Object} The stored event (with an id/day assigned if missing).
   */
  addGlobalEvent(event) {
    const record = {
      id: event.id ?? generateId('worldevent'),
      day: event.day ?? this.currentDay,
      ...event,
    };

    this.globalEvents.push(record);
    if (this.globalEvents.length > BALANCE.WORLD.GLOBAL_EVENT_HISTORY_LIMIT) {
      this.globalEvents.splice(
        0,
        this.globalEvents.length - BALANCE.WORLD.GLOBAL_EVENT_HISTORY_LIMIT
      );
    }

    EventBus.publish(WORLD_EVENTS.GLOBAL_EVENT_ADDED, { event: record });
    return record;
  }

  // ---- relationship graph -----------------------------------------------------

  /**
   * Canonical, order-independent key for a pair of entity ids.
   * @param {string} entityAId
   * @param {string} entityBId
   * @returns {string}
   */
  _pairKey(entityAId, entityBId) {
    return [entityAId, entityBId].sort().join('|');
  }

  /**
   * @param {string} entityAId
   * @param {string} entityBId
   * @returns {Object|null} A copy of the relationship record, or null if none exists yet.
   */
  getRelationship(entityAId, entityBId) {
    const record = this.relationships[this._pairKey(entityAId, entityBId)];
    return record ? { ...record, gauges: { ...record.gauges }, history: [...record.history] } : null;
  }

  /**
   * Creates (with BALANCE-defined starting gauges) or updates the
   * relationship between two entities, clamping every gauge to its bounds,
   * and optionally appending a chronological history entry.
   *
   * @param {string} entityAId
   * @param {string} entityBId
   * @param {Object} [deltas] - Any of RELATIONSHIP_GAUGES' keys -> numeric delta.
   * @param {Object} [historyEntry] - { type, description, ...extra }. `day` is
   *   stamped automatically from this.currentDay if not provided.
   * @returns {Object} A copy of the resulting relationship record.
   */
  upsertRelationship(entityAId, entityBId, deltas = {}, historyEntry = null) {
    const key = this._pairKey(entityAId, entityBId);
    if (!this.relationships[key]) {
      this.relationships[key] = {
        entityA: entityAId,
        entityB: entityBId,
        gauges: defaultRelationshipGauges(),
        history: [],
      };
    }
    const record = this.relationships[key];

    for (const gaugeKey of RELATIONSHIP_GAUGES) {
      if (typeof deltas[gaugeKey] === 'number') {
        record.gauges[gaugeKey] = clampGauge(gaugeKey, record.gauges[gaugeKey] + deltas[gaugeKey]);
      }
    }

    if (historyEntry) {
      record.history.push({ day: this.currentDay, ...historyEntry });
      if (record.history.length > BALANCE.RELATIONSHIP.HISTORY_LIMIT) {
        record.history.splice(0, record.history.length - BALANCE.RELATIONSHIP.HISTORY_LIMIT);
      }
    }

    EventBus.publish(WORLD_EVENTS.RELATIONSHIP_UPDATED, {
      entityA: entityAId,
      entityB: entityBId,
      gauges: { ...record.gauges },
      deltas: { ...deltas },
    });

    return { ...record, gauges: { ...record.gauges }, history: [...record.history] };
  }

  // ---- world records ------------------------------------------------------------

  /**
   * @param {string} key - One of Object.keys(this.records).
   * @returns {Object} A copy of that record.
   */
  getRecord(key) {
    if (!(key in this.records)) {
      throw new TypeError(`WorldState.getRecord: unknown record "${key}".`);
    }
    return { ...this.records[key] };
  }

  /**
   * Sets a world record only if the candidate value actually beats the
   * current one (or none is set yet), publishing RECORD_BROKEN when it does.
   *
   * @param {string} key - One of Object.keys(this.records).
   * @param {number} value
   * @param {Object} [options]
   * @param {('HIGHER'|'LOWER')} [options.betterIf='HIGHER']
   * @param {string} [options.detail] - Human-readable description.
   * @param {Object} [options.meta] - Free-form context (fighter ids/names...).
   * @returns {boolean} True if the record was broken/set.
   */
  trySetRecord(key, value, { betterIf = 'HIGHER', detail = null, meta = null } = {}) {
    if (!(key in this.records)) {
      throw new TypeError(`WorldState.trySetRecord: unknown record "${key}".`);
    }
    const current = this.records[key];
    const isBetter =
      current.value === null ||
      (betterIf === 'HIGHER' ? value > current.value : value < current.value);

    if (!isBetter) return false;

    const previous = { ...current };
    this.records[key] = { value, day: this.currentDay, detail, meta };

    EventBus.publish(WORLD_EVENTS.RECORD_BROKEN, {
      key,
      record: { ...this.records[key] },
      previous,
    });
    return true;
  }

  /**
   * @param {string} titleKey - e.g. `${orgId}:${weightClass}`.
   * @returns {Object|null}
   */
  getTitleHolder(titleKey) {
    return this.titleHolders[titleKey] ? { ...this.titleHolders[titleKey] } : null;
  }

  /**
   * @param {string} titleKey
   * @param {Object} holder - { fighterId, fighterName, sinceDay }
   */
  setTitleHolder(titleKey, holder) {
    this.titleHolders[titleKey] = { ...holder };
  }

  // ---- hall of fame (Phase 4.2) -------------------------------------------------

  /**
   * Appends a retired legend to the world's permanent Hall of Fame registry
   * (see engine/HistoryEngine.js#induct), trimming the oldest entries past
   * BALANCE.WORLD.HALL_OF_FAME_HISTORY_LIMIT.
   *
   * @param {Object} entry
   * @returns {Object} The stored entry (with an id/inductedOnDay assigned if missing).
   */
  addHallOfFameEntry(entry) {
    const record = {
      id: entry.id ?? generateId('hof'),
      inductedOnDay: entry.inductedOnDay ?? this.currentDay,
      ...entry,
    };

    this.hallOfFame.push(record);
    if (this.hallOfFame.length > BALANCE.WORLD.HALL_OF_FAME_HISTORY_LIMIT) {
      this.hallOfFame.splice(0, this.hallOfFame.length - BALANCE.WORLD.HALL_OF_FAME_HISTORY_LIMIT);
    }

    EventBus.publish(WORLD_EVENTS.HALL_OF_FAME_INDUCTED, { entry: record });
    return record;
  }

  /**
   * @returns {Object[]} A copy of the full Hall of Fame registry.
   */
  getHallOfFame() {
    return this.hallOfFame.map((entry) => ({ ...entry }));
  }

  // ---- golden book (Livre d'Or) ------------------------------------------------

  /**
   * Appends one auto-engraved season recap phrase to the world's permanent
   * "Livre d'Or" (see engine/HallOfFameEngine.js#generateGoldenBookEntry),
   * trimming the oldest entries past BALANCE.GOLDEN_BOOK.HISTORY_LIMIT.
   *
   * @param {Object} entry - { year, season, text, ...extra }.
   * @returns {Object} The stored entry (with an id/engravedOnDay assigned if missing).
   */
  addGoldenBookEntry(entry) {
    const record = {
      id: entry.id ?? generateId('gb'),
      engravedOnDay: entry.engravedOnDay ?? this.currentDay,
      ...entry,
    };

    this.goldenBook.push(record);
    if (this.goldenBook.length > BALANCE.GOLDEN_BOOK.HISTORY_LIMIT) {
      this.goldenBook.splice(0, this.goldenBook.length - BALANCE.GOLDEN_BOOK.HISTORY_LIMIT);
    }

    EventBus.publish(WORLD_EVENTS.GOLDEN_BOOK_ENTRY_ADDED, { entry: record });
    return record;
  }

  /**
   * @returns {Object[]} A copy of the full Livre d'Or registry.
   */
  getGoldenBook() {
    return this.goldenBook.map((entry) => ({ ...entry }));
  }

  // ---- prospect waves -----------------------------------------------------------

  /**
   * Marks that this year's "Cuvee de Prospects" wave has been generated —
   * see engine/ProspectGenerator.js#isProspectWaveDue/generateProspectWave.
   * @param {number} year
   */
  recordProspectWave(year) {
    this.lastProspectWaveYear = year;
  }

  // ---- serialization ------------------------------------------------------------

  /**
   * @returns {Object} A plain, JSON-serializable snapshot of the world.
   */
  toJSON() {
    return {
      currentDay: this.currentDay,
      season: this.season,
      year: this.year,
      orgRanks: structuredCloneOrCopy(this.orgRanks),
      orgLadders: structuredCloneOrCopy(this.orgLadders),
      rivalGyms: structuredCloneOrCopy(this.rivalGyms),
      globalEvents: this.globalEvents.map((event) => ({ ...event })),
      relationships: structuredCloneOrCopy(this.relationships),
      records: structuredCloneOrCopy(this.records),
      titleHolders: structuredCloneOrCopy(this.titleHolders),
      hallOfFame: this.hallOfFame.map((entry) => ({ ...entry })),
      lastProspectWaveYear: this.lastProspectWaveYear,
      goldenBook: this.goldenBook.map((entry) => ({ ...entry })),
    };
  }

  /**
   * @param {Object} data - A toJSON() snapshot (or equivalent loaded data).
   * @returns {WorldState}
   */
  static fromJSON(data) {
    return new WorldState(data ?? {});
  }
}

/**
 * Deep-copies a plain JSON-safe object graph. Prefers the native
 * structuredClone when available (Node 17+/modern browsers), falls back to
 * JSON round-tripping otherwise.
 * @param {Object} value
 * @returns {Object}
 */
function structuredCloneOrCopy(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export default WorldState;
