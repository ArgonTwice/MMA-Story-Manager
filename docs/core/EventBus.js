/**
 * EventBus.js
 * ---------------------------------------------------------------------------
 * Lightweight Publish/Subscribe event bus used as the sole communication
 * channel between decoupled modules (State, Engine, Render, Models, Data).
 *
 * Design rules for the V2 architecture:
 *   - No module should import another module's internals to talk to it.
 *     Instead it publishes an event, and interested modules subscribe.
 *   - The bus carries no game knowledge. It has no idea what "FIGHT_RESOLVED"
 *     or "CONTRACT_SIGNED" mean — event names and payload shapes are a
 *     contract owned by the modules that emit/consume them.
 *
 * Usage:
 *   import EventBus from '../core/EventBus.js';
 *
 *   const unsubscribe = EventBus.subscribe('FIGHT_RESOLVED', (payload) => {
 *     console.log(payload);
 *   });
 *
 *   EventBus.publish('FIGHT_RESOLVED', { winnerId: 'f_001' });
 *
 *   unsubscribe(); // or EventBus.unsubscribe('FIGHT_RESOLVED', handler)
 * ---------------------------------------------------------------------------
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();

    /** @type {Map<string, Set<Function>>} one-shot listeners, pruned after firing */
    this._onceListeners = new Map();
  }

  /**
   * Subscribe to an event.
   *
   * @param {string} eventName - Name of the event to listen for.
   * @param {Function} callback - Invoked with (payload) when the event fires.
   * @returns {Function} unsubscribe - Call to remove this exact subscription.
   */
  subscribe(eventName, callback) {
    this._assertEventName(eventName);
    this._assertCallback(callback);

    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
    }
    this._listeners.get(eventName).add(callback);

    return () => this.unsubscribe(eventName, callback);
  }

  /**
   * Subscribe to an event for a single invocation only.
   * Automatically unsubscribes itself after the first time it fires.
   *
   * @param {string} eventName
   * @param {Function} callback
   * @returns {Function} unsubscribe
   */
  once(eventName, callback) {
    this._assertEventName(eventName);
    this._assertCallback(callback);

    if (!this._onceListeners.has(eventName)) {
      this._onceListeners.set(eventName, new Set());
    }
    this._onceListeners.get(eventName).add(callback);

    return () => {
      const set = this._onceListeners.get(eventName);
      if (set) set.delete(callback);
    };
  }

  /**
   * Remove a previously registered listener (subscribe or once).
   *
   * @param {string} eventName
   * @param {Function} callback
   */
  unsubscribe(eventName, callback) {
    this._listeners.get(eventName)?.delete(callback);
    this._onceListeners.get(eventName)?.delete(callback);
  }

  /**
   * Publish (emit) an event to all subscribers, synchronously, in
   * subscription order. A throwing listener is caught and logged so it
   * cannot break other subscribers or the caller.
   *
   * @param {string} eventName
   * @param {*} [payload] - Arbitrary data passed to each listener.
   */
  publish(eventName, payload) {
    this._assertEventName(eventName);

    const regular = this._listeners.get(eventName);
    if (regular) {
      // Snapshot to array: a listener may subscribe/unsubscribe during publish.
      for (const callback of Array.from(regular)) {
        this._safeInvoke(callback, payload, eventName);
      }
    }

    const once = this._onceListeners.get(eventName);
    if (once && once.size > 0) {
      const callbacks = Array.from(once);
      once.clear();
      for (const callback of callbacks) {
        this._safeInvoke(callback, payload, eventName);
      }
    }
  }

  /**
   * Remove listeners.
   * - clear() with no args wipes every event.
   * - clear(eventName) wipes only that event's listeners (regular + once).
   */
  clear(eventName) {
    if (eventName === undefined) {
      this._listeners.clear();
      this._onceListeners.clear();
      return;
    }
    this._assertEventName(eventName);
    this._listeners.delete(eventName);
    this._onceListeners.delete(eventName);
  }

  /**
   * Number of active listeners for an event (regular + once). Useful for
   * debugging leaks in dev tools.
   *
   * @param {string} eventName
   * @returns {number}
   */
  listenerCount(eventName) {
    const regular = this._listeners.get(eventName)?.size ?? 0;
    const once = this._onceListeners.get(eventName)?.size ?? 0;
    return regular + once;
  }

  // ---- internals ----------------------------------------------------------

  _safeInvoke(callback, payload, eventName) {
    try {
      callback(payload);
    } catch (error) {
      // A single bad subscriber must never break the publish chain.
      console.error(`[EventBus] Listener for "${eventName}" threw:`, error);
    }
  }

  _assertEventName(eventName) {
    if (typeof eventName !== 'string' || eventName.length === 0) {
      throw new TypeError('[EventBus] eventName must be a non-empty string.');
    }
  }

  _assertCallback(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('[EventBus] callback must be a function.');
    }
  }
}

// Singleton instance shared across the whole application.
const instance = new EventBus();

export default instance;
export { EventBus };
