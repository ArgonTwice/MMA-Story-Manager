/**
 * web/app.js
 * ---------------------------------------------------------------------------
 * Mobile Web App entry point: wires the SAME State/Engine/ui/ layers
 * tools/play-vertical-slice.js already validated (GameState, the full
 * Pyramide Emergente reactive stack, GymHub/WeeklyFlowController/
 * FightNightView/WorldFeed/SeasonSummary) to a touch-first DOM instead of a
 * terminal. No bundler, no build step — plain ES modules imported by
 * relative path, exactly like the desktop App.js/main.js at the repo root;
 * this file only differs in which DOM it drives and how it renders.
 *
 * Autosave: every meaningful action (a week resolved, a Drama Engine choice
 * answered, a fight finished) persists via GameState#save() into
 * localStorage (see core/SaveManager.js) under AUTOSAVE_SLOT, so closing
 * the mobile tab never loses progress.
 * ---------------------------------------------------------------------------
 */

import EventBus from './core/EventBus.js';
import SaveManager from './core/SaveManager.js';
import { GameState } from './state/GameState.js';
import { WORLD_EVENTS } from './state/WorldState.js';
import BALANCE from './data/balance.js';
import { getTraitDisplay } from './data/traits.js';
import Fighter from './models/Fighter.js';
import { CombatEngine, COMBAT_STATES } from './engine/CombatEngine.js';
import { PersonalityEngine } from './engine/PersonalityEngine.js';
import { RelationshipEngine } from './engine/RelationshipEngine.js';
import { StoryEngine } from './engine/StoryEngine.js';
import { NarrativeEngine } from './engine/NarrativeEngine.js';
import { WorldMemory } from './engine/WorldMemory.js';
import { HistoryEngine } from './engine/HistoryEngine.js';
import { SocialEngine } from './engine/SocialEngine.js';

import { generateAcademyPool, isAcademyDraftAvailable } from './engine/AcademyEngine.js';
import { generateRecruitmentPool, generateRivalGymStarterRoster } from './engine/DraftEngine.js';
import { isGenderMatch, assertGenderMatch } from './engine/Matchmaking.js';
import { analyzeSeason, hasAnyTrophy, TROPHY_CATEGORIES } from './engine/StoryAnalyzer.js';

import { GymHub } from './ui/GymHub.js';
import { WeeklyFlowController, WEEKLY_FLOW_PHASES } from './ui/WeeklyFlowController.js';
import { FightNightView } from './ui/FightNightView.js';
import { WorldFeed } from './ui/WorldFeed.js';
import { SeasonSummary } from './ui/SeasonSummary.js';

import telemetry from './telemetry.js';
import { buildStoryCard, renderStoryCardToCanvas, toShareText } from './StoryExporter.js';

import { runUndergroundFight, runGauntlet, UNDERGROUND_MODES, UNDERGROUND_RULESETS } from './engine/UndergroundEngine.js';
import { resolveGymStipulation, processActiveDeals, GYM_STIPULATIONS } from './engine/GymStipulations.js';
import {
  recordLeagueFightResult,
  getPromotionProgress,
  resolveRegionalOrg,
  getWeightClassRanking,
  getAllWeightClassRankings,
  getUpcomingGalas,
  registerForGala,
} from './engine/LeagueEngine.js';
import { isTreasuryCrisis, takePredatoryLoan, getFireSalePrice, fireSaleEquipment } from './engine/EmergencyFinanceEngine.js';
import { isMainEventEligible, getStances, applyPressConferenceChoice } from './engine/PressConferenceEngine.js';
import { HallOfFameEngine, evaluateBadgeUnlocks, generateGoldenBookEntry, getAllBadgeDefinitions } from './engine/HallOfFameEngine.js';
import AudioEngine from './engine/AudioEngine.js';
import { computeWeeklyMerchandisingIncome } from './engine/SocialFeedEngine.js';
import { generateHiringPool, hireStaff } from './engine/StaffEngine.js';
import { getScoutableGyms, sendScout, computeBuyoutFee, buyoutRivalFighter } from './engine/MercatoEngine.js';
import {
  getDaysUntilFight,
  isFightWeek,
  isFightDue,
  setCampOrientation,
  setWeightCutChoice,
  resolveWeightCutProfileKey,
  setLogisticsChoice,
  cancelScheduledFight,
} from './engine/FightWeekEngine.js';
import {
  getNextTierUpgradeCost,
  getNextTier,
  getEquipmentHealthIndicator,
  getRepairCost,
  repairEquipment,
} from './engine/GymInfrastructure.js';

const AUTOSAVE_SLOT = 'web-autosave';
const ONBOARDING_SEEN_KEY = 'mma_gym_manager.onboarding_seen';
/** V3.7: shown small/discreet on the start screen and in the topbar header — lets a tester eyeball whether their PWA cache is actually serving the latest deploy (see index.html's own reload-on-new-service-worker note). */
const APP_VERSION = 'v3.7';

// ---- Underground Circuit: challenge catalog (V3.5: "Underground Pur") -----------

/**
 * V3.5 refonte: "Une seule ligue clandestine mondiale permanente, sans
 * regles exotiques, victoire uniquement par KO ou Soumission." Every
 * remaining challenge — including the optional gym-stakes wagers below —
 * now forces the exact same fixed ruleset (UNDERGROUND_RULESETS.KO_NO_JUDGES:
 * no judges' decision, a finish is the only way to win) and NEVER a `mode`
 * (Vale Tudo's purse/injury multipliers, Open Weight's cross-category
 * bonus, and Gauntlet's multi-fight survival format are all gone — those
 * were the "regles exotiques"). engine/UndergroundEngine.js's own
 * VALE_TUDO/OPEN_WEIGHT/GAUNTLET/SUBMISSION_ONLY/STRIKING_STANDUP exports
 * are intentionally left in place (still tested, just unreachable from this
 * UI) rather than deleted — the safest way to shrink the picker without
 * touching engine code that other tests still exercise directly.
 */
const UNDERGROUND_CHALLENGES = Object.freeze([
  {
    id: 'UNDERGROUND_MONDIAL',
    mode: null,
    ruleset: UNDERGROUND_RULESETS.KO_NO_JUDGES,
    stipulation: null,
    icon: '\u{1F977}',
    title: 'Underground Mondial',
    desc: 'La ligue clandestine mondiale — combat standard, victoire uniquement par KO/TKO ou soumission.',
    badgeLabel: 'KO / SOUMISSION',
    badgeClass: 'badge-purple',
  },
  {
    id: 'GYM_TAKEOVER',
    mode: null,
    ruleset: UNDERGROUND_RULESETS.KO_NO_JUDGES,
    stipulation: GYM_STIPULATIONS.GYM_TAKEOVER,
    icon: '\u{1F3DA}\u{FE0F}',
    title: 'Gym Takeover',
    desc: 'Victoire = equipement haut de gamme gratuit. Defaite = perte d\'un niveau d\'installation.',
    badgeLabel: 'SAISIE DE MATERIEL',
    badgeClass: 'badge-red',
  },
  {
    id: 'COACHS_HONOUR',
    mode: null,
    ruleset: UNDERGROUND_RULESETS.KO_NO_JUDGES,
    stipulation: GYM_STIPULATIONS.COACHS_HONOUR,
    icon: '\u{1F396}\u{FE0F}',
    title: "Coach's Honour",
    desc: 'Victoire = Reputation et Loyaute du roster en hausse. Defaite = Loyaute du roster en chute.',
    badgeLabel: 'HONNEUR DU STAFF',
    badgeClass: 'badge-orange',
  },
  {
    id: 'PINK_SLIP',
    mode: null,
    ruleset: UNDERGROUND_RULESETS.KO_NO_JUDGES,
    stipulation: GYM_STIPULATIONS.PINK_SLIP,
    icon: '\u{1F4C4}',
    title: 'Pink Slip',
    desc: 'Le perdant cede immediatement son combattant au gym adverse, sans indemnite.',
    badgeLabel: 'CONTRAT EN JEU',
    badgeClass: 'badge-red',
  },
  {
    id: 'SPONSORSHIP_RAID',
    mode: null,
    ruleset: UNDERGROUND_RULESETS.KO_NO_JUDGES,
    stipulation: GYM_STIPULATIONS.SPONSORSHIP_RAID,
    icon: '\u{1F4B0}',
    title: 'Sponsorship Raid',
    desc: 'Victoire = contrat de sponsor exclusif (2 000$/semaine pendant 10 semaines).',
    badgeLabel: 'RAID SPONSOR',
    badgeClass: 'badge-green',
  },
]);

function shuffleAndTake(list, count, rng) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

const ACTIVITY_LABELS = Object.freeze({
  TECHNIQUE: 'Technique',
  SPARRING: 'Sparring',
  VIDEO_PREP: 'Video Prep',
  MEDIA_SPONSORS: 'Medias',
  PHYSIO_REST: 'Repos',
});

const METHOD_LABELS = Object.freeze({
  KO: 'KO',
  TKO: 'TKO',
  SUBMISSION: 'Soumission',
  DOCTOR_STOPPAGE: 'Arret medical',
  UNANIMOUS_DECISION: 'Decision unanime',
  SPLIT_DECISION: 'Decision partagee',
  MAJORITY_DECISION: 'Decision majoritaire',
  DRAW: 'Match nul',
});

const TARGET_LABELS = Object.freeze({ HEAD: 'Tete', BODY: 'Corps', LEGS: 'Jambes' });
const DISTANCE_LABELS = Object.freeze({ STRIKING: 'Frappe', CLINCH: 'Clinch', GROUND: 'Sol' });
const TEMPO_LABELS = Object.freeze({ CONSERVATIVE: 'Prudent', BALANCED: 'Equilibre', AGGRESSIVE: 'Agressif' });

const TROPHY_ICONS = Object.freeze({
  [TROPHY_CATEGORIES.RIVALRY_OF_THE_YEAR]: '\u{2694}\u{FE0F}',
  [TROPHY_CATEGORIES.UPSET_OF_THE_YEAR]: '\u{1F4A5}',
  [TROPHY_CATEGORIES.FINISHER_KING]: '\u{1F451}',
  [TROPHY_CATEGORIES.COACH_OF_THE_YEAR]: '\u{1F393}',
  [TROPHY_CATEGORIES.GYM_OF_THE_YEAR]: '\u{1F3DF}\u{FE0F}',
});
const SKILL_LABELS = Object.freeze({
  boxe: 'Boxe',
  jambes: 'Jambes',
  sol: 'Sol',
  soumission: 'Soumission',
  cardio: 'Cardio',
  intelligence: 'Intelligence',
});

/** Purely decorative per-style emoji for the profile avatar — not a BALANCE-owned gameplay concept. */
const STYLE_AVATARS = Object.freeze({
  Boxe: '\u{1F94A}',
  'Muay Thai': '\u{1F9B5}',
  Lutte: '\u{1F93C}',
  'Jiu-Jitsu Bresilien': '\u{1F94B}',
  Freestyle: '\u{1F300}',
  Kickboxing: '\u{1F9B6}',
});

/** French "1m78" height display — V3.5, see Fighter#identity.heightCm/engine/FighterGenerator.js#generatePhysicalProfile. */
function formatHeightCm(heightCm) {
  if (!heightCm) return '';
  const meters = Math.floor(heightCm / 100);
  const centimeters = String(heightCm % 100).padStart(2, '0');
  return `${meters}m${centimeters}`;
}

/** Trend-arrow thresholds for the profile's Forme/Moral week-over-week delta — UI-only, mirrors gaugeClass()'s own local-threshold precedent. */
function trendArrow(delta) {
  if (delta > 8) return { symbol: '\u{2191}', cls: 'trend-up' };
  if (delta > 2) return { symbol: '\u{2197}', cls: 'trend-up' };
  if (delta < -8) return { symbol: '\u{2193}', cls: 'trend-down' };
  if (delta < -2) return { symbol: '\u{2198}', cls: 'trend-down' };
  return { symbol: '\u{2192}', cls: 'trend-flat' };
}


// ---- small DOM helpers -------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'onclick' && tag === 'button' && typeof value === 'function') {
      // A single choke point for "clic sur un bouton d'interface" — every
      // button built through this helper gets the click SFX for free,
      // rather than every one of this app's ~100 onclick call sites having
      // to remember to add it individually. AudioEngine itself is the mute
      // guard (see AudioEngine#_withContext) so this is always safe to call.
      node.addEventListener('click', (event) => {
        AudioEngine.playClick();
        value(event);
      });
    } else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Green/orange/red gauge color, thresholds mirroring ui/GymHub.js's own FATIGUE_WARNING_THRESHOLD (70) and the general "healthy above ~65, critical below ~35" convention used throughout this project's reports. */
function gaugeClass(value, { invert = false } = {}) {
  const v = Math.max(0, Math.min(100, value));
  const good = invert ? v < 35 : v >= 65;
  const bad = invert ? v >= 70 : v < 35;
  if (good) return 'gauge-green';
  if (bad) return 'gauge-red';
  return 'gauge-orange';
}

function gaugeRow(label, value, options = {}) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return el('div', { class: 'gauge-row' }, [
    el('span', { class: 'gauge-label', text: label }),
    el('div', { class: 'gauge-bar' }, [el('div', { class: `gauge-fill ${gaugeClass(value, options)}`, style: `width:${v}%` })]),
    el('span', { class: 'gauge-value', text: `${v}` }),
  ]);
}

// ---- reactive engine lifecycle (mirrors App.js/tools/play-vertical-slice.js) --

function createReactiveEngines() {
  return {
    personalityEngine: new PersonalityEngine(),
    relationshipEngine: new RelationshipEngine(),
    storyEngine: new StoryEngine(),
    narrativeEngine: new NarrativeEngine(),
    worldMemory: new WorldMemory(),
    historyEngine: new HistoryEngine(),
    socialEngine: new SocialEngine(),
    hallOfFameEngine: new HallOfFameEngine(),
  };
}

function attachReactiveEngines(engines, playerState, worldState) {
  engines.personalityEngine.attach(playerState);
  engines.relationshipEngine.attach(worldState);
  engines.storyEngine.attach(playerState, worldState);
  engines.narrativeEngine.attach(playerState, worldState);
  engines.worldMemory.attach(worldState);
  engines.historyEngine.attach(worldState);
  engines.socialEngine.attach(playerState);
  engines.hallOfFameEngine.attach(playerState);
}

function detachReactiveEngines(engines) {
  Object.values(engines).forEach((engine) => engine.detach());
}

// =============================================================================

class WebApp {
  constructor() {
    this.gameState = new GameState();
    this.rng = Math.random;
    this.engines = null;
    this.combatEngine = null;
    this.gymHub = null;
    this.worldFeed = null;
    this.weeklyFlow = null;
    this.fightView = null;
    this.fightCard = null;
    this.weeklyResultsThisYear = [];
    this.fightResultsThisYear = [];
    this.yearStartMoney = 0;
    this.yearStartDay = 1;
    /** { [fighterId]: getOverallRating() } snapshot taken at the start of the current year — see _captureRosterRatings()/engine/StoryAnalyzer.js's Coach of the Year trophy. */
    this.yearStartRosterRatings = {};
    this._yearChangedUnsub = null;
    this._yearChangedPending = false;
    this.lastWeekEconomy = null;
    this.journalTab = 'world';
    this.fightSetupDone = false;
    // Only the player's own corner (A) is ever player-configured — the
    // opponent (B) always fights their own AI gameplan/natural weight cut
    // (see _confirmFightSetup).
    this.gameplanChoices = { A: {} };
    this.weightCutChoices = { A: 'NATUREL' };
    this.academyPool = [];
    /** { [fighterId]: { forme, moral } } snapshot taken at the start of the current week — see _startNewWeek()/_showFighterProfile()'s trend arrows. Runtime-only, never persisted. */
    this.weekStartSnapshot = {};
    /** Set true only by the "Nouvelle Partie" flow (never Continuer/load) — gates the first-steps onboarding to a truly brand-new save, see _maybeShowFirstStepsOnboarding(). */
    this._isBrandNewGame = false;
    /** 'normal' | 'underground' — which sub-tab the Combat panel shows (see _renderFight()). */
    this.fightTab = 'normal';
    /** In-progress Underground Circuit setup ({ challenge, fighterId, gymId, opponentId }), or null — see _showUndergroundSetupModal(). Runtime-only, never persisted. */
    this._undergroundSetup = null;
    /** The permanent Recrutement market's currently-open pool ({ fighter, cost }[]) — regenerated each time the modal opens, see _showRecruitmentMarketModal(). */
    this._recruitmentPool = [];
    /** V3.7: in-progress Gala Calendar registration ({ fighterId, allowMixedGender }), or null — see _renderGalaCalendar()/_registerForGala(). The opponent is no longer hand-picked here; engine/LeagueEngine.js#registerForGala draws it from the global pool. */
    this._galaSetup = null;
    /** Live Text Feed playback state ({ beats, revealedCount, playing, timerId }) for the fight currently in progress, or null — see _beginCombatPlayback()/_scheduleNextBeat(). Runtime-only, torn down on every fight reset. */
    this._combatPlayback = null;
    this.dom = {};
  }

  init() {
    this._cacheDom();
    this._wireStartScreen();
    this._wireNav();
    this._wireModalDismiss();
    this._wireMuteToggle();
    if (this.dom.startVersion) this.dom.startVersion.textContent = APP_VERSION;
    if (this.dom.tbVersion) this.dom.tbVersion.textContent = APP_VERSION;

    const hasAutosave = SaveManager.listSlots().includes(AUTOSAVE_SLOT);
    this.dom.continueBlock.classList.toggle('hidden', !hasAutosave);
    if (hasAutosave) {
      try {
        const { savedAt } = SaveManager.load(AUTOSAVE_SLOT);
        this.dom.continueMeta.textContent = `Derniere sauvegarde : ${new Date(savedAt).toLocaleString('fr-FR')}`;
      } catch {
        // An incompatible (e.g. pre-v1/unmigratable) or corrupted autosave
        // must never block "Nouvelle Partie" — that flow never reads this
        // slot at all (see _wireStartScreen's btnNewGame handler, which
        // calls gameState.newGame() directly). Actively delete the dead
        // slot here too, rather than only hiding "Continuer": leaving it in
        // localStorage forever would keep failing this same load on every
        // future boot for no benefit, and SaveManager.listSlots()/
        // isCompatible() give no other cleanup path for it.
        SaveManager.deleteSlot(AUTOSAVE_SLOT);
        this.dom.continueBlock.classList.add('hidden');
      }
    }
  }

  _cacheDom() {
    this.dom = {
      startScreen: document.getElementById('startScreen'),
      gameShell: document.getElementById('gameShell'),
      continueBlock: document.getElementById('continueBlock'),
      continueMeta: document.getElementById('continueMeta'),
      btnContinue: document.getElementById('btnContinue'),
      btnNewGame: document.getElementById('btnNewGame'),
      btnShowSlots: document.getElementById('btnShowSlots'),
      slotList: document.getElementById('slotList'),
      newGymName: document.getElementById('newGymName'),
      newGymCountry: document.getElementById('newGymCountry'),
      managerBackgroundChoice: document.getElementById('managerBackgroundChoice'),
      startVersion: document.getElementById('startVersion'),
      tbVersion: document.getElementById('tbVersion'),
      tbGymName: document.getElementById('tbGymName'),
      tbDay: document.getElementById('tbDay'),
      tbMoney: document.getElementById('tbMoney'),
      tbRep: document.getElementById('tbRep'),
      tbHype: document.getElementById('tbHype'),
      btnMuteToggle: document.getElementById('btnMuteToggle'),
      panels: {
        hub: document.getElementById('panel-hub'),
        roster: document.getElementById('panel-roster'),
        planning: document.getElementById('panel-planning'),
        fight: document.getElementById('panel-fight'),
        journal: document.getElementById('panel-journal'),
      },
      navButtons: Array.from(document.querySelectorAll('.nav-btn')),
      modalOverlay: document.getElementById('modalOverlay'),
      modalCard: document.getElementById('modalCard'),
      toast: document.getElementById('toast'),
    };
  }

  // ---- boot flow ------------------------------------------------------------

  _wireStartScreen() {
    this.dom.btnNewGame.addEventListener('click', () => {
      try {
        // A brand new gym starts with STRICTLY ZERO fighters and goes
        // STRAIGHT to the Hub — no mandatory Draft step blocking entry
        // anymore. The permanent Recrutement market (Effectif tab, see
        // _showRecruitmentMarketModal) is always there whenever the player
        // decides they're ready to sign their first fighters.
        this.gameState.newGame({
          gymName: this.dom.newGymName.value || undefined,
          country: this.dom.newGymCountry.value || undefined,
        });
        this._applyManagerBackground();
        // Seeded with a starting roster (not the default empty one) so a
        // fresh game has a legal opponent from Day 1: engine/Matchmaking.js
        // now forbids a competitive bout between two of the player's own
        // fighters, and engine/TransferMarket.js's own autonomous recruiting
        // only runs once a season — an empty rival gym would otherwise leave
        // the Combat tab with nobody to fight for weeks.
        for (const { name, reputation } of [
          { name: 'Iron Fist Academy', reputation: 55 },
          { name: 'Apex MMA', reputation: 45 },
        ]) {
          const starterRoster = generateRivalGymStarterRoster({ reputation, rng: this.rng });
          this.gameState.worldState.addRivalGym({ name, reputation, roster: starterRoster.map((fighter) => fighter.toJSON()) });
        }
        this._isBrandNewGame = true;
        this._enterGame();
        this._autosave();
        this._showWelcomeModal();
      } catch (error) {
        // A failure here used to fail completely silently: the click handler
        // would throw, the start screen would just sit there, and nothing in
        // the UI ever told the player (or us) why "Commencer" appeared to do
        // nothing. Surface it loudly instead of leaving the button inert.
        console.error('[web] Echec de la creation de partie:', error);
        window.alert(`Impossible de creer la partie : ${error?.message ?? error}`);
      }
    });

    this.dom.btnContinue.addEventListener('click', () => {
      this.gameState.load(AUTOSAVE_SLOT);
      this._enterGame();
      this._maybeOpenAcademyDraft();
    });

    this.dom.btnShowSlots.addEventListener('click', () => {
      const slots = SaveManager.listSlots();
      this.dom.slotList.innerHTML = '';
      if (slots.length === 0) {
        this.dom.slotList.appendChild(el('li', { class: 'empty', text: 'Aucune sauvegarde disponible.' }));
        return;
      }
      for (const slot of slots) {
        this.dom.slotList.appendChild(
          el('li', {}, [
            el('button', {
              class: 'btn btn-outline btn-block slot-btn',
              text: slot,
              onclick: () => {
                this.gameState.load(slot);
                this._enterGame();
                this._maybeOpenAcademyDraft();
              },
            }),
          ])
        );
      }
    });
  }

  /**
   * V3.5: applies exactly one BALANCE.MANAGER_BACKGROUNDS bonus, read from
   * the checked radio in the "Nouvelle Partie" form — called once, right
   * after gameState.newGame() constructs a fresh PlayerState. Each
   * background hands out a single kind of bonus (money/hype/reputation),
   * never combined.
   */
  _applyManagerBackground() {
    const checked = this.dom.managerBackgroundChoice.querySelector('input[name="managerBackground"]:checked');
    const background = BALANCE.MANAGER_BACKGROUNDS[checked?.value];
    if (!background) return;

    const { playerState } = this.gameState;
    if (background.moneyBonus) playerState.changeMoney(background.moneyBonus, `MANAGER_BACKGROUND:${background.id}`);
    if (background.hypeBonus) playerState.changeHype(background.hypeBonus, `MANAGER_BACKGROUND:${background.id}`);
    if (background.reputationBonus) playerState.changeReputation(background.reputationBonus, `MANAGER_BACKGROUND:${background.id}`);
  }

  _wireNav() {
    for (const button of this.dom.navButtons) {
      button.addEventListener('click', () => this._showPanel(button.dataset.panel));
    }
  }

  _wireModalDismiss() {
    this.dom.modalOverlay.addEventListener('click', (event) => {
      if (event.target === this.dom.modalOverlay && !this.dom.modalOverlay.dataset.blocking) {
        this._hideModal();
      }
    });
  }

  /**
   * The 🔊/🔇 header toggle — deliberately a raw addEventListener rather
   * than el()'s onclick (which itself calls AudioEngine.playClick()): a
   * click on the mute button toggling INTO muted should not also fire a
   * click sound, and un-muting doesn't need its own confirmation chime
   * either. AudioEngine.isMuted() is read once here at boot to reflect
   * whatever was persisted from a previous session (see AudioEngine's own
   * localStorage-backed constructor).
   */
  _wireMuteToggle() {
    this._syncMuteButton();
    this.dom.btnMuteToggle.addEventListener('click', () => {
      AudioEngine.toggleMuted();
      this._syncMuteButton();
    });
  }

  _syncMuteButton() {
    const muted = AudioEngine.isMuted();
    this.dom.btnMuteToggle.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
    this.dom.btnMuteToggle.setAttribute('aria-label', muted ? 'Activer le son' : 'Couper le son');
  }

  // ---- WELCOME (immersive "Nouvelle Partie" intro) ---------------------------------

  /**
   * A brand-new gym no longer opens on a mandatory Draft — it opens
   * straight on the Hub, roster empty, with this one-time immersive
   * welcome instead: a dynamic, in-character pitch ("you, a manager
   * building a club from nothing") naming the gym/country the player just
   * typed in, pointing them at the permanent Recrutement market
   * (Effectif tab) whenever they're ready to sign their first fighters.
   * Closing it chains into the existing mechanical First Steps onboarding
   * (Readiness/Loyaute/Planning), unchanged.
   */
  _showWelcomeModal() {
    const { gymName, country, money } = this.gameState.playerState;
    const place = country ? ` a ${country}` : '';

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F94A} Bienvenue au sommet — ou plutot, tout en bas' }),
      el('p', {
        text: `${gymName}${place} n'est encore rien : une adresse, ${Math.round(money).toLocaleString('fr-FR')}$ en caisse, et pas un seul combattant sous contrat. Personne ne connait votre nom — pas encore.`,
      }),
      el('p', {
        text: "C'est vous, desormais, le manager. Chaque signature, chaque contrat, chaque combat porte votre empreinte. Un promoteur inconnu peut batir un empire ; un mauvais choix peut tout couler avant meme le premier combat.",
      }),
      el('p', {
        text: "Rendez-vous dans l'onglet Effectif des que vous etes pret : le Marche de Recrutement y est ouvert en permanence pour signer vos premiers combattants, a votre rythme et selon votre budget.",
      }),
      el('button', {
        class: 'btn btn-gold btn-block',
        text: 'Prendre les commandes',
        onclick: () => {
          this._hideModal();
          this._maybeShowFirstStepsOnboarding();
        },
      }),
    ]);
    this._showModal(content, { blocking: true });
  }

  _enterGame() {
    this.engines = createReactiveEngines();
    attachReactiveEngines(this.engines, this.gameState.playerState, this.gameState.worldState);

    this.combatEngine = new CombatEngine({ playerState: this.gameState.playerState, worldState: this.gameState.worldState, rng: this.rng });
    this.gymHub = new GymHub({ playerState: this.gameState.playerState, worldState: this.gameState.worldState });
    this.worldFeed = new WorldFeed({ playerState: this.gameState.playerState, worldState: this.gameState.worldState }).attach();

    this.yearStartMoney = this.gameState.playerState.money;
    this.yearStartDay = this.gameState.worldState.currentDay;
    this.yearStartRosterRatings = this._captureRosterRatings();
    this.weeklyResultsThisYear = [];
    this.fightResultsThisYear = [];
    this.lastWeekEconomy = null;
    this.journalTab = 'world';
    this._galaSetup = null;
    this.fightView = null;
    this.fightSetupDone = false;
    this.academyPool = [];
    this.fightTab = 'normal';
    this._undergroundSetup = null;

    this._yearChangedPending = false;
    this._yearChangedUnsub?.();
    this._yearChangedUnsub = EventBus.subscribe(WORLD_EVENTS.YEAR_CHANGED, () => {
      this._yearChangedPending = true;
    });

    telemetry.startSession();

    this.dom.startScreen.classList.add('hidden');
    this.dom.gameShell.classList.remove('hidden');

    this._startNewWeek();
    this._renderAll();
  }

  // ---- panel switching --------------------------------------------------------

  _showPanel(name) {
    for (const [key, panel] of Object.entries(this.dom.panels)) {
      panel.classList.toggle('active', key === name);
    }
    for (const button of this.dom.navButtons) {
      button.classList.toggle('active', button.dataset.panel === name);
    }
    this._renderPanel(name);
  }

  _renderAll() {
    this._renderTopbar();
    for (const key of Object.keys(this.dom.panels)) this._renderPanel(key);
  }

  _renderPanel(name) {
    if (name === 'hub') this._renderHub();
    else if (name === 'roster') this._renderRoster();
    else if (name === 'planning') this._renderPlanning();
    else if (name === 'fight') this._renderFight();
    else if (name === 'journal') this._renderJournal();
  }

  _renderTopbar() {
    const { playerState, worldState } = this.gameState;
    this.dom.tbGymName.textContent = playerState.gymName;
    this.dom.tbDay.textContent = `Jour ${worldState.currentDay} — ${worldState.season}, an ${worldState.year}`;
    this.dom.tbMoney.textContent = `${Math.round(playerState.money).toLocaleString('fr-FR')}$`;
    this.dom.tbRep.textContent = Math.round(playerState.reputation);
    this.dom.tbHype.textContent = Math.round(playerState.hype);
  }

  // ---- HUB panel --------------------------------------------------------------

  _renderHub() {
    const panel = this.dom.panels.hub;
    panel.innerHTML = '';
    const snapshot = this.gymHub.getSnapshot();

    if (snapshot.alerts.length > 0) {
      const list = el(
        'ul',
        { class: 'alert-list' },
        snapshot.alerts.map((alert) => el('li', { class: 'alert-item', text: `⚠️ ${alert.text}` }))
      );
      panel.appendChild(list);
    }

    if (isTreasuryCrisis(this.gameState.playerState)) {
      panel.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title', text: '\u{1F6A8} Tresorerie critique' }),
          el('p', { text: "La tresorerie est passee sous le seuil critique — des leviers d'urgence sont disponibles." }),
          el('button', {
            class: 'btn btn-gold btn-block',
            text: "\u{1F6A8} Leviers d'urgence",
            onclick: () => this._showEmergencyFinanceModal(),
          }),
        ])
      );
    }

    panel.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Gym' }),
        el('ul', { class: 'stat-grid' }, [
          el('li', { class: 'stat-tile' }, [el('span', { class: 'stat-label', text: 'Tresorerie' }), el('span', { class: 'stat-value', text: `${Math.round(snapshot.gym.money).toLocaleString('fr-FR')}$` })]),
          el('li', { class: 'stat-tile' }, [el('span', { class: 'stat-label', text: 'Reputation' }), el('span', { class: 'stat-value', text: `${Math.round(snapshot.gym.reputation)}` })]),
          el('li', { class: 'stat-tile' }, [el('span', { class: 'stat-label', text: 'Hype' }), el('span', { class: 'stat-value', text: `${Math.round(snapshot.gym.hype)}` })]),
        ]),
      ])
    );

    if (snapshot.gym.coaches.length > 0) {
      panel.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title', text: 'Staff Legacy' }),
          ...this.gameState.playerState.coaches.map((coach) => {
            const awardsTag = coach.awards?.length > 0 ? ` \u{1F3C6}x${coach.awards.length}` : '';
            return el('p', { text: `\u{1F393} ${coach.name} — ${coach.specialty ?? 'generaliste'} (skill ${coach.skill})${awardsTag}` });
          }),
        ])
      );
    }

    const staffCoaches = this.gameState.playerState.coaches.filter((coach) => coach.role);
    const promotion = getPromotionProgress(this.gameState.playerState);
    panel.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '\u{1F4CB} Staff & Competitions' }),
        el('div', { class: 'list-row' }, [
          el('span', { class: 'list-row-label', text: 'Ligue actuelle' }),
          el('span', { class: 'list-row-value', text: promotion.tier.label }),
        ]),
        promotion.nextTier
          ? el('div', {}, [
              gaugeRow(`Winrate -> ${promotion.nextTier.label}`, (promotion.winrateProgress ?? 0) * 100),
              gaugeRow(`Reputation -> ${promotion.nextTier.label}`, (promotion.reputationProgress ?? 0) * 100),
            ])
          : el('p', { text: 'Ligue la plus haute deja atteinte.' }),
        staffCoaches.length === 0
          ? el('p', { text: 'Aucun staff specialise sous contrat.' })
          : el(
              'div',
              {},
              staffCoaches.map((coach) =>
                el('div', { class: 'list-row' }, [
                  el('div', {}, [
                    el('div', { class: 'list-row-label', text: `${coach.name} — ${BALANCE.STAFF.ROLES[coach.role]?.label ?? coach.role}` }),
                    el('div', { class: 'list-row-sub', text: `Skill ${coach.skill} — ${coach.salary}$/sem — Relation ${coach.relationship ?? '-'}` }),
                  ]),
                ])
              )
            ),
        el('button', {
          class: 'btn btn-outline btn-block',
          text: '\u{1F4CB} Recruter du staff',
          onclick: () => this._showStaffHiringModal(),
        }),
      ])
    );

    const communityPlayerState = this.gameState.playerState;
    panel.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '\u{1F4F1} Community Manager' }),
        el('div', { class: 'list-row' }, [
          el('span', { class: 'list-row-label', text: 'Abonnes' }),
          el('span', { class: 'list-row-value', text: Math.round(communityPlayerState.subscribers).toLocaleString('fr-FR') }),
        ]),
        el('div', { class: 'list-row' }, [
          el('span', { class: 'list-row-label', text: 'Revenus merchandising (est. hebdo)' }),
          el('span', { class: 'list-row-value', text: `+${Math.round(computeWeeklyMerchandisingIncome(communityPlayerState)).toLocaleString('fr-FR')}$` }),
        ]),
        el('label', { class: 'checkbox-row' }, [
          el('input', {
            type: 'checkbox',
            checked: communityPlayerState.filmingEnabled ? 'checked' : null,
            onchange: (event) => {
              communityPlayerState.setFilmingEnabled(event.target.checked);
              this._renderHub();
            },
          }),
          ' Filmer les combattants (plus d\'abonnes/revenus, mais coute du moral aux combattants Introvertis)',
        ]),
      ])
    );

    if (this.lastWeekEconomy) {
      const e = this.lastWeekEconomy;
      panel.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title', text: 'Charges (derniere semaine)' }),
          el('div', { class: 'list-row' }, [el('span', { class: 'list-row-label', text: 'Loyer' }), el('span', { class: 'list-row-value', text: `-${Math.round(e.rent)}$` })]),
          el('div', { class: 'list-row' }, [el('span', { class: 'list-row-label', text: 'Salaires coachs' }), el('span', { class: 'list-row-value', text: `-${Math.round(e.coachPayroll)}$` })]),
          el('div', { class: 'list-row' }, [el('span', { class: 'list-row-label', text: 'Salaires combattants' }), el('span', { class: 'list-row-value', text: `-${Math.round(e.fighterPayroll)}$` })]),
          el('div', { class: 'list-row' }, [el('span', { class: 'list-row-label', text: 'Entretien equipements' }), el('span', { class: 'list-row-value', text: `-${Math.round(e.equipmentMaintenance)}$` })]),
          el('div', { class: 'list-row' }, [el('span', { class: 'list-row-label', text: 'Revenus passifs' }), el('span', { class: 'list-row-value', text: `+${Math.round(e.passiveIncome)}$` })]),
          el('div', { class: 'list-row' }, [
            el('span', { class: 'list-row-label', text: 'Solde net' }),
            el('span', { class: 'list-row-value', text: `${e.netChange >= 0 ? '+' : ''}${Math.round(e.netChange)}$` }),
          ]),
        ])
      );
    }

    const rosterCard = el('div', { class: 'card' }, [el('div', { class: 'card-title', text: `Effectif (${snapshot.roster.length})` })]);
    for (const fighter of snapshot.roster.slice(0, 4)) {
      rosterCard.appendChild(this._buildFighterCard(fighter));
    }
    if (snapshot.roster.length > 4) {
      rosterCard.appendChild(el('p', { text: `+ ${snapshot.roster.length - 4} autre(s) — voir l'onglet Effectif.` }));
    }
    panel.appendChild(rosterCard);

    panel.appendChild(
      el('button', {
        class: 'btn btn-outline btn-block',
        text: '\u{1F3CB}\u{FE0F} Ma salle (equipement & rivaux)',
        onclick: () => this._showGymFacilityModal(),
      })
    );

    panel.appendChild(
      el('button', {
        class: 'btn btn-outline btn-block',
        text: '\u{2699}\u{FE0F} Parametres & Sauvegarde',
        onclick: () => this._showSettingsModal(),
      })
    );

    panel.appendChild(
      el('button', {
        class: 'btn btn-gold btn-block',
        text: '\u{1F4C5} Aller au planning de la semaine',
        onclick: () => this._showPanel('planning'),
      })
    );

    panel.appendChild(el('p', { class: 'version-tag hub-footer-version', text: APP_VERSION }));
  }

  // ---- GYM FACILITY / EQUIPMENT / RIVALS modal ---------------------------------

  _showGymFacilityModal() {
    const playerState = this.gameState.playerState;
    const tier = playerState.getFacilityTier();
    const nextTier = getNextTier(playerState);
    const nextTierCost = getNextTierUpgradeCost(playerState);

    const ownedIds = new Set(playerState.equipment.map((item) => item.id));
    const owned = playerState.equipment
      .map((item) => ({ ...item, def: BALANCE.EQUIPMENT.DEFINITIONS[item.id] }))
      .filter((item) => item.def);
    const catalog = Object.entries(BALANCE.EQUIPMENT.DEFINITIONS)
      .filter(([id]) => !ownedIds.has(id))
      .map(([id, def]) => ({ id, ...def, affordable: playerState.money >= def.purchaseCost }));

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F3CB}\u{FE0F} Infrastructure & Materiel' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: `${tier.label} — ${playerState.roster.length}/${tier.capacity} places` }),
        nextTier
          ? el('button', {
              class: 'btn btn-gold btn-block',
              text: `Agrandir vers ${nextTier.label} (${nextTierCost}$)`,
              disabled: playerState.money >= nextTierCost ? null : 'disabled',
              onclick: () => this._upgradeFacility(),
            })
          : el('p', { text: 'Palier maximum atteint (Academie Elite).' }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: `Equipement possede (${owned.length})` }),
        owned.length === 0
          ? el('p', { text: 'Aucun equipement pour le moment.' })
          : el(
              'div',
              {},
              owned.map((item) => {
                const quality = item.quality ?? 1;
                const lowQuality = quality < BALANCE.EQUIPMENT.LOW_QUALITY_THRESHOLD;
                const repairCost = getRepairCost(item.id);
                return el('div', { class: 'list-row' }, [
                  el('div', {}, [
                    el('div', { class: 'list-row-label', text: `${getEquipmentHealthIndicator(quality)} ${item.def.label}` }),
                    el('div', {
                      class: 'list-row-sub',
                      text: `Qualite ${Math.round(quality * 100)}% — ${item.def.weeklyMaintenanceCost}$/sem${lowQuality ? ' — risque de blessure accru' : ''}`,
                    }),
                  ]),
                  quality < 1
                    ? el('button', {
                        class: 'btn btn-outline btn-sm',
                        text: `Entretenir (${repairCost}$)`,
                        disabled: playerState.money >= repairCost ? null : 'disabled',
                        onclick: () => this._repairEquipmentItem(item.id),
                      })
                    : null,
                ]);
              })
            ),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Catalogue' }),
        catalog.length === 0
          ? el('p', { text: 'Tout est deja possede.' })
          : el(
              'div',
              {},
              catalog.map((item) =>
                el('div', { class: 'list-row' }, [
                  el('div', {}, [
                    el('div', { class: 'list-row-label', text: item.label }),
                    el('div', { class: 'list-row-sub', text: `${item.purchaseCost}$ — ${item.weeklyMaintenanceCost}$/sem` }),
                  ]),
                  el('button', {
                    class: 'btn btn-outline btn-sm',
                    text: 'Acheter',
                    disabled: item.affordable ? null : 'disabled',
                    onclick: () => this._buyEquipment(item.id),
                  }),
                ])
              )
            ),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Gyms rivaux' }),
        this.gameState.worldState.rivalGyms.length === 0
          ? el('p', { text: 'Aucun gym rival recense.' })
          : el(
              'div',
              {},
              this.gameState.worldState.rivalGyms.map((gym) =>
                el('div', { class: 'list-row' }, [
                  el('span', { class: 'list-row-label', text: gym.name ?? gym.id }),
                  el('span', { class: 'list-row-value', text: `Reputation ${Math.round(gym.reputation ?? 0)}` }),
                ])
              )
            ),
      ]),
      el('button', { class: 'btn btn-gold btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);
    this._showModal(content);
  }

  _buyEquipment(equipmentId) {
    const playerState = this.gameState.playerState;
    const def = BALANCE.EQUIPMENT.DEFINITIONS[equipmentId];
    if (!def || playerState.money < def.purchaseCost) return;
    playerState.changeMoney(-def.purchaseCost, `EQUIPMENT_PURCHASE:${equipmentId}`);
    playerState.addEquipmentItem({ id: equipmentId });
    AudioEngine.playCash();
    this._renderTopbar();
    this._showToast(`\u{1F6E0}\u{FE0F} ${def.label} achete.`);
    this._showGymFacilityModal();
  }

  _upgradeFacility() {
    const playerState = this.gameState.playerState;
    const cost = getNextTierUpgradeCost(playerState);
    const upgraded = cost !== null && playerState.upgradeFacility(cost);
    if (upgraded) {
      AudioEngine.playCash();
      this._renderTopbar();
      this._showToast(`\u{2B06}\u{FE0F} ${playerState.getFacilityTier().label} — nouvelle capacite atteinte.`);
    }
    this._showGymFacilityModal();
  }

  _repairEquipmentItem(equipmentId) {
    const playerState = this.gameState.playerState;
    const def = BALANCE.EQUIPMENT.DEFINITIONS[equipmentId];
    if (repairEquipment(playerState, equipmentId)) {
      this._renderTopbar();
      this._showToast(`\u{1F527} ${def?.label ?? equipmentId} remis en etat.`);
    }
    this._showGymFacilityModal();
  }

  // ---- STAFF ENGINE hiring modal ---------------------------------------------

  _showStaffHiringModal() {
    const playerState = this.gameState.playerState;
    if (!this._staffHiringPool) this._staffHiringPool = generateHiringPool({ reputation: playerState.reputation, rng: this.rng });
    const pool = this._staffHiringPool;
    const specialtyLabel = { STRIKING: 'Frappe', GRAPPLING: 'Grappling' };

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F4CB} Recruter du staff' }),
      ...pool.map((candidate) => {
        const role = BALANCE.STAFF.ROLES[candidate.role];
        const incumbent = playerState.coaches.find((coach) => coach.role === candidate.role);
        return el('div', { class: 'card' }, [
          el('div', {
            class: 'card-title',
            text: `${candidate.name} — ${role.label}${candidate.specialty ? ` (${specialtyLabel[candidate.specialty]})` : ''}`,
          }),
          el('p', { text: `Skill ${candidate.skill} — ${candidate.salary}$/semaine` }),
          incumbent
            ? el('p', { class: 'fighter-meta', text: `Poste occupe par ${incumbent.name} — congediez-le d'abord.` })
            : el('button', {
                class: 'btn btn-gold btn-block',
                text: 'Recruter',
                onclick: () => this._hireStaffCandidate(candidate),
              }),
        ]);
      }),
      ...(playerState.coaches.filter((coach) => coach.role).length > 0
        ? [
            el('div', { class: 'card' }, [
              el('div', { class: 'card-title', text: 'Staff sous contrat' }),
              ...playerState.coaches
                .filter((coach) => coach.role)
                .map((coach) =>
                  el('div', { class: 'list-row' }, [
                    el('span', { class: 'list-row-label', text: `${coach.name} — ${BALANCE.STAFF.ROLES[coach.role]?.label ?? coach.role}` }),
                    el('button', { class: 'btn btn-outline btn-sm', text: 'Congedier', onclick: () => this._fireStaffCoach(coach.id) }),
                  ])
                ),
            ]),
          ]
        : []),
      el('button', { class: 'btn btn-outline btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);
    this._showModal(content);
  }

  _hireStaffCandidate(candidate) {
    const playerState = this.gameState.playerState;
    if (playerState.coaches.some((coach) => coach.role === candidate.role)) return;
    hireStaff(playerState, candidate);
    this._staffHiringPool = null;
    this._renderTopbar();
    this._showToast(`\u{1F4CB} ${candidate.name} rejoint le staff.`);
    this._hideModal();
    this._renderHub();
  }

  _fireStaffCoach(coachId) {
    this.gameState.playerState.removeCoach(coachId);
    this._renderTopbar();
    this._showStaffHiringModal();
  }

  // ---- EMERGENCY FINANCE (treasury crisis levers) ----------------------------

  _showEmergencyFinanceModal() {
    const playerState = this.gameState.playerState;
    const loanCfg = BALANCE.EMERGENCY_FINANCE.PREDATORY_LOAN;
    const ownedEquipment = playerState.equipment
      .map((item) => ({ ...item, def: BALANCE.EQUIPMENT.DEFINITIONS[item.id] }))
      .filter((item) => item.def);

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: "\u{1F6A8} Leviers d'urgence" }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '\u{1F4B8} Pret usurier' }),
        el('p', { text: `Recevez ${loanCfg.PRINCIPAL}$ immediatement, rembourses ${loanCfg.TOTAL_REPAYMENT}$ au total sur ${loanCfg.WEEKS_TO_REPAY} semaines.` }),
        el('button', { class: 'btn btn-gold btn-block', text: 'Emprunter', onclick: () => this._takeEmergencyLoan() }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '\u{1F4E6} Vente bradee de materiel' }),
        ownedEquipment.length === 0
          ? el('p', { text: 'Aucun equipement a vendre.' })
          : el(
              'div',
              {},
              ownedEquipment.map((item) =>
                el('div', { class: 'list-row' }, [
                  el('span', { class: 'list-row-label', text: item.def.label }),
                  el('button', {
                    class: 'btn btn-outline btn-sm',
                    text: `Vendre (${getFireSalePrice(item.id)}$)`,
                    onclick: () => this._fireSaleEquipmentItem(item.id),
                  }),
                ])
              )
            ),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '\u{1F573}\u{FE0F} Combat clandestin a haut risque' }),
        el('p', { text: 'Une bourse plus elevee, mais un risque de blessure accru — Underground Circuit, mode Vale Tudo.' }),
        el('button', {
          class: 'btn btn-outline btn-block',
          text: 'Aller au Circuit Underground',
          onclick: () => {
            this._hideModal();
            this.fightTab = 'underground';
            this._showPanel('fight');
          },
        }),
      ]),
      el('button', { class: 'btn btn-outline btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);
    this._showModal(content);
  }

  _takeEmergencyLoan() {
    takePredatoryLoan(this.gameState.playerState);
    this._renderTopbar();
    this._showToast('\u{1F4B8} Pret usurier accepte — remboursement hebdomadaire engage.');
    this._hideModal();
    this._renderHub();
  }

  _fireSaleEquipmentItem(equipmentId) {
    const def = BALANCE.EQUIPMENT.DEFINITIONS[equipmentId];
    if (fireSaleEquipment(this.gameState.playerState, equipmentId)) {
      this._renderTopbar();
      this._showToast(`\u{1F4E6} ${def?.label ?? equipmentId} vendu en urgence.`);
    }
    this._showEmergencyFinanceModal();
  }

  _buildFighterCard(fighter) {
    const badges = [];
    if (fighter.nickname) badges.push(el('span', { class: 'badge badge-nickname', text: fighter.nickname }));
    if (fighter.injured) badges.push(el('span', { class: 'badge badge-injured', text: 'Blesse' }));

    const card = el('div', { class: 'fighter-card' }, [
      el('div', { class: 'fighter-head' }, [
        el('div', {}, [
          el('div', { class: 'fighter-name', text: fighter.name }),
          el('div', { class: 'fighter-meta', text: `${fighter.style} — ${fighter.age} ans — ${fighter.record ?? ''}` }),
        ]),
        el('div', {}, badges),
      ]),
      gaugeRow('Readiness', fighter.readiness),
      gaugeRow('Fatigue P', fighter.physicalFatigue, { invert: true }),
      gaugeRow('Fatigue M', fighter.mentalFatigue, { invert: true }),
    ]);
    card.appendChild(
      el('button', {
        class: 'btn btn-outline btn-sm',
        text: '\u{1F4CB} Fiche',
        onclick: () => this._showFighterProfile(this.gameState.playerState.getFighter(fighter.id)),
      })
    );
    return card;
  }

  // ---- ROSTER panel -------------------------------------------------------------

  _renderRoster() {
    const panel = this.dom.panels.roster;
    panel.innerHTML = '';
    const roster = this.gameState.playerState.roster;

    panel.appendChild(el('h2', { class: 'section-title', text: `Effectif (${roster.length}/${this.gameState.playerState.getRosterCapacity()})` }));

    panel.appendChild(
      el('button', {
        class: 'btn btn-outline btn-block',
        text: '\u{1F4B0} Marche de Recrutement',
        onclick: () => this._showRecruitmentMarketModal(),
      })
    );

    panel.appendChild(
      el('button', {
        class: 'btn btn-outline btn-block',
        text: '\u{1F575}\u{FE0F} Mercato & Debauchage',
        onclick: () => this._showMercatoModal(),
      })
    );

    for (const fighter of roster) {
      panel.appendChild(this._buildRosterDetailCard(fighter));
    }
  }

  // ---- RECRUITMENT MARKET (permanent, always-open — see engine/DraftEngine.js) ----

  _showRecruitmentMarketModal() {
    this._recruitmentPool = generateRecruitmentPool({ playerState: this.gameState.playerState, rng: this.rng });
    this._renderRecruitmentMarketModal();
  }

  _renderRecruitmentMarketModal() {
    const playerState = this.gameState.playerState;
    const rosterFull = playerState.roster.length >= playerState.getRosterCapacity();

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F4B0} Marche de Recrutement' }),
      el('p', { text: 'Recrutez de nouveaux combattants a tout moment, contre une prime de signature et un salaire hebdomadaire — independamment de la Draft Annuelle de l\'Academie.' }),
      el('p', { class: 'fighter-meta', text: `Tresorerie : ${Math.round(playerState.money).toLocaleString('fr-FR')}$ — Effectif ${playerState.roster.length}/${playerState.getRosterCapacity()}` }),
      rosterFull ? el('p', { text: 'Effectif au complet — liberez une place avant de recruter.' }) : null,
      ...this._recruitmentPool.map((candidate) => this._buildRecruitmentCandidateCard(candidate, rosterFull)),
      el('button', { class: 'btn btn-outline btn-block', text: 'Rafraichir la liste', onclick: () => this._showRecruitmentMarketModal() }),
      el('button', { class: 'btn btn-gold btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);
    this._showModal(content, { blocking: true });
  }

  _buildRecruitmentCandidateCard(candidate, rosterFull) {
    const { fighter, cost, weeklySalary, potentialLabel } = candidate;
    const { playerState } = this.gameState;
    const affordable = !rosterFull && playerState.money >= cost;

    return el('div', { class: 'fighter-card' }, [
      el('div', { class: 'fighter-head' }, [
        el('div', {}, [
          el('div', { class: 'fighter-name' }, [
            fighter.identity.name,
            potentialLabel && potentialLabel !== 'Prospect' ? el('span', { class: 'badge badge-nickname', text: potentialLabel }) : null,
          ]),
          el('div', { class: 'fighter-meta', text: `${fighter.identity.style} — ${fighter.identity.age} ans — Note ${fighter.getOverallRating()}` }),
        ]),
        el('span', { class: 'badge badge-blue', text: `${cost.toLocaleString('fr-FR')}$` }),
      ]),
      el('div', { class: 'fighter-meta', text: `Salaire hebdomadaire : ${weeklySalary.toLocaleString('fr-FR')}$/semaine` }),
      el('button', {
        class: 'btn btn-gold btn-sm',
        text: 'Signer',
        disabled: affordable ? null : 'disabled',
        onclick: () => this._signRecruit(candidate),
      }),
    ]);
  }

  _signRecruit(candidate) {
    const { fighter, cost, weeklySalary } = candidate;
    const { playerState } = this.gameState;
    if (playerState.roster.length >= playerState.getRosterCapacity() || playerState.money < cost) return;

    fighter.weeklySalary = weeklySalary;
    playerState.addFighter(fighter);
    playerState.changeMoney(-cost, 'RECRUITMENT_MARKET');
    telemetry.recordFighterRecruited();
    this._recruitmentPool = this._recruitmentPool.filter((c) => c.fighter.identity.id !== fighter.identity.id);

    AudioEngine.playCash();
    this._showToast(`\u{1F4DD} ${fighter.identity.name} signe au gym (${weeklySalary.toLocaleString('fr-FR')}$/semaine).`);
    this._renderRecruitmentMarketModal();
    this._renderTopbar();
    this._autosave();
  }

  // ---- MERCATO (V3.5: scouting + rival buyouts) ------------------------------

  _showMercatoModal() {
    this._renderMercatoModal();
  }

  _renderMercatoModal() {
    const playerState = this.gameState.playerState;
    const worldState = this.gameState.worldState;
    const scoutCfg = BALANCE.MERCATO.SCOUT;
    const scoutableGyms = getScoutableGyms(worldState.rivalGyms);

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F575}\u{FE0F} Mercato & Debauchage' }),

      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Envoyer un Detecteur' }),
        el('p', { text: `Payez ${scoutCfg.COST}$ pour denicher 1 a 3 jeunes rookies (18-23 ans) dans un petit club — libres a signer, sans frais de recrutement.` }),
        scoutableGyms.length === 0 ? el('p', { class: 'fighter-meta', text: 'Aucun petit club a explorer pour le moment.' }) : null,
        el('button', {
          class: 'btn btn-gold btn-block',
          text: `Envoyer un Detecteur (${scoutCfg.COST}$)`,
          disabled: scoutableGyms.length > 0 && playerState.money >= scoutCfg.COST ? null : 'disabled',
          onclick: () => this._sendMercatoScout(),
        }),
      ]),

      ...(this._scoutedRookies && this._scoutedRookies.length > 0
        ? [
            el('div', { class: 'card' }, [
              el('div', { class: 'card-title', text: 'Rookies deniches' }),
              ...this._scoutedRookies.map((rookie) => this._buildScoutedRookieCard(rookie)),
            ]),
          ]
        : []),

      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Racheter un combattant rival' }),
        worldState.rivalGyms.length === 0
          ? el('p', { text: 'Aucun gym rival recense.' })
          : el(
              'div',
              {},
              worldState.rivalGyms.map((gym) => this._buildMercatoRivalGymBlock(gym))
            ),
      ]),

      el('button', { class: 'btn btn-outline btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);
    this._showModal(content, { blocking: true });
  }

  _buildScoutedRookieCard(rookie) {
    const { playerState } = this.gameState;
    const rosterFull = playerState.roster.length >= playerState.getRosterCapacity();
    return el('div', { class: 'fighter-card' }, [
      el('div', { class: 'fighter-head' }, [
        el('div', {}, [
          el('div', { class: 'fighter-name', text: rookie.identity.name }),
          el('div', { class: 'fighter-meta', text: `${rookie.identity.style} — ${rookie.identity.age} ans — Note ${rookie.getOverallRating()}` }),
        ]),
      ]),
      el('button', {
        class: 'btn btn-gold btn-sm',
        text: 'Signer (libre)',
        disabled: rosterFull ? 'disabled' : null,
        onclick: () => this._signScoutedRookie(rookie),
      }),
    ]);
  }

  _buildMercatoRivalGymBlock(gym) {
    const { playerState } = this.gameState;
    const roster = (gym.roster ?? []).map((entry) => Fighter.fromJSON(entry));

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: `${gym.name ?? gym.id} — Reputation ${Math.round(gym.reputation ?? 0)}` }),
      roster.length === 0
        ? el('p', { class: 'fighter-meta', text: 'Effectif vide.' })
        : el(
            'div',
            {},
            roster.map((fighter) => {
              const fee = computeBuyoutFee(fighter);
              const affordable = playerState.money >= fee && playerState.roster.length < playerState.getRosterCapacity();
              return el('div', { class: 'list-row' }, [
                el('span', {
                  class: 'list-row-label',
                  text: `${fighter.identity.name}${fighter.isChampion() ? ' \u{1F3C6}' : ''} — Note ${fighter.getOverallRating()}`,
                }),
                el('button', {
                  class: 'btn btn-outline btn-sm',
                  text: `Racheter (${fee.toLocaleString('fr-FR')}$)`,
                  disabled: affordable ? null : 'disabled',
                  onclick: () => this._buyoutFighter(gym.id, fighter.identity.id),
                }),
              ]);
            })
          ),
    ]);
  }

  _sendMercatoScout() {
    const playerState = this.gameState.playerState;
    const cfg = BALANCE.MERCATO.SCOUT;
    if (playerState.money < cfg.COST) return;

    playerState.changeMoney(-cfg.COST, 'MERCATO_SCOUT');
    this._scoutedRookies = sendScout({ rng: this.rng });
    AudioEngine.playCash();
    this._showToast(`\u{1F575}\u{FE0F} Detecteur envoye — ${this._scoutedRookies.length} rookie(s) deniche(s).`);
    this._renderMercatoModal();
    this._renderTopbar();
    this._autosave();
  }

  _signScoutedRookie(rookie) {
    const playerState = this.gameState.playerState;
    if (playerState.roster.length >= playerState.getRosterCapacity()) return;

    rookie.weeklySalary = Math.round(BALANCE.RECRUITMENT_MARKET.MIN_COST * BALANCE.RECRUITMENT_MARKET.SALARY_RATIO_OF_COST);
    playerState.addFighter(rookie);
    this._scoutedRookies = this._scoutedRookies.filter((r) => r.identity.id !== rookie.identity.id);
    telemetry.recordFighterRecruited();

    AudioEngine.playCash();
    this._showToast(`\u{1F4DD} ${rookie.identity.name} signe au gym.`);
    this._renderMercatoModal();
    this._renderTopbar();
    this._autosave();
  }

  _buyoutFighter(gymId, fighterId) {
    const { playerState } = this.gameState;
    const { worldState } = this.gameState;
    const result = buyoutRivalFighter(playerState, worldState, gymId, fighterId);
    if (!result.success) return;

    telemetry.recordFighterRecruited();
    AudioEngine.playCash();
    this._showToast(`\u{1F4B8} ${result.fighter.identity.name} rachete pour ${result.fee.toLocaleString('fr-FR')}$.`);
    this._renderMercatoModal();
    this._renderTopbar();
    this._autosave();
  }

  _buildRosterDetailCard(fighter) {
    const injured = fighter.isInjured(this.gameState.worldState.currentDay);
    const badges = [];
    if (fighter.identity.nickname) badges.push(el('span', { class: 'badge badge-nickname', text: fighter.identity.nickname }));
    if (injured) badges.push(el('span', { class: 'badge badge-injured', text: 'Blesse' }));

    const skillsList = el(
      'ul',
      { class: 'skill-list' },
      Object.entries(fighter.attributes.skills).map(([key, value]) => el('li', { class: 'skill-pill', text: `${SKILL_LABELS[key] ?? key} ${Math.round(value)}` }))
    );

    const card = el('div', { class: 'fighter-card' }, [
      el('div', { class: 'fighter-head' }, [
        el('div', {}, [
          el('div', { class: 'fighter-name' }, [
            fighter.identity.name,
            el('span', { class: 'rating-badge', text: `Note ${fighter.getOverallRating()}` }),
          ]),
          el('div', { class: 'fighter-meta', text: `${fighter.identity.style} — ${fighter.identity.age} ans — ${fighter.getRecordString()}` }),
        ]),
        el('div', {}, badges),
      ]),
      gaugeRow('Readiness', fighter.getReadiness()),
      gaugeRow('Fatigue P', fighter.attributes.physicalFatigue, { invert: true }),
      gaugeRow('Fatigue M', fighter.attributes.mentalFatigue, { invert: true }),
      gaugeRow('Moral', fighter.attributes.moral),
      skillsList,
      el('p', { class: 'fighter-meta', text: `Legacy : ${fighter.getLegacyStage()} — Plan : ${fighter.weeklyPlan.slots.map((a) => ACTIVITY_LABELS[a] ?? '—').join(', ') || 'vide'}` }),
    ]);

    card.appendChild(
      el('button', {
        class: 'btn btn-outline btn-sm',
        text: '\u{1F4CB} Fiche',
        onclick: () => this._showFighterProfile(fighter),
      })
    );

    if (fighter.isRetirementEligible()) {
      card.appendChild(
        el('button', {
          class: 'btn btn-outline btn-sm',
          text: 'Retraite',
          onclick: () => this._confirmRetireFighter(fighter.identity.id, fighter.identity.name),
        })
      );
    }

    return card;
  }

  _confirmRetireFighter(fighterId, fighterName) {
    const card = el('div', {}, [
      el('h2', { class: 'section-title', text: 'Confirmer la retraite' }),
      el('p', { text: `${fighterName} va prendre sa retraite et quitter votre effectif. Cette action est definitive.` }),
      el('div', { class: 'choice-list' }, [
        el('button', {
          class: 'btn btn-danger btn-block',
          text: 'Confirmer la retraite',
          onclick: () => {
            this.gameState.playerState.removeFighter(fighterId);
            this._hideModal();
            this._showToast(`\u{1F44B} ${fighterName} part a la retraite.`);
            this._renderRoster();
            this._autosave();
          },
        }),
        el('button', { class: 'btn btn-outline btn-block', text: 'Annuler', onclick: () => this._hideModal() }),
      ]),
    ]);
    this._showModal(card, { blocking: true });
  }

  // ---- FIGHTER PROFILE ("fiche combattant") --------------------------------------

  _showFighterProfile(fighter) {
    if (!fighter) return;

    const snapshot = this.weekStartSnapshot[fighter.identity.id] ?? {
      forme: fighter.attributes.forme,
      moral: fighter.attributes.moral,
    };
    const formeTrend = trendArrow(fighter.attributes.forme - snapshot.forme);
    const moralTrend = trendArrow(fighter.attributes.moral - snapshot.moral);

    const { archetype, traits } = fighter.psychology.personality;
    const traitBadges = [
      el('span', { class: 'trait-badge trait-gold', text: archetype }),
      ...traits.map((trait) => {
        const display = getTraitDisplay(trait);
        return el('button', {
          class: `trait-badge trait-${display.color}`,
          text: trait,
          onclick: () => this._showTraitInfo(fighter, trait, display),
        });
      }),
    ];

    const trophyRows = this._buildTrophyRows(fighter);

    const content = el('div', {}, [
      el('div', { class: 'profile-header' }, [
        el('div', { class: 'profile-avatar', text: STYLE_AVATARS[fighter.identity.style] ?? '\u{1F94A}' }),
        el('div', {}, [
          el(
            'div',
            { class: 'profile-name' },
            [fighter.identity.name, fighter.identity.nickname ? ` "${fighter.identity.nickname}"` : ''].filter(Boolean)
          ),
          el('div', {
            class: 'fighter-meta',
            text: `${fighter.identity.gender === 'F' ? '♀' : '♂'} ${fighter.identity.age} ans — ${formatHeightCm(fighter.identity.heightCm)} — ${fighter.identity.weightKg}kg — ${fighter.identity.weightClass} — ${fighter.getRecordString()} — ${fighter.getLegacyStage()}`,
          }),
        ]),
      ]),
      el('p', { class: 'fighter-meta' }, [
        'Forme ',
        el('span', { class: `trend-arrow ${formeTrend.cls}`, text: formeTrend.symbol }),
        '   Moral ',
        el('span', { class: `trend-arrow ${moralTrend.cls}`, text: moralTrend.symbol }),
      ]),
      gaugeRow('Loyaute envers le gym', fighter.psychology.loyalty),
      el('div', { class: 'trait-list' }, traitBadges),

      trophyRows.length > 0 ? el('div', { class: 'card' }, [el('div', { class: 'card-title', text: 'Palmares' }), ...trophyRows]) : null,

      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Attributs' }),
        gaugeRow('Striking', fighter.getDistanceRating('STRIKING')),
        gaugeRow('Clinch', fighter.getDistanceRating('CLINCH')),
        gaugeRow('Grappling', fighter.getDistanceRating('GROUND')),
        gaugeRow('Mental', fighter.attributes.skills.intelligence),
        gaugeRow('Physique', Math.round((fighter.attributes.skills.boxe + fighter.attributes.skills.jambes) / 2)),
        gaugeRow('Endurance', fighter.attributes.skills.cardio),
      ]),

      this._buildCareerTable(fighter),

      el('button', { class: 'btn btn-gold btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);

    this._showModal(content);
  }

  /** Tap-to-explain trait badge: native `title` hover tooltips don't work on mobile touch, so a tap opens the description here instead, with a button back to the profile it came from. */
  _showTraitInfo(fighter, trait, display) {
    const card = el('div', {}, [
      el('h2', { class: 'section-title', text: trait }),
      el('p', { text: display.description || 'Aucune description disponible.' }),
      el('button', { class: 'btn btn-gold btn-block', text: 'Retour a la fiche', onclick: () => this._showFighterProfile(fighter) }),
    ]);
    this._showModal(card);
  }

  _buildTrophyRows(fighter) {
    const rows = [];
    for (const title of fighter.career.titles) {
      rows.push(el('div', { class: 'trophy-row', text: `\u{1F3C6} Ceinture : ${title}` }));
    }
    if (fighter.career.hallOfFameStatus && fighter.career.hallOfFameStatus !== 'none') {
      rows.push(el('div', { class: 'trophy-row', text: `\u{2728} Hall of Fame (${fighter.career.hallOfFameStatus})` }));
    }

    const recordLabels = {
      fastestKO: 'KO le plus rapide',
      longestTitleReign: 'Plus long regne de titre',
      mostTitles: 'Plus de titres en carriere',
      biggestFight: 'Plus grosse bourse combinee',
      youngestChampion: 'Plus jeune champion',
      longestWinStreak: 'Plus longue serie de victoires',
    };
    for (const [key, record] of Object.entries(this.gameState.worldState.records ?? {})) {
      const meta = record?.meta;
      if (!meta) continue;
      const holds = meta.fighterId === fighter.identity.id || meta.fighterAId === fighter.identity.id || meta.fighterBId === fighter.identity.id;
      if (holds) rows.push(el('div', { class: 'trophy-row', text: `\u{1F947} Record du monde : ${recordLabels[key] ?? key}` }));
    }

    for (const trophy of fighter.career.trophies) {
      const icon = TROPHY_ICONS[trophy.category] ?? '\u{1F3C6}';
      rows.push(el('div', { class: 'trophy-row', text: `${icon} ${trophy.label} (${trophy.year})` }));
    }

    return rows;
  }

  _buildCareerTable(fighter) {
    const rows = fighter.career.seasonHistory;
    if (rows.length === 0) {
      return el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Carriere par saison' }),
        el('p', { text: 'Aucun combat dispute pour le moment.' }),
      ]);
    }

    const bodyRows = rows.map((row) => {
      const total = row.wins + row.losses + row.draws;
      const performance =
        total === 0 ? 0 : Math.max(0, Math.min(100, Math.round(((row.wins - row.losses) / total + 1) * 50 + (row.koWins + row.subWins) * 4)));
      return el('tr', {}, [
        el('td', { text: `${row.year}` }),
        el('td', { text: row.orgId }),
        el('td', { text: `${row.wins}-${row.losses}-${row.draws}` }),
        el('td', { text: `${row.koWins}K/${row.subWins}S` }),
        el('td', { text: `${performance}` }),
      ]);
    });

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: 'Carriere par saison' }),
      el('div', { class: 'table-scroll' }, [
        el('table', { class: 'career-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Saison' }),
              el('th', { text: 'Org' }),
              el('th', { text: 'V-D-N' }),
              el('th', { text: 'KO/Sub' }),
              el('th', { text: 'Perf.' }),
            ]),
          ]),
          el('tbody', {}, bodyRows),
        ]),
      ]),
    ]);
  }

  // ---- PLANNING panel -----------------------------------------------------------

  _renderPlanning() {
    const panel = this.dom.panels.planning;
    panel.innerHTML = '';

    if (!this.weeklyFlow || this.weeklyFlow.getPhase() !== WEEKLY_FLOW_PHASES.PLANNING) {
      this._startNewWeek();
    }

    panel.appendChild(el('h2', { class: 'section-title', text: `Semaine — Jour ${this.gameState.worldState.currentDay}` }));
    panel.appendChild(
      el('button', {
        class: 'btn btn-outline btn-block',
        text: '✨ Auto-remplir le planning',
        onclick: () => {
          this.weeklyFlow.autoFillPlan();
          this._renderPlanning();
        },
      })
    );

    const options = this.weeklyFlow.getPlanningOptions();
    for (const option of options) {
      const card = el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: `${option.name}${option.injured ? ' (blesse — repos force)' : ''}` }),
      ]);

      for (let slot = 0; slot < BALANCE.WEEKLY_PLANNING.SLOTS_PER_WEEK; slot += 1) {
        const row = el('div', { class: 'slot-row' });
        for (const activityKey of option.activityKeys) {
          const selected = option.slots[slot] === activityKey;
          row.appendChild(
            el('button', {
              class: `activity-chip${selected ? ' selected' : ''}`,
              text: ACTIVITY_LABELS[activityKey] ?? activityKey,
              disabled: option.injured ? 'disabled' : null,
              onclick: () => {
                this.weeklyFlow.setSlot(option.fighterId, slot, activityKey);
                this._renderPlanning();
              },
            })
          );
        }
        card.appendChild(el('p', { class: 'fighter-meta', text: `Creneau ${slot + 1}` }));
        card.appendChild(row);
      }
      panel.appendChild(card);
    }

    panel.appendChild(
      el('button', {
        class: 'btn btn-gold btn-block',
        text: '▶️ Resoudre la semaine',
        onclick: () => this._resolveWeek(),
      })
    );
  }

  _captureRosterRatings() {
    return Object.fromEntries(this.gameState.playerState.roster.map((fighter) => [fighter.identity.id, fighter.getOverallRating()]));
  }

  _startNewWeek() {
    this.weeklyFlow = new WeeklyFlowController({ gameState: this.gameState, rng: this.rng });
    this.weekStartSnapshot = Object.fromEntries(
      this.gameState.playerState.roster.map((fighter) => [
        fighter.identity.id,
        { forme: fighter.attributes.forme, moral: fighter.attributes.moral },
      ])
    );
  }

  _resolveWeek() {
    const result = this.weeklyFlow.resolveWeek();
    if (result.phase === WEEKLY_FLOW_PHASES.DRAMA_CHOICE) {
      this._showDramaModal(result.dramaPrompt);
      return;
    }
    this._completeWeek(result);
  }

  _showDramaModal(dramaPrompt) {
    this.gymHub.setPendingDramaChoice({
      event: { id: dramaPrompt.eventId, category: dramaPrompt.category, choices: dramaPrompt.choices },
      fighter: { identity: { id: dramaPrompt.fighterId, name: dramaPrompt.fighterName } },
    });

    const card = el('div', {}, [
      el('h2', { class: 'section-title', text: `\u{1F3AD} ${dramaPrompt.title ?? 'Evenement'}` }),
      el('p', { class: 'fighter-meta', text: dramaPrompt.fighterName }),
      el('p', { text: dramaPrompt.description ?? '' }),
      el(
        'div',
        { class: 'choice-list' },
        dramaPrompt.choices.map((choice) =>
          el('button', {
            class: 'btn btn-outline choice-btn',
            text: choice.label,
            onclick: () => {
              telemetry.recordDramaChoice(dramaPrompt.eventId, choice.id);
              const result = this.weeklyFlow.resolveDramaChoice(choice.id);
              this.gymHub.clearPendingDramaChoice();
              this._hideModal();
              this._completeWeek(result);
            },
          })
        )
      ),
    ]);
    this._showModal(card, { blocking: true });
  }

  /**
   * "Rumeurs de mercato" — engine/SocialEngine.js already reacts to every
   * fight/roster-add/facility-upgrade with fan/journalist/rival posts; this
   * is the one remaining source it doesn't cover, since
   * engine/TransferMarket.js only runs in a batch at season boundaries and
   * publishes no EventBus event of its own — so this reads its report
   * straight out of the weekly summary instead.
   * @param {Object|null} transferMarketReport - result.weekSummary.transferMarketReport (null except at a season boundary).
   */
  _postMercatoRumors(transferMarketReport) {
    if (!transferMarketReport) return;
    const playerState = this.gameState.playerState;

    for (const signing of transferMarketReport.signings.slice(0, 2)) {
      playerState.pushSocialFeedEntry({
        author: 'Rumeur de Mercato',
        authorType: 'JOURNALIST',
        text: `${signing.gymName} vient de signer ${signing.fighterName}.`,
        likes: Math.round(5 + playerState.hype * 0.3),
      });
    }
  }

  _completeWeek(result) {
    this.weeklyResultsThisYear.push(result);
    this.lastWeekEconomy = result.weekSummary.economyReport;
    telemetry.recordWeekResolved();
    telemetry.checkFrustrationSignals(this.gameState.playerState);
    processActiveDeals(this.gameState.playerState);
    this._postMercatoRumors(result.weekSummary.transferMarketReport);
    const newBadges = evaluateBadgeUnlocks(this.gameState.playerState, this.gameState.worldState);
    this._startNewWeek();
    this._renderAll();
    this._autosave();

    const summary = result.weekSummary;
    const bits = [];
    if (summary.retirements.length > 0) {
      for (const retirement of summary.retirements) {
        bits.push(`\u{1F44B} ${retirement.name} part a la retraite${retirement.reconversion.isHallOfFamer ? ' \u{1F3C6} HALL OF FAME' : ''}.`);
      }
    }
    for (const badge of newBadges) {
      bits.push(`${badge.icon} Badge debloque : ${badge.label} !`);
    }
    for (const poached of summary.poachingReport ?? []) {
      bits.push(`\u{1F6A8} ${poached.fighterName} a ete debauche par ${poached.gymName} !`);
    }
    const scheduledFight = this.gameState.playerState.scheduledFight;
    if (scheduledFight) {
      if (isFightDue(scheduledFight, this.gameState.worldState.currentDay)) {
        bits.push('\u{1F94A} Le combat programme est pret — rendez-vous dans l\'onglet Combat.');
      } else if (isFightWeek(scheduledFight, this.gameState.worldState.currentDay)) {
        bits.push('\u{1F9F3} La Fight Week a commence — preparez la logistique dans l\'onglet Combat.');
      } else if (summary.fightWeekReport) {
        bits.push(`\u{1F3CB}\u{FE0F} Camp d'entrainement : ${BALANCE.FIGHT_WEEK.CAMP_ORIENTATIONS[summary.fightWeekReport.orientationId]?.label ?? ''}.`);
      }
    }
    const net = Math.round(summary.economyReport.netChange);
    bits.push(`Semaine resolue — jour ${this.gameState.worldState.currentDay}. Solde net ${net >= 0 ? '+' : ''}${net}$.`);
    this._showToast(bits.join(' '));
    this._showPanel('hub');

    if (this._yearChangedPending) {
      this._yearChangedPending = false;
      const analysis = analyzeSeason({
        playerState: this.gameState.playerState,
        worldState: this.gameState.worldState,
        year: this.gameState.worldState.year - 1,
        fightResultsThisYear: this.fightResultsThisYear,
        yearStartRosterRatings: this.yearStartRosterRatings,
      });
      this._persistTrophies(analysis);
      const goldenBookEntry = generateGoldenBookEntry(this.gameState.playerState, this.gameState.worldState, analysis);
      this.gameState.worldState.addGoldenBookEntry(goldenBookEntry);
      if (hasAnyTrophy(analysis)) {
        this._showGala(analysis);
      } else {
        this._showSeasonSummary({ afterYearChange: true });
      }
    }
  }

  // ---- FIGHT NIGHT panel ----------------------------------------------------------

  _renderFight() {
    const panel = this.dom.panels.fight;
    panel.innerHTML = '';

    const result = this.combatEngine.getSnapshot?.().result;
    if (this.fightView && result && this.combatEngine.state === COMBAT_STATES.FINISHED) {
      this._renderFightResult(panel);
      return;
    }
    if (this.fightView && !this.fightSetupDone) {
      this._renderFightSetup(panel);
      return;
    }
    if (this.fightView && this.combatEngine.state && this.combatEngine.state !== COMBAT_STATES.IDLE && this.combatEngine.state !== COMBAT_STATES.FINISHED) {
      this._renderFightInProgress(panel);
      return;
    }

    panel.appendChild(
      el('div', { class: 'subtab-row' }, [
        el('button', {
          class: `subtab-btn${this.fightTab === 'normal' ? ' active' : ''}`,
          text: 'Combat',
          onclick: () => {
            this.fightTab = 'normal';
            this._renderFight();
          },
        }),
        el('button', {
          class: `subtab-btn${this.fightTab === 'underground' ? ' active' : ''}`,
          text: '\u{1F573}\u{FE0F} Underground',
          onclick: () => {
            this.fightTab = 'underground';
            this._renderFight();
          },
        }),
      ])
    );

    if (this.fightTab === 'underground') {
      this._renderUndergroundHub(panel);
      return;
    }

    if (this.gameState.playerState.scheduledFight) {
      this._renderFightWeek(panel);
      return;
    }

    this._renderGalaCalendar(panel);
  }

  /**
   * A sanctioned/competitive bout (as opposed to Underground) always pits
   * one of the player's own fighters against a RIVAL gym's fighter — never
   * two gym-mates (see engine/Matchmaking.js). Two gym-mates only ever
   * spar, as a weekly Planning activity. Mirrors
   * _renderUndergroundSetupModal's own (fighter, gym, their fighter) picker.
   */
  /**
   * V3.7 "Calendrier des Galas": no more hand-picking a rival gym's
   * fighter directly — the player picks their OWN fighter, then registers
   * onto an open weight-class slot of an upcoming Gala (see
   * engine/LeagueEngine.js#getUpcomingGalas/registerForGala). The
   * opponent is drawn automatically from the global pool once
   * registration is confirmed.
   */
  _renderGalaCalendar(panel) {
    if (!this._galaSetup) {
      this._galaSetup = { fighterId: null, allowMixedGender: false };
    }
    const setup = this._galaSetup;
    const { playerState, worldState } = this.gameState;
    const selectedFighter = setup.fighterId ? playerState.getFighter(setup.fighterId) : null;

    panel.appendChild(el('h2', { class: 'section-title', text: '\u{1F4C6} Calendrier des Galas' }));
    panel.appendChild(el('p', { text: 'Inscrivez votre combattant sur la Fight Card ouverte d\'un Gala a venir — l\'adversaire est tire automatiquement du pool global de la ligue (rivaux ou independants).' }));

    const available = playerState.roster.filter((f) => !f.isInjured(worldState.currentDay));
    panel.appendChild(el('div', { class: 'card-title', text: 'Votre combattant' }));
    if (available.length === 0) {
      panel.appendChild(el('p', { text: 'Pas de combattant disponible (non blesse).' }));
      return;
    }
    for (const fighter of available) {
      const selected = setup.fighterId === fighter.identity.id;
      panel.appendChild(
        el(
          'div',
          {
            class: `fighter-card selectable${selected ? ' selected' : ''}`,
            onclick: () => {
              setup.fighterId = fighter.identity.id;
              this._renderFight();
            },
          },
          [
            el('div', { class: 'fighter-head' }, [
              el('div', {}, [
                el('div', { class: 'fighter-name', text: fighter.identity.name + (fighter.identity.nickname ? ` "${fighter.identity.nickname}"` : '') }),
                el('div', { class: 'fighter-meta', text: `${fighter.identity.style} — ${fighter.identity.weightClass} — ${fighter.getRecordString()}` }),
              ]),
            ]),
            gaugeRow('Readiness', fighter.getReadiness()),
          ]
        )
      );
    }

    if (selectedFighter) {
      const org = resolveRegionalOrg(playerState.country);
      const ranking = getWeightClassRanking(playerState, worldState, selectedFighter.identity.weightClass, 5);
      panel.appendChild(el('div', { class: 'card-title', text: `\u{1F3C6} Classement ${org.label} — ${selectedFighter.identity.weightClass}` }));
      panel.appendChild(
        el(
          'div',
          { class: 'card' },
          ranking.map((entry, index) =>
            el('div', { class: 'list-row' }, [
              el('span', { class: 'list-row-label', text: `#${index + 1} ${entry.name} (${entry.gymName})` }),
              el('span', { class: 'list-row-value', text: `${entry.overallRating} — ${entry.record}` }),
            ])
          )
        )
      );
      panel.appendChild(
        el('button', {
          class: 'btn btn-outline btn-block',
          text: '\u{1F3C6} Classements Officiels (Top 15)',
          onclick: () => this._showRankingsModal(),
        })
      );
    }

    panel.appendChild(
      el('label', { class: 'checkbox-row' }, [
        el('input', {
          type: 'checkbox',
          checked: setup.allowMixedGender ? 'checked' : null,
          onchange: (event) => {
            setup.allowMixedGender = event.target.checked;
            this._renderFight();
          },
        }),
        ' Mode Mixte (autoriser un adversaire tire du pool oppose)',
      ])
    );

    panel.appendChild(el('div', { class: 'card-title', text: '\u{1F4C5} Galas a venir' }));
    const galas = getUpcomingGalas(worldState);
    if (galas.length === 0) {
      panel.appendChild(el('p', { text: 'Aucun gala programme pour le moment.' }));
      return;
    }

    for (const gala of galas) {
      const daysOut = gala.day - worldState.currentDay;
      const slot = selectedFighter ? gala.weightClassSlots.find((s) => s.weightClass === selectedFighter.identity.weightClass) : null;

      panel.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title', text: gala.label }),
          el('p', { class: 'fighter-meta', text: `Dans ${daysOut} jour(s) — Fight Card de ${gala.cardSize} combats.` }),
          !selectedFighter
            ? el('p', { text: 'Choisissez d\'abord votre combattant.' })
            : slot
              ? el('button', {
                  class: 'btn btn-gold btn-block',
                  text: `S'inscrire (${selectedFighter.identity.weightClass})`,
                  onclick: () => this._registerForGala(gala.id),
                })
              : el('p', { text: `Aucun slot ouvert pour ${selectedFighter.identity.weightClass} sur ce gala.` }),
        ])
      );
    }
  }

  /** French-language reasons for every engine/LeagueEngine.js#registerForGala failure, so a failed registration always surfaces the exact cause instead of a silent no-op. */
  _describeGalaRegistrationFailure(reason) {
    const messages = {
      ALREADY_BOOKED: 'un combat est deja programme.',
      FIGHTER_NOT_FOUND: 'combattant introuvable.',
      FIGHTER_INJURED: 'ce combattant est blesse.',
      GALA_NOT_FOUND: 'ce gala n\'existe plus.',
      NO_OPEN_SLOT: 'aucun slot disponible pour cette categorie de poids.',
      NO_OPPONENT_AVAILABLE: 'aucun adversaire disponible pour le moment.',
      MATCHMAKING_VIOLATION: 'regles de matchmaking non respectees.',
    };
    return messages[reason] ?? 'raison inconnue.';
  }

  _registerForGala(galaId) {
    const setup = this._galaSetup;
    if (!setup?.fighterId) return;
    const { playerState, worldState } = this.gameState;

    try {
      const result = registerForGala(playerState, worldState, {
        galaId,
        fighterId: setup.fighterId,
        allowMixedGender: setup.allowMixedGender,
        rng: this.rng,
      });

      if (!result.success) {
        this._showToast(`\u{26A0}\u{FE0F} Inscription impossible : ${this._describeGalaRegistrationFailure(result.reason)}`);
        return;
      }

      const daysOut = result.record.fightDay - result.record.scheduledDay;
      this._galaSetup = null;
      AudioEngine.playClick();
      this._showToast(`\u{1F4C5} Inscrit contre ${result.opponent.identity.name} — ${result.gala.label} dans ${daysOut} jour(s).`);
      this._renderFight();
      this._renderTopbar();
      this._autosave();
    } catch (error) {
      console.error('[web/app.js] _registerForGala failed:', error);
      this._showToast(`\u{26A0}\u{FE0F} Inscription impossible : ${error.message}`);
    }
  }

  /**
   * "Fight Launch Contract" — the last checkpoint before opening the live
   * combat view, checked right before _launchFight actually calls
   * presentMatchup()/CombatEngine#setupMatch. Every condition here mirrors
   * one setupMatch itself would otherwise throw on (or a state that would
   * leave a fighter unable to safely compete) — checking it here means a
   * broken contract surfaces an exact reason via toast, instead of an
   * uncaught exception leaving the Combat tab silently frozen mid-click.
   * @returns {{ ok: true }|{ ok: false, reason: string }}
   */
  _validateFightLaunchContract({ fighterA, fighterB, orgId }) {
    if (!fighterA) return { ok: false, reason: 'Combattant introuvable (retraite ou transfere).' };
    if (!fighterB) return { ok: false, reason: 'Adversaire introuvable.' };
    if (fighterA.identity.id === fighterB.identity.id) return { ok: false, reason: 'Un combattant ne peut pas s\'affronter lui-meme.' };
    if (fighterA.isInjured(this.gameState.worldState.currentDay)) return { ok: false, reason: `${fighterA.identity.name} est blesse.` };
    if (!orgId) return { ok: false, reason: 'Organisation/ruleset manquant pour ce combat.' };
    if (
      this.combatEngine.state &&
      this.combatEngine.state !== COMBAT_STATES.IDLE &&
      this.combatEngine.state !== COMBAT_STATES.FINISHED
    ) {
      return { ok: false, reason: 'Un combat est deja en cours.' };
    }
    return { ok: true };
  }

  /**
   * Runs once the booked fight's date has actually arrived (see
   * _renderFightWeek's "Se rendre au combat" button, only enabled once
   * engine/FightWeekEngine.js#isFightDue agrees). The opponent is read
   * straight from the Fight Launch Contract's own locked-in
   * opponentSnapshot (see engine/FightWeekEngine.js's header note) — never
   * re-derived from a live rival-gym roster, so a rival's autonomous
   * roster churn or a Mercato buyout/poach mid-camp can no longer strand
   * this booking. Only a genuinely broken contract (the booked fighter
   * retired/left the roster, or got injured) cancels it.
   */
  _confirmFightWeekArrival() {
    const { playerState, worldState } = this.gameState;
    const scheduledFight = playerState.scheduledFight;
    if (!scheduledFight || !isFightDue(scheduledFight, worldState.currentDay)) return;

    const fighterA = playerState.getFighter(scheduledFight.fighterId);
    let fighterB = null;
    try {
      fighterB = scheduledFight.opponentSnapshot ? Fighter.fromJSON(scheduledFight.opponentSnapshot) : null;
    } catch (error) {
      console.error('[web/app.js] Failed to rehydrate the booked opponent:', error);
    }

    const contract = this._validateFightLaunchContract({ fighterA, fighterB, orgId: scheduledFight.orgId });
    if (!contract.ok) {
      cancelScheduledFight(playerState);
      this._showToast(`\u{1F6AB} Combat annule — ${contract.reason}`);
      this._renderFight();
      return;
    }

    const gym = scheduledFight.gymId ? worldState.rivalGyms.find((g) => g.id === scheduledFight.gymId) : null;

    if (isMainEventEligible({ fighterA, fighterB, opponentGymReputation: gym?.reputation ?? 0 })) {
      this._showPressConferenceModal(fighterA, fighterB, gym, scheduledFight.orgId);
      return;
    }

    this._beginScheduledFightCombat(fighterA, fighterB, gym, null, scheduledFight.orgId);
  }

  _showPressConferenceModal(fighterA, fighterB, gym, orgId) {
    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: "\u{1F3A4} Conference de presse" }),
      el('p', { text: `Avant d'affronter ${fighterB.identity.name}, quelle posture adopte ${fighterA.identity.name} ?` }),
      el(
        'div',
        { class: 'choice-list' },
        getStances().map((stance) =>
          el('div', { class: 'card' }, [
            el('p', { class: 'fighter-meta', text: stance.description }),
            el('button', {
              class: 'btn btn-outline choice-btn btn-block',
              text: stance.label,
              onclick: () => {
                applyPressConferenceChoice(stance.id, { fighterA, fighterB, worldState: this.gameState.worldState });
                this._hideModal();
                this._beginScheduledFightCombat(fighterA, fighterB, gym, { purseMultiplier: stance.purseMultiplier }, orgId);
              },
            }),
          ])
        )
      ),
    ]);
    this._showModal(content, { blocking: true });
  }

  /** Finalizes the Fight Week booking (capturing its resolved weight-cut choice) and hands off to _launchFight — the single place a scheduled fight actually becomes a live CombatEngine match. */
  _beginScheduledFightCombat(fighterA, fighterB, gym, rules, orgId) {
    const { playerState } = this.gameState;
    this._pendingWeightCutProfileKey = resolveWeightCutProfileKey(playerState.scheduledFight);
    cancelScheduledFight(playerState);
    this._launchFight(fighterA, fighterB, gym, rules, orgId);
  }

  /**
   * The single place a Fight Launch Contract actually becomes a live
   * CombatEngine match. Re-validates the contract one last time (belt and
   * braces — _confirmFightWeekArrival already checked it, but this is
   * also reachable from other call sites like Underground's own flow via
   * _launchFight's shared plumbing) and wraps the actual launch in
   * try/catch: any unexpected failure surfaces an exact toast and leaves
   * the Combat tab back on the Fight Week/Gala view, never frozen.
   */
  _launchFight(fighterA, fighterB, gym, rules, orgId) {
    const resolvedOrgId = orgId ?? resolveRegionalOrg(this.gameState.playerState.country).id;
    const contract = this._validateFightLaunchContract({ fighterA, fighterB, orgId: resolvedOrgId });
    if (!contract.ok) {
      this._showToast(`\u{26A0}\u{FE0F} Impossible de lancer le combat : ${contract.reason}`);
      this._renderFight();
      return;
    }

    try {
      this._fightOpponentGymId = gym?.id ?? null;
      this._fightFighterB = fighterB;
      this._teardownCombatPlayback();
      this.fightView = new FightNightView({ combatEngine: this.combatEngine });
      this.fightCard = this.fightView.presentMatchup(fighterA, fighterB, resolvedOrgId, false, rules);
      this.fightSetupDone = false;
      // Only the player's own corner (A) is ever player-configured — the
      // opponent (B) always fights their own AI gameplan/natural weight cut
      // (see _confirmFightSetup).
      this.gameplanChoices = { A: {} };
      // Resolved from the Fight Week Logistique weight-cut choice (see
      // _beginScheduledFightCombat) — falls back to NATUREL if somehow unset.
      this.weightCutChoices = { A: this._pendingWeightCutProfileKey ?? 'NATUREL' };
      this._pendingWeightCutProfileKey = null;
      this._renderFight();
    } catch (error) {
      console.error('[web/app.js] _launchFight failed:', error);
      this.fightView = null;
      this._showToast(`\u{26A0}\u{FE0F} Le combat n'a pas pu demarrer : ${error.message}`);
      this._renderFight();
    }
  }

  // ---- FIGHT WEEK (V3.6: scheduling, camp orientation, logistics) -------------------

  /** The Combat tab's countdown/camp-orientation view, shown for as long as PlayerState#scheduledFight is set (see _renderFight). */
  _renderFightWeek(panel) {
    const { playerState, worldState } = this.gameState;
    const scheduledFight = playerState.scheduledFight;
    const fighterA = playerState.getFighter(scheduledFight.fighterId);
    let opponent = null;
    try {
      opponent = scheduledFight.opponentSnapshot ? Fighter.fromJSON(scheduledFight.opponentSnapshot) : null;
    } catch (error) {
      console.error('[web/app.js] Failed to rehydrate the booked opponent for display:', error);
    }

    panel.appendChild(el('h2', { class: 'section-title', text: '\u{1F4C5} Fight Week' }));

    if (!fighterA || !opponent) {
      panel.appendChild(el('p', { text: 'Ce combat n\'est plus possible — un des deux combattants n\'est plus disponible.' }));
      panel.appendChild(
        el('button', {
          class: 'btn btn-danger btn-block',
          text: 'Annuler le combat',
          onclick: () => {
            cancelScheduledFight(playerState);
            this._showToast('\u{1F6AB} Combat annule.');
            this._renderFight();
          },
        })
      );
      return;
    }

    const daysLeft = getDaysUntilFight(scheduledFight, worldState.currentDay);
    const fightWeek = isFightWeek(scheduledFight, worldState.currentDay);
    const due = isFightDue(scheduledFight, worldState.currentDay);
    const originLabel = scheduledFight.gymId
      ? worldState.rivalGyms.find((g) => g.id === scheduledFight.gymId)?.name ?? 'Gym rival'
      : 'Combattant independant';

    panel.appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: `${fighterA.identity.name} vs ${opponent.identity.name}` }),
        el('p', { class: 'fighter-meta', text: `${originLabel} — ${opponent.identity.style} — ${opponent.career.wins}-${opponent.career.losses}-${opponent.career.draws}` }),
        el('p', { text: due ? 'Le combat peut avoir lieu.' : `Combat dans ${daysLeft} jour(s).` }),
      ])
    );

    if (!fightWeek) {
      const orientation = BALANCE.FIGHT_WEEK.CAMP_ORIENTATIONS[scheduledFight.campOrientation];
      panel.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title', text: '\u{1F3CB}\u{FE0F} Orientation du Camp d\'Entrainement' }),
          el(
            'div',
            { class: 'slot-row' },
            Object.entries(BALANCE.FIGHT_WEEK.CAMP_ORIENTATIONS).map(([id, def]) =>
              el('button', {
                class: `activity-chip${scheduledFight.campOrientation === id ? ' selected' : ''}`,
                text: def.label,
                onclick: () => {
                  setCampOrientation(playerState, id);
                  this._renderFight();
                },
              })
            )
          ),
          el('p', { class: 'fighter-meta', text: orientation?.description ?? '' }),
        ])
      );
    } else {
      panel.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title', text: '\u{1F9F3} Fight Week Logistique' }),
          el('p', {
            class: 'fighter-meta',
            text: `Coupe de poids : ${scheduledFight.weightCutChoice ? BALANCE.FIGHT_WEEK.WEIGHT_CUT_CHOICES[scheduledFight.weightCutChoice].label : 'Non choisie'} — Logistique : ${scheduledFight.logisticsChoice ? BALANCE.FIGHT_WEEK.LOGISTICS[scheduledFight.logisticsChoice].label : 'Non choisie'}`,
          }),
          el('button', {
            class: 'btn btn-outline btn-block',
            text: '\u{1F9F3} Preparer le Fight Week',
            onclick: () => this._showFightWeekLogistiqueModal(),
          }),
        ])
      );
    }

    panel.appendChild(
      el('button', {
        class: 'btn btn-gold btn-block',
        text: 'Se rendre au combat',
        disabled: due ? null : 'disabled',
        onclick: () => this._confirmFightWeekArrival(),
      })
    );
  }

  /** The pre-fight logistics modal — weight cut (relabeled WEIGH_IN profiles) plus the one-off transport/hotel choice. Reachable once fight week starts (see _renderFightWeek). */
  _showFightWeekLogistiqueModal() {
    const { playerState } = this.gameState;
    const scheduledFight = playerState.scheduledFight;
    if (!scheduledFight) {
      this._hideModal();
      return;
    }

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F9F3} Fight Week Logistique' }),

      el(
        'div',
        { class: 'card' },
        [
          el('div', { class: 'card-title', text: 'Coupe de poids' }),
          ...Object.entries(BALANCE.FIGHT_WEEK.WEIGHT_CUT_CHOICES).map(([id, def]) =>
            el('div', { class: 'list-row' }, [
              el('div', {}, [
                el('div', { class: 'list-row-label', text: def.label + (scheduledFight.weightCutChoice === id ? ' ✓' : '') }),
                el('div', { class: 'fighter-meta', text: def.description }),
              ]),
              el('button', {
                class: `btn btn-sm ${scheduledFight.weightCutChoice === id ? 'btn-gold' : 'btn-outline'}`,
                text: 'Choisir',
                onclick: () => {
                  setWeightCutChoice(playerState, id);
                  this._showFightWeekLogistiqueModal();
                },
              }),
            ])
          ),
        ]
      ),

      el(
        'div',
        { class: 'card' },
        [
          el('div', { class: 'card-title', text: 'Transport & Hebergement' }),
          ...Object.entries(BALANCE.FIGHT_WEEK.LOGISTICS).map(([id, def]) =>
            el('div', { class: 'list-row' }, [
              el('div', {}, [
                el('div', {
                  class: 'list-row-label',
                  text: `${def.label} — ${def.cost.toLocaleString('fr-FR')}$${scheduledFight.logisticsChoice === id ? ' ✓' : ''}`,
                }),
                el('div', { class: 'fighter-meta', text: def.description }),
              ]),
              el('button', {
                class: `btn btn-sm ${scheduledFight.logisticsChoice === id ? 'btn-gold' : 'btn-outline'}`,
                text: scheduledFight.logisticsChoice ? (scheduledFight.logisticsChoice === id ? 'Choisi' : 'Indisponible') : 'Choisir',
                disabled: scheduledFight.logisticsChoice ? 'disabled' : null,
                onclick: () => {
                  const result = setLogisticsChoice(playerState, id);
                  if (result.success) {
                    AudioEngine.playCash();
                    this._showToast(`\u{1F9F3} Logistique ${def.label} reservee (${result.cost.toLocaleString('fr-FR')}$).`);
                    this._renderTopbar();
                  } else if (result.reason === 'INSUFFICIENT_FUNDS') {
                    this._showToast('\u{26A0}\u{FE0F} Fonds insuffisants pour cette option.');
                  }
                  this._showFightWeekLogistiqueModal();
                },
              }),
            ])
          ),
        ]
      ),

      el('button', {
        class: 'btn btn-outline btn-block',
        text: 'Fermer',
        onclick: () => {
          this._hideModal();
          this._renderFight();
        },
      }),
    ]);
    this._showModal(content);
  }

  /** V3.6 item 3: the full "Classements Officiels" board — Top 15 for every weight-class division, both genders, in the gym's regional org (see engine/LeagueEngine.js#getAllWeightClassRankings). */
  _showRankingsModal() {
    const { playerState, worldState } = this.gameState;
    const board = getAllWeightClassRankings(playerState, worldState, { limit: 15 });
    const genderLabels = { M: 'Hommes', F: 'Femmes' };

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: `\u{1F3C6} Classements Officiels — ${board.org.label}` }),
      ...Object.entries(board.byGender).flatMap(([gender, divisions]) => [
        el('h3', { class: 'section-title', text: genderLabels[gender] ?? gender }),
        ...divisions.map((division) =>
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title', text: division.label }),
            division.ranking.length === 0
              ? el('p', { class: 'fighter-meta', text: 'Aucun combattant recense dans cette categorie.' })
              : el(
                  'div',
                  {},
                  division.ranking.map((entry, index) =>
                    el('div', { class: 'list-row' }, [
                      el('span', { class: 'list-row-label', text: `#${index + 1} ${entry.name} (${entry.gymName})` }),
                      el('span', { class: 'list-row-value', text: `${entry.overallRating} — ${entry.record}` }),
                    ])
                  )
                ),
          ])
        ),
      ]),
      el('button', { class: 'btn btn-gold btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);
    this._showModal(content);
  }

  // ---- UNDERGROUND CIRCUIT (Phase Underground) ---------------------------------------

  _renderUndergroundHub(panel) {
    panel.appendChild(el('h2', { class: 'section-title', text: '\u{1F573}\u{FE0F} Underground Circuit' }));
    panel.appendChild(
      el('p', {
        text: 'La ligue clandestine mondiale — victoire uniquement par KO/TKO ou soumission, contre le roster d\'un gym rival, hors sanction officielle. Optionnellement, un enjeu de gym peut etre mis en jeu.',
      })
    );

    for (const challenge of UNDERGROUND_CHALLENGES) {
      panel.appendChild(
        el('div', { class: 'card underground-card', onclick: () => this._showUndergroundSetupModal(challenge) }, [
          el('div', { class: 'fighter-head' }, [
            el('div', {}, [
              el('div', { class: 'fighter-name', text: `${challenge.icon} ${challenge.title}` }),
              el('div', { class: 'fighter-meta', text: challenge.desc }),
            ]),
            el('span', { class: `badge ${challenge.badgeClass}`, text: challenge.badgeLabel }),
          ]),
        ])
      );
    }
  }

  _showUndergroundSetupModal(challenge) {
    this._undergroundSetup = { challenge, fighterId: null, gymId: null, opponentId: null, allowMixedGender: false };
    this._renderUndergroundSetupModal();
  }

  _renderUndergroundSetupModal() {
    const setup = this._undergroundSetup;
    const { playerState, worldState } = this.gameState;
    const isGauntlet = setup.challenge.mode === UNDERGROUND_MODES.GAUNTLET;

    const available = playerState.roster.filter((f) => !f.isInjured(worldState.currentDay));
    const selectedGym = worldState.rivalGyms.find((gym) => gym.id === setup.gymId) ?? null;
    const selectedFighter = setup.fighterId ? playerState.getFighter(setup.fighterId) : null;

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: `${setup.challenge.icon} ${setup.challenge.title}` }),
      el('p', { text: setup.challenge.desc }),
      el('div', { class: 'card-title', text: 'Votre combattant' }),
    ]);

    if (available.length === 0) {
      content.appendChild(el('p', { text: 'Aucun combattant disponible (non blesse).' }));
    }
    for (const fighter of available) {
      content.appendChild(
        el('div', {
          class: `fighter-card selectable${setup.fighterId === fighter.identity.id ? ' selected' : ''}`,
          onclick: () => {
            setup.fighterId = fighter.identity.id;
            this._renderUndergroundSetupModal();
          },
        }, [
          el('div', { class: 'fighter-name', text: fighter.identity.name }),
          el('div', { class: 'fighter-meta', text: `${fighter.identity.style} — ${fighter.getRecordString()}` }),
        ])
      );
    }

    content.appendChild(el('div', { class: 'card-title', text: isGauntlet ? 'Gym adverse (pioche 3 a 5 adversaires)' : 'Gym adverse' }));
    if (worldState.rivalGyms.length === 0) {
      content.appendChild(el('p', { text: 'Aucun gym rival recense.' }));
    }
    for (const gym of worldState.rivalGyms) {
      const rosterSize = gym.roster?.length ?? 0;
      content.appendChild(
        el('div', {
          class: `fighter-card selectable${setup.gymId === gym.id ? ' selected' : ''}`,
          onclick: () => {
            setup.gymId = gym.id;
            setup.opponentId = null;
            this._renderUndergroundSetupModal();
          },
        }, [
          el('div', { class: 'fighter-name', text: gym.name ?? gym.id }),
          el('div', { class: 'fighter-meta', text: `Reputation ${Math.round(gym.reputation ?? 0)} — ${rosterSize} combattant(s) recense(s)` }),
        ])
      );
    }

    if (selectedGym && !isGauntlet) {
      content.appendChild(
        el('label', { class: 'checkbox-row' }, [
          el('input', {
            type: 'checkbox',
            checked: setup.allowMixedGender ? 'checked' : null,
            onchange: (event) => {
              setup.allowMixedGender = event.target.checked;
              this._renderUndergroundSetupModal();
            },
          }),
          ' Mode Mixte (autoriser les combats mixtes)',
        ])
      );

      content.appendChild(el('div', { class: 'card-title', text: 'Leur combattant' }));
      const roster = selectedGym.roster ?? [];
      if (roster.length === 0) {
        content.appendChild(el('p', { text: 'Ce gym n\'a pas encore de combattant recrute.' }));
      }
      for (const entry of roster) {
        const genderMismatch = Boolean(selectedFighter) && !isGenderMatch(selectedFighter, entry, { allowMixedGender: setup.allowMixedGender });
        content.appendChild(
          el('div', {
            class: `fighter-card${genderMismatch ? ' gender-mismatch' : ' selectable'}${setup.opponentId === entry.identity.id ? ' selected' : ''}`,
            onclick: genderMismatch
              ? undefined
              : () => {
                  setup.opponentId = entry.identity.id;
                  this._renderUndergroundSetupModal();
                },
          }, [
            el('div', { class: 'fighter-name', text: entry.identity.name }),
            el('div', { class: 'fighter-meta', text: `${entry.identity.style} — ${entry.career.wins}-${entry.career.losses}-${entry.career.draws}` }),
          ])
        );
      }
    }

    if (selectedGym && isGauntlet) {
      const rosterSize = selectedGym.roster?.length ?? 0;
      const minOpponents = BALANCE.UNDERGROUND.GAUNTLET.MIN_OPPONENTS;
      if (rosterSize < minOpponents) {
        content.appendChild(
          el('p', { text: `Il faut au moins ${minOpponents} combattants recenses dans ce gym pour lancer un Gauntlet (actuellement ${rosterSize}).` })
        );
      }
    }

    content.appendChild(
      el('button', {
        class: 'btn btn-gold btn-block',
        text: 'Lancer le combat Underground',
        disabled: this._isUndergroundSetupReady() ? null : 'disabled',
        onclick: () => this._resolveUndergroundFight(),
      })
    );
    content.appendChild(el('button', { class: 'btn btn-outline btn-block', text: 'Annuler', onclick: () => this._hideModal() }));

    this._showModal(content, { blocking: true });
  }

  _isUndergroundSetupReady() {
    const setup = this._undergroundSetup;
    if (!setup || !setup.fighterId || !setup.gymId) return false;

    const { worldState } = this.gameState;
    const gym = worldState.rivalGyms.find((g) => g.id === setup.gymId);
    if (!gym) return false;

    if (setup.challenge.mode === UNDERGROUND_MODES.GAUNTLET) {
      return (gym.roster?.length ?? 0) >= BALANCE.UNDERGROUND.GAUNTLET.MIN_OPPONENTS;
    }
    return Boolean(setup.opponentId);
  }

  /** Writes a (possibly mutated, e.g. after fighting) hydrated opponent Fighter back onto its rival gym's plain-JSON roster — see engine/TransferMarket.js's own precedent for this roster-storage discipline. */
  _writeBackRivalFighter(gymId, fighter) {
    const { worldState } = this.gameState;
    const gym = worldState.rivalGyms.find((g) => g.id === gymId);
    if (!gym) return;
    const nextRoster = (gym.roster ?? []).map((entry) => (entry.identity.id === fighter.identity.id ? fighter.toJSON() : entry));
    worldState.updateRivalGym(gymId, { roster: nextRoster });
  }

  _resolveUndergroundFight() {
    const setup = this._undergroundSetup;
    const { playerState, worldState } = this.gameState;
    const playerFighter = playerState.getFighter(setup.fighterId);
    const gym = worldState.rivalGyms.find((g) => g.id === setup.gymId);

    if (setup.challenge.mode === UNDERGROUND_MODES.GAUNTLET) {
      const cfg = BALANCE.UNDERGROUND.GAUNTLET;
      const roster = (gym.roster ?? []).map((entry) => Fighter.fromJSON(entry));
      const count = Math.min(cfg.MAX_OPPONENTS, roster.length);
      const opponents = shuffleAndTake(roster, count, this.rng);

      const run = runGauntlet({
        runner: playerFighter,
        opponents,
        ruleset: setup.challenge.ruleset,
        playerState,
        worldState,
        rng: this.rng,
      });

      for (const opponent of opponents) this._writeBackRivalFighter(gym.id, opponent);

      this._hideModal();
      this._showUndergroundResultModal({ kind: 'GAUNTLET', run, challenge: setup.challenge });
    } else {
      const opponentEntry = (gym.roster ?? []).find((entry) => entry.identity.id === setup.opponentId);
      const opponentFighter = Fighter.fromJSON(opponentEntry);
      assertGenderMatch(playerFighter, opponentFighter, { allowMixedGender: setup.allowMixedGender });

      const result = runUndergroundFight({
        fighterA: playerFighter,
        fighterB: opponentFighter,
        mode: setup.challenge.mode,
        ruleset: setup.challenge.ruleset,
        playerState,
        worldState,
        rng: this.rng,
      });

      let stipulationOutcome = null;
      if (setup.challenge.stipulation) {
        const playerCorner = result.fighters.A === playerFighter.identity.id ? 'A' : 'B';
        const playerWon = result.winner === playerCorner;
        stipulationOutcome = resolveGymStipulation(setup.challenge.stipulation, {
          playerWon,
          playerFighter,
          opponentFighter,
          opponentGymId: gym.id,
          playerState,
          worldState,
        });
      }

      // PINK_SLIP may already have moved one of these fighters to a different roster entirely — writing back a stale gym membership would re-add them where they no longer belong.
      if (stipulationOutcome?.type !== 'FIGHTER_ACQUIRED' && stipulationOutcome?.type !== 'FIGHTER_LOST') {
        this._writeBackRivalFighter(gym.id, opponentFighter);
      }

      this._hideModal();
      this._showUndergroundResultModal({ kind: 'SINGLE', result, stipulationOutcome, challenge: setup.challenge, playerFighter, opponentFighter });
    }

    this._undergroundSetup = null;
    this._renderAll();
    this._autosave();
  }

  _describeStipulationOutcome(outcome) {
    if (!outcome) return null;
    switch (outcome.type) {
      case 'EQUIPMENT_GAINED':
        return `\u{1F381} Equipement gagne : ${outcome.label}.`;
      case 'NOTHING_TO_GAIN':
        return `\u{1F937} ${outcome.detail}`;
      case 'FACILITY_LEVEL_SEIZED':
        return `\u{1F4C9} Un niveau d'installation a ete saisi (niveau ${outcome.newEquipLevel}).`;
      case 'NOTHING_TO_LOSE':
        return `\u{1F937} ${outcome.detail}`;
      case 'HONOUR_UPHELD':
        return `\u{1F3C6} Reputation +${outcome.reputationDelta}, Loyaute du roster +${outcome.loyaltyDelta}.`;
      case 'HONOUR_LOST':
        return '\u{1F4C9} La Loyaute de tout le roster s\'effondre.';
      case 'FIGHTER_ACQUIRED':
        return `\u{1F4C4} ${outcome.fighterName} rejoint votre effectif, sans indemnite.`;
      case 'ROSTER_FULL':
        return `\u{1F937} ${outcome.detail}`;
      case 'FIGHTER_LOST':
        return `\u{1F4C4} ${outcome.fighterName} rejoint le gym adverse, sans indemnite.`;
      case 'SPONSOR_CAPTURED':
        return `\u{1F4B0} Contrat de sponsor capture : +${outcome.deal.weeklyAmount}$/semaine pendant ${outcome.deal.weeksRemaining} semaines.`;
      case 'RAID_FAILED':
        return '\u{1F937} Le raid de sponsoring a echoue.';
      default:
        return null;
    }
  }

  _showUndergroundResultModal({ kind, result, run, stipulationOutcome, challenge }) {
    const lines = [];

    if (kind === 'GAUNTLET') {
      lines.push(`${run.survived ? '\u{1F3C6} Gauntlet survecu !' : '\u{1F480} Le Gauntlet s\'arrete ici.'}`);
      lines.push(`Adversaires vaincus : ${run.opponentsDefeated} / ${run.totalOpponents}`);
      run.fightResults.forEach((fightResult, index) => {
        const won = fightResult.winner === fightResult.gauntletRunnerCorner;
        lines.push(`  Combat ${index + 1} : ${won ? 'Victoire' : fightResult.winner === null ? 'Nul' : 'Defaite'} (${fightResult.method})`);
      });
    } else {
      lines.push(`${result.method} — ${result.winner === null ? 'Match nul' : `Victoire de ${result.names[result.winner]}`}`);
      lines.push(`Bourse (part gym) : ${result.purses.A.gymShare + result.purses.B.gymShare}$`);
    }

    const stipulationText = this._describeStipulationOutcome(stipulationOutcome);
    if (stipulationText) lines.push('', stipulationText);

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: `${challenge.icon} ${challenge.title} — Resultat` }),
      el('pre', { style: 'white-space:pre-wrap;font-family:inherit;font-size:13px;', text: lines.join('\n') }),
      el('button', { class: 'btn btn-gold btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);
    this._showModal(content, { blocking: true });
  }

  /**
   * The player only ever configures their OWN corner (A) — the opponent (B)
   * fights their own AI gameplan, derived from their style/stats (see
   * ui/FightNightView.js#defaultGameplanForFighter, applied automatically in
   * _confirmFightSetup by never passing a B gameplan at all). There used to
   * be a full "Coin B" card here letting the player also puppet the
   * opponent's target/distance/tempo/weight-cut, which made no narrative
   * sense (the player doesn't corner the other gym's fighter).
   */
  _renderFightSetup(panel) {
    const opponentName = this.fightCard?.fighterB?.name ?? 'l\'adversaire';
    panel.appendChild(el('h2', { class: 'section-title', text: '\u{1F94A} Preparation du combat' }));
    panel.appendChild(el('pre', { class: 'card', style: 'white-space:pre-wrap;font-family:inherit;font-size:13px;', text: this.fightView.toCardText() }));
    panel.appendChild(el('p', { class: 'fighter-meta', text: `${opponentName} suit son propre plan de jeu, base sur son style et ses stats.` }));

    const card = el('div', { class: 'card' }, [el('div', { class: 'card-title', text: `Coin A — ${this.fightCard?.fighterA?.name ?? 'Vous'}` })]);

    // Weight cut is now decided during Fight Week (see _showFightWeekLogistiqueModal)
    // — this.weightCutChoices.A was already resolved from that choice in _launchFight.
    card.appendChild(el('p', { class: 'fighter-meta', text: `Coupe de poids (choisie en Fight Week) : ${this.weightCutChoices.A}` }));

    card.appendChild(el('p', { class: 'fighter-meta', text: 'Cible' }));
    card.appendChild(this._gameplanChipRow('A', 'target', TARGET_LABELS));
    card.appendChild(el('p', { class: 'fighter-meta', text: 'Distance' }));
    card.appendChild(this._gameplanChipRow('A', 'distance', DISTANCE_LABELS));
    card.appendChild(el('p', { class: 'fighter-meta', text: 'Tempo' }));
    card.appendChild(this._gameplanChipRow('A', 'tempo', TEMPO_LABELS));

    panel.appendChild(card);

    panel.appendChild(
      el('button', {
        class: 'btn btn-gold btn-block',
        text: 'Lancer le combat',
        onclick: () => this._confirmFightSetup(),
      })
    );
  }

  _gameplanChipRow(cornerKey, field, labels) {
    return el(
      'div',
      { class: 'slot-row' },
      Object.entries(labels).map(([value, label]) =>
        el('button', {
          class: `activity-chip${this.gameplanChoices[cornerKey][field] === value ? ' selected' : ''}`,
          text: label,
          onclick: () => {
            this.gameplanChoices = { ...this.gameplanChoices, [cornerKey]: { ...this.gameplanChoices[cornerKey], [field]: value } };
            this._renderFight();
          },
        })
      )
    );
  }

  _confirmFightSetup() {
    this.combatEngine.selectWeightCutProfile('A', this.weightCutChoices.A);
    // The opponent (B) always cuts weight naturally — the player never
    // corners the other gym's fighter, so there is no UI to choose it for them.
    this.combatEngine.selectWeightCutProfile('B', 'NATUREL');
    // B intentionally omitted: FightNightView#setGameplans falls back to
    // defaultGameplanForFighter(fighterB) — their own style/stats-driven AI
    // gameplan — whenever no explicit B plan is passed.
    this.fightView.setGameplans({ A: this.gameplanChoices.A });
    this.fightSetupDone = true;
    this._beginCombatPlayback();
  }

  // ---- LIVE TEXT FEED (play-by-play combat playback) ------------------------------

  /** Fetches the next round (or the final result) and, for a round, arms the beat-by-beat reveal timer — the single engine-advancing step every playback control (auto-advance, Sauter le Round) ultimately calls. */
  _advanceCombatRound() {
    const step = this.fightView.advanceOneRound();
    if (step.finished) {
      this._finishCombatPlayback();
      return;
    }
    AudioEngine.playGong(); // Round bell — this single choke point covers both "round starts" and, by the same token, "the previous round just ended".
    this._combatPlayback = { beats: step.round.beats, revealedCount: 0, playing: true, timerId: null };
    this._renderFight();
    this._scheduleNextBeat();
  }

  _beginCombatPlayback() {
    this._teardownCombatPlayback();
    this._advanceCombatRound();
  }

  /** Reveals one beat every ~1.4s while playback.playing stays true — paused by _togglePlayback, short-circuited by _skipRound. */
  _scheduleNextBeat() {
    const playback = this._combatPlayback;
    if (!playback || !playback.playing) return;

    if (playback.revealedCount >= playback.beats.length) {
      this._advanceCombatRound();
      return;
    }

    playback.timerId = setTimeout(() => {
      if (this._combatPlayback !== playback) return; // a newer round/playback superseded this timer — stale, ignore.
      playback.revealedCount += 1;
      AudioEngine.playHit();
      this._renderFight();
      this._scheduleNextBeat();
    }, 1400);
  }

  _togglePlayback() {
    const playback = this._combatPlayback;
    if (!playback) return;
    playback.playing = !playback.playing;
    if (playback.playing) this._scheduleNextBeat();
    else clearTimeout(playback.timerId);
    this._renderFight();
  }

  /** "Sauter le Round": instantly reveals the rest of the current round's text, then immediately fetches the next round (or the result) — preserving whatever play/pause state was already active. */
  _skipRound() {
    const playback = this._combatPlayback;
    if (!playback) return;
    clearTimeout(playback.timerId);
    playback.revealedCount = playback.beats.length;
    this._renderFight();
    this._advanceCombatRound();
  }

  /** "Simuler le Match": abandons the live feed entirely and resolves the rest of the fight instantly. */
  _simulateWholeFight() {
    this._teardownCombatPlayback();
    this.fightView.simulateToCompletion();
    this._finishCombatPlayback();
  }

  _teardownCombatPlayback() {
    if (this._combatPlayback?.timerId) clearTimeout(this._combatPlayback.timerId);
    this._combatPlayback = null;
  }

  _finishCombatPlayback() {
    this._teardownCombatPlayback();
    if (this._fightOpponentGymId && this._fightFighterB) {
      this._writeBackRivalFighter(this._fightOpponentGymId, this._fightFighterB);
    }
    const result = this.combatEngine.getSnapshot().result;
    this.fightResultsThisYear.push(result);

    AudioEngine.playGong(); // Final bell.
    // The player's own corner is always 'A' in this normal Combat-tab flow (see _confirmFightSetup).
    if (result.winner === 'A') {
      AudioEngine.playVictory();
      if (result.purses?.A?.gymShare > 0) AudioEngine.playCash();
    }

    // LeagueEngine: only sanctioned WFC Combat-tab fights count toward
    // promotion/relegation — this is that single call site (Underground
    // Circuit bouts never reach _finishCombatPlayback at all). A draw
    // (winner === null) is skipped rather than counted as a loss.
    if (result.winner !== null) {
      recordLeagueFightResult(this.gameState.playerState, result.winner === 'A');
    }

    this._autosave();
    this._renderFight();
  }

  _renderFightInProgress(panel) {
    const playback = this._combatPlayback;
    const roundLogs = this.fightView.getRoundLogs();
    const currentRoundNumber = roundLogs.length > 0 ? roundLogs[roundLogs.length - 1].round : 1;
    const revealedBeats = playback ? playback.beats.slice(0, playback.revealedCount) : [];
    const clock = revealedBeats.length > 0 ? revealedBeats[revealedBeats.length - 1].timestamp : this._formatRoundClock(BALANCE.COMBAT.ROUND_DURATION_SECONDS);

    panel.appendChild(el('h2', { class: 'section-title', text: '\u{1F94A} Combat en cours' }));
    panel.appendChild(el('pre', { class: 'card', style: 'white-space:pre-wrap;font-family:inherit;font-size:13px;', text: this.fightView.toCardText() }));

    panel.appendChild(
      el('div', { class: 'card round-log-header', text: `Round ${currentRoundNumber} — \u{23F1}\u{FE0F} ${clock}` })
    );

    const feed = el('div', { class: 'card fight-feed' });
    for (const beat of revealedBeats) {
      feed.appendChild(
        el('div', { class: 'fight-feed-line' }, [
          el('span', { class: 'fight-feed-time', text: beat.timestamp }),
          el('span', { class: 'fight-feed-text', text: beat.text }),
        ])
      );
    }
    panel.appendChild(feed);

    const lastLog = roundLogs[roundLogs.length - 1];
    if (lastLog) {
      panel.appendChild(gaugeRow('Vie A', lastLog.healthAfter.A));
      panel.appendChild(gaugeRow('Vie B', lastLog.healthAfter.B));
      panel.appendChild(gaugeRow('Stamina A', lastLog.staminaAfter.A));
      panel.appendChild(gaugeRow('Stamina B', lastLog.staminaAfter.B));
    }

    const isPlaying = Boolean(playback?.playing);
    const controls = el('div', { class: 'slot-row' }, [
      el('button', {
        class: 'btn btn-gold',
        text: isPlaying ? '\u{23F8}\u{FE0F} Pause' : '\u{25B6}\u{FE0F} Lecture',
        onclick: () => this._togglePlayback(),
      }),
      el('button', { class: 'btn btn-outline', text: '\u{23ED}\u{FE0F} Sauter le round', onclick: () => this._skipRound() }),
      el('button', { class: 'btn btn-outline', text: '\u{23E9} Simuler le combat', onclick: () => this._simulateWholeFight() }),
    ]);
    panel.appendChild(controls);
  }

  _formatRoundClock(secondsRemaining) {
    const clamped = Math.max(0, Math.round(secondsRemaining));
    const minutes = Math.floor(clamped / 60);
    const seconds = clamped % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  _renderFightResult(panel) {
    const banner = this.fightView.getResultBanner();
    const headline = banner?.headline ?? this.fightView.toResultText();
    const dramatic = Boolean(banner?.dramaticBanner);

    const bannerEl = el('div', { class: `result-banner${dramatic ? ' dramatic' : ''}` }, [
      dramatic ? el('div', { text: banner.dramaticBanner }) : null,
      el('div', { class: 'result-headline', text: headline }),
      banner?.method ? el('div', { class: 'fighter-meta', text: `Methode : ${METHOD_LABELS[banner.method] ?? banner.method}` }) : null,
    ]);
    panel.appendChild(bannerEl);

    if (banner?.recordsBroken?.length > 0) {
      for (const record of banner.recordsBroken) {
        panel.appendChild(el('div', { class: 'card feed-hall-of-fame', text: `\u{1F3C6} NOUVEAU RECORD : ${record.detail ?? record.key}` }));
      }
    }

    panel.appendChild(el('h3', { class: 'section-title', text: 'Compte-rendu' }));
    for (const round of this.fightView.getRoundLogs()) {
      const roundCard = el('div', { class: 'card fight-feed' }, [
        el('div', { class: 'round-log-header', text: `Round ${round.round}` }),
      ]);
      for (const beat of round.beats ?? []) {
        roundCard.appendChild(
          el('div', { class: 'fight-feed-line' }, [
            el('span', { class: 'fight-feed-time', text: beat.timestamp }),
            el('span', { class: 'fight-feed-text', text: beat.text }),
          ])
        );
      }
      panel.appendChild(roundCard);
    }

    panel.appendChild(
      el('button', {
        class: 'btn btn-gold btn-block',
        text: 'Nouveau combat',
        onclick: () => {
          this._teardownCombatPlayback();
          this._galaSetup = null;
          this._fightOpponentGymId = null;
          this._fightFighterB = null;
          this.fightView = null;
          this.fightCard = null;
          this.fightSetupDone = false;
          this._renderFight();
        },
      })
    );
  }

  // ---- JOURNAL panel --------------------------------------------------------------

  _renderJournal() {
    const panel = this.dom.panels.journal;
    panel.innerHTML = '';
    panel.appendChild(el('h2', { class: 'section-title', text: '\u{1F4F0} Journal' }));
    panel.appendChild(
      el('button', {
        class: 'btn btn-outline btn-block',
        text: '\u{1F3C6} Bilan de la saison en cours',
        onclick: () => this._showSeasonSummary(),
      })
    );

    panel.appendChild(
      el('div', { class: 'subtab-row' }, [
        el('button', {
          class: `subtab-btn${this.journalTab === 'world' ? ' active' : ''}`,
          text: 'Monde',
          onclick: () => {
            this.journalTab = 'world';
            this._renderJournal();
          },
        }),
        el('button', {
          class: `subtab-btn${this.journalTab === 'social' ? ' active' : ''}`,
          text: 'Reseaux',
          onclick: () => {
            this.journalTab = 'social';
            this._renderJournal();
          },
        }),
        el('button', {
          class: `subtab-btn${this.journalTab === 'legends' ? ' active' : ''}`,
          text: '\u{1F3C6} Hall of Fame',
          onclick: () => {
            this.journalTab = 'legends';
            this._renderJournal();
          },
        }),
      ])
    );

    if (this.journalTab === 'social') {
      this._renderSocialFeed(panel);
      return;
    }
    if (this.journalTab === 'legends') {
      this._renderHallOfFame(panel);
      return;
    }

    const entries = this.worldFeed.getEntries(50);
    if (entries.length === 0) {
      panel.appendChild(el('p', { text: 'Rien a signaler pour le moment.' }));
      return;
    }
    for (const entry of entries) {
      const extraClass = entry.category === 'HALL_OF_FAME' ? ' feed-hall-of-fame' : entry.category === 'TITLE' ? ' feed-title' : '';
      panel.appendChild(
        el('div', { class: `feed-entry${extraClass}` }, [
          el('span', { class: 'feed-day', text: `J${entry.day}` }),
          el('span', { class: 'feed-category', text: entry.category }),
          el('span', { text: entry.text }),
        ])
      );
    }
  }

  _renderSocialFeed(panel) {
    const posts = [...this.gameState.playerState.socialFeed].reverse().slice(0, 30);
    if (posts.length === 0) {
      panel.appendChild(el('p', { text: 'Aucune publication pour le moment.' }));
      return;
    }
    for (const post of posts) {
      panel.appendChild(
        el('div', { class: 'social-post' }, [
          el('div', { class: 'post-author', text: post.author }),
          el('div', { class: 'post-text', text: post.text }),
          el('div', { class: 'post-likes', text: `\u{2605} ${post.likes}` }),
        ])
      );
    }
  }

  // ---- HALL OF FAME & TROPHEES (badges, Livre d'Or, legends) --------------------------

  _renderHallOfFame(panel) {
    this._renderBadgesGrid(panel);
    this._renderGoldenBook(panel);

    panel.appendChild(el('h3', { class: 'section-title', text: '\u{2728} Legendes' }));
    const legends = [...this.gameState.worldState.getHallOfFame()].reverse();
    if (legends.length === 0) {
      panel.appendChild(el('p', { text: 'Aucune legende intronisee pour le moment.' }));
      return;
    }
    for (const entry of legends) {
      panel.appendChild(
        el('div', { class: 'card', onclick: () => this._showLegendProfile(entry) }, [
          el('div', { class: 'fighter-head' }, [
            el('div', {}, [
              el('div', { class: 'fighter-name', text: entry.name }),
              el('div', { class: 'fighter-meta', text: `${entry.style} — ${entry.record}` }),
            ]),
            entry.nickname ? el('span', { class: 'badge badge-nickname', text: `"${entry.nickname}"` }) : null,
          ]),
        ])
      );
    }
  }

  _renderBadgesGrid(panel) {
    const unlockedIds = new Set(this.gameState.playerState.unlockedBadges);
    const badges = getAllBadgeDefinitions();

    panel.appendChild(
      el('h3', { class: 'section-title', text: `\u{1F396}\u{FE0F} Badges (${unlockedIds.size}/${badges.length})` })
    );
    const grid = el('div', { class: 'badge-grid' });
    for (const badge of badges) {
      const unlocked = unlockedIds.has(badge.id);
      grid.appendChild(
        el('div', { class: `card badge-tile${unlocked ? ' badge-unlocked' : ' badge-locked'}` }, [
          el('div', { class: 'badge-icon', text: badge.icon }),
          el('div', { class: 'fighter-name', text: badge.label }),
          el('div', { class: 'fighter-meta', text: badge.description }),
        ])
      );
    }
    panel.appendChild(grid);
  }

  _renderGoldenBook(panel) {
    const entries = [...this.gameState.worldState.getGoldenBook()].reverse();
    panel.appendChild(el('h3', { class: 'section-title', text: "\u{1F4DC} Livre d'Or" }));
    if (entries.length === 0) {
      panel.appendChild(el('p', { text: 'Aucune saison gravee pour le moment.' }));
      return;
    }
    for (const entry of entries) {
      panel.appendChild(el('div', { class: 'card golden-book-entry', text: entry.text }));
    }
  }

  _showLegendProfile(entry) {
    const rows = [
      el('div', { class: 'gauge-row' }, [el('span', { class: 'gauge-label', text: 'Bilan' }), el('span', { text: entry.record })]),
      el('div', { class: 'gauge-row' }, [el('span', { class: 'gauge-label', text: 'Style' }), el('span', { text: entry.style })]),
      el('div', { class: 'gauge-row' }, [el('span', { class: 'gauge-label', text: 'Retraite a' }), el('span', { text: `${entry.retiredAtAge} ans` })]),
      el('div', { class: 'gauge-row' }, [el('span', { class: 'gauge-label', text: 'Finitions' }), el('span', { text: String(entry.finishes) })]),
      el('div', { class: 'gauge-row' }, [
        el('span', { class: 'gauge-label', text: 'Plus longue serie' }),
        el('span', { text: String(entry.longestWinStreak) }),
      ]),
    ];
    if (entry.biggestRival) {
      rows.push(
        el('div', { class: 'gauge-row' }, [
          el('span', { class: 'gauge-label', text: 'Plus grand rival' }),
          el('span', { text: `${entry.biggestRival.fighterName} (tension ${Math.round(entry.biggestRival.tension)})` }),
        ])
      );
    }

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: `\u{2728} ${entry.name}${entry.nickname ? ` "${entry.nickname}"` : ''}` }),
      ...rows,
      el('button', {
        class: 'btn btn-gold btn-block',
        text: '\u{1F4DC} Exporter mon Epopee / Partager',
        onclick: () => this._showStoryExportModal(),
      }),
      el('button', { class: 'btn btn-outline btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);
    this._showModal(content);
  }

  // ---- GALA DE FIN DE SAISON (Story Analyzer trophies) -----------------------------

  /** Permanently records each trophy onto its winning fighter/coach's own profile — see Fighter#addTrophy/PlayerState#awardCoachTrophy. Gym of the Year has no fighter/coach owner, so it's shown in the Gala only. */
  _persistTrophies(analysis) {
    const { playerState } = this.gameState;
    const asRecord = (trophy) => ({ category: trophy.category, label: trophy.label, year: analysis.year });

    if (analysis.rivalryOfTheYear) {
      const trophy = asRecord(analysis.rivalryOfTheYear);
      playerState.getFighter(analysis.rivalryOfTheYear.fighterAId)?.addTrophy(trophy);
      playerState.getFighter(analysis.rivalryOfTheYear.fighterBId)?.addTrophy(trophy);
    }
    if (analysis.upsetOfTheYear) {
      playerState.getFighter(analysis.upsetOfTheYear.fighterId)?.addTrophy(asRecord(analysis.upsetOfTheYear));
    }
    if (analysis.finisherKing) {
      playerState.getFighter(analysis.finisherKing.fighterId)?.addTrophy(asRecord(analysis.finisherKing));
    }
    if (analysis.coachOfTheYear) {
      playerState.awardCoachTrophy(analysis.coachOfTheYear.coachId, asRecord(analysis.coachOfTheYear));
    }
  }

  _showGala(analysis) {
    const trophies = [analysis.rivalryOfTheYear, analysis.upsetOfTheYear, analysis.finisherKing, analysis.coachOfTheYear, analysis.gymOfTheYear].filter(
      Boolean
    );

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: `\u{1F3C6} Gala de fin de saison — Annee ${analysis.year}` }),
      el('p', { text: 'Tapez sur un trophee pour en savoir plus.' }),
      ...trophies.map((trophy) => this._buildGalaTrophyCard(analysis, trophy)),
      el('button', {
        class: 'btn btn-gold btn-block',
        text: 'Continuer',
        onclick: () => {
          this._hideModal();
          this._showSeasonSummary({ afterYearChange: true });
        },
      }),
    ]);
    this._showModal(content, { blocking: true });
  }

  _buildGalaTrophyCard(analysis, trophy) {
    const icon = TROPHY_ICONS[trophy.category] ?? '\u{1F3C6}';
    return el('div', { class: 'card trophy-card', onclick: () => this._showGalaTrophyDetail(analysis, trophy) }, [
      el('div', { class: 'card-title', text: `${icon} ${trophy.label}` }),
      el('div', { class: 'fighter-meta', text: this._trophyWinnerLabel(trophy) }),
    ]);
  }

  _trophyWinnerLabel(trophy) {
    switch (trophy.category) {
      case TROPHY_CATEGORIES.RIVALRY_OF_THE_YEAR:
        return `${trophy.fighterAName} vs ${trophy.fighterBName}`;
      case TROPHY_CATEGORIES.UPSET_OF_THE_YEAR:
        return trophy.fighterName;
      case TROPHY_CATEGORIES.FINISHER_KING:
        return `${trophy.fighterName} — ${trophy.finishes} finition(s)`;
      case TROPHY_CATEGORIES.COACH_OF_THE_YEAR:
        return trophy.coachName;
      case TROPHY_CATEGORIES.GYM_OF_THE_YEAR:
        return trophy.gymName;
      default:
        return '';
    }
  }

  _trophyDetailText(trophy) {
    switch (trophy.category) {
      case TROPHY_CATEGORIES.RIVALRY_OF_THE_YEAR:
        return (
          `${trophy.fighterAName} vs ${trophy.fighterBName}\n` +
          `Tension : ${trophy.tension}\n` +
          `Methode : ${METHOD_LABELS[trophy.method] ?? trophy.method}\n` +
          (trophy.winnerName ? `Vainqueur : ${trophy.winnerName}` : 'Match nul')
        );
      case TROPHY_CATEGORIES.UPSET_OF_THE_YEAR:
        return (
          `${trophy.fighterName} bat ${trophy.opponentName}\n` +
          `Ecart de niveau : ${trophy.ratingGap} points\n` +
          `Methode : ${METHOD_LABELS[trophy.method] ?? trophy.method}`
        );
      case TROPHY_CATEGORIES.FINISHER_KING:
        return `${trophy.fighterName}\n${trophy.koWins} KO/TKO — ${trophy.subWins} soumission(s)\nTotal : ${trophy.finishes} finition(s) cette saison`;
      case TROPHY_CATEGORIES.COACH_OF_THE_YEAR:
        return (
          `${trophy.coachName}\n` +
          `Progression d'equipe : ${trophy.teamProgression >= 0 ? '+' : ''}${trophy.teamProgression} points ` +
          `(${trophy.fightersTracked} combattant(s) suivi(s))`
        );
      case TROPHY_CATEGORIES.GYM_OF_THE_YEAR:
        return (
          `${trophy.gymName}${trophy.isPlayerGym ? ' (votre salle)' : ' (salle rivale)'}\n` +
          `Reputation : ${trophy.reputation}\n` +
          `Victoires de votre salle cette saison : ${trophy.playerWinsThisYear}`
        );
      default:
        return '';
    }
  }

  _showGalaTrophyDetail(analysis, trophy) {
    const icon = TROPHY_ICONS[trophy.category] ?? '\u{1F3C6}';
    const card = el('div', {}, [
      el('h2', { class: 'section-title', text: `${icon} ${trophy.label}` }),
      el('p', { style: 'white-space:pre-wrap;font-family:inherit;font-size:13px;', text: this._trophyDetailText(trophy) }),
      el('button', { class: 'btn btn-gold btn-block', text: 'Retour au Gala', onclick: () => this._showGala(analysis) }),
    ]);
    this._showModal(card);
  }

  _showSeasonSummary({ afterYearChange = false } = {}) {
    const seasonSummary = new SeasonSummary({ playerState: this.gameState.playerState, worldState: this.gameState.worldState });
    const summary = seasonSummary.build({
      weeklyResults: this.weeklyResultsThisYear,
      fightResults: this.fightResultsThisYear,
      startMoney: this.yearStartMoney,
      startDay: this.yearStartDay,
    });

    const card = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F3C6} Bilan de saison' }),
      el('pre', { style: 'white-space:pre-wrap;font-family:inherit;font-size:13px;', text: seasonSummary.toText(summary) }),
      el('button', {
        class: 'btn btn-outline btn-block',
        text: '\u{1F4DC} Exporter mon Epopee / Partager',
        onclick: () => this._showStoryExportModal({ afterYearChange }),
      }),
      el('button', {
        class: 'btn btn-gold btn-block',
        text: 'Fermer',
        onclick: () => {
          this._hideModal();
          if (afterYearChange) this._maybeOpenAcademyDraft();
        },
      }),
    ]);
    this._showModal(card);

    this.weeklyResultsThisYear = [];
    this.fightResultsThisYear = [];
    this.yearStartMoney = this.gameState.playerState.money;
    this.yearStartDay = this.gameState.worldState.currentDay;
  }

  // ---- STORY EXPORTER (Phase Beta) --------------------------------------------------

  /**
   * Opens the "Carte de Succes / Chronique" export modal — reachable from
   * the Week-52 Gala/Bilan de saison and from any Hall of Fame legend's
   * profile (see _renderHallOfFame()). The card itself always summarizes
   * the whole career (see web/StoryExporter.js#buildStoryCard), not just
   * whichever legend the player was looking at when they tapped Export.
   * @param {Object} [options]
   * @param {boolean} [options.afterYearChange] - Threaded through so closing this modal can still resume the post-Gala Academy Draft flow, exactly like _showSeasonSummary()'s own "Fermer" does.
   */
  _showStoryExportModal({ afterYearChange = false } = {}) {
    const card = buildStoryCard({ playerState: this.gameState.playerState, worldState: this.gameState.worldState });
    const canvas = document.createElement('canvas');
    canvas.className = 'story-card-canvas';
    renderStoryCardToCanvas(canvas, card);

    const actions = [
      el('button', {
        class: 'btn btn-gold btn-block',
        text: "\u{2B07}\u{FE0F} Telecharger l'image",
        onclick: () => this._downloadStoryCard(canvas, card),
      }),
    ];
    if (typeof navigator !== 'undefined' && navigator.share) {
      actions.push(
        el('button', {
          class: 'btn btn-outline btn-block',
          text: '\u{1F4E4} Partager',
          onclick: () => this._shareStoryCard(canvas, card),
        })
      );
    }
    actions.push(
      el('button', {
        class: 'btn btn-outline btn-block',
        text: 'Fermer',
        onclick: () => {
          this._hideModal();
          if (afterYearChange) this._maybeOpenAcademyDraft();
        },
      })
    );

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F4DC} Exporter mon Epopee' }),
      canvas,
      el('p', { class: 'story-card-note', text: card.note }),
      ...actions,
    ]);
    this._showModal(content);
  }

  _downloadStoryCard(canvas, card) {
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `${(card.gymName || 'chronique').replace(/[^a-z0-9]+/gi, '_')}_chronique.png`;
    link.click();
  }

  async _shareStoryCard(canvas, card) {
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const file = blob ? new File([blob], 'chronique.png', { type: 'image/png' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Ma Chronique MMA Gym Manager', text: toShareText(card) });
      } else {
        await navigator.share({ title: 'Ma Chronique MMA Gym Manager', text: toShareText(card) });
      }
    } catch (error) {
      console.warn('[web/app.js] Story card share failed or was cancelled:', error);
    }
  }

  // ---- FIRST-STEPS ONBOARDING (Phase Beta, Week 1 of the very first season only) ----

  /**
   * Shows the "Premiers pas" welcome modal exactly once per browser/device
   * (localStorage flag, own namespace — never routed through
   * core/SaveManager.js's WorldState/PlayerState-only save envelope, same
   * reasoning as web/telemetry.js's own storage split) and only for a
   * truly brand-new game (see _isBrandNewGame, set only by the "Nouvelle
   * Partie" flow — Continuer/charger une sauvegarde never sets it, so a
   * returning player is never re-shown this).
   *
   * V3.5: deliberately does NOT chain into _maybeOpenAcademyDraft() anymore
   * — "Demarrage 100% libre", no modal gate of any kind at game launch. The
   * Academy Draft mechanic itself is untouched and still checked at every
   * subsequent year boundary (see the afterYearChange call sites in
   * _showSeasonSummary/_showGala) and when loading an existing save.
   */
  _maybeShowFirstStepsOnboarding() {
    const alreadySeen = this._hasSeenOnboarding();
    if (!this._isBrandNewGame || alreadySeen) return;
    this._showFirstStepsOnboardingModal();
  }

  _hasSeenOnboarding() {
    try {
      return localStorage.getItem(ONBOARDING_SEEN_KEY) === '1';
    } catch {
      return true; // if localStorage is unavailable, don't force the modal on every load.
    }
  }

  _markOnboardingSeen() {
    try {
      localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
    } catch {
      // Best-effort only — a blocked localStorage must never break the flow.
    }
  }

  _showFirstStepsOnboardingModal() {
    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F44B} Premiers pas' }),
      el('p', { text: "Trois notions reviendront chaque semaine — voici l'essentiel avant de commencer." }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '\u{1F4AA} Readiness' }),
        el('p', {
          text: "La forme d'un combattant le jour du combat : fatigue physique, charge mentale, moral et blessures s'y combinent. Une Readiness elevee (vert) rend un combattant plus dangereux ; une Readiness basse (rouge) le fragilise.",
        }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '\u{1F91D} Loyaute envers le gym' }),
        el('p', {
          text: 'Visible sur la fiche de chaque combattant : plus elle est haute, plus le combattant reste engage envers votre salle sur la duree.',
        }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '\u{1F4C5} Les 3 creneaux de Planning' }),
        el('p', {
          text: 'Chaque semaine, chaque combattant occupe jusqu\'a 3 creneaux (Technique, Sparring, Preparation Video, Medias & Sponsors, Physio & Repos). Ce choix hebdomadaire faconne sa progression et sa condition.',
        }),
      ]),
      el('button', {
        class: 'btn btn-gold btn-block',
        text: "C'est parti",
        onclick: () => {
          this._markOnboardingSeen();
          this._hideModal();
        },
      }),
    ]);
    this._showModal(content, { blocking: true });
  }

  // ---- ACADEMY DRAFT (free annual recruitment) -------------------------------------

  _maybeOpenAcademyDraft() {
    const { playerState, worldState } = this.gameState;
    if (!isAcademyDraftAvailable(playerState, worldState.year)) return;
    this.academyPool = generateAcademyPool({ playerState, rng: this.rng });
    this._showAcademyDraftModal();
  }

  _showAcademyDraftModal() {
    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F393} Draft Annuel de l\'Academie' }),
      el('p', {
        text: "Votre academie presente ses jeunes espoirs de l'annee. Promouvez-en un gratuitement dans votre effectif (1 choix par an), ou passez cette annee.",
      }),
      ...this.academyPool.map((candidate) => this._buildAcademyCandidateCard(candidate)),
      el('button', {
        class: 'btn btn-outline btn-block',
        text: 'Passer cette annee',
        onclick: () => this._resolveAcademyDraft(null),
      }),
    ]);
    this._showModal(content, { blocking: true });
  }

  _buildAcademyCandidateCard(candidate) {
    const { fighter, potentialLabel } = candidate;
    const { playerState } = this.gameState;
    const rosterFull = playerState.roster.length >= playerState.getRosterCapacity();

    const skillsList = el(
      'ul',
      { class: 'skill-list' },
      Object.entries(fighter.attributes.skills).map(([key, value]) => el('li', { class: 'skill-pill', text: `${SKILL_LABELS[key] ?? key} ${Math.round(value)}` }))
    );

    return el('div', { class: 'card' }, [
      el('div', { class: 'fighter-head' }, [
        el('div', {}, [
          el('div', { class: 'fighter-name', text: fighter.identity.name }),
          el('div', {
            class: 'fighter-meta',
            text: `${fighter.identity.style} — ${fighter.identity.age} ans — ${fighter.psychology.personality.archetype}`,
          }),
        ]),
        el('span', { class: 'badge badge-nickname', text: potentialLabel }),
      ]),
      gaugeRow('Potentiel global', fighter.getOverallRating()),
      skillsList,
      el('button', {
        class: 'btn btn-gold btn-block',
        text: rosterFull ? 'Effectif complet' : 'Promouvoir gratuitement (1/1)',
        disabled: rosterFull ? 'disabled' : null,
        onclick: () => this._resolveAcademyDraft(fighter),
      }),
    ]);
  }

  _resolveAcademyDraft(chosenFighter) {
    const { playerState, worldState } = this.gameState;
    if (chosenFighter) {
      playerState.addFighter(chosenFighter);
      telemetry.recordFighterRecruited();
      this._showToast(`\u{1F393} ${chosenFighter.identity.name} rejoint votre effectif (draft academie).`);
    }
    playerState.recordAcademyDraftOffer(worldState.year);
    this.academyPool = [];
    this._hideModal();
    this._renderAll();
    this._autosave();
  }

  // ---- SETTINGS / SAVE EXPORT-IMPORT --------------------------------------------------

  /**
   * core/SaveManager.js (via state/GameState.js#exportSave/importSave)
   * already handles the versioned JSON envelope, serialization and
   * migration — this modal is purely the browser-side file download/upload
   * plumbing on top of that pre-existing, already-tested API. Autosave
   * itself already runs after every meaningful action (fight, week,
   * purchase...) via this._autosave() — a strictly tighter safety net than
   * "every 5 weeks", so no separate timer is added here.
   */
  _showSettingsModal() {
    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{2699}\u{FE0F} Parametres & Sauvegarde' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Exporter la sauvegarde' }),
        el('p', { class: 'fighter-meta', text: 'Telecharge un fichier .json contenant votre partie actuelle.' }),
        el('button', { class: 'btn btn-gold btn-block', text: '\u{2B07}\u{FE0F} Exporter (.json)', onclick: () => this._exportSaveToFile() }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Importer une sauvegarde' }),
        el('p', { class: 'fighter-meta', text: 'Remplace la partie actuelle par le contenu du fichier .json choisi.' }),
        el('input', {
          type: 'file',
          accept: '.json,application/json',
          onchange: (event) => this._importSaveFromFile(event),
        }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: 'Sauvegarde automatique' }),
        el('p', { class: 'fighter-meta', text: 'La partie est sauvegardee automatiquement dans le navigateur apres chaque action importante (combat, semaine, achat...).' }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '\u{1F3B5} Options Audio' }),
        el('label', { class: 'checkbox-row' }, [
          el('input', {
            type: 'checkbox',
            checked: AudioEngine.isJulModeEnabled() ? 'checked' : null,
            onchange: (event) => {
              AudioEngine.setJulModeEnabled(event.target.checked);
              this._showSettingsModal();
            },
          }),
          ' Musique Style Jul (ambiance synthetique inspiree du style marseillais)',
        ]),
        el('p', { class: 'fighter-meta', text: 'Ou chargez votre propre morceau local (mp3/ogg/wav) en ambiance de fond — reste sur votre appareil, jamais televerse.' }),
        el('input', {
          type: 'file',
          accept: 'audio/*',
          onchange: (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (AudioEngine.loadCustomTrack(file)) this._showToast(`\u{1F3B6} ${file.name} charge en ambiance.`);
            this._showSettingsModal();
          },
        }),
        AudioEngine.getCustomTrackName()
          ? el('div', { class: 'list-row' }, [
              el('span', { class: 'list-row-label', text: `\u{1F3B6} ${AudioEngine.getCustomTrackName()}` }),
              el('label', { class: 'checkbox-row' }, [
                el('input', {
                  type: 'checkbox',
                  checked: AudioEngine.isCustomTrackEnabled() ? 'checked' : null,
                  onchange: (event) => {
                    AudioEngine.setCustomTrackEnabled(event.target.checked);
                    this._showSettingsModal();
                  },
                }),
                ' Actif',
              ]),
              el('button', {
                class: 'btn btn-outline btn-sm',
                text: 'Retirer',
                onclick: () => {
                  AudioEngine.clearCustomTrack();
                  this._showSettingsModal();
                },
              }),
            ])
          : null,
      ]),
      el('button', { class: 'btn btn-outline btn-block', text: 'Fermer', onclick: () => this._hideModal() }),
    ]);
    this._showModal(content);
  }

  _exportSaveToFile() {
    try {
      const json = this.gameState.exportSave();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const gymSlug = (this.gameState.playerState.gymName || 'gym').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const link = document.createElement('a');
      link.href = url;
      link.download = `mma-gym-manager_${gymSlug}_${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      this._showToast('\u{2B07}\u{FE0F} Sauvegarde exportee.');
    } catch (error) {
      console.error('[web/app.js] Export failed:', error);
      this._showToast('\u{26A0}\u{FE0F} Echec de l\'export.');
    }
  }

  _importSaveFromFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        this.gameState.importSave(String(reader.result));
        this._hideModal();
        this._startNewWeek();
        this._renderAll();
        this._autosave();
        this._showToast('\u{2705} Sauvegarde importee.');
      } catch (error) {
        console.error('[web/app.js] Import failed:', error);
        this._showToast('\u{26A0}\u{FE0F} Fichier de sauvegarde invalide.');
      }
    };
    reader.readAsText(file);
  }

  // ---- modal / toast -----------------------------------------------------------------

  _showModal(contentEl, { blocking = false } = {}) {
    this.dom.modalCard.innerHTML = '';
    this.dom.modalCard.appendChild(contentEl);
    this.dom.modalOverlay.classList.remove('hidden');
    if (blocking) this.dom.modalOverlay.dataset.blocking = '1';
    else delete this.dom.modalOverlay.dataset.blocking;
  }

  _hideModal() {
    this.dom.modalOverlay.classList.add('hidden');
    this.dom.modalCard.innerHTML = '';
  }

  _showToast(message) {
    this.dom.toast.textContent = message;
    this.dom.toast.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.dom.toast.classList.add('hidden'), 3200);
  }

  // ---- persistence -------------------------------------------------------------------

  _autosave() {
    try {
      this.gameState.save(AUTOSAVE_SLOT);
    } catch (error) {
      console.error('[web/app.js] Autosave failed:', error);
    }
  }
}

const app = new WebApp();
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.init());
  } else {
    app.init();
  }
}

export { WebApp };
export default app;
