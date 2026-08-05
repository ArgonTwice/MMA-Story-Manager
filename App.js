/**
 * App.js
 * ---------------------------------------------------------------------------
 * The composition root: wires State, the reactive engines (CombatEngine,
 * SocialEngine), the weekly progression loop, and every Render component
 * together, and owns the top-level screen flow
 * (StartScreen -> SlotPicker -> Game).
 *
 * This module does not itself decide *how* things are drawn — it only
 * decides *when* renderers exist and what State/Engine instances they're
 * bound to. Each renderer still updates itself independently in reaction
 * to EventBus events, exactly as it does in isolation; App never calls a
 * global "render everything" function.
 * ---------------------------------------------------------------------------
 */

import EventBus from './core/EventBus.js';
import SaveManager from './core/SaveManager.js';
import GameStateSingleton from './state/GameState.js';
import { CombatEngine } from './engine/CombatEngine.js';
import { SocialEngine } from './engine/SocialEngine.js';
import { advanceWeek } from './engine/ProgressionEngine.js';
import DashboardRenderer from './render/DashboardRenderer.js';
import RosterRenderer from './render/RosterRenderer.js';
import CombatRenderer from './render/CombatRenderer.js';
import GymRenderer from './render/GymRenderer.js';
import SocialRenderer from './render/SocialRenderer.js';

/** The three top-level screens App cycles through. */
export const APP_SCREENS = Object.freeze({
  START_SCREEN: 'START_SCREEN',
  SLOT_PICKER: 'SLOT_PICKER',
  GAME: 'GAME',
});

/** Event names published on EventBus by App. Import instead of raw strings. */
export const APP_EVENTS = Object.freeze({
  SCREEN_CHANGED: 'app:screen_changed',
  READY: 'app:ready',
});

export class App {
  /**
   * @param {Object} [options]
   * @param {Object} [options.gameState] - Defaults to the shared GameState
   *   singleton. Inject a fresh `new GameState()` for isolated tests.
   * @param {Object} [options.combatEngine] - Defaults to a fresh CombatEngine
   *   instance owned by this App (kept separate from CombatEngine.js's own
   *   default singleton, which other code may use independently).
   * @param {Object} [options.socialEngine] - Defaults to a fresh SocialEngine instance.
   * @param {Object} [options.mounts] - Optional DOM-like mount elements per
   *   renderer: { dashboard, roster, combat, gym, social }.
   */
  constructor(options = {}) {
    this.gameState = options.gameState ?? GameStateSingleton;
    this.combatEngine = options.combatEngine ?? new CombatEngine();
    this.socialEngine = options.socialEngine ?? new SocialEngine();
    this.mounts = options.mounts ?? {};

    this.screen = APP_SCREENS.START_SCREEN;
    /** @type {Object<string, import('./render/BaseRenderer.js').BaseRenderer>} */
    this.renderers = {};
    this._started = false;
  }

  // ---- browser bootstrap -------------------------------------------------------

  /**
   * Wires this App up to the real DOM: looks up the standard mount points
   * (#hud, #p-dash, #p-roster, #p-fight, #p-gym, #p-social), binds the
   * start-screen form/buttons, the tab bar, and start/game visibility
   * toggling, then shows the start screen. Safe to import/instantiate in
   * Node (e.g. under `node --test`) — this is a no-op there, since
   * `document` doesn't exist outside a browser; nothing here runs unless
   * something explicitly calls start().
   *
   * @returns {App} this, for chaining.
   */
  start() {
    if (typeof document === 'undefined') return this;
    if (this._started) return this;
    this._started = true;

    this.mounts = {
      hud: document.getElementById('hud'),
      dashboard: document.getElementById('p-dash'),
      roster: document.getElementById('p-roster'),
      combat: document.getElementById('p-fight'),
      gym: document.getElementById('p-gym'),
      social: document.getElementById('p-social'),
    };

    this._wireStartScreen();
    this._wireTabBar();
    this._wireScreenVisibility();

    this.showStartScreen();
    return this;
  }

  _wireStartScreen() {
    const btnNewGame = document.getElementById('btnNewGame');
    const nameInput = document.getElementById('newGymName');
    const countryInput = document.getElementById('newGymCountry');
    btnNewGame?.addEventListener('click', () => {
      this.startNewGame({
        gymName: nameInput?.value || undefined,
        country: countryInput?.value || undefined,
      });
    });

    const btnShowSlots = document.getElementById('btnShowSlots');
    const slotList = document.getElementById('slotList');
    btnShowSlots?.addEventListener('click', () => {
      const slots = this.showSlotPicker();
      if (!slotList) return;
      slotList.innerHTML = slots.length
        ? slots
            .map((slot) => `<li><button class="btn btn-outline slot-btn" data-slot="${slot}">${slot}</button></li>`)
            .join('')
        : '<li class="empty">Aucune sauvegarde disponible.</li>';
      slotList.querySelectorAll('.slot-btn').forEach((button) => {
        button.addEventListener('click', () => this.loadGame(button.dataset.slot));
      });
    });
  }

  _wireTabBar() {
    const tabButtons = Array.from(document.querySelectorAll('#tabbar .tab-btn'));
    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.tab;
        tabButtons.forEach((b) => b.classList.toggle('active', b === button));
        document.querySelectorAll('#panels .panel').forEach((panel) => {
          panel.classList.toggle('active', panel.id === `p-${target}`);
        });
      });
    });

    document.getElementById('btnAdvanceWeek')?.addEventListener('click', () => this.advanceWeek());
  }

  _wireScreenVisibility() {
    EventBus.subscribe(APP_EVENTS.SCREEN_CHANGED, ({ to }) => {
      const startScreen = document.getElementById('startScreen');
      const gameShell = document.getElementById('gameShell');
      if (!startScreen || !gameShell) return;
      const inGame = to === APP_SCREENS.GAME;
      startScreen.classList.toggle('hidden', inGame);
      gameShell.classList.toggle('hidden', !inGame);
    });
  }

  // ---- screen flow ------------------------------------------------------------

  /** Leaves the game (if any) and returns to the start screen. */
  showStartScreen() {
    this._teardownRenderers();
    this.socialEngine.detach();
    this._setScreen(APP_SCREENS.START_SCREEN);
    return this.screen;
  }

  /** @returns {string[]} Available save slot names, and switches to the picker screen. */
  showSlotPicker() {
    this._setScreen(APP_SCREENS.SLOT_PICKER);
    return SaveManager.listSlots();
  }

  /**
   * Starts a brand new game and enters the GAME screen.
   * @param {Object} [options]
   * @param {string} [options.gymName]
   * @param {string} [options.country]
   * @returns {Object} The active GameState.
   */
  startNewGame({ gymName, country } = {}) {
    this.gameState.newGame({ gymName, country });
    this._enterGame();
    return this.gameState;
  }

  /**
   * Loads a save slot and enters the GAME screen.
   * @param {string} [slot='default']
   * @returns {Object} The active GameState.
   */
  loadGame(slot = 'default') {
    this.gameState.load(slot);
    this._enterGame();
    return this.gameState;
  }

  /**
   * @param {string} [slot='default']
   * @returns {Object} The save envelope written (see SaveManager.save).
   */
  saveGame(slot = 'default') {
    return this.gameState.save(slot);
  }

  // ---- gameplay actions (thin pass-throughs to the underlying engines) --------

  /**
   * Advances the world by one week (Training, Economy, Narrative Events,
   * birthdays, rival gyms — see engine/ProgressionEngine.js).
   * @returns {Object} The weekly summary.
   */
  advanceWeek() {
    return advanceWeek(this.gameState);
  }

  /**
   * Starts a new match on this App's CombatEngine (CombatRenderer, already
   * mounted, will pick up every step reactively).
   * @param {Object} fighterA
   * @param {Object} fighterB
   * @param {string} orgId
   * @param {boolean} [isTitle=false]
   * @returns {Object} The CombatEngine instance driving the fight.
   */
  startFight(fighterA, fighterB, orgId, isTitle = false) {
    this.combatEngine.setupMatch(fighterA, fighterB, orgId, isTitle);
    return this.combatEngine;
  }

  // ---- internals ------------------------------------------------------------

  _enterGame() {
    this.combatEngine.attachContext({
      playerState: this.gameState.playerState,
      worldState: this.gameState.worldState,
      runtimeState: this.gameState.runtimeState,
    });

    this.socialEngine.detach();
    this.socialEngine.attach(this.gameState.playerState);

    this._mountRenderers();
    this._setScreen(APP_SCREENS.GAME);
    EventBus.publish(APP_EVENTS.READY, { screen: this.screen });
  }

  _mountRenderers() {
    this._teardownRenderers();
    const { playerState, worldState } = this.gameState;

    this.renderers.dashboard = new DashboardRenderer({
      playerState,
      worldState,
      mount: this.mounts.dashboard,
      hudMount: this.mounts.hud,
    }).attach();

    this.renderers.roster = new RosterRenderer({ playerState, mount: this.mounts.roster }).attach();

    this.renderers.combat = new CombatRenderer({
      combatEngine: this.combatEngine,
      mount: this.mounts.combat,
    }).attach();

    this.renderers.gym = new GymRenderer({ playerState, worldState, mount: this.mounts.gym }).attach();

    this.renderers.social = new SocialRenderer({ playerState, mount: this.mounts.social }).attach();
  }

  _teardownRenderers() {
    Object.values(this.renderers).forEach((renderer) => renderer.detach());
    this.renderers = {};
  }

  _setScreen(screen) {
    const previous = this.screen;
    this.screen = screen;
    EventBus.publish(APP_EVENTS.SCREEN_CHANGED, { from: previous, to: screen });
  }
}

// Default singleton wiring the whole game together. Construct `new App(...)`
// directly for isolated tests or for running multiple independent instances.
const instance = new App();
export default instance;
