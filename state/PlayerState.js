/**
 * state/PlayerState.js
 * ---------------------------------------------------------------------------
 * The player's gym: money, reputation, hype, roster, staff and social feed.
 *
 * Architectural rules this file follows:
 *   - State depends on Models (Fighter) and Data (balance.js), and is the
 *     ONLY layer allowed to publish on EventBus about the player's gym.
 *     Engine reads/mutates PlayerState through these methods; Render reads
 *     PlayerState and subscribes to its events — neither talks to the
 *     other directly.
 *   - Every mutation method that changes persisted data publishes an event
 *     describing what changed, so Render/Engine can react without polling.
 *   - Only serializable game data lives here (see toJSON). UI selection,
 *     modals, animation flags, etc. belong in RuntimeState (GameState.js),
 *     never here.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';

/** Event names published on EventBus by PlayerState. Import instead of raw strings. */
export const PLAYER_EVENTS = Object.freeze({
  ROSTER_FIGHTER_ADDED: 'roster:fighter_added',
  ROSTER_FIGHTER_ADD_REJECTED: 'roster:fighter_add_rejected',
  ROSTER_FIGHTER_REMOVED: 'roster:fighter_removed',
  ECONOMY_MONEY_CHANGED: 'economy:money_changed',
  ECONOMY_INSOLVENT: 'economy:insolvent',
  GYM_REPUTATION_CHANGED: 'gym:reputation_changed',
  GYM_HYPE_CHANGED: 'gym:hype_changed',
  GYM_FACILITY_UPGRADED: 'gym:facility_upgraded',
  GYM_FACILITY_UPGRADE_REJECTED: 'gym:facility_upgrade_rejected',
  GYM_EQUIPMENT_ADDED: 'gym:equipment_added',
  STAFF_COACH_ADDED: 'staff:coach_added',
  STAFF_COACH_REMOVED: 'staff:coach_removed',
  SOCIAL_FEED_ENTRY_ADDED: 'social:feed_entry_added',
  ACADEMY_DRAFT_OFFERED: 'academy:draft_offered',
});

let idCounter = 0;
function generateId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class PlayerState {
  /**
   * @param {Object} [config]
   * @param {string} [config.gymName]
   * @param {string} [config.country]
   * @param {number} [config.money]
   * @param {number} [config.reputation]
   * @param {number} [config.hype]
   * @param {number} [config.equipLevel]
   * @param {Object[]} [config.equipment]
   * @param {(Fighter|Object)[]} [config.roster]
   * @param {Object[]} [config.coaches]
   * @param {Object[]} [config.socialFeed]
   * @param {number|null} [config.lastAcademyDraftYear]
   */
  constructor(config = {}) {
    this.gymName = config.gymName ?? 'New Gym';
    this.country = config.country ?? '';

    this.money = config.money ?? BALANCE.ECONOMY.STARTING_GYM_FUNDS;
    this.reputation = clamp(
      config.reputation ?? BALANCE.GYM.STARTING_REPUTATION,
      0,
      BALANCE.GYM.MAX_REPUTATION
    );
    this.hype = clamp(
      config.hype ?? BALANCE.GYM.HYPE.STARTING_VALUE,
      BALANCE.GYM.HYPE.MIN,
      BALANCE.GYM.HYPE.MAX
    );

    this.equipLevel = config.equipLevel ?? 0;
    this.equipment = config.equipment ? [...config.equipment] : [];

    /** @type {Fighter[]} */
    this.roster = (config.roster ?? []).map((entry) =>
      entry instanceof Fighter ? entry : Fighter.fromJSON(entry)
    );

    this.coaches = config.coaches ? config.coaches.map((coach) => ({ ...coach })) : [];
    this.socialFeed = config.socialFeed ? config.socialFeed.map((entry) => ({ ...entry })) : [];

    /** Year (WorldState.year) the Academy Draft was last offered — see engine/AcademyEngine.js#isAcademyDraftAvailable. null before the first offer. */
    this.lastAcademyDraftYear = config.lastAcademyDraftYear ?? null;
  }

  // ---- roster -----------------------------------------------------------

  /**
   * @returns {number} Max roster size at the current facility level.
   */
  getRosterCapacity() {
    return (
      BALANCE.GYM.STARTING_ROSTER_CAPACITY +
      this.equipLevel * BALANCE.GYM.ROSTER_SLOTS_PER_FACILITY_LEVEL
    );
  }

  /**
   * Adds a fighter to the roster if there is room.
   *
   * @param {Fighter} fighter
   * @returns {boolean} True if added, false if rejected (roster full).
   */
  addFighter(fighter) {
    if (!(fighter instanceof Fighter)) {
      throw new TypeError('PlayerState.addFighter: fighter must be a Fighter instance.');
    }

    if (this.roster.length >= this.getRosterCapacity()) {
      EventBus.publish(PLAYER_EVENTS.ROSTER_FIGHTER_ADD_REJECTED, {
        fighterId: fighter.identity.id,
        reason: 'ROSTER_FULL',
        capacity: this.getRosterCapacity(),
      });
      return false;
    }

    this.roster.push(fighter);
    EventBus.publish(PLAYER_EVENTS.ROSTER_FIGHTER_ADDED, {
      fighterId: fighter.identity.id,
      rosterSize: this.roster.length,
    });
    return true;
  }

  /**
   * @param {string} fighterId
   * @returns {Fighter|null} The removed fighter, or null if not found.
   */
  removeFighter(fighterId) {
    const index = this.roster.findIndex((fighter) => fighter.identity.id === fighterId);
    if (index === -1) return null;

    const [removed] = this.roster.splice(index, 1);
    EventBus.publish(PLAYER_EVENTS.ROSTER_FIGHTER_REMOVED, {
      fighterId,
      rosterSize: this.roster.length,
    });
    return removed;
  }

  /**
   * @param {string} fighterId
   * @returns {Fighter|undefined}
   */
  getFighter(fighterId) {
    return this.roster.find((fighter) => fighter.identity.id === fighterId);
  }

  // ---- economy ------------------------------------------------------------

  /**
   * Applies a delta (positive or negative) to the gym's funds.
   *
   * @param {number} delta
   * @param {string} [reason='']
   * @returns {number} The new balance.
   */
  changeMoney(delta, reason = '') {
    this.money += delta;

    EventBus.publish(PLAYER_EVENTS.ECONOMY_MONEY_CHANGED, {
      delta,
      balance: this.money,
      reason,
    });

    if (this.money < 0) {
      EventBus.publish(PLAYER_EVENTS.ECONOMY_INSOLVENT, { balance: this.money });
    }

    return this.money;
  }

  // ---- gym meta -------------------------------------------------------------

  /**
   * @param {number} delta
   * @param {string} [reason='']
   * @returns {number} The new reputation value.
   */
  changeReputation(delta, reason = '') {
    this.reputation = clamp(this.reputation + delta, 0, BALANCE.GYM.MAX_REPUTATION);
    EventBus.publish(PLAYER_EVENTS.GYM_REPUTATION_CHANGED, {
      delta,
      value: this.reputation,
      reason,
    });
    return this.reputation;
  }

  /**
   * @param {number} delta
   * @param {string} [reason='']
   * @returns {number} The new hype value.
   */
  changeHype(delta, reason = '') {
    this.hype = clamp(this.hype + delta, BALANCE.GYM.HYPE.MIN, BALANCE.GYM.HYPE.MAX);
    EventBus.publish(PLAYER_EVENTS.GYM_HYPE_CHANGED, { delta, value: this.hype, reason });
    return this.hype;
  }

  /**
   * Upgrades the gym facility by one level, deducting the given cost
   * (computed by Engine from BALANCE.ECONOMY.FACILITY_UPGRADE — this method
   * does not invent the price itself).
   *
   * @param {number} cost
   * @returns {boolean} True if the upgrade succeeded.
   */
  upgradeFacility(cost) {
    if (this.equipLevel >= BALANCE.ECONOMY.FACILITY_UPGRADE.MAX_LEVEL) {
      EventBus.publish(PLAYER_EVENTS.GYM_FACILITY_UPGRADE_REJECTED, {
        reason: 'MAX_LEVEL_REACHED',
        equipLevel: this.equipLevel,
      });
      return false;
    }

    if (this.money < cost) {
      EventBus.publish(PLAYER_EVENTS.GYM_FACILITY_UPGRADE_REJECTED, {
        reason: 'INSUFFICIENT_FUNDS',
        cost,
        balance: this.money,
      });
      return false;
    }

    this.changeMoney(-cost, 'FACILITY_UPGRADE');
    this.equipLevel += 1;

    EventBus.publish(PLAYER_EVENTS.GYM_FACILITY_UPGRADED, {
      equipLevel: this.equipLevel,
      cost,
    });
    return true;
  }

  /**
   * @param {Object} item
   */
  addEquipmentItem(item) {
    this.equipment.push(item);
    EventBus.publish(PLAYER_EVENTS.GYM_EQUIPMENT_ADDED, { item });
  }

  // ---- staff ----------------------------------------------------------------

  /**
   * @param {Object} coach
   * @returns {Object} The coach record, with an id assigned if missing.
   */
  addCoach(coach) {
    const record = { id: coach.id ?? generateId('coach'), ...coach };
    this.coaches.push(record);
    EventBus.publish(PLAYER_EVENTS.STAFF_COACH_ADDED, { coachId: record.id });
    return record;
  }

  /**
   * @param {string} coachId
   * @returns {boolean} True if a coach was removed.
   */
  removeCoach(coachId) {
    const index = this.coaches.findIndex((coach) => coach.id === coachId);
    if (index === -1) return false;

    this.coaches.splice(index, 1);
    EventBus.publish(PLAYER_EVENTS.STAFF_COACH_REMOVED, { coachId });
    return true;
  }

  /**
   * Phase V2.6 ("Story Analyzer & Gala de Fin de Saison"): permanently
   * records an end-of-season trophy a coach won (e.g. "Coach de l'Annee") —
   * coach records have no fixed schema (see addCoach), so `awards` is
   * created on first use, mirroring Fighter#addTrophy()'s own pattern.
   * @param {string} coachId
   * @param {Object} trophy
   * @returns {boolean} True if the coach was found and the trophy recorded.
   */
  awardCoachTrophy(coachId, trophy) {
    const coach = this.coaches.find((c) => c.id === coachId);
    if (!coach) return false;
    coach.awards = coach.awards ? [...coach.awards, { ...trophy }] : [{ ...trophy }];
    return true;
  }

  // ---- academy draft ------------------------------------------------------------

  /**
   * Marks this year's Academy Draft window as used — whether the player
   * promoted a prospect or skipped the offer — so it isn't presented again
   * until the next year change. See engine/AcademyEngine.js#isAcademyDraftAvailable.
   *
   * @param {number} year - The current WorldState.year.
   */
  recordAcademyDraftOffer(year) {
    this.lastAcademyDraftYear = year;
    EventBus.publish(PLAYER_EVENTS.ACADEMY_DRAFT_OFFERED, { year });
  }

  // ---- social feed ------------------------------------------------------------

  /**
   * Appends an entry to the gym's social media feed, trimming the oldest
   * entries past BALANCE.SOCIAL_MEDIA.FEED_HISTORY_LIMIT.
   *
   * @param {Object} entry
   * @returns {Object} The stored entry (with an id/postedAt assigned if missing).
   */
  pushSocialFeedEntry(entry) {
    const record = {
      id: entry.id ?? generateId('post'),
      postedAt: entry.postedAt ?? new Date().toISOString(),
      ...entry,
    };

    this.socialFeed.push(record);
    if (this.socialFeed.length > BALANCE.SOCIAL_MEDIA.FEED_HISTORY_LIMIT) {
      this.socialFeed.splice(0, this.socialFeed.length - BALANCE.SOCIAL_MEDIA.FEED_HISTORY_LIMIT);
    }

    EventBus.publish(PLAYER_EVENTS.SOCIAL_FEED_ENTRY_ADDED, { entry: record });
    return record;
  }

  // ---- serialization ----------------------------------------------------------

  /**
   * @returns {Object} A plain, JSON-serializable snapshot of the player's gym.
   */
  toJSON() {
    return {
      gymName: this.gymName,
      country: this.country,
      money: this.money,
      reputation: this.reputation,
      hype: this.hype,
      equipLevel: this.equipLevel,
      equipment: [...this.equipment],
      roster: this.roster.map((fighter) => fighter.toJSON()),
      coaches: this.coaches.map((coach) =>
        coach.awards ? { ...coach, awards: coach.awards.map((award) => ({ ...award })) } : { ...coach }
      ),
      socialFeed: this.socialFeed.map((entry) => ({ ...entry })),
      lastAcademyDraftYear: this.lastAcademyDraftYear,
    };
  }

  /**
   * @param {Object} data - A toJSON() snapshot (or equivalent loaded data).
   * @returns {PlayerState}
   */
  static fromJSON(data) {
    return new PlayerState(data ?? {});
  }
}

export default PlayerState;
