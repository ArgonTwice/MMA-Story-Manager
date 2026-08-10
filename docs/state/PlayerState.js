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
  GYM_EQUIPMENT_REMOVED: 'gym:equipment_removed',
  GYM_FACILITY_SEIZED: 'gym:facility_seized',
  STAFF_COACH_ADDED: 'staff:coach_added',
  STAFF_COACH_REMOVED: 'staff:coach_removed',
  SOCIAL_FEED_ENTRY_ADDED: 'social:feed_entry_added',
  ACADEMY_DRAFT_OFFERED: 'academy:draft_offered',
  /** Underground Circuit gym-stipulation matches (engine/GymStipulations.js): a timed recurring deal (e.g. a captured Sponsorship Raid contract) was added/expired. */
  ACTIVE_DEAL_ADDED: 'deals:active_deal_added',
  ACTIVE_DEAL_REMOVED: 'deals:active_deal_removed',
  /** engine/HallOfFameEngine.js: a new BALANCE.HALL_OF_FAME_BADGES entry was unlocked. */
  BADGE_UNLOCKED: 'hallOfFame:badge_unlocked',
  /** engine/SocialFeedEngine.js: the gym's subscriber count changed. */
  SUBSCRIBERS_CHANGED: 'community:subscribers_changed',
  /** The "Filmer les combattants" toggle was flipped. */
  FILMING_TOGGLED: 'community:filming_toggled',
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
   * @param {Object[]} [config.activeDeals]
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

    /**
     * Timed recurring deals (Underground Circuit gym-stipulation matches —
     * see engine/GymStipulations.js#processActiveDeals, called weekly by
     * web/app.js). Shape: { id, type, weeklyAmount, weeksRemaining }.
     * Plain data only — the weekly payout/countdown logic lives in Engine,
     * never here, exactly like every other State array in this file.
     */
    this.activeDeals = config.activeDeals ? config.activeDeals.map((deal) => ({ ...deal })) : [];

    /** engine/LeagueEngine.js's own 3-tier player-progression id (see BALANCE.LEAGUE_PYRAMID.TIERS) — every new gym starts at the bottom. */
    this.leagueTier = config.leagueTier ?? BALANCE.LEAGUE_PYRAMID.TIER_ORDER[0];
    /** Rolling win/loss (true/false) window over the gym's last BALANCE.LEAGUE_PYRAMID.FIGHT_HISTORY_WINDOW SANCTIONED fights (Underground Circuit/sparring never count) — oldest first, capped at the window size by engine/LeagueEngine.js#recordLeagueFightResult. */
    this.recentFightResults = config.recentFightResults ? [...config.recentFightResults] : [];

    /** engine/HallOfFameEngine.js's 20-badge catalog (BALANCE.HALL_OF_FAME_BADGES) — ids of every badge ever unlocked, permanent (never removed even if the triggering condition later stops holding). */
    this.unlockedBadges = config.unlockedBadges ? [...config.unlockedBadges] : [];

    /** engine/SocialFeedEngine.js's gym-wide TikTok/YouTube-style subscriber count — see BALANCE.COMMUNITY_MANAGER. */
    this.subscribers = config.subscribers ?? BALANCE.COMMUNITY_MANAGER.STARTING_SUBSCRIBERS;
    /** "Filmer les combattants" toggle: boosts subscriber growth/merchandising income, but costs morale for Introverti fighters (see engine/SocialFeedEngine.js#applyFilmingMoralePenalty). Off by default. */
    this.filmingEnabled = config.filmingEnabled ?? false;
  }

  // ---- roster -----------------------------------------------------------

  /**
   * @returns {number} Max roster size at the current facility tier
   *   (BALANCE.GYM.TIERS[equipLevel]), minus any roster-space cost owned
   *   equipment carries (see BALANCE.EQUIPMENT.DEFINITIONS[*].rosterCapacityCost,
   *   e.g. Zone Cardio) — floored at 1 so a capacity-hungry loadout can
   *   never lock the gym out of signing anyone at all.
   */
  getRosterCapacity() {
    const tier = BALANCE.GYM.TIERS[this.equipLevel] ?? BALANCE.GYM.TIERS[BALANCE.GYM.TIERS.length - 1];
    const equipmentSpaceCost = this.equipment.reduce((sum, item) => {
      const def = BALANCE.EQUIPMENT.DEFINITIONS[item?.id];
      return sum + (def?.rosterCapacityCost ?? 0);
    }, 0);
    return Math.max(1, tier.capacity - equipmentSpaceCost);
  }

  /**
   * @returns {Object} The current facility tier record (BALANCE.GYM.TIERS[equipLevel]).
   */
  getFacilityTier() {
    return BALANCE.GYM.TIERS[this.equipLevel] ?? BALANCE.GYM.TIERS[BALANCE.GYM.TIERS.length - 1];
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
   * Forcibly removes one facility level with no cost/refund — the "Gym
   * Takeover" stipulation's defeat consequence (engine/GymStipulations.js):
   * a rival gym seizes equipment, the inverse of upgradeFacility() winning
   * one honestly. No-ops at equipLevel 0 (nothing left to seize).
   *
   * @returns {boolean} True if a level was actually seized.
   */
  seizeFacilityLevel() {
    if (this.equipLevel <= 0) return false;

    this.equipLevel -= 1;
    EventBus.publish(PLAYER_EVENTS.GYM_FACILITY_SEIZED, { equipLevel: this.equipLevel });
    return true;
  }

  /**
   * @param {Object} item
   */
  addEquipmentItem(item) {
    /** New equipment always starts at full quality (see engine/GymInfrastructure.js's weekly degradation/repair). */
    const record = { quality: 1, ...item };
    this.equipment.push(record);
    EventBus.publish(PLAYER_EVENTS.GYM_EQUIPMENT_ADDED, { item: record });
  }

  /**
   * Removes one owned equipment item outright — the inverse of
   * addEquipmentItem(), used by e.g. engine/EmergencyFinanceEngine.js's
   * equipment fire-sale (no refund logic here; the caller credits whatever
   * sale price it decides on before/after calling this).
   * @param {string} equipmentId
   * @returns {Object|null} The removed item record, or null if not owned.
   */
  removeEquipmentItem(equipmentId) {
    const index = this.equipment.findIndex((item) => item.id === equipmentId);
    if (index === -1) return null;

    const [removed] = this.equipment.splice(index, 1);
    EventBus.publish(PLAYER_EVENTS.GYM_EQUIPMENT_REMOVED, { item: removed });
    return removed;
  }

  // ---- active deals (Underground Circuit gym-stipulation matches) -----------------

  /**
   * @param {Object} deal - { type, weeklyAmount, weeksRemaining }.
   * @returns {Object} The stored deal record, with an id assigned if missing.
   */
  addActiveDeal(deal) {
    const record = { id: deal.id ?? generateId('deal'), ...deal };
    this.activeDeals.push(record);
    EventBus.publish(PLAYER_EVENTS.ACTIVE_DEAL_ADDED, { deal: record });
    return record;
  }

  /**
   * @param {string} dealId
   * @returns {boolean} True if a deal was removed.
   */
  removeActiveDeal(dealId) {
    const index = this.activeDeals.findIndex((deal) => deal.id === dealId);
    if (index === -1) return false;

    this.activeDeals.splice(index, 1);
    EventBus.publish(PLAYER_EVENTS.ACTIVE_DEAL_REMOVED, { dealId });
    return true;
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

  // ---- hall of fame badges ----------------------------------------------------

  /**
   * Unlocks one BALANCE.HALL_OF_FAME_BADGES entry, permanently. No-ops
   * (returns false) if already unlocked — badges never re-fire.
   * @param {string} badgeId
   * @returns {boolean} True if this call actually unlocked it (false if already owned).
   */
  unlockBadge(badgeId) {
    if (this.unlockedBadges.includes(badgeId)) return false;
    this.unlockedBadges.push(badgeId);
    EventBus.publish(PLAYER_EVENTS.BADGE_UNLOCKED, { badgeId });
    return true;
  }

  // ---- community manager (V3.5) ------------------------------------------------

  /**
   * @param {number} delta
   * @param {string} [reason='']
   * @returns {number} The new subscriber count (floored at 0).
   */
  changeSubscribers(delta, reason = '') {
    this.subscribers = Math.max(0, Math.round(this.subscribers + delta));
    EventBus.publish(PLAYER_EVENTS.SUBSCRIBERS_CHANGED, { delta, value: this.subscribers, reason });
    return this.subscribers;
  }

  /**
   * @param {boolean} enabled
   */
  setFilmingEnabled(enabled) {
    this.filmingEnabled = Boolean(enabled);
    EventBus.publish(PLAYER_EVENTS.FILMING_TOGGLED, { enabled: this.filmingEnabled });
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
      activeDeals: this.activeDeals.map((deal) => ({ ...deal })),
      leagueTier: this.leagueTier,
      recentFightResults: [...this.recentFightResults],
      unlockedBadges: [...this.unlockedBadges],
      subscribers: this.subscribers,
      filmingEnabled: this.filmingEnabled,
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
