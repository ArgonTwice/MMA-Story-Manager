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

import EventBus from '../core/EventBus.js';
import SaveManager from '../core/SaveManager.js';
import { GameState } from '../state/GameState.js';
import { WORLD_EVENTS } from '../state/WorldState.js';
import BALANCE from '../data/balance.js';
import { getTraitDisplay } from '../data/traits.js';
import Fighter from '../models/Fighter.js';
import { generatePersonality } from '../engine/FighterGenerator.js';
import { CombatEngine, COMBAT_STATES } from '../engine/CombatEngine.js';
import { PersonalityEngine } from '../engine/PersonalityEngine.js';
import { RelationshipEngine } from '../engine/RelationshipEngine.js';
import { StoryEngine } from '../engine/StoryEngine.js';
import { NarrativeEngine } from '../engine/NarrativeEngine.js';
import { WorldMemory } from '../engine/WorldMemory.js';
import { HistoryEngine } from '../engine/HistoryEngine.js';
import { SocialEngine } from '../engine/SocialEngine.js';

import { generateAcademyPool, isAcademyDraftAvailable } from '../engine/AcademyEngine.js';
import { analyzeSeason, hasAnyTrophy, TROPHY_CATEGORIES } from '../engine/StoryAnalyzer.js';

import { GymHub } from '../ui/GymHub.js';
import { WeeklyFlowController, WEEKLY_FLOW_PHASES } from '../ui/WeeklyFlowController.js';
import { FightNightView } from '../ui/FightNightView.js';
import { WorldFeed } from '../ui/WorldFeed.js';
import { SeasonSummary } from '../ui/SeasonSummary.js';

const AUTOSAVE_SLOT = 'web-autosave';
const STARTING_ROSTER_STYLES = Object.freeze(['Boxe', 'Muay Thai', 'Lutte', 'Jiu-Jitsu Bresilien', 'Freestyle', 'Kickboxing']);

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
const WEIGHT_CUT_LABELS = Object.freeze({ NATUREL: 'Naturel', MODERE: 'Modere', INTENSIF: 'Intensif', EXTREME: 'Extreme' });

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
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
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

// ---- roster bootstrap (same spirit as tools/play-vertical-slice.js's own) ---

function bootstrapRoster(playerState, rng) {
  const skillDefault = BALANCE.PROGRESSION.DEFAULT_STARTING_SKILL_VALUE;
  for (const style of STARTING_ROSTER_STYLES) {
    const spread = 15;
    const skills = Object.fromEntries(
      ['boxe', 'jambes', 'sol', 'soumission', 'cardio', 'intelligence'].map((key) => [key, Math.round(skillDefault + (rng() * 2 - 1) * spread)])
    );
    const fighter = new Fighter({
      identity: {
        name: `${style} Prospect`,
        age: BALANCE.AGE.DEBUT_MIN_AGE + Math.floor(rng() * 8),
        style,
        weightClass: 'Poids Welter',
      },
      attributes: { skills },
      psychology: { personality: generatePersonality(rng) },
    });
    playerState.addFighter(fighter);
  }
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
    this.selectedFighterIds = [];
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
    this.gameplanChoices = { A: {}, B: {} };
    this.weightCutChoices = { A: 'NATUREL', B: 'NATUREL' };
    this.academyPool = [];
    /** { [fighterId]: { forme, moral } } snapshot taken at the start of the current week — see _startNewWeek()/_showFighterProfile()'s trend arrows. Runtime-only, never persisted. */
    this.weekStartSnapshot = {};
    this.dom = {};
  }

  init() {
    this._cacheDom();
    this._wireStartScreen();
    this._wireNav();
    this._wireModalDismiss();

    const hasAutosave = SaveManager.listSlots().includes(AUTOSAVE_SLOT);
    this.dom.continueBlock.classList.toggle('hidden', !hasAutosave);
    if (hasAutosave) {
      try {
        const { savedAt } = SaveManager.load(AUTOSAVE_SLOT);
        this.dom.continueMeta.textContent = `Derniere sauvegarde : ${new Date(savedAt).toLocaleString('fr-FR')}`;
      } catch {
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
      tbGymName: document.getElementById('tbGymName'),
      tbDay: document.getElementById('tbDay'),
      tbMoney: document.getElementById('tbMoney'),
      tbRep: document.getElementById('tbRep'),
      tbHype: document.getElementById('tbHype'),
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
      this.gameState.newGame({
        gymName: this.dom.newGymName.value || undefined,
        country: this.dom.newGymCountry.value || undefined,
      });
      bootstrapRoster(this.gameState.playerState, this.rng);
      this.gameState.worldState.addRivalGym({ name: 'Iron Fist Academy', reputation: 55 });
      this.gameState.worldState.addRivalGym({ name: 'Apex MMA', reputation: 45 });
      this._enterGame();
      this._autosave();
      this._maybeOpenAcademyDraft();
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
    this.selectedFighterIds = [];
    this.fightView = null;
    this.fightSetupDone = false;
    this.academyPool = [];

    this._yearChangedPending = false;
    this._yearChangedUnsub?.();
    this._yearChangedUnsub = EventBus.subscribe(WORLD_EVENTS.YEAR_CHANGED, () => {
      this._yearChangedPending = true;
    });

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

    if (this.lastWeekEconomy) {
      const e = this.lastWeekEconomy;
      panel.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title', text: 'Charges (derniere semaine)' }),
          el('div', { class: 'list-row' }, [el('span', { class: 'list-row-label', text: 'Loyer' }), el('span', { class: 'list-row-value', text: `-${Math.round(e.rent)}$` })]),
          el('div', { class: 'list-row' }, [el('span', { class: 'list-row-label', text: 'Salaires coachs' }), el('span', { class: 'list-row-value', text: `-${Math.round(e.coachPayroll)}$` })]),
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
        class: 'btn btn-gold btn-block',
        text: '\u{1F4C5} Aller au planning de la semaine',
        onclick: () => this._showPanel('planning'),
      })
    );
  }

  // ---- GYM FACILITY / EQUIPMENT / RIVALS modal ---------------------------------

  _showGymFacilityModal() {
    const playerState = this.gameState.playerState;
    const { BASE_COST, GROWTH, MAX_LEVEL } = BALANCE.ECONOMY.FACILITY_UPGRADE;
    const atMax = playerState.equipLevel >= MAX_LEVEL;
    const nextLevelCost = atMax ? null : Math.round(BASE_COST * GROWTH ** playerState.equipLevel);

    const ownedIds = new Set(playerState.equipment.map((item) => item.id));
    const owned = playerState.equipment.map((item) => ({ id: item.id, ...BALANCE.EQUIPMENT.DEFINITIONS[item.id] })).filter((item) => item.label);
    const catalog = Object.entries(BALANCE.EQUIPMENT.DEFINITIONS)
      .filter(([id]) => !ownedIds.has(id))
      .map(([id, def]) => ({ id, ...def, affordable: playerState.money >= def.purchaseCost }));

    const content = el('div', {}, [
      el('h2', { class: 'section-title', text: '\u{1F3CB}\u{FE0F} Ma salle' }),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: `Niveau ${playerState.equipLevel} — ${playerState.roster.length}/${playerState.getRosterCapacity()} places` }),
        atMax
          ? el('p', { text: 'Niveau maximum atteint.' })
          : el('button', {
              class: 'btn btn-gold btn-block',
              text: `Ameliorer (${nextLevelCost}$)`,
              disabled: playerState.money >= nextLevelCost ? null : 'disabled',
              onclick: () => this._upgradeFacility(),
            }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: `Equipement possede (${owned.length})` }),
        owned.length === 0
          ? el('p', { text: 'Aucun equipement pour le moment.' })
          : el(
              'div',
              {},
              owned.map((item) => el('div', { class: 'list-row' }, [el('span', { class: 'list-row-label', text: item.label })]))
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
                  el('div', {}, [el('div', { class: 'list-row-label', text: item.label }), el('div', { class: 'list-row-sub', text: `${item.purchaseCost}$` })]),
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
    this._renderTopbar();
    this._showToast(`\u{1F6E0}\u{FE0F} ${def.label} achete.`);
    this._showGymFacilityModal();
  }

  _upgradeFacility() {
    const playerState = this.gameState.playerState;
    const { BASE_COST, GROWTH } = BALANCE.ECONOMY.FACILITY_UPGRADE;
    const cost = Math.round(BASE_COST * GROWTH ** playerState.equipLevel);
    const upgraded = playerState.upgradeFacility(cost);
    if (upgraded) {
      this._renderTopbar();
      this._showToast(`\u{2B06}\u{FE0F} Salle amelioree — niveau ${playerState.equipLevel}.`);
    }
    this._showGymFacilityModal();
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

    for (const fighter of roster) {
      panel.appendChild(this._buildRosterDetailCard(fighter));
    }
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
            text: `${fighter.identity.age} ans — ${fighter.identity.weightClass} — ${fighter.getRecordString()} — ${fighter.getLegacyStage()}`,
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
      el('h2', { class: 'section-title', text: '\u{1F3AD} Evenement' }),
      el('p', { text: `${dramaPrompt.fighterName} — ${dramaPrompt.eventId}` }),
      el(
        'div',
        { class: 'choice-list' },
        dramaPrompt.choices.map((choice) =>
          el('button', {
            class: 'btn btn-outline choice-btn',
            text: choice.label,
            onclick: () => {
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

  _completeWeek(result) {
    this.weeklyResultsThisYear.push(result);
    this.lastWeekEconomy = result.weekSummary.economyReport;
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

    this._renderFightPicker(panel);
  }

  _renderFightPicker(panel) {
    panel.appendChild(el('h2', { class: 'section-title', text: '\u{1F94A} Choisir un combat' }));
    panel.appendChild(el('p', { text: 'Selectionnez 2 combattants disponibles (limitation : combats internes au roster, pas de systeme d’adversaires externes).' }));

    const available = this.gameState.playerState.roster.filter((f) => !f.isInjured(this.gameState.worldState.currentDay));
    if (available.length < 2) {
      panel.appendChild(el('p', { text: 'Pas assez de combattants disponibles (non blesses).' }));
      return;
    }

    for (const fighter of available) {
      const selected = this.selectedFighterIds.includes(fighter.identity.id);
      const card = el('div', {
        class: `fighter-card selectable${selected ? ' selected' : ''}`,
        onclick: () => this._toggleFighterSelection(fighter.identity.id),
      });
      card.appendChild(
        el('div', { class: 'fighter-head' }, [
          el('div', {}, [
            el('div', { class: 'fighter-name', text: fighter.identity.name + (fighter.identity.nickname ? ` "${fighter.identity.nickname}"` : '') }),
            el('div', { class: 'fighter-meta', text: `${fighter.identity.style} — ${fighter.getRecordString()}` }),
          ]),
        ])
      );
      card.appendChild(gaugeRow('Readiness', fighter.getReadiness()));
      panel.appendChild(card);
    }

    panel.appendChild(
      el('button', {
        class: 'btn btn-gold btn-block',
        text: 'Lancer le combat',
        disabled: this.selectedFighterIds.length === 2 ? null : 'disabled',
        onclick: () => this._startFight(),
      })
    );
  }

  _toggleFighterSelection(fighterId) {
    if (this.selectedFighterIds.includes(fighterId)) {
      this.selectedFighterIds = this.selectedFighterIds.filter((id) => id !== fighterId);
    } else if (this.selectedFighterIds.length < 2) {
      this.selectedFighterIds = [...this.selectedFighterIds, fighterId];
    }
    this._renderFight();
  }

  _startFight() {
    const [idA, idB] = this.selectedFighterIds;
    const fighterA = this.gameState.playerState.getFighter(idA);
    const fighterB = this.gameState.playerState.getFighter(idB);
    this.fightView = new FightNightView({ combatEngine: this.combatEngine });
    this.fightCard = this.fightView.presentMatchup(fighterA, fighterB, 'WFC', false);
    this.fightSetupDone = false;
    this.gameplanChoices = { A: {}, B: {} };
    this.weightCutChoices = { A: 'NATUREL', B: 'NATUREL' };
    this._renderFight();
  }

  _renderFightSetup(panel) {
    panel.appendChild(el('h2', { class: 'section-title', text: '\u{1F94A} Preparation du combat' }));
    panel.appendChild(el('pre', { class: 'card', style: 'white-space:pre-wrap;font-family:inherit;font-size:13px;', text: this.fightView.toCardText() }));

    for (const [key, label] of [['A', this.fightCard?.fighterA?.name ?? 'Coin A'], ['B', this.fightCard?.fighterB?.name ?? 'Coin B']]) {
      const card = el('div', { class: 'card' }, [el('div', { class: 'card-title', text: `Coin ${key} — ${label}` })]);

      card.appendChild(el('p', { class: 'fighter-meta', text: 'Coupe de poids' }));
      card.appendChild(
        el(
          'div',
          { class: 'slot-row' },
          Object.keys(WEIGHT_CUT_LABELS).map((profileKey) =>
            el('button', {
              class: `activity-chip${this.weightCutChoices[key] === profileKey ? ' selected' : ''}`,
              text: WEIGHT_CUT_LABELS[profileKey],
              onclick: () => {
                this.weightCutChoices = { ...this.weightCutChoices, [key]: profileKey };
                this._renderFight();
              },
            })
          )
        )
      );

      card.appendChild(el('p', { class: 'fighter-meta', text: 'Cible' }));
      card.appendChild(this._gameplanChipRow(key, 'target', TARGET_LABELS));
      card.appendChild(el('p', { class: 'fighter-meta', text: 'Distance' }));
      card.appendChild(this._gameplanChipRow(key, 'distance', DISTANCE_LABELS));
      card.appendChild(el('p', { class: 'fighter-meta', text: 'Tempo' }));
      card.appendChild(this._gameplanChipRow(key, 'tempo', TEMPO_LABELS));

      panel.appendChild(card);
    }

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
    this.combatEngine.selectWeightCutProfile('B', this.weightCutChoices.B);
    this.fightView.setGameplans({ A: this.gameplanChoices.A, B: this.gameplanChoices.B });
    this.fightSetupDone = true;
    this._renderFight();
  }

  _renderFightInProgress(panel) {
    panel.appendChild(el('h2', { class: 'section-title', text: '\u{1F94A} Combat en cours' }));
    panel.appendChild(el('pre', { class: 'card', style: 'white-space:pre-wrap;font-family:inherit;font-size:13px;', text: this.fightView.toCardText() }));

    for (const round of this.fightView.getRoundLogs()) {
      panel.appendChild(
        el('div', { class: 'round-log' }, [
          el('div', { class: 'round-log-header', text: `Round ${round.round} — Degats A ${round.damageDealt.A} / B ${round.damageDealt.B}` }),
          gaugeRow('Vie A', round.healthAfter.A),
          gaugeRow('Vie B', round.healthAfter.B),
          gaugeRow('Stamina A', round.staminaAfter.A),
          gaugeRow('Stamina B', round.staminaAfter.B),
        ])
      );
    }

    const controls = el('div', { class: 'slot-row' }, [
      el('button', { class: 'btn btn-gold', text: 'Round suivant ▶️', onclick: () => this._advanceFightRound() }),
      el('button', { class: 'btn btn-outline', text: '⏩ Simuler jusqu’au bout', onclick: () => this._simulateFightToEnd() }),
    ]);
    panel.appendChild(controls);
  }

  _advanceFightRound() {
    const step = this.fightView.advanceOneRound();
    if (step.finished) {
      this.fightResultsThisYear.push(this.combatEngine.getSnapshot().result);
      this._autosave();
    }
    this._renderFight();
  }

  _simulateFightToEnd() {
    this.fightView.simulateToCompletion();
    this.fightResultsThisYear.push(this.combatEngine.getSnapshot().result);
    this._autosave();
    this._renderFight();
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

    panel.appendChild(el('h3', { class: 'section-title', text: 'Rounds' }));
    for (const round of this.fightView.getRoundLogs()) {
      panel.appendChild(
        el('div', { class: 'round-log' }, [
          el('div', { class: 'round-log-header', text: `Round ${round.round} — Degats A ${round.damageDealt.A} / B ${round.damageDealt.B}` }),
        ])
      );
    }

    panel.appendChild(
      el('button', {
        class: 'btn btn-gold btn-block',
        text: 'Nouveau combat',
        onclick: () => {
          this.selectedFighterIds = [];
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
      ])
    );

    if (this.journalTab === 'social') {
      this._renderSocialFeed(panel);
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
      this._showToast(`\u{1F393} ${chosenFighter.identity.name} rejoint votre effectif (draft academie).`);
    }
    playerState.recordAcademyDraftOffer(worldState.year);
    this.academyPool = [];
    this._hideModal();
    this._renderAll();
    this._autosave();
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
