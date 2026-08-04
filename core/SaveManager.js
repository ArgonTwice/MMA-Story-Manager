/**
 * core/SaveManager.js
 * ---------------------------------------------------------------------------
 * Versioned save/load system.
 *
 * Scope contract (STRICT):
 *   SaveManager persists WorldState and PlayerState ONLY.
 *   - WorldState  : the simulated universe (fighters, gyms, calendar, events,
 *                    economy, promotions...) — anything the Engine mutates.
 *   - PlayerState : the human player's own progress/choices (their gym id,
 *                    settings that must persist, unlocked content...).
 *   It NEVER touches:
 *   - UI state (open panels, scroll position, selected tab...)
 *   - RuntimeState (transient simulation caches, animation flags, timers...)
 *   Those are rebuilt on load and must never be serialized. Callers who pass
 *   anything else in are a bug, not a feature — keep it that way.
 *
 * Responsibilities:
 *   - Wrap state in a versioned envelope { version, savedAt, world, player }.
 *   - Persist to / read from a storage backend (localStorage by default,
 *     with an in-memory fallback so this module also works in Node/tests).
 *   - Export/import as portable JSON strings (for manual backups, sharing,
 *     or cloud-save payloads).
 *   - Detect stale save versions and run them through registered migrations
 *     until they match CURRENT_SAVE_VERSION, or reject them if they're from
 *     a future/unsupported version.
 *
 * Communication: SaveManager publishes lifecycle events on the shared
 * EventBus instead of returning callbacks, so Render/UI modules can react
 * (toast "Game saved", error banner, etc.) without SaveManager knowing they
 * exist.
 * ---------------------------------------------------------------------------
 */

import EventBus from './EventBus.js';

/** Bump this whenever the shape of WorldState or PlayerState changes. */
const CURRENT_SAVE_VERSION = 1;

/** Save files older than this version can no longer be migrated forward. */
const MIN_SUPPORTED_SAVE_VERSION = 1;

/** Event names published on EventBus. Import these instead of raw strings. */
const SAVE_EVENTS = Object.freeze({
  SAVE_STARTED: 'SAVE_STARTED',
  SAVE_COMPLETED: 'SAVE_COMPLETED',
  SAVE_FAILED: 'SAVE_FAILED',
  LOAD_STARTED: 'LOAD_STARTED',
  LOAD_COMPLETED: 'LOAD_COMPLETED',
  LOAD_FAILED: 'LOAD_FAILED',
  IMPORT_COMPLETED: 'IMPORT_COMPLETED',
  IMPORT_FAILED: 'IMPORT_FAILED',
  MIGRATION_APPLIED: 'MIGRATION_APPLIED',
  SLOT_DELETED: 'SLOT_DELETED',
});

const STORAGE_KEY_PREFIX = 'mma_gym_manager.save.';
const SLOT_INDEX_KEY = 'mma_gym_manager.save_index';

/**
 * Migration registry: maps a save version to the function that upgrades
 * an envelope FROM that version TO version+1. Keep every migration pure
 * (no side effects) and additive — never delete a migration once players
 * may have saves at that version.
 *
 * Example (uncomment when version 2 introduces a `player.difficulty` field):
 *   1: (envelope) => {
 *     envelope.player.difficulty = 'normal';
 *     envelope.version = 2;
 *     return envelope;
 *   },
 *
 * @type {Record<number, (envelope: SaveEnvelope) => SaveEnvelope>}
 */
const MIGRATIONS = {
  // Intentionally empty at V1. Add entries as the schema evolves.
};

/**
 * @typedef {Object} SaveEnvelope
 * @property {number} version
 * @property {string} savedAt - ISO 8601 timestamp.
 * @property {string} slot
 * @property {Object} world - Serialized WorldState.
 * @property {Object} player - Serialized PlayerState.
 */

// ---------------------------------------------------------------------------
// Storage backend: localStorage when available, in-memory Map fallback
// otherwise (Node, tests, or privacy modes that block Web Storage).
// ---------------------------------------------------------------------------

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
      removeItem: (key) => localStorage.removeItem(key),
    };
  }

  const memoryStore = new Map();
  return {
    getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
    setItem: (key, value) => memoryStore.set(key, value),
    removeItem: (key) => memoryStore.delete(key),
  };
}

class SaveManager {
  constructor(storageAdapter = createStorageAdapter()) {
    this._storage = storageAdapter;
  }

  // ---- public API -----------------------------------------------------

  /**
   * Serialize and persist WorldState + PlayerState under a named slot.
   *
   * @param {Object} worldState
   * @param {Object} playerState
   * @param {string} [slot='default']
   * @returns {SaveEnvelope} the envelope that was written.
   */
  save(worldState, playerState, slot = 'default') {
    EventBus.publish(SAVE_EVENTS.SAVE_STARTED, { slot });

    try {
      this._assertSerializableState(worldState, 'worldState');
      this._assertSerializableState(playerState, 'playerState');

      /** @type {SaveEnvelope} */
      const envelope = {
        version: CURRENT_SAVE_VERSION,
        savedAt: new Date().toISOString(),
        slot,
        world: worldState,
        player: playerState,
      };

      this._storage.setItem(this._slotKey(slot), JSON.stringify(envelope));
      this._registerSlot(slot);

      EventBus.publish(SAVE_EVENTS.SAVE_COMPLETED, { slot, savedAt: envelope.savedAt });
      return envelope;
    } catch (error) {
      EventBus.publish(SAVE_EVENTS.SAVE_FAILED, { slot, error: this._errorMessage(error) });
      throw error;
    }
  }

  /**
   * Load a slot, migrating it to CURRENT_SAVE_VERSION if needed.
   *
   * @param {string} [slot='default']
   * @returns {{ world: Object, player: Object, version: number, savedAt: string }}
   */
  load(slot = 'default') {
    EventBus.publish(SAVE_EVENTS.LOAD_STARTED, { slot });

    try {
      const raw = this._storage.getItem(this._slotKey(slot));
      if (!raw) {
        throw new Error(`No save found in slot "${slot}".`);
      }

      const envelope = this._migrate(this._parseEnvelope(raw));

      EventBus.publish(SAVE_EVENTS.LOAD_COMPLETED, {
        slot,
        version: envelope.version,
        savedAt: envelope.savedAt,
      });

      return {
        world: envelope.world,
        player: envelope.player,
        version: envelope.version,
        savedAt: envelope.savedAt,
      };
    } catch (error) {
      EventBus.publish(SAVE_EVENTS.LOAD_FAILED, { slot, error: this._errorMessage(error) });
      throw error;
    }
  }

  /**
   * Serialize WorldState + PlayerState to a portable JSON string, without
   * touching storage. Use for "export to file" / "copy to clipboard" flows.
   *
   * @param {Object} worldState
   * @param {Object} playerState
   * @returns {string} JSON-encoded SaveEnvelope.
   */
  exportSave(worldState, playerState) {
    this._assertSerializableState(worldState, 'worldState');
    this._assertSerializableState(playerState, 'playerState');

    /** @type {SaveEnvelope} */
    const envelope = {
      version: CURRENT_SAVE_VERSION,
      savedAt: new Date().toISOString(),
      slot: 'export',
      world: worldState,
      player: playerState,
    };

    return JSON.stringify(envelope, null, 2);
  }

  /**
   * Parse and migrate a JSON string produced by exportSave() (or a raw
   * stored envelope). Does not write to storage — the caller decides what
   * to do with the resulting state (e.g. hand it to State modules, or
   * follow up with save() to persist it under a slot).
   *
   * @param {string} jsonString
   * @returns {{ world: Object, player: Object, version: number, savedAt: string }}
   */
  importSave(jsonString) {
    try {
      const envelope = this._migrate(this._parseEnvelope(jsonString));

      EventBus.publish(SAVE_EVENTS.IMPORT_COMPLETED, {
        version: envelope.version,
        savedAt: envelope.savedAt,
      });

      return {
        world: envelope.world,
        player: envelope.player,
        version: envelope.version,
        savedAt: envelope.savedAt,
      };
    } catch (error) {
      EventBus.publish(SAVE_EVENTS.IMPORT_FAILED, { error: this._errorMessage(error) });
      throw error;
    }
  }

  /**
   * Whether a save of the given version can be loaded (as-is or via
   * migration) by this build.
   *
   * @param {number} version
   * @returns {boolean}
   */
  isCompatible(version) {
    return (
      typeof version === 'number' &&
      version >= MIN_SUPPORTED_SAVE_VERSION &&
      version <= CURRENT_SAVE_VERSION
    );
  }

  /**
   * List slot names that currently have a save.
   * @returns {string[]}
   */
  listSlots() {
    const raw = this._storage.getItem(SLOT_INDEX_KEY);
    if (!raw) return [];
    try {
      const slots = JSON.parse(raw);
      return Array.isArray(slots) ? slots : [];
    } catch {
      return [];
    }
  }

  /**
   * Delete a save slot.
   * @param {string} [slot='default']
   */
  deleteSlot(slot = 'default') {
    this._storage.removeItem(this._slotKey(slot));
    const slots = this.listSlots().filter((existing) => existing !== slot);
    this._storage.setItem(SLOT_INDEX_KEY, JSON.stringify(slots));
    EventBus.publish(SAVE_EVENTS.SLOT_DELETED, { slot });
  }

  // ---- internals --------------------------------------------------------

  _slotKey(slot) {
    return `${STORAGE_KEY_PREFIX}${slot}`;
  }

  _registerSlot(slot) {
    const slots = this.listSlots();
    if (!slots.includes(slot)) {
      slots.push(slot);
      this._storage.setItem(SLOT_INDEX_KEY, JSON.stringify(slots));
    }
  }

  /**
   * @param {string} raw
   * @returns {SaveEnvelope}
   */
  _parseEnvelope(raw) {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error('Save data is not valid JSON.');
    }

    if (
      !envelope ||
      typeof envelope !== 'object' ||
      typeof envelope.version !== 'number' ||
      typeof envelope.world !== 'object' ||
      typeof envelope.player !== 'object'
    ) {
      throw new Error('Save data is missing required fields (version, world, player).');
    }

    if (envelope.version > CURRENT_SAVE_VERSION) {
      throw new Error(
        `Save was created by a newer game version (v${envelope.version}); ` +
          `this build only supports up to v${CURRENT_SAVE_VERSION}.`
      );
    }

    if (envelope.version < MIN_SUPPORTED_SAVE_VERSION) {
      throw new Error(
        `Save version v${envelope.version} predates the oldest supported version ` +
          `(v${MIN_SUPPORTED_SAVE_VERSION}) and can no longer be migrated.`
      );
    }

    return envelope;
  }

  /**
   * Runs the envelope through MIGRATIONS until it reaches CURRENT_SAVE_VERSION.
   * @param {SaveEnvelope} envelope
   * @returns {SaveEnvelope}
   */
  _migrate(envelope) {
    let current = envelope;

    while (current.version < CURRENT_SAVE_VERSION) {
      const migrate = MIGRATIONS[current.version];
      if (typeof migrate !== 'function') {
        throw new Error(
          `No migration registered to upgrade save from v${current.version}. ` +
            `Cannot reach v${CURRENT_SAVE_VERSION}.`
        );
      }

      const fromVersion = current.version;
      current = migrate(current);

      if (current.version !== fromVersion + 1) {
        throw new Error(
          `Migration from v${fromVersion} did not advance the version correctly ` +
            `(expected v${fromVersion + 1}, got v${current.version}).`
        );
      }

      EventBus.publish(SAVE_EVENTS.MIGRATION_APPLIED, {
        from: fromVersion,
        to: current.version,
      });
    }

    return current;
  }

  _assertSerializableState(state, label) {
    if (!state || typeof state !== 'object') {
      throw new TypeError(`SaveManager: ${label} must be a plain object.`);
    }
    try {
      JSON.stringify(state);
    } catch {
      throw new TypeError(`SaveManager: ${label} is not JSON-serializable.`);
    }
  }

  _errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Singleton instance shared across the whole application.
const instance = new SaveManager();

export default instance;
export { SaveManager, SAVE_EVENTS, CURRENT_SAVE_VERSION, MIN_SUPPORTED_SAVE_VERSION };
