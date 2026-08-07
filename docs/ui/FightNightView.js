/**
 * ui/FightNightView.js — Phase 4.3 ("Player Experience & Vertical Slice")
 * ---------------------------------------------------------------------------
 * The presentation layer over a fight: a pre-fight "card" (Readiness,
 * nicknames, records — the head-to-head comparison the spec asks for), a
 * round-by-round summary as the match plays out, and a final result banner.
 *
 * FightNightView never invents a consequence itself — CombatEngine already
 * applies every one (money, reputation, hype, injuries, career stats,
 * perks), and the reactive Pyramide Emergente engines (WorldMemory,
 * HistoryEngine, StoryEngine, NarrativeEngine, SocialEngine...), once
 * attached to the session, already react to 'combat:finished' on their own —
 * this module only reads CombatEngine's own return values/snapshot to
 * describe what just happened for a human to read.
 *
 * Phase 4.4 polish: visual health/stamina bars per round, and a distinct
 * banner for a dramatic finish (KO/TKO/Submission/Doctor Stoppage) vs a
 * plain decision — plus any world record broken during this exact fight
 * (engine/HistoryEngine.js/engine/WorldMemory.js both react to
 * 'combat:finished' synchronously, so briefly listening for
 * WORLD_EVENTS.RECORD_BROKEN around one fight's own resolution reliably
 * captures only records THIS fight broke, see presentMatchup/_buildResultBanner).
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import EventBus from '../core/EventBus.js';
import { COMBAT_STATES, FINISH_METHODS } from '../engine/CombatEngine.js';
import { generateScoutingReport } from '../engine/ScoutingEngine.js';
import { WORLD_EVENTS } from '../state/WorldState.js';

/** Distinct celebratory banner text for a dramatic finish — a plain decision falls back to a neutral headline instead. */
const DRAMATIC_FINISH_BANNERS = Object.freeze({
  [FINISH_METHODS.KO]: '\u{1F4A5} KO !!!',
  [FINISH_METHODS.TKO]: '\u{1F6D1} ARRET DE L\'ARBITRE (TKO) !',
  [FINISH_METHODS.SUBMISSION]: '\u{1F512} SOUMISSION !',
  [FINISH_METHODS.DOCTOR_STOPPAGE]: '\u{1FA7A} ARRET MEDICAL.',
});

/** ASCII/unicode progress bar for a 0-100-ish gauge (health/stamina) — clamped like render/CombatRenderer.js's own gauge display, since Stamina Max can exceed 100 depending on Readiness (see BALANCE.READINESS's calibration curve). */
function renderBar(value, width = 20) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const filled = Math.round((clamped / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${clamped}%`;
}

// ---- Play-by-play commentary (Live Text Feed) --------------------------------
// Purely descriptive flavor text built from engine/CombatEngine.js's own
// round `actions` (see its _processRoundSimulation log — target/distance/
// takedown-submission outcomes already computed by the simulation, never
// re-decided here). No randomness is introduced: the same fight replayed
// from the same seed always narrates identically, since the phrase picked
// for a given beat is a deterministic function of the round/corner/action
// it describes, not a fresh roll.

const STRIKING_HEAD_PHRASES = [
  '{name} envoie un jab sec au visage de {opp} !',
  '{name} place un crochet du droit qui fait vaciller {opp} !',
  '{name} enchaine une combinaison rapide a la tete.',
  '{name} connecte un uppercut tranchant !',
  '{name} cherche l\'ouverture avec des coups au visage.',
];
const STRIKING_BODY_PHRASES = [
  '{name} plante un crochet au foie !',
  '{name} martele les cotes de {opp}.',
  '{name} coupe {opp} en deux avec un coup au corps !',
  '{name} travaille methodiquement le corps.',
];
const STRIKING_LEGS_PHRASES = [
  '{name} balance un low-kick sec sur la cuisse de {opp} !',
  '{name} fauche la jambe d\'appui de {opp}.',
  '{name} hache la cuisse a coups de low-kicks repetes.',
];
const CLINCH_LANDED_PHRASES = [
  '{name} colle {opp} contre la cage et place un genou au corps !',
  '{name} controle le clinch et enchaine les coudes courts.',
  '{name} plaque {opp} contre la grille, genoux et coudes au menu.',
];
const CLINCH_TAKEDOWN_LANDED_PHRASES = [
  '{name} bascule {opp} au sol depuis le clinch !',
  '{name} trouve l\'angle et emmene {opp} au tapis depuis la cage !',
];
const CLINCH_TAKEDOWN_FAILED_PHRASES = [
  '{name} tente de basculer {opp} au sol mais celui-ci tient la position debout.',
  '{name} cherche la bascule depuis le clinch, sans succes.',
];
const TAKEDOWN_LANDED_PHRASES = [
  '{name} enchaine un takedown net et passe directement en garde montee !',
  '{name} penetre le double-leg et amene {opp} au sol !',
  '{name} plaque {opp} au tapis d\'un takedown propre.',
];
const TAKEDOWN_FAILED_PHRASES = [
  '{name} tente un takedown mais {opp} sprawl et se degage !',
  '{name} shoot sur les jambes, {opp} defend et se replace debout.',
  '{name} echoue a amener {opp} au sol.',
];
const SUBMISSION_ATTEMPT_PHRASES = [
  '{name} cherche l\'etranglement depuis la garde montee !',
  '{name} isole un bras et tente une cle !',
  '{name} tente de passer au sol pour chercher la soumission.',
];
const SUBMISSION_SUCCESS_PHRASES = [
  '{name} serre l\'etranglement, {opp} n\'a plus le choix !',
  '{name} verrouille la cle de bras, la soumission se rapproche !',
];

// Pure texture — never anchored to an actual engine outcome, just fills out
// the round's rhythm between the real, engine-decided beats below (see
// _generateRoundBeats's FEINT/FOOTWORK/CORNER fillers).
const FEINT_PHRASES = [
  '{name} feinte du gauche pour tester la reaction de {opp}.',
  '{name} teste la distance avec un jab de mesure.',
  '{name} bouge la tete, hors de portee des coups de {opp}.',
  '{name} pompe le jab sans s\'engager encore.',
  '{name} change de garde pour brouiller les reperes de {opp}.',
  '{name} feinte un low-kick puis se ravise.',
];
const FOOTWORK_PHRASES = [
  '{name} circule sur le pourtour de la cage.',
  '{name} coupe l\'octogone pour fermer l\'angle sur {opp}.',
  'Les deux combattants se jaugent au centre.',
  '{opp} recule vers la cage pour souffler un instant.',
  '{name} garde le centre et impose son rythme.',
  '{name} pivote pour se replacer face a {opp}.',
];
const CORNER_PHRASES = [
  'Le coin de {name} crie des consignes depuis l\'exterieur.',
  'La foule s\'anime a chaque echange.',
  'L\'arbitre surveille de pres la distance de securite.',
  'Les deux coins s\'observent, prets a intervenir a la pause.',
];
const GROUND_AND_POUND_PHRASES = [
  '{name} martele {opp} au sol avec des coups au visage !',
  '{name} maintient la garde montee et place des coups courts.',
  '{name} cherche a stabiliser la position avant d\'enchainer les frappes.',
  '{name} pese de tout son poids et lache des coups au corps depuis le sol.',
];
const ESCAPE_PHRASES = [
  '{name} parvient a se degager et revient debout !',
  '{name} recupere la garde et neutralise l\'attaque au sol.',
  '{name} se replace et evite le pire.',
  '{name} agrippe la cage pour se relever malgre la pression.',
];

function fillPhrase(phrase, name, opp) {
  return phrase.replace('{name}', name).replace('{opp}', opp);
}

/** Deterministic pseudo-random index (no external rng dependency) so the same fight always narrates the same way. */
function stableIndex(seedString, length) {
  let hash = 0;
  for (let i = 0; i < seedString.length; i += 1) hash = (hash * 31 + seedString.charCodeAt(i)) >>> 0;
  return hash % length;
}

function pickPhrase(list, seedString) {
  return list[stableIndex(seedString, list.length)];
}

/** Builds one corner's action beat text from its engine/CombatEngine.js `actions` entry (target/distance/takedown-submission outcome). */
function describeAction(action, name, opp, seedString) {
  if (action.submissionAttempted) {
    const list = action.submissionSuccess ? SUBMISSION_SUCCESS_PHRASES : SUBMISSION_ATTEMPT_PHRASES;
    return fillPhrase(pickPhrase(list, seedString), name, opp);
  }
  if (action.clinchAttempted) {
    const list = action.clinchTakedownLanded
      ? CLINCH_TAKEDOWN_LANDED_PHRASES
      : action.distance === 'CLINCH'
        ? CLINCH_LANDED_PHRASES
        : CLINCH_TAKEDOWN_FAILED_PHRASES;
    return fillPhrase(pickPhrase(list, seedString), name, opp);
  }
  if (action.takedownAttempted) {
    const list = action.takedownSuccess ? TAKEDOWN_LANDED_PHRASES : TAKEDOWN_FAILED_PHRASES;
    return fillPhrase(pickPhrase(list, seedString), name, opp);
  }
  if (action.target === 'BODY') return fillPhrase(pickPhrase(STRIKING_BODY_PHRASES, seedString), name, opp);
  if (action.target === 'LEGS') return fillPhrase(pickPhrase(STRIKING_LEGS_PHRASES, seedString), name, opp);
  return fillPhrase(pickPhrase(STRIKING_HEAD_PHRASES, seedString), name, opp);
}

const FINISH_BEAT_LINES = Object.freeze({
  KO: '{winner} explose {loser} — K.O. !!!',
  TKO: 'L\'arbitre s\'interpose, {loser} ne peut plus continuer — TKO pour {winner} !',
  SUBMISSION: '{loser} tape au sol — soumission pour {winner} !',
  DOCTOR_STOPPAGE: 'Le medecin met fin au combat — arret pour {winner} sur blessure de {loser}.',
});

function formatClock(secondsRemaining) {
  const clamped = Math.max(0, Math.round(secondsRemaining));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Dramatic finishes eligible for the round-1 "flash" beat sequence (see _generateFlashFinishBeats) — DOCTOR_STOPPAGE is deliberately excluded: it reads as accumulated damage catching up, not a sudden finish. */
const FLASH_FINISH_METHODS = new Set([FINISH_METHODS.KO, FINISH_METHODS.TKO, FINISH_METHODS.SUBMISSION]);

/** Sensible default gameplan for a fighter whose corner didn't explicitly choose one — leans on their own style's primary distance/target affinity (see BALANCE.COMBAT.STYLE_BONUSES), same spirit as tools/SimRunner.js's headless gameplanForStyle but without that file's coach-AI randomness (a human corner can always override via setGameplans before simulating). */
function defaultGameplanForFighter(fighter) {
  const styleBonus = BALANCE.COMBAT.STYLE_BONUSES[fighter.identity.style] ?? BALANCE.COMBAT.STYLE_BONUSES.DEFAULT;
  const distance = styleBonus.distance ?? 'STRIKING';

  let target = 'HEAD';
  if (styleBonus.targetMultipliers) {
    target = Object.keys(styleBonus.targetMultipliers).reduce((best, candidate) =>
      styleBonus.targetMultipliers[candidate] > (styleBonus.targetMultipliers[best] ?? 0) ? candidate : best
    );
  }

  return { target, distance, tempo: 'BALANCED' };
}

export class FightNightView {
  /**
   * @param {Object} options
   * @param {Object} options.combatEngine - A CombatEngine instance, already
   *   attached to the session's PlayerState/WorldState if fight consequences
   *   (purses, reputation) should apply to a real gym.
   */
  constructor({ combatEngine }) {
    this.combatEngine = combatEngine;
    this._roundLogs = [];
    this._fighterA = null;
    this._fighterB = null;
    this._orgId = null;
    this._isTitle = false;
    this._recordsBrokenThisFight = [];
    this._recordBrokenUnsub = null;
  }

  /**
   * Books the match and returns the pre-fight comparison card. Also arms a
   * short-lived WORLD_EVENTS.RECORD_BROKEN listener so the eventual result
   * banner can call out any world record THIS fight broke (see this file's
   * header) — torn down once the fight's result banner is built.
   * @param {Object} fighterA
   * @param {Object} fighterB
   * @param {string} orgId
   * @param {boolean} [isTitle=false]
   * @param {Object|null} [rules=null] - Forwarded verbatim to CombatEngine#setupMatch (e.g. engine/PressConferenceEngine.js's purseMultiplier).
   * @returns {Object} The fight card view model.
   */
  presentMatchup(fighterA, fighterB, orgId, isTitle = false, rules = null) {
    this._teardownRecordListener();
    this.combatEngine.setupMatch(fighterA, fighterB, orgId, isTitle, rules);
    this._roundLogs = [];
    this._fighterA = fighterA;
    this._fighterB = fighterB;
    this._orgId = orgId;
    this._isTitle = isTitle;
    this._recordsBrokenThisFight = [];
    this._recordBrokenUnsub = EventBus.subscribe(WORLD_EVENTS.RECORD_BROKEN, (payload) => {
      this._recordsBrokenThisFight.push(payload);
    });
    return this._buildFightCard(orgId, isTitle);
  }

  /**
   * Sets both corners' gameplans, defaulting to defaultGameplanForFighter()
   * for whichever corner isn't explicitly provided.
   * @param {Object} [plans]
   * @param {Object} [plans.A] - { target, distance, tempo }
   * @param {Object} [plans.B]
   */
  setGameplans({ A, B } = {}) {
    this.combatEngine.setGameplan('A', A ?? defaultGameplanForFighter(this._fighterA));
    this.combatEngine.setGameplan('B', B ?? defaultGameplanForFighter(this._fighterB));
  }

  /**
   * Advances the fight exactly one simulated round (driving past whichever
   * FSM phases precede ROUND_SIMULATION), or resolves the final decision if
   * the match just ended.
   * @returns {{ finished: boolean, round: Object|null, resultBanner: Object|null }}
   */
  advanceOneRound() {
    let stepResult;
    do {
      stepResult = this.combatEngine.executeNextStep();
    } while (!('log' in stepResult) && this.combatEngine.state !== COMBAT_STATES.FINISHED);

    if ('log' in stepResult) {
      const roundSummary = this._buildRoundSummary(stepResult.log);
      this._roundLogs.push(roundSummary);
      return { finished: false, round: roundSummary, resultBanner: null };
    }

    // The match ended without one more 'log' step surfacing here (e.g. the
    // engine reached FINISHED while resolving the decision/rewards phases
    // this same call) — drive it the rest of the way and report the result.
    while (this.combatEngine.state !== COMBAT_STATES.FINISHED) {
      this.combatEngine.executeNextStep();
    }
    return { finished: true, round: null, resultBanner: this._buildResultBanner() };
  }

  /**
   * Runs the entire fight to completion in one call (no round-by-round
   * pause) — useful for a "simulate instantly" shortcut. Still populates
   * the round-by-round log for getRoundLogs()/toRoundsText().
   * @returns {Object} The result banner view model.
   */
  simulateToCompletion() {
    while (this.combatEngine.state !== COMBAT_STATES.FINISHED) {
      const stepResult = this.combatEngine.executeNextStep();
      if ('log' in stepResult) this._roundLogs.push(this._buildRoundSummary(stepResult.log));
    }
    return this._buildResultBanner();
  }

  /** @returns {Object[]} Every round summary collected so far this fight. */
  getRoundLogs() {
    return [...this._roundLogs];
  }

  /**
   * Public accessor for the structured result banner (winner, method,
   * dramaticBanner, recordsBroken, headline, purses, injuries...) once the
   * fight is finished — the same data toResultText() renders as plain text,
   * exposed for a UI that wants to build its own presentation instead.
   * @returns {Object|null} null if the fight hasn't finished yet.
   */
  getResultBanner() {
    return this._buildResultBanner();
  }

  // ---- view-model builders ----------------------------------------------------

  /**
   * @param {Object} fighter
   * @param {boolean} [isOpponent=false] - True for the corner the player
   *   does NOT manage (Coin B): exact Readiness/Overall are withheld and
   *   replaced with a qualitative scoutingReport (see
   *   engine/ScoutingEngine.js) — "Rapport de Scouting sous incertitude"
   *   instead of exposing tape the player was never given. The player's
   *   own fighter (Coin A) keeps the full precise numbers, same as before.
   */
  _buildFighterCardEntry(fighter, isOpponent = false) {
    const base = {
      id: fighter.identity.id,
      name: fighter.identity.name,
      nickname: fighter.identity.nickname,
      style: fighter.identity.style,
      age: fighter.identity.age,
      record: fighter.getRecordString(),
      legacyStage: fighter.getLegacyStage(),
    };
    if (isOpponent) {
      return { ...base, readiness: null, overallRating: null, scoutingReport: generateScoutingReport(fighter) };
    }
    return { ...base, readiness: Math.round(fighter.getReadiness()), overallRating: fighter.getOverallRating(), scoutingReport: null };
  }

  _buildFightCard(orgId, isTitle) {
    return {
      orgId,
      isTitle,
      fighterA: this._buildFighterCardEntry(this._fighterA, false),
      fighterB: this._buildFighterCardEntry(this._fighterB, true),
    };
  }

  _buildRoundSummary(log) {
    return {
      round: log.round,
      damageDealt: { ...log.damageDealt },
      healthAfter: { ...log.healthAfter },
      staminaAfter: { ...log.staminaAfter },
      healthBar: { A: renderBar(log.healthAfter.A), B: renderBar(log.healthAfter.B) },
      staminaBar: { A: renderBar(log.staminaAfter.A), B: renderBar(log.staminaAfter.B) },
      finish: log.finish ? { ...log.finish } : null,
      /** Live Text Feed: timestamped French play-by-play lines for this round (see _generateRoundBeats), MM:SS counting down from BALANCE.COMBAT.ROUND_DURATION_SECONDS to 00:00. */
      beats: this._generateRoundBeats(log),
    };
  }

  /**
   * Builds this round's timestamped play-by-play beats from the engine's
   * own already-decided `actions` (see engine/CombatEngine.js's
   * _processRoundSimulation log) — never re-decides anything, purely
   * narrates what the simulation already computed.
   * @param {Object} log - The raw CombatEngine round log (round, actions, finish...).
   * @returns {{ timestamp: string, text: string }[]}
   */
  /**
   * Builds 10-25 beats per round (BALANCE.COMBAT... no dedicated constant
   * needed — the range itself is the spec) rather than a fixed handful of
   * lines: a mix of pure-texture filler (feints, footwork, corner chatter —
   * never anchored to an engine outcome) woven around the round's two REAL,
   * engine-decided action beats (log.actions.A/B — target/distance/
   * takedown/submission, exactly as CombatEngine computed them), plus an
   * extra ground-and-pound/escape flourish whenever a takedown actually
   * landed this round. The beat COUNT and every filler CHOICE are
   * deterministic functions of (round, corner, action-shape) — never
   * Math.random — so the same fight replayed from the same seed always
   * narrates identically, even though it now reads like a real live feed.
   */
  _generateRoundBeats(log) {
    const nameA = this._fighterA.identity.name;
    const nameB = this._fighterB.identity.name;
    const roundSeconds = BALANCE.COMBAT.ROUND_DURATION_SECONDS;

    // A round-1 KO/TKO/Submission doesn't play out the standard 10-25-beat
    // build-up — it feels sudden, over in a handful of lines, same "KO
    // eclair" a real broadcast would cut to instantly rather than narrate
    // round-by-round tension for a fight that never got that far.
    if (log.round === 1 && log.finish && FLASH_FINISH_METHODS.has(log.finish.method)) {
      return this._generateFlashFinishBeats(log, nameA, nameB, roundSeconds);
    }

    // Beat count reflects this round's actual intensity rather than a flat
    // range: a tactical, low-damage round stays short, a back-and-forth
    // war runs long — capped at 25 either way.
    const totalDamage = log.damageDealt.A + log.damageDealt.B;
    const beatCount = clamp(6 + Math.round(totalDamage * 0.8), 6, 25);

    const lines = [];
    lines.push(log.round === 1 ? 'La cloche retentit, le combat commence !' : `Round ${log.round} — les coins liberent les combattants.`);

    const actionSeedA = log.actions ? `${log.round}-A-${log.actions.A.target}-${log.actions.A.distance}-${log.actions.A.takedownSuccess}` : null;
    const actionSeedB = log.actions ? `${log.round}-B-${log.actions.B.target}-${log.actions.B.distance}-${log.actions.B.takedownSuccess}` : null;

    // Pure texture, filling out the round's rhythm before/between the real action.
    const fillerPool = [...FEINT_PHRASES, ...FOOTWORK_PHRASES, ...CORNER_PHRASES];
    const fillerBeats = (n, seedPrefix) =>
      Array.from({ length: n }, (_, i) => {
        const subject = i % 2 === 0 ? [nameA, nameB] : [nameB, nameA];
        return fillPhrase(pickPhrase(fillerPool, `${seedPrefix}-${i}`), subject[0], subject[1]);
      });

    // Extra ground-sequence flavor for whichever corner(s) actually landed a takedown this round.
    const groundBeats = [];
    if (log.actions) {
      for (const [key, opponentKey, name, opp] of [
        ['A', 'B', nameA, nameB],
        ['B', 'A', nameB, nameA],
      ]) {
        const action = log.actions[key];
        if (action.takedownSuccess || action.clinchTakedownLanded) {
          groundBeats.push(fillPhrase(pickPhrase(GROUND_AND_POUND_PHRASES, `${log.round}-${key}-gnp`), name, opp));
          groundBeats.push(fillPhrase(pickPhrase(ESCAPE_PHRASES, `${log.round}-${key}-escape`), opp, name));
        }
      }
    }

    const closingCount = 1; // damage assessment / finish, added at the very end.
    const openingCount = lines.length;
    const actionCount = log.actions ? 2 : 0;
    const fillerNeeded = Math.max(0, beatCount - openingCount - actionCount - groundBeats.length - closingCount);
    const leadFillerCount = Math.ceil(fillerNeeded / 2);
    const trailFillerCount = fillerNeeded - leadFillerCount;

    lines.push(...fillerBeats(leadFillerCount, `${log.round}-lead`));
    if (log.actions) lines.push(describeAction(log.actions.A, nameA, nameB, actionSeedA));
    lines.push(...fillerBeats(Math.floor(trailFillerCount / 2), `${log.round}-mid`));
    if (log.actions) lines.push(describeAction(log.actions.B, nameB, nameA, actionSeedB));
    lines.push(...groundBeats);
    lines.push(...fillerBeats(trailFillerCount - Math.floor(trailFillerCount / 2), `${log.round}-trail`));

    if (log.finish) {
      const winnerName = log.finish.winnerKey === 'A' ? nameA : nameB;
      const loserName = log.finish.winnerKey === 'A' ? nameB : nameA;
      const template = FINISH_BEAT_LINES[log.finish.method];
      lines.push(template ? template.replace('{winner}', winnerName).replace('{loser}', loserName) : `La cloche finale sonne le round ${log.round}.`);
    } else {
      if (totalDamage > 15) lines.push('Les deux combattants echangent avec intensite, l\'assistance est debout !');
      else if (totalDamage < 4) lines.push('Round plus tactique, les deux coins jaugent la distance.');
      else lines.push(`Fin du round ${log.round} — retour au coin.`);
    }

    const count = lines.length;
    return lines.map((text, index) => {
      const secondsRemaining = roundSeconds * (1 - (index + 1) / count);
      return { timestamp: formatClock(secondsRemaining), text };
    });
  }

  /**
   * 1-3 beats total, compressed into the opening seconds of the round
   * rather than spread across the full 5 minutes — a flash KO/TKO/
   * Submission doesn't wait for a slow build-up.
   * @param {Object} log
   * @param {string} nameA
   * @param {string} nameB
   * @param {number} roundSeconds
   * @returns {{ timestamp: string, text: string }[]}
   */
  _generateFlashFinishBeats(log, nameA, nameB, roundSeconds) {
    const winnerKey = log.finish.winnerKey;
    const finisherName = winnerKey === 'A' ? nameA : nameB;
    const victimName = winnerKey === 'A' ? nameB : nameA;
    const finisherAction = log.actions?.[winnerKey];

    const beatTarget = 1 + stableIndex(`${log.round}-flash`, 3); // 1..3
    const lines = [];
    if (beatTarget >= 3) lines.push(`La cloche sonne a peine que ${finisherName} s'avance, en chasse.`);
    if (beatTarget >= 2 && finisherAction) {
      lines.push(describeAction(finisherAction, finisherName, victimName, `${log.round}-flash-action`));
    }
    const template = FINISH_BEAT_LINES[log.finish.method];
    lines.push(template ? template.replace('{winner}', finisherName).replace('{loser}', victimName) : `Fin eclair du round ${log.round}.`);

    return lines.map((text, index) => ({
      timestamp: formatClock(Math.max(0, roundSeconds - 5 - index * 20)),
      text,
    }));
  }

  _buildResultBanner() {
    const snapshot = this.combatEngine.getSnapshot();
    const result = snapshot.result;
    if (!result) return null;

    const winnerEntry = result.winner ? (result.winner === 'A' ? this._fighterA : this._fighterB) : null;
    const dramaticBanner = DRAMATIC_FINISH_BANNERS[result.method] ?? null;
    const recordsBroken = this._recordsBrokenThisFight.map((r) => ({ key: r.key, detail: r.record.detail }));
    this._teardownRecordListener();

    return {
      winner: result.winner,
      winnerName: winnerEntry?.identity.name ?? null,
      winnerNickname: winnerEntry?.identity.nickname ?? null,
      method: result.method,
      round: result.round,
      timeLabel: result.timeLabel,
      isTitle: result.isTitle,
      titleOnTheLine: result.titleOnTheLine,
      purses: result.purses,
      injuries: result.injuries,
      readiness: { A: result.combatMetrics.A.readiness, B: result.combatMetrics.B.readiness },
      dramaticBanner,
      recordsBroken,
      headline: result.winner
        ? `${winnerEntry?.identity.name ?? `Coin ${result.winner}`} l'emporte par ${result.method} (round ${result.round}, ${result.timeLabel}).`
        : `Match nul par ${result.method}.`,
    };
  }

  /** Stops listening for WORLD_EVENTS.RECORD_BROKEN — called automatically once a result banner is built, and defensively at the start of every new presentMatchup(). */
  _teardownRecordListener() {
    this._recordBrokenUnsub?.();
    this._recordBrokenUnsub = null;
  }

  // ---- text rendering ---------------------------------------------------------

  /** @returns {string} The pre-fight card, as plain text. */
  toCardText() {
    const card = this._buildFightCard(this._orgId, this._isTitle);
    const ownLine = (f) =>
      `${f.name}${f.nickname ? ` "${f.nickname}"` : ''} (${f.style}, ${f.age} ans, ${f.record}, ${f.legacyStage}) — ` +
      `Readiness ${f.readiness}, Overall ${f.overallRating}`;
    const opponentLine = (f) =>
      `${f.name}${f.nickname ? ` "${f.nickname}"` : ''} (${f.style}, ${f.age} ans, ${f.record}, ${f.legacyStage})\n` +
      `  Rapport de Scouting :\n` +
      f.scoutingReport.map((observation) => `    - ${observation}`).join('\n');
    return [
      `=== ${card.fighterA.name} vs ${card.fighterB.name}${card.isTitle ? ' — COMBAT DE TITRE' : ''} ===`,
      ownLine(card.fighterA),
      opponentLine(card.fighterB),
    ].join('\n');
  }

  /** @returns {string} Every round collected so far, as plain text with visual health/stamina bars. */
  toRoundsText() {
    return this._roundLogs
      .map((r) => {
        const header = `Round ${r.round} — Degats A ${r.damageDealt.A} / B ${r.damageDealt.B}` + (r.finish ? ` — FIN (${r.finish.method})` : '');
        return (
          `${header}\n` +
          `  Vie     A ${r.healthBar.A}   B ${r.healthBar.B}\n` +
          `  Stamina A ${r.staminaBar.A}   B ${r.staminaBar.B}`
        );
      })
      .join('\n');
  }

  /** @returns {string} The final result banner, as plain text (empty string if the fight isn't finished yet) — a dramatic finish and any world record broken this fight get their own lines. */
  toResultText() {
    const banner = this.getResultBanner();
    if (!banner) return '';

    const lines = [];
    if (banner.dramaticBanner) lines.push(banner.dramaticBanner);
    lines.push(banner.headline);
    for (const record of banner.recordsBroken) {
      lines.push(`\u{1F3C6} NOUVEAU RECORD DU MONDE : ${record.detail ?? record.key}`);
    }
    return lines.join('\n');
  }
}

export default FightNightView;
