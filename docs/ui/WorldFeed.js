/**
 * ui/WorldFeed.js — Phase 4.3 ("Player Experience & Vertical Slice")
 * ---------------------------------------------------------------------------
 * Makes engine/HistoryEngine.js's and engine/LegacyEngine.js's data actually
 * readable to a player — before this, a world record breaking or a
 * champion's Hall of Fame induction had zero visible trace anywhere in the
 * render/ layer (see engine/WorldMemory.js's fastestKO/biggestFight, which
 * were tracked since an earlier phase but never surfaced until
 * tools/BalanceReporter.js's Phase 4.2 section; the real game had nothing
 * at all).
 *
 * An append-only rolling log, EventBus-reactive like render/DashboardRenderer.js
 * (a "feed" is inherently a log across many independent sources, not a
 * pull-on-demand snapshot like ui/GymHub.js) — but framework-agnostic like
 * every other Phase 4.3 ui/ module: no DOM assumption, a plain toText() for
 * the CLI.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import { WORLD_EVENTS } from '../state/WorldState.js';
import { DRAMA_ENGINE_EVENTS } from '../engine/DramaEngine.js';
import { NARRATIVE_ENGINE_EVENTS } from '../engine/NarrativeEngine.js';
import { COMBAT_EVENTS } from '../engine/CombatEngine.js';
import { DRAMA_EVENTS } from '../data/events.js';

/** How many entries WorldFeed keeps — a display concern, not gameplay balance (mirrors render/DashboardRenderer.js's own LOG_DISPLAY_LIMIT precedent). */
const FEED_HISTORY_LIMIT = 100;

export class WorldFeed {
  /**
   * @param {Object} options
   * @param {Object} options.worldState - A WorldState instance.
   * @param {Object} [options.playerState] - Optional; used only to resolve a
   *   Drama Engine event's featured fighter's display name from their id.
   */
  constructor({ worldState, playerState = null }) {
    this.worldState = worldState;
    this.playerState = playerState;
    this.entries = [];
    this._unsubs = [];
  }

  /** @returns {WorldFeed} this, for chaining. */
  attach() {
    this._unsubs.push(EventBus.subscribe(DRAMA_ENGINE_EVENTS.RESOLVED, (payload) => this._onDramaResolved(payload)));
    this._unsubs.push(EventBus.subscribe(WORLD_EVENTS.RECORD_BROKEN, (payload) => this._onRecordBroken(payload)));
    this._unsubs.push(EventBus.subscribe(WORLD_EVENTS.HALL_OF_FAME_INDUCTED, (payload) => this._onHallOfFameInducted(payload)));
    this._unsubs.push(EventBus.subscribe(WORLD_EVENTS.GLOBAL_EVENT_ADDED, (payload) => this._onGlobalEvent(payload)));
    this._unsubs.push(EventBus.subscribe(NARRATIVE_ENGINE_EVENTS.PUBLISHED, (payload) => this._onNarrativeBeat(payload)));
    this._unsubs.push(EventBus.subscribe(COMBAT_EVENTS.FINISHED, (payload) => this._onCombatFinished(payload)));
    return this;
  }

  /** Unsubscribes from every event this feed listens to. */
  detach() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
  }

  /**
   * @param {number} [limit] - Defaults to every kept entry.
   * @returns {Object[]} Newest-first feed entries: { category, text, day }.
   */
  getEntries(limit) {
    return limit ? this.entries.slice(0, limit) : [...this.entries];
  }

  /**
   * @param {number} [limit=20]
   * @returns {string} The feed, newest-first, as plain text.
   */
  toText(limit = 20) {
    return this.getEntries(limit)
      .map((entry) => `[J${entry.day}] (${entry.category}) ${entry.text}`)
      .join('\n');
  }

  // ---- event handlers -----------------------------------------------------

  _onDramaResolved(payload) {
    const event = DRAMA_EVENTS.find((e) => e.id === payload.eventId);
    const choice = event?.choices.find((c) => c.id === payload.choiceId);
    const fighter = this.playerState?.getFighter(payload.fighterId);
    const fighterName = fighter?.identity.name ?? payload.fighterId;

    this._push('DRAMA', `${fighterName} — ${event?.id ?? payload.eventId} : "${choice?.label ?? payload.choiceId}".`, payload.day);
  }

  _onRecordBroken({ key, record }) {
    this._push('RECORD', record.detail ?? `Nouveau record "${key}" : ${record.value}.`, record.day);
  }

  _onHallOfFameInducted({ entry }) {
    const nickname = entry.nickname ? ` "${entry.nickname}"` : '';
    this._push(
      'HALL_OF_FAME',
      `\u{1F3C6}✨ HALL OF FAME ✨\u{1F3C6} — ${entry.name}${nickname} entre dans la legende (${entry.record}, ${entry.finishes} finishes).`,
      entry.inductedOnDay
    );
  }

  _onGlobalEvent({ event }) {
    const text = this._describeGlobalEvent(event);
    if (text) this._push('WORLD', text, event.day);
  }

  _onNarrativeBeat(beat) {
    this._push('NARRATIVE', beat.headline, beat.day);
  }

  /** Celebrates a title fight's outcome (win or successful defense) — every other 'combat:finished' fight is silently ignored here, non-title results are already covered by whichever category actually cares (Drama/Narrative/etc.). */
  _onCombatFinished(payload) {
    if (!payload.titleOnTheLine || payload.winner === null) return;

    const winnerKey = payload.winner;
    const winnerName = payload.names?.[winnerKey] ?? payload.fighters?.[winnerKey] ?? 'Inconnu';
    const weightClass = payload.weightClasses?.[winnerKey] ?? 'Inconnu';
    this._push('TITLE', `\u{1F947} TITRE ${weightClass} — ${winnerName} remporte le combat par ${payload.method}.`, payload.day);
  }

  // ---- internals ------------------------------------------------------------

  _describeGlobalEvent(event) {
    switch (event.type) {
      case 'FORCED_RETIREMENT': {
        const hofTag = event.isHallOfFamer ? ' [HALL OF FAME]' : '';
        const nickname = event.nickname ? ` "${event.nickname}"` : '';
        const name = event.name ?? event.fighterId;
        return `${name}${nickname} part a la retraite (${event.age} ans)${hofTag} — reconversion : ${event.reconversionOutcome}.`;
      }
      case 'RIVAL_FIGHT_RESULT':
        return `Combat chez un gym rival (${event.method ?? 'resultat inconnu'}).`;
      case 'RIVAL_SIGNING':
        return `\u{270D}\u{FE0F} ${event.gymName} signe ${event.fighterName}.`;
      case 'RIVAL_EXTENSION':
        return `\u{1F4DD} ${event.gymName} prolonge le contrat de ${event.fighterName}.`;
      case 'RIVAL_RELEASE':
        return `\u{1F44B} ${event.gymName} libere ${event.fighterName}.`;
      case 'PROSPECT_WAVE':
        return `\u{1F31F} Nouvelle cuvee de prospects : "${event.themeLabel}" (${event.placedCount}/${event.waveSize} places pourvues).`;
      default:
        return null;
    }
  }

  _push(category, text, day) {
    this.entries.unshift({ category, text, day: day ?? this.worldState.currentDay });
    if (this.entries.length > FEED_HISTORY_LIMIT) {
      this.entries.length = FEED_HISTORY_LIMIT;
    }
  }
}

export default WorldFeed;
