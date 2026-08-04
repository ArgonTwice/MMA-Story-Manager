/**
 * render/BaseRenderer.js
 * ---------------------------------------------------------------------------
 * Shared plumbing for every Render component: EventBus subscription
 * bookkeeping, a plain-object view model, and a single "flush" step that
 * writes to an optional DOM mount and/or an optional onRender callback.
 *
 * Framework-agnostic on purpose: this project has no bundler/DOM library
 * committed yet, so "rendering" here means computing a structured view
 * model (the stable, testable contract) and, if a real mount element was
 * provided, writing a plain HTML string into it. Swapping in a real UI
 * framework later only means replacing toHTML()/the mount-writing step —
 * the event-driven view-model computation in each concrete renderer stays
 * the same.
 *
 * THE CORE RULE: no renderer ever re-renders anything but itself, and only
 * in reaction to the specific EventBus events it subscribes to in attach().
 * There is no global renderAll().
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';

export class BaseRenderer {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.mount] - A DOM-like element exposing
   *   `.innerHTML` (or any object with that property). Optional — renderers
   *   work fine headless, which is how they're unit-tested.
   * @param {(viewModel: Object) => void} [options.onRender] - Called after
   *   every render with the fresh view model. Optional; the primary hook
   *   used by tests and by non-DOM consumers (e.g. a different UI layer).
   */
  constructor(options = {}) {
    this.mount = options.mount ?? null;
    this.onRender = options.onRender ?? null;
    /** @type {Object} */
    this.viewModel = {};
    /** @type {Function[]} */
    this._unsubs = [];
  }

  /**
   * Subscribes to one EventBus event and tracks the unsubscribe function so
   * detach() can clean it up. Concrete renderers call this from attach().
   * @param {string} eventName
   * @param {(payload: *) => void} handler
   */
  _subscribe(eventName, handler) {
    this._unsubs.push(EventBus.subscribe(eventName, handler));
  }

  /** Unsubscribes from every event this renderer is listening to. */
  detach() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
  }

  /**
   * Writes the current view model to the mount (if any) and notifies
   * onRender (if any). Concrete renderers call this after updating
   * this.viewModel.
   * @returns {Object} The current view model, for convenience.
   */
  _flush() {
    if (this.mount) {
      this.mount.innerHTML = this.toHTML();
    }
    this.onRender?.(this.viewModel);
    return this.viewModel;
  }

  /**
   * @returns {Object} The current view model (read-only by convention —
   *   callers should not mutate the returned object).
   */
  getViewModel() {
    return this.viewModel;
  }

  /**
   * Renders the current view model as an HTML string. Overridden by every
   * concrete renderer; the base implementation is an empty shell so a
   * renderer that forgets to override it fails loudly-ish rather than
   * throwing.
   * @returns {string}
   */
  toHTML() {
    return '';
  }
}

export default BaseRenderer;
