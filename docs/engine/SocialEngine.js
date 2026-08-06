/**
 * engine/SocialEngine.js
 * ---------------------------------------------------------------------------
 * Reactive social feed generator. Unlike TrainingEngine/EconomyEngine/
 * EventEngine (which run once, explicitly, per week), SocialEngine is
 * always-on: it subscribes to gameplay events as they happen and writes
 * auto-authored posts (fan reactions, journalist recaps, rival trash talk,
 * fighter statements) straight to PlayerState.socialFeed.
 *
 * It has no events of its own to publish: PlayerState.pushSocialFeedEntry()
 * already publishes 'social:feed_entry_added' for every post, from any
 * source — SocialEngine relies on that single source of truth rather than
 * re-announcing the same record under a second name.
 *
 * Like CombatEngine, this is a class (not a plain function module) because
 * it needs to persist its EventBus subscriptions for the game's lifetime —
 * call attach(playerState) once the game starts, detach() when it ends.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import { COMBAT_EVENTS, FINISH_METHODS } from './CombatEngine.js';
import { PLAYER_EVENTS } from '../state/PlayerState.js';

const DECISION_METHODS = new Set([
  FINISH_METHODS.UNANIMOUS_DECISION,
  FINISH_METHODS.SPLIT_DECISION,
  FINISH_METHODS.MAJORITY_DECISION,
  FINISH_METHODS.DRAW,
]);

function randomInRange(rng, min, max) {
  return min + rng() * (max - min);
}

function computeLikes(hype, authorType, wasFinish, rng) {
  const cfg = BALANCE.SOCIAL_MEDIA.POST_LIKES;
  const base = randomInRange(rng, cfg.BASE_MIN, cfg.BASE_MAX);
  const hypeBonus = hype * cfg.HYPE_MULTIPLIER;
  const typeMultiplier = cfg.POST_TYPE_LIKE_MULTIPLIER[authorType] ?? 1;
  const finishMultiplier = wasFinish ? cfg.FINISH_BONUS_MULTIPLIER : 1;
  return Math.max(0, Math.round((base + hypeBonus) * typeMultiplier * finishMultiplier));
}

class SocialEngine {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.playerState] - A PlayerState instance. Can
   *   also be supplied later via attach().
   * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
   */
  constructor(options = {}) {
    this.playerState = options.playerState ?? null;
    this.rng = options.rng ?? Math.random;
    this._unsubs = [];
  }

  /**
   * Subscribes to the gameplay events this engine reacts to. Safe to call
   * again after detach() (e.g. when switching save slots).
   *
   * @param {Object} [playerState] - Rebinds the target PlayerState if provided.
   * @returns {SocialEngine} this, for chaining.
   */
  attach(playerState) {
    if (playerState) this.playerState = playerState;

    this._unsubs.push(EventBus.subscribe(COMBAT_EVENTS.FINISHED, (payload) => this._onCombatFinished(payload)));
    this._unsubs.push(
      EventBus.subscribe(PLAYER_EVENTS.ROSTER_FIGHTER_ADDED, (payload) => this._onFighterAdded(payload))
    );
    this._unsubs.push(
      EventBus.subscribe(PLAYER_EVENTS.GYM_FACILITY_UPGRADED, (payload) => this._onFacilityUpgraded(payload))
    );

    return this;
  }

  /** Unsubscribes from every event this engine listens to. */
  detach() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
  }

  // ---- event handlers -----------------------------------------------------

  _onCombatFinished(payload) {
    if (!this.playerState) return;

    const playerKey = this._isPlayerFighterId(payload.fighters.A)
      ? 'A'
      : this._isPlayerFighterId(payload.fighters.B)
        ? 'B'
        : null;
    if (!playerKey) return; // Not one of the player's fighters — e.g. a headless rival-gym sim.

    const opponentKey = playerKey === 'A' ? 'B' : 'A';
    const playerName = payload.names?.[playerKey] ?? 'Notre combattant';
    const opponentName = payload.names?.[opponentKey] ?? "l'adversaire";
    const isDraw = payload.winner === null;
    const won = payload.winner === playerKey;
    const wasFinish = !DECISION_METHODS.has(payload.method);

    const fanText = isDraw
      ? `Match nul intense entre ${playerName} et ${opponentName} !`
      : won
        ? `${playerName} l'emporte face a ${opponentName} par ${payload.method} !`
        : `Defaite difficile pour ${playerName} face a ${opponentName}.`;
    this._postToFeed({ author: 'Fan de la salle', authorType: 'FAN', text: fanText }, wasFinish);

    const journalistText = isDraw
      ? `Analyse : un combat tres serre, aucun vainqueur clair au round ${payload.round}.`
      : won
        ? `Analyse tactique : ${playerName} a domine jusqu'a la victoire par ${payload.method} au round ${payload.round}.`
        : `Analyse : ${opponentName} s'impose, ${playerName} devra revoir sa preparation.`;
    this._postToFeed({ author: 'Journaliste MMA', authorType: 'JOURNALIST', text: journalistText }, wasFinish);

    if (!isDraw) {
      const authorName = won ? playerName : opponentName;
      const statementText = won
        ? `"Je savais que j'allais gagner." - ${playerName}`
        : `"On reviendra plus fort." - ${playerName}`;
      this._postToFeed(
        { author: authorName, authorType: 'FIGHTER_STATEMENT', text: statementText },
        wasFinish
      );
    }

    if (!isDraw && !won && wasFinish) {
      this._postToFeed(
        {
          author: `Camp de ${opponentName}`,
          authorType: 'RIVAL',
          text: `${opponentName} charrie : "On savait qu'on allait gagner." Le trash talk continue.`,
        },
        wasFinish
      );
    }
  }

  _onFighterAdded(payload) {
    if (!this.playerState) return;
    const fighter = this.playerState.getFighter(payload.fighterId);
    if (!fighter) return;

    this._postToFeed(
      { author: 'Fan de la salle', authorType: 'FAN', text: `Bienvenue a ${fighter.identity.name} qui rejoint l'equipe !` },
      false
    );
  }

  _onFacilityUpgraded(payload) {
    if (!this.playerState) return;

    this._postToFeed(
      {
        author: this.playerState.gymName,
        authorType: 'FAN',
        text: `La salle passe au niveau ${payload.equipLevel} ! De nouveaux equipements arrivent.`,
      },
      false
    );
  }

  // ---- internals ------------------------------------------------------------

  _isPlayerFighterId(fighterId) {
    return this.playerState?.roster.some((fighter) => fighter.identity.id === fighterId) ?? false;
  }

  /**
   * @param {Object} entry - { author, authorType, text }
   * @param {boolean} wasFinish
   * @returns {Object|null} The stored feed entry (see PlayerState.pushSocialFeedEntry).
   */
  _postToFeed(entry, wasFinish) {
    if (!this.playerState) return null;
    const likes = computeLikes(this.playerState.hype, entry.authorType, wasFinish, this.rng);
    return this.playerState.pushSocialFeedEntry({ ...entry, likes });
  }
}

const instance = new SocialEngine();
export default instance;
export { SocialEngine };
