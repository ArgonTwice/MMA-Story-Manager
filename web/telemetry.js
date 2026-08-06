/**
 * web/telemetry.js — Phase Beta ("Players First — Analytics, Frustration
 * Detector & Story Export")
 * ---------------------------------------------------------------------------
 * Anonymous, local-only behavioral telemetry for the mobile web app. No
 * network calls, no player-identifying data (no gym name, no fighter names,
 * nothing beyond ids/counts/timestamps) — everything lives in its own
 * localStorage key, entirely separate from core/SaveManager.js's save
 * envelopes (that module is STRICTLY WorldState/PlayerState only, see its
 * own header — a behavioral log is neither, so it gets its own namespace
 * and its own tiny storage adapter rather than being smuggled into a save).
 *
 * Same storage-adapter-with-in-memory-fallback trick as SaveManager, kept
 * as a small local copy (not imported) — the same "each module keeps its
 * own local helpers" precedent already used by engine/TransferMarket.js and
 * engine/ProspectGenerator.js's own name lists — so this file stays fully
 * Node-testable via `node --test` without a browser, and web/app.js can
 * still use it against real localStorage with zero extra wiring.
 *
 * Tracks exactly what the phase asks for, nothing more:
 *   - session length: weeks played before the app is closed/reloaded.
 *   - Drama Engine decisions: which choiceId was picked for which eventId.
 *   - fighter retention: how many ever-recruited fighters are still on the
 *     roster right now (same honest caveat as tools/BalanceReporter.js's
 *     Roster Attachment Index — this game has no player-side cut/transfer
 *     mechanic yet, so a near-100% rate is an expected, real result, not a
 *     measurement bug).
 *   - frustration signals: financial bankruptcy and prolonged low morale
 *     (BALANCE.TELEMETRY.LOW_MORALE_THRESHOLD for several consecutive
 *     weeks, BALANCE.TELEMETRY.LOW_MORALE_STREAK_WEEKS_THRESHOLD running —
 *     see that BALANCE section for why those exact numbers were chosen).
 *     Both are edge-triggered (logged once when the bad state is entered,
 *     not once per week it persists) so the log stays meaningful instead
 *     of flooding with duplicates.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';

const STORAGE_KEY = 'mma_gym_manager.telemetry';
const TELEMETRY_VERSION = 1;

function createStorageAdapter() {
  const hasLocalStorage = (() => {
    try {
      return typeof localStorage !== 'undefined';
    } catch {
      return false;
    }
  })();

  if (hasLocalStorage) {
    return {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
    };
  }

  const memoryStore = new Map();
  return {
    getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
    setItem: (key, value) => memoryStore.set(key, value),
  };
}

function blankData() {
  return {
    version: TELEMETRY_VERSION,
    sessions: [],
    currentSession: null,
    dramaChoices: [],
    dramaChoiceCounts: {},
    totalFightersRecruited: 0,
    frustrationEvents: [],
  };
}

function trimToLimit(list) {
  const limit = BALANCE.TELEMETRY.LOG_HISTORY_LIMIT;
  if (list.length > limit) list.splice(0, list.length - limit);
}

export class Telemetry {
  /**
   * @param {Object} [storageAdapter] - Defaults to localStorage, falling
   *   back to an in-memory Map (Node/tests, or privacy modes that block
   *   Web Storage) — see createStorageAdapter().
   */
  constructor(storageAdapter = createStorageAdapter()) {
    this._storage = storageAdapter;
    this._data = this._load();
    /** { [fighterId]: number } consecutive-weeks-below-threshold streak, runtime-only (not persisted — a fresh streak count on reload is an acceptable simplification for a "prolonged" signal). */
    this._moraleStreaks = {};
    /** Edge-trigger latch for the bankruptcy signal, runtime-only. */
    this._wasInsolvent = false;
  }

  // ---- persistence --------------------------------------------------------

  _load() {
    try {
      const raw = this._storage.getItem(STORAGE_KEY);
      if (!raw) return blankData();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.version !== TELEMETRY_VERSION) return blankData();
      return { ...blankData(), ...parsed };
    } catch {
      return blankData();
    }
  }

  _persist() {
    try {
      this._storage.setItem(STORAGE_KEY, JSON.stringify(this._data));
    } catch {
      // Best-effort only: a full/blocked localStorage must never break gameplay.
    }
  }

  // ---- session length -------------------------------------------------------

  /**
   * Call once per app boot (new game, continue, or slot load). Closes out
   * any session left dangling by a previous run that never called
   * endSession() (tab closed without a clean unload — unload events are
   * unreliable on mobile, so this reconciliation happens on the NEXT boot
   * instead of relying on beforeunload), then opens a fresh one.
   */
  startSession() {
    if (this._data.currentSession) {
      this._data.sessions.push({ ...this._data.currentSession, endedAt: this._data.currentSession.endedAt ?? new Date().toISOString() });
      trimToLimit(this._data.sessions);
    }
    this._data.currentSession = { startedAt: new Date().toISOString(), endedAt: null, weeksPlayed: 0 };
    this._persist();
  }

  /** Call every time a week is fully resolved (see web/app.js#_completeWeek). */
  recordWeekResolved() {
    if (!this._data.currentSession) this.startSession();
    this._data.currentSession.weeksPlayed += 1;
    this._persist();
  }

  // ---- Drama Engine decisions ------------------------------------------------

  /**
   * @param {string} eventId - data/events.js event id.
   * @param {string} choiceId
   */
  recordDramaChoice(eventId, choiceId) {
    this._data.dramaChoices.push({ eventId, choiceId, at: new Date().toISOString() });
    trimToLimit(this._data.dramaChoices);

    const key = `${eventId}:${choiceId}`;
    this._data.dramaChoiceCounts[key] = (this._data.dramaChoiceCounts[key] ?? 0) + 1;
    this._persist();
  }

  // ---- fighter retention ------------------------------------------------------

  /** Call once per fighter that ever joins the player's roster (bootstrap + Academy Draft — see web/app.js's two playerState.addFighter() call sites). */
  recordFighterRecruited() {
    this._data.totalFightersRecruited += 1;
    this._persist();
  }

  /**
   * @param {number} currentRosterSize - playerState.roster.length right now.
   * @returns {number|null} currentRosterSize / totalFightersRecruited, or null if nothing has been recruited yet.
   */
  getRetentionRate(currentRosterSize) {
    if (this._data.totalFightersRecruited === 0) return null;
    return currentRosterSize / this._data.totalFightersRecruited;
  }

  // ---- frustration signals ----------------------------------------------------

  /**
   * Call once per resolved week (see web/app.js#_completeWeek). Pure read
   * of the given PlayerState — never mutates it.
   * @param {Object} playerState
   */
  checkFrustrationSignals(playerState) {
    this._checkBankruptcySignal(playerState);
    this._checkMoraleSignal(playerState);
  }

  _checkBankruptcySignal(playerState) {
    const isInsolvent = playerState.money < 0;
    if (isInsolvent && !this._wasInsolvent) {
      this._logFrustration('BANKRUPTCY', { balance: Math.round(playerState.money) });
    }
    this._wasInsolvent = isInsolvent;
  }

  _checkMoraleSignal(playerState) {
    const threshold = BALANCE.TELEMETRY.LOW_MORALE_THRESHOLD;
    const streakTarget = BALANCE.TELEMETRY.LOW_MORALE_STREAK_WEEKS_THRESHOLD;
    const stillRosteredIds = new Set(playerState.roster.map((fighter) => fighter.identity.id));

    for (const fighter of playerState.roster) {
      const id = fighter.identity.id;
      if (fighter.attributes.moral < threshold) {
        const streak = (this._moraleStreaks[id] ?? 0) + 1;
        this._moraleStreaks[id] = streak;
        if (streak === streakTarget) {
          this._logFrustration('LOW_MORALE_PROLONGED', { fighterId: id, weeks: streak });
        }
      } else {
        delete this._moraleStreaks[id];
      }
    }

    // A fighter who left the roster (retirement) can't keep accumulating a streak.
    for (const id of Object.keys(this._moraleStreaks)) {
      if (!stillRosteredIds.has(id)) delete this._moraleStreaks[id];
    }
  }

  _logFrustration(type, detail) {
    this._data.frustrationEvents.push({ type, detail, at: new Date().toISOString() });
    trimToLimit(this._data.frustrationEvents);
    this._persist();
  }

  // ---- export ---------------------------------------------------------------

  /**
   * @param {number} [currentRosterSize] - Optional, includes a live retention rate when supplied.
   * @returns {Object} A deep copy of the anonymous telemetry blob.
   */
  getSummary(currentRosterSize) {
    const sessions = [...this._data.sessions];
    if (this._data.currentSession) sessions.push({ ...this._data.currentSession, endedAt: this._data.currentSession.endedAt ?? 'en cours' });

    return {
      version: this._data.version,
      sessions,
      totalWeeksPlayed: sessions.reduce((sum, s) => sum + s.weeksPlayed, 0),
      dramaChoiceCounts: { ...this._data.dramaChoiceCounts },
      totalFightersRecruited: this._data.totalFightersRecruited,
      retentionRate: currentRosterSize === undefined ? null : this.getRetentionRate(currentRosterSize),
      frustrationEvents: [...this._data.frustrationEvents],
    };
  }

  /**
   * @param {number} [currentRosterSize]
   * @returns {string} JSON-encoded telemetry blob, for a "download my data" / "share with the devs" flow.
   */
  exportAsJSON(currentRosterSize) {
    return JSON.stringify(this.getSummary(currentRosterSize), null, 2);
  }
}

const instance = new Telemetry();
export default instance;
