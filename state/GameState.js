/**
 * state/GameState.js
 * ---------------------------------------------------------------------------
 * Top-level orchestrator holding the three state containers the rest of the
 * app talks to:
 *
 *   - worldState   (WorldState)   - the simulated world. SAVED.
 *   - playerState  (PlayerState)  - the player's gym.     SAVED.
 *   - runtimeState (plain object) - transient UI/combat scratch space
 *                                   (current screen, selected fighter,
 *                                   in-progress fight sim, modals...).
 *                                   NEVER SAVED, rebuilt fresh every load.
 *
 * SaveManager's scope contract only accepts WorldState/PlayerState data —
 * GameState is the single place responsible for handing it exactly that,
 * and never runtimeState. This is the only file that should call
 * SaveManager directly; other modules go through GameState instead.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import SaveManager from '../core/SaveManager.js';
import WorldState from './WorldState.js';
import PlayerState from './PlayerState.js';

/** Event names published on EventBus by GameState. Import instead of raw strings. */
export const GAME_EVENTS = Object.freeze({
  NEW_GAME: 'game:new_game',
  STATE_REPLACED: 'game:state_replaced',
  RUNTIME_STATE_RESET: 'game:runtime_state_reset',
});

/**
 * Builds a fresh RuntimeState. Kept as a plain object (not a class) since
 * it is intentionally free-form scratch space owned collectively by
 * Engine/Render — GameState only guarantees it exists and is never saved.
 *
 * @returns {Object}
 */
function createDefaultRuntimeState() {
  return {
    currentScreen: 'MAIN_MENU',
    selectedFighterId: null,
    activeModal: null,
    isPaused: true,
    isSimulationRunning: false,
    combatLog: [],
    uiFlags: {},
  };
}

export class GameState {
  constructor() {
    /** @type {WorldState} */
    this.worldState = new WorldState();
    /** @type {PlayerState} */
    this.playerState = new PlayerState();
    /** @type {Object} */
    this.runtimeState = createDefaultRuntimeState();
  }

  /**
   * Resets everything to a brand new game.
   *
   * @param {Object} [options]
   * @param {string} [options.gymName]
   * @param {string} [options.country]
   * @returns {GameState} this, for chaining.
   */
  newGame({ gymName, country } = {}) {
    this.worldState = new WorldState();
    this.playerState = new PlayerState({ gymName, country });
    this.runtimeState = createDefaultRuntimeState();

    EventBus.publish(GAME_EVENTS.NEW_GAME, {});
    EventBus.publish(GAME_EVENTS.STATE_REPLACED, { reason: 'new' });

    return this;
  }

  /**
   * Persists worldState + playerState (and ONLY those) via SaveManager.
   * runtimeState is intentionally never passed through.
   *
   * @param {string} [slot='default']
   * @returns {Object} The envelope SaveManager wrote (see SaveManager.save).
   */
  save(slot = 'default') {
    return SaveManager.save(this.worldState.toJSON(), this.playerState.toJSON(), slot);
  }

  /**
   * Loads a slot via SaveManager and replaces worldState/playerState with
   * the result. runtimeState is reset to its defaults — nothing transient
   * survives a load.
   *
   * @param {string} [slot='default']
   * @returns {GameState} this, for chaining.
   */
  load(slot = 'default') {
    const { world, player } = SaveManager.load(slot);

    this.worldState = WorldState.fromJSON(world);
    this.playerState = PlayerState.fromJSON(player);
    this.runtimeState = createDefaultRuntimeState();

    EventBus.publish(GAME_EVENTS.STATE_REPLACED, { reason: 'load', slot });

    return this;
  }

  /**
   * Serializes worldState + playerState to a portable JSON string, without
   * touching storage or this.runtimeState.
   *
   * @returns {string}
   */
  exportSave() {
    return SaveManager.exportSave(this.worldState.toJSON(), this.playerState.toJSON());
  }

  /**
   * Imports a JSON string produced by exportSave()/SaveManager.exportSave(),
   * replacing worldState/playerState. runtimeState is reset to its defaults.
   *
   * @param {string} jsonString
   * @returns {GameState} this, for chaining.
   */
  importSave(jsonString) {
    const { world, player } = SaveManager.importSave(jsonString);

    this.worldState = WorldState.fromJSON(world);
    this.playerState = PlayerState.fromJSON(player);
    this.runtimeState = createDefaultRuntimeState();

    EventBus.publish(GAME_EVENTS.STATE_REPLACED, { reason: 'import' });

    return this;
  }

  /**
   * Discards all transient UI/combat scratch state without touching
   * worldState/playerState. Useful when leaving a screen/flow that left
   * runtimeState dirty (e.g. an aborted fight simulation).
   *
   * @returns {GameState} this, for chaining.
   */
  resetRuntimeState() {
    this.runtimeState = createDefaultRuntimeState();
    EventBus.publish(GAME_EVENTS.RUNTIME_STATE_RESET, {});
    return this;
  }
}

// Singleton instance shared across the whole application.
const instance = new GameState();

export default instance;
