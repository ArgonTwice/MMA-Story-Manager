/**
 * state/WorldState.js
 * ---------------------------------------------------------------------------
 * The simulated world surrounding the player: the calendar, organization
 * rankings/ladders, rival gyms, and a rolling log of global events.
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
  RIVAL_GYM_REMOVED: 'world:rival_gym_removed',
  GLOBAL_EVENT_ADDED: 'world:global_event_added',
});

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
   */
  constructor(config = {}) {
    this.currentDay = config.currentDay ?? BALANCE.CALENDAR.START_DAY;

    const position = resolveCalendarPosition(this.currentDay);
    this.season = config.season ?? position.seasonName;
    this.year = config.year ?? position.year;

    this.orgRanks = config.orgRanks ? structuredCloneOrCopy(config.orgRanks) : {};
    this.orgLadders = config.orgLadders ? structuredCloneOrCopy(config.orgLadders) : {};
    this.rivalGyms = config.rivalGyms ? config.rivalGyms.map((gym) => ({ ...gym })) : [];
    this.globalEvents = config.globalEvents
      ? config.globalEvents.map((event) => ({ ...event }))
      : [];
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
      rivalGyms: this.rivalGyms.map((gym) => ({ ...gym })),
      globalEvents: this.globalEvents.map((event) => ({ ...event })),
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
