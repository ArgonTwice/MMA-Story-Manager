/**
 * data/events.js
 * ---------------------------------------------------------------------------
 * Phase 3.2 ("Simulation Drama Engine"): declarative catalog of systemic
 * weekly drama events, consumed by engine/DramaEngine.js. Every number that
 * affects balance lives here, same "zero magic numbers" rule as
 * data/balance.js — DramaEngine.js only interprets these structures, it
 * never hardcodes an event's own conditions/weights/effects.
 *
 * Each event is a plain object:
 *   {
 *     id           - unique string key. Never shown to the player directly —
 *                    see `title`/`description` below (ui/WeeklyFlowController.js
 *                    ('_buildDramaPrompt') and web/app.js's drama modal
 *                    ('_showDramaModal') surface those instead, so the UI
 *                    never leaks a raw id like "DOCUMENTARY_FEATURE").
 *     title        - short French narrative headline shown in the drama modal.
 *     description  - one-sentence French context/flavor shown under the title.
 *     category     - one of EVENT_CATEGORIES below (Fighter Stories, Media
 *                    Engine, Sponsors/Marche Noir, Rivalites, Gym Life).
 *     baseChance   - the "BaseChance" term of EventWeight = BaseChance *
 *                    Context * FighterTraits * WorldState (see
 *                    DramaEngine#computeEventWeight) — a relative weight
 *                    among eligible events, not an independent probability.
 *     conditions   - array of small declarative eligibility checks (see
 *                    DramaEngine#CONDITION_EVALUATORS), ALL must pass.
 *     weightSignals - array of { signal, scale } pairs feeding the
 *                    Context/FighterTraits/WorldState multipliers (see
 *                    DramaEngine#SIGNAL_EVALUATORS) — order-independent,
 *                    their multipliers are multiplied together.
 *     choices      - array of { id, label, effects, personalityLean }.
 *       effects        - array of { type, target, amount } (see
 *                        DramaEngine#EFFECT_APPLIERS for the vocabulary).
 *       personalityLean - optional { dimension, scale } biasing how often
 *                        the headless bot AI picks this choice (see
 *                        computeCombinedModifiers's 4 dimensions) — a choice
 *                        without one always carries a flat pick-weight of 1.
 *   }
 *
 * Every event features one roster fighter (picked by DramaEngine before
 * resolving conditions/weights/effects) as its "protagonist" — even the
 * gym-level events (Sponsors, Gym Life) since PlayerState-level effects
 * still need *someone* to react personally to the news, matching how the
 * pre-existing engine/EventEngine.js already treats every category.
 * ---------------------------------------------------------------------------
 */

export const EVENT_CATEGORIES = Object.freeze({
  FIGHTER_STORY: 'FIGHTER_STORY',
  MEDIA_ENGINE: 'MEDIA_ENGINE',
  SPONSORS_MARCHE_NOIR: 'SPONSORS_MARCHE_NOIR',
  RIVALRIES: 'RIVALRIES',
  GYM_LIFE: 'GYM_LIFE',
});

export const DRAMA_EVENTS = Object.freeze([
  Object.freeze({
    id: 'BREAKTHROUGH_SESSION',
    title: 'Seance Revelation',
    description: 'Une seance d\'entrainement ou tout semble soudain plus facile — la percee technique que tout combattant espere.',
    category: EVENT_CATEGORIES.FIGHTER_STORY,
    baseChance: 1.0,
    conditions: [{ type: 'NOT_INJURED' }],
    weightSignals: [{ signal: 'PERSONALITY_PROGRESSION', scale: 1 }],
    choices: [
      {
        id: 'CAPITALIZE',
        label: 'Capitaliser publiquement sur la percee',
        effects: [
          { type: 'CHANGE_REPUTATION', amount: 1 },
          { type: 'CHANGE_HYPE', amount: 2 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 6 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 4 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'STAY_FOCUSED',
        label: 'Rester concentre, sans en faire une histoire',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 8 },
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: -3 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'INJURY_SCARE',
    title: 'Alerte Physique',
    description: 'Une douleur inhabituelle inquiete le staff medical apres l\'entrainement.',
    category: EVENT_CATEGORIES.FIGHTER_STORY,
    baseChance: 0.6,
    conditions: [{ type: 'NOT_INJURED' }],
    weightSignals: [{ signal: 'PERSONALITY_MORALE_VOLATILITY', scale: 0.5 }],
    choices: [
      {
        id: 'GET_CHECKED',
        label: 'Se faire examiner par precaution',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: -10 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 5 },
        ],
      },
      {
        id: 'SHRUG_IT_OFF',
        label: 'Hausser les epaules et continuer',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 4 },
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: 5 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
    ],
  }),
  Object.freeze({
    id: 'PERSONAL_SETBACK',
    title: 'Coup Dur Personnel',
    description: 'Des soucis en dehors du tapis pesent sur le moral du combattant.',
    category: EVENT_CATEGORIES.FIGHTER_STORY,
    baseChance: 0.8,
    conditions: [],
    weightSignals: [{ signal: 'PERSONALITY_MORALE_VOLATILITY', scale: 1 }],
    choices: [
      {
        id: 'TAKE_TIME_OFF',
        label: 'Prendre du recul, souffler',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: -15 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: -15 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -3 },
        ],
      },
      {
        id: 'PUSH_THROUGH',
        label: 'Serrer les dents et continuer',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -10 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 5 },
        ],
        personalityLean: { dimension: 'progressionMultiplier', scale: 1 },
      },
    ],
  }),
  Object.freeze({
    id: 'VIRAL_INTERVIEW',
    title: 'Interview qui Buzz',
    description: 'Un media sportif sollicite une interview qui pourrait faire parler.',
    category: EVENT_CATEGORIES.MEDIA_ENGINE,
    baseChance: 1.0,
    conditions: [{ type: 'NOT_INJURED' }],
    weightSignals: [
      { signal: 'HYPE', scale: 1 },
      { signal: 'PERSONALITY_MORALE_VOLATILITY', scale: 0.5 },
    ],
    choices: [
      {
        id: 'PLAY_HEEL',
        label: 'Jouer les provocateurs face aux cameras',
        effects: [
          { type: 'CHANGE_HYPE', amount: 6 },
          { type: 'CHANGE_REPUTATION', amount: 1 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 8 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -2 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1.5 },
      },
      {
        id: 'STAY_HUMBLE',
        label: 'Rester humble et mesure',
        effects: [
          { type: 'CHANGE_HYPE', amount: 2 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 5 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'PRESS_CONTROVERSY',
    title: 'Polemique Mediatique',
    description: 'Des propos mal interpretes enflamment la presse specialisee.',
    category: EVENT_CATEGORIES.MEDIA_ENGINE,
    baseChance: 0.7,
    conditions: [],
    weightSignals: [{ signal: 'HYPE', scale: 0.5 }],
    choices: [
      {
        id: 'CLAP_BACK',
        label: 'Repondre publiquement a la polemique',
        effects: [
          { type: 'CHANGE_HYPE', amount: 4 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 10 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -3 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'IGNORE',
        label: 'Ignorer et laisser passer',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 2 }],
      },
    ],
  }),
  Object.freeze({
    id: 'DOCUMENTARY_FEATURE',
    title: 'Portrait Documentaire',
    description: 'Une equipe de tournage propose de suivre le combattant pour un portrait intimiste.',
    category: EVENT_CATEGORIES.MEDIA_ENGINE,
    baseChance: 0.5,
    conditions: [{ type: 'NOT_INJURED' }],
    weightSignals: [{ signal: 'HYPE', scale: 0.8 }],
    choices: [
      {
        id: 'OPEN_UP',
        label: 'Se livrer devant les cameras',
        effects: [
          { type: 'CHANGE_HYPE', amount: 8 },
          { type: 'CHANGE_REPUTATION', amount: 2 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 10 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 5 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'KEEP_PRIVATE',
        label: 'Garder sa vie privee',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 2 }],
      },
    ],
  }),
  Object.freeze({
    id: 'SPONSOR_OFFER',
    title: 'Offre de Sponsoring',
    description: 'Une marque propose un contrat de sponsoring pour ce combattant.',
    category: EVENT_CATEGORIES.SPONSORS_MARCHE_NOIR,
    baseChance: 1.0,
    conditions: [],
    weightSignals: [{ signal: 'PERSONALITY_SALARY_DEMAND', scale: 1 }],
    choices: [
      {
        id: 'ACCEPT',
        label: 'Accepter le contrat de sponsoring',
        effects: [
          { type: 'CHANGE_MONEY', amount: 800 },
          { type: 'CHANGE_REPUTATION', amount: 1 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 6 },
        ],
        personalityLean: { dimension: 'salaryDemandMultiplier', scale: 1 },
      },
      {
        id: 'DECLINE',
        label: 'Refuser, garder son integrite',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 4 }],
      },
    ],
  }),
  Object.freeze({
    id: 'SHADY_SUPPLEMENT_OFFER',
    title: 'Complement Douteux',
    description: 'Un inconnu propose un complement au marche noir, promettant une recuperation express.',
    category: EVENT_CATEGORIES.SPONSORS_MARCHE_NOIR,
    baseChance: 0.5,
    conditions: [{ type: 'NOT_INJURED' }],
    weightSignals: [{ signal: 'MONEY_SCARCITY', scale: 1 }],
    choices: [
      {
        id: 'ACCEPT',
        label: 'Accepter le complement du marche noir',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: -20 },
          { type: 'CHANGE_REPUTATION', amount: -3 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -2 },
        ],
        personalityLean: { dimension: 'salaryDemandMultiplier', scale: 1 },
      },
      {
        id: 'REFUSE',
        label: 'Refuser, rester propre',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 3 }],
      },
    ],
  }),
  Object.freeze({
    id: 'MERCHANDISE_DEAL',
    title: 'Accord Merchandising',
    description: 'Une opportunite de vendre des produits derives a l\'effigie du combattant se presente.',
    category: EVENT_CATEGORIES.SPONSORS_MARCHE_NOIR,
    baseChance: 0.6,
    conditions: [],
    weightSignals: [{ signal: 'HYPE', scale: 0.6 }],
    choices: [
      {
        id: 'SIGN',
        label: 'Signer l\'accord de merchandising',
        effects: [
          { type: 'CHANGE_MONEY', amount: 500 },
          { type: 'CHANGE_HYPE', amount: 3 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 3 },
        ],
        personalityLean: { dimension: 'salaryDemandMultiplier', scale: 1 },
      },
      {
        id: 'PASS',
        label: 'Decliner l\'offre',
        effects: [],
      },
    ],
  }),
  Object.freeze({
    id: 'TRASH_TALK_CHALLENGE',
    title: 'Provocation Rivale',
    description: 'Un gym rival lance une pique publique pour faire monter la pression.',
    category: EVENT_CATEGORIES.RIVALRIES,
    baseChance: 0.9,
    conditions: [{ type: 'HAS_RIVAL_GYMS' }],
    weightSignals: [
      { signal: 'RIVAL_GYM_COUNT', scale: 1 },
      { signal: 'PERSONALITY_MORALE_VOLATILITY', scale: 0.5 },
    ],
    choices: [
      {
        id: 'CLAP_BACK',
        label: 'Repondre a la provocation du rival',
        effects: [
          { type: 'CHANGE_HYPE', amount: 5 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 3 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 7 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'STAY_PROFESSIONAL',
        label: 'Rester professionnel, ne pas mordre a l’hameçon',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 6 },
          { type: 'CHANGE_REPUTATION', amount: 1 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'POACHING_ATTEMPT',
    title: 'Tentative de Debauchage',
    description: 'Un gym concurrent tente de debaucher discretement ce combattant.',
    category: EVENT_CATEGORIES.RIVALRIES,
    baseChance: 0.5,
    conditions: [{ type: 'HAS_RIVAL_GYMS' }, { type: 'MIN_MONEY', amount: 1000 }],
    weightSignals: [{ signal: 'RIVAL_GYM_COUNT', scale: 1 }],
    choices: [
      {
        id: 'COUNTER_OFFER',
        label: 'Contre-offrir pour le retenir',
        effects: [
          { type: 'CHANGE_MONEY', amount: -600 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 8 },
        ],
        personalityLean: { dimension: 'salaryDemandMultiplier', scale: 1 },
      },
      {
        id: 'LET_GO',
        label: 'Ne pas surencherir',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -6 },
          { type: 'CHANGE_REPUTATION', amount: -1 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'PUBLIC_CALLOUT',
    title: 'Callout Public',
    description: 'Un rival interpelle publiquement ce combattant pour provoquer un affrontement.',
    category: EVENT_CATEGORIES.RIVALRIES,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_RIVAL_GYMS' }],
    weightSignals: [{ signal: 'RIVAL_GYM_COUNT', scale: 0.8 }],
    choices: [
      {
        id: 'FIRE_BACK',
        label: 'Repondre publiquement au callout',
        effects: [
          { type: 'CHANGE_HYPE', amount: 6 },
          { type: 'CHANGE_REPUTATION', amount: -1 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 4 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'STAY_SILENT',
        label: 'Garder le silence',
        effects: [{ type: 'CHANGE_REPUTATION', amount: 1 }],
      },
    ],
  }),
  Object.freeze({
    id: 'EQUIPMENT_OPPORTUNITY',
    title: 'Opportunite Materielle',
    description: 'Un fournisseur propose du materiel d\'entrainement a prix avantageux.',
    category: EVENT_CATEGORIES.GYM_LIFE,
    baseChance: 0.6,
    conditions: [{ type: 'MIN_MONEY', amount: 1500 }],
    weightSignals: [{ signal: 'ROSTER_SIZE', scale: 0.5 }],
    choices: [
      {
        id: 'INVEST',
        label: 'Investir dans du nouveau materiel',
        effects: [
          { type: 'CHANGE_MONEY', amount: -1200 },
          { type: 'CHANGE_REPUTATION', amount: 2 },
          { type: 'CHANGE_HYPE', amount: 2 },
        ],
      },
      {
        id: 'WAIT',
        label: 'Attendre une meilleure occasion',
        effects: [],
      },
    ],
  }),
  Object.freeze({
    id: 'TEAMMATE_CONFLICT',
    title: 'Tension au Vestiaire',
    description: 'Une friction eclate entre deux membres du roster.',
    category: EVENT_CATEGORIES.GYM_LIFE,
    baseChance: 0.8,
    conditions: [{ type: 'MIN_ROSTER_SIZE', amount: 2 }],
    weightSignals: [{ signal: 'ROSTER_SIZE', scale: 1 }],
    choices: [
      {
        id: 'INTERVENE',
        label: 'Intervenir pour apaiser le vestiaire',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 5 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 4 },
        ],
      },
      {
        id: 'LET_IT_PLAY_OUT',
        label: 'Laisser la situation se resoudre seule',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: -4 }],
        personalityLean: { dimension: 'progressionMultiplier', scale: 1 },
      },
    ],
  }),
  // ---------------------------------------------------------------------
  // Phase 4.6 ("Fighters with Soul"): one event per trait (20 total),
  // each gated by { type: 'HAS_TRAIT', trait: '<TraitKey>' } so it can
  // only ever be selected for the week's randomly-featured fighter when
  // THEY happen to carry that exact trait — combined with at least one
  // contextual condition/weightSignal, matching the spec's "Traits +
  // Contexte" pairing. Several exercise the new ADJUST_LOYALTY effect
  // (Fighter#adjustLoyalty) so the relationship/loyalty gauge is actually
  // moved by real gameplay, not just displayed.
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'PROFESSIONAL_CONSISTENCY',
    title: 'Metronome du Gym',
    description: 'Sa regularite exemplaire a l\'entrainement ne passe pas inapercue.',
    category: EVENT_CATEGORIES.FIGHTER_STORY,
    baseChance: 0.7,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Professionnel' }],
    weightSignals: [{ signal: 'PERSONALITY_PROGRESSION', scale: 0.5 }],
    choices: [
      {
        id: 'EMBRACE_ROUTINE',
        label: 'Assumer sa reputation de metronome',
        effects: [
          { type: 'CHANGE_REPUTATION', amount: 2 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 3 },
        ],
      },
      {
        id: 'STAY_QUIET',
        label: 'Rester discret sur sa methode',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 1 }],
      },
    ],
  }),
  Object.freeze({
    id: 'NIGHT_OUT_TEMPTATION',
    title: 'Tentation Nocturne',
    description: 'Une soiree s\'annonce, et la tentation de sortir est grande.',
    category: EVENT_CATEGORIES.GYM_LIFE,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Fetard' }],
    weightSignals: [{ signal: 'HYPE', scale: 0.5 }],
    choices: [
      {
        id: 'JOIN_THE_PARTY',
        label: 'Sortir faire la fete',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: 10 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 5 },
          { type: 'CHANGE_REPUTATION', amount: -1 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'STAY_IN',
        label: 'Rester au calme',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: -5 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 1 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'IMPULSIVE_CHALLENGE',
    title: 'Defi sur un Coup de Tete',
    description: 'Une provocation sur les reseaux pousse le combattant a reagir sans reflechir.',
    category: EVENT_CATEGORIES.RIVALRIES,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Impulsif' }, { type: 'HAS_RIVAL_GYMS' }],
    weightSignals: [{ signal: 'RIVAL_GYM_COUNT', scale: 1 }],
    choices: [
      {
        id: 'CALL_OUT_RIVAL',
        label: 'Defier un rival sur un coup de tete',
        effects: [
          { type: 'CHANGE_HYPE', amount: 5 },
          { type: 'CHANGE_REPUTATION', amount: -1 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 6 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'THINK_TWICE',
        label: 'Se raviser au dernier moment',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 2 }],
      },
    ],
  }),
  Object.freeze({
    id: 'PROVOCATEUR_STUNT',
    title: 'Coup d\'Eclat Mediatique',
    description: 'L\'occasion de faire un coup d\'eclat devant les cameras se presente.',
    category: EVENT_CATEGORIES.MEDIA_ENGINE,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Provocateur' }],
    weightSignals: [{ signal: 'HYPE', scale: 0.6 }],
    choices: [
      {
        id: 'PULL_THE_STUNT',
        label: 'Faire un coup d\'eclat devant les cameras',
        effects: [
          { type: 'CHANGE_HYPE', amount: 7 },
          { type: 'CHANGE_REPUTATION', amount: -2 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 5 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'PLAY_IT_SAFE',
        label: 'Jouer la carte de la sobriete',
        effects: [{ type: 'CHANGE_HYPE', amount: 2 }],
      },
    ],
  }),
  Object.freeze({
    id: 'EXTRA_MILE_SESSION',
    title: 'Session Supplementaire',
    description: 'Le combattant propose d\'ajouter une seance non prevue au programme.',
    category: EVENT_CATEGORIES.FIGHTER_STORY,
    baseChance: 0.7,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Discipline' }, { type: 'NOT_INJURED' }],
    weightSignals: [{ signal: 'PERSONALITY_PROGRESSION', scale: 0.8 }],
    choices: [
      {
        id: 'PUSH_EXTRA',
        label: 'Ajouter une session non prevue',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: 8 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 4 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 3 },
        ],
      },
      {
        id: 'KEEP_STANDARD',
        label: 'S\'en tenir au plan prevu',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 1 }],
      },
    ],
  }),
  Object.freeze({
    id: 'LOYALTY_TEST',
    title: 'Epreuve de Loyaute',
    description: 'Un gym rival teste l\'attachement du combattant envers votre salle.',
    category: EVENT_CATEGORIES.RIVALRIES,
    baseChance: 0.5,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Loyal' }, { type: 'HAS_RIVAL_GYMS' }],
    weightSignals: [{ signal: 'RIVAL_GYM_COUNT', scale: 1 }],
    choices: [
      {
        id: 'REAFFIRM_BOND',
        label: 'Reaffirmer publiquement son attachement au gym',
        effects: [
          { type: 'ADJUST_LOYALTY', target: 'fighter', amount: 15 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 5 },
        ],
      },
      {
        id: 'STAY_NONCOMMITTAL',
        label: 'Rester evasif sur son avenir',
        effects: [{ type: 'ADJUST_LOYALTY', target: 'fighter', amount: -5 }],
      },
    ],
  }),
  Object.freeze({
    id: 'ARROGANT_CALLOUT',
    title: 'Sortie Arrogante',
    description: 'Face aux critiques, le combattant est tente d\'en rajouter une couche.',
    category: EVENT_CATEGORIES.MEDIA_ENGINE,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Arrogant' }],
    weightSignals: [{ signal: 'HYPE', scale: 0.5 }],
    choices: [
      {
        id: 'DOUBLE_DOWN',
        label: 'En rajouter face aux critiques',
        effects: [
          { type: 'CHANGE_HYPE', amount: 6 },
          { type: 'CHANGE_REPUTATION', amount: -2 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 5 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'TONE_IT_DOWN',
        label: 'Se moderer, a contrecoeur',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -2 },
          { type: 'CHANGE_REPUTATION', amount: 1 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'HUMBLE_DEFLECTION',
    title: 'Modestie Assumee',
    description: 'Les eloges pleuvent, mais le combattant prefere les rediriger vers le staff.',
    category: EVENT_CATEGORIES.MEDIA_ENGINE,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Humble' }],
    weightSignals: [{ signal: 'HYPE', scale: 0.4 }],
    choices: [
      {
        id: 'CREDIT_THE_TEAM',
        label: 'Rediriger les eloges vers le staff',
        effects: [
          { type: 'CHANGE_REPUTATION', amount: 2 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 3 },
        ],
      },
      {
        id: 'TAKE_THE_SPOTLIGHT',
        label: 'Accepter les projecteurs, pour une fois',
        effects: [
          { type: 'CHANGE_HYPE', amount: 3 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -1 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'CHARITY_REQUEST',
    title: 'Sollicitation Caritative',
    description: 'Une association sollicite un don sur la bourse du combattant.',
    category: EVENT_CATEGORIES.SPONSORS_MARCHE_NOIR,
    baseChance: 0.5,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Genereux' }, { type: 'MIN_MONEY', amount: 500 }],
    weightSignals: [],
    choices: [
      {
        id: 'DONATE_PURSE',
        label: 'Faire un don sur sa propre bourse',
        effects: [
          { type: 'CHANGE_MONEY', amount: -400 },
          { type: 'CHANGE_REPUTATION', amount: 3 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 4 },
        ],
        personalityLean: { dimension: 'salaryDemandMultiplier', scale: 1 },
      },
      {
        id: 'DECLINE_POLITELY',
        label: 'Decliner poliment cette fois',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: -2 }],
      },
    ],
  }),
  Object.freeze({
    id: 'OVERTRAINING_RISK',
    title: 'Risque de Surentrainement',
    description: 'Le combattant pousse fort a l\'entrainement, peut-etre trop fort.',
    category: EVENT_CATEGORIES.FIGHTER_STORY,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Intense' }, { type: 'NOT_INJURED' }],
    weightSignals: [{ signal: 'PERSONALITY_PROGRESSION', scale: 0.5 }],
    choices: [
      {
        id: 'PUSH_THROUGH_PAIN',
        label: 'Continuer malgre les signaux d\'alerte',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: 15 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 5 },
        ],
      },
      {
        id: 'LISTEN_TO_BODY',
        label: 'Ecouter son corps et lever le pied',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: -10 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -2 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'ZEN_FOCUS',
    title: 'Concentration Zen',
    description: 'La pression mediatique monte, mais le combattant reste imperturbable.',
    category: EVENT_CATEGORIES.MEDIA_ENGINE,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Calme' }],
    weightSignals: [{ signal: 'HYPE', scale: 0.4 }],
    choices: [
      {
        id: 'STAY_COMPOSED',
        label: 'Rester impassible face a la pression',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 4 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: -5 },
        ],
      },
      {
        id: 'ENGAGE_ANYWAY',
        label: 'Se preter au jeu mediatique',
        effects: [
          { type: 'CHANGE_HYPE', amount: 2 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 6 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'TITLE_SHOT_DEMAND',
    title: 'Exigence de Standing',
    description: 'Le combattant juge le prochain combat propose indigne de son statut.',
    category: EVENT_CATEGORIES.GYM_LIFE,
    baseChance: 0.5,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Ambitieux' }],
    weightSignals: [{ signal: 'PERSONALITY_SALARY_DEMAND', scale: 0.5 }],
    choices: [
      {
        id: 'DEMAND_BIGGER_FIGHT',
        label: 'Refuser un combat juge indigne de son statut',
        effects: [
          { type: 'CHANGE_REPUTATION', amount: -2 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 6 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 4 },
        ],
        personalityLean: { dimension: 'salaryDemandMultiplier', scale: 1 },
      },
      {
        id: 'ACCEPT_ANYWAY',
        label: 'Accepter le combat malgre tout',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -5 },
          { type: 'CHANGE_REPUTATION', amount: 1 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'GRINDER_BREAKTHROUGH',
    title: 'Ethique de Bosseur',
    description: 'Le combattant veut enchainer les heures supplementaires a la salle.',
    category: EVENT_CATEGORIES.FIGHTER_STORY,
    baseChance: 0.7,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Travailleur' }, { type: 'NOT_INJURED' }],
    weightSignals: [{ signal: 'PERSONALITY_PROGRESSION', scale: 0.6 }],
    choices: [
      {
        id: 'LOG_EXTRA_HOURS',
        label: 'Enchainer les heures supplementaires',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: 10 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 3 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 5 },
        ],
      },
      {
        id: 'STICK_TO_PLAN',
        label: 'S\'en tenir au programme etabli',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 2 }],
      },
    ],
  }),
  Object.freeze({
    id: 'SKIPPED_SESSION',
    title: 'Seance Sechee',
    description: 'Le combattant a saute une session d\'entrainement sans prevenir.',
    category: EVENT_CATEGORIES.FIGHTER_STORY,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Paresseux' }, { type: 'NOT_INJURED' }],
    weightSignals: [],
    choices: [
      {
        id: 'LET_IT_SLIDE',
        label: 'Fermer les yeux, juste cette fois',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: -8 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 3 },
        ],
      },
      {
        id: 'CALL_THEM_OUT',
        label: 'Le recadrer devant le reste du groupe',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -6 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 4 },
          { type: 'ADJUST_LOYALTY', target: 'fighter', amount: -8 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'VIRAL_STUNT',
    title: 'Coup Viral',
    description: 'L\'occasion de tenter un coup mediatique risque mais tres visible se presente.',
    category: EVENT_CATEGORIES.MEDIA_ENGINE,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Frimeur' }],
    weightSignals: [{ signal: 'HYPE', scale: 0.6 }],
    choices: [
      {
        id: 'GO_VIRAL',
        label: 'Tenter le coup viral',
        effects: [
          { type: 'CHANGE_HYPE', amount: 10 },
          { type: 'CHANGE_REPUTATION', amount: -1 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 6 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
      {
        id: 'KEEP_IT_CLASSY',
        label: 'Rester sobre malgre l\'occasion',
        effects: [
          { type: 'CHANGE_HYPE', amount: 2 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 2 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'MEDIA_AVOIDANCE',
    title: 'Evitement Mediatique',
    description: 'Une interview est proposee, mais l\'exercice met le combattant mal a l\'aise.',
    category: EVENT_CATEGORIES.MEDIA_ENGINE,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Introverti' }],
    weightSignals: [{ signal: 'HYPE', scale: 0.3 }],
    choices: [
      {
        id: 'DECLINE_INTERVIEW',
        label: 'Decliner poliment l\'interview',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 5 },
          { type: 'CHANGE_HYPE', amount: -1 },
        ],
      },
      {
        id: 'FORCE_THROUGH_IT',
        label: 'S\'y plier malgre l\'inconfort',
        effects: [
          { type: 'CHANGE_HYPE', amount: 3 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 8 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -3 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'SPARRING_INCIDENT',
    title: 'Incident au Sparring',
    description: 'Une session de sparring degenere en echange trop intense.',
    category: EVENT_CATEGORIES.GYM_LIFE,
    baseChance: 0.6,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Agressif' }, { type: 'MIN_ROSTER_SIZE', amount: 2 }],
    weightSignals: [{ signal: 'ROSTER_SIZE', scale: 0.5 }],
    choices: [
      {
        id: 'EASE_OFF',
        label: 'Lever le pied avec son partenaire',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: -5 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -2 },
          { type: 'ADJUST_LOYALTY', target: 'fighter', amount: 3 },
        ],
      },
      {
        id: 'KEEP_GOING_HARD',
        label: 'Continuer a pleine intensite',
        effects: [
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: 12 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 5 },
          { type: 'ADJUST_LOYALTY', target: 'fighter', amount: -6 },
        ],
        personalityLean: { dimension: 'moraleVolatility', scale: 1 },
      },
    ],
  }),
  Object.freeze({
    id: 'LOCKER_ROOM_SPEECH',
    title: 'Discours du Vestiaire',
    description: 'Le combattant sent que le groupe a besoin d\'etre galvanise avant la semaine.',
    category: EVENT_CATEGORIES.GYM_LIFE,
    baseChance: 0.5,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Meneur' }, { type: 'MIN_ROSTER_SIZE', amount: 2 }],
    weightSignals: [{ signal: 'ROSTER_SIZE', scale: 0.5 }],
    choices: [
      {
        id: 'RALLY_THE_TEAM',
        label: 'Galvaniser le vestiaire avant la semaine',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 8 },
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 3 },
          { type: 'ADJUST_LOYALTY', target: 'fighter', amount: 10 },
        ],
      },
      {
        id: 'KEEP_TO_YOURSELF',
        label: 'Rester en retrait cette fois',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 1 }],
      },
    ],
  }),
  Object.freeze({
    id: 'TOXIC_FRICTION',
    title: 'Friction Toxique',
    description: 'Une tension malsaine s\'installe dans le vestiaire autour du combattant.',
    category: EVENT_CATEGORIES.GYM_LIFE,
    baseChance: 0.5,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Toxique' }, { type: 'MIN_ROSTER_SIZE', amount: 2 }],
    weightSignals: [{ signal: 'ROSTER_SIZE', scale: 0.5 }],
    choices: [
      {
        id: 'ADDRESS_THE_TENSION',
        label: 'Crever l\'abces en discutant franchement',
        effects: [
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 6 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 2 },
          { type: 'ADJUST_LOYALTY', target: 'fighter', amount: 5 },
        ],
      },
      {
        id: 'LET_IT_FESTER',
        label: 'Laisser la tension s\'installer',
        effects: [
          { type: 'ADJUST_MORALE', target: 'fighter', amount: -4 },
          { type: 'ADJUST_LOYALTY', target: 'fighter', amount: -10 },
        ],
      },
    ],
  }),
  Object.freeze({
    id: 'MENTORSHIP_MOMENT',
    title: 'Moment de Mentorat',
    description: 'Un jeune combattant du roster pourrait profiter de son experience.',
    category: EVENT_CATEGORIES.GYM_LIFE,
    baseChance: 0.5,
    conditions: [{ type: 'HAS_TRAIT', trait: 'Mentor' }, { type: 'MIN_ROSTER_SIZE', amount: 2 }],
    weightSignals: [{ signal: 'ROSTER_SIZE', scale: 0.5 }],
    choices: [
      {
        id: 'TAKE_PROSPECT_UNDER_WING',
        label: 'Prendre un jeune combattant sous son aile',
        effects: [
          { type: 'ADJUST_MENTAL_FATIGUE', target: 'fighter', amount: 5 },
          { type: 'ADJUST_MORALE', target: 'fighter', amount: 4 },
          { type: 'ADJUST_LOYALTY', target: 'fighter', amount: 8 },
        ],
      },
      {
        id: 'FOCUS_ON_SELF',
        label: 'Se concentrer sur sa propre carriere',
        effects: [{ type: 'ADJUST_MORALE', target: 'fighter', amount: 2 }],
      },
    ],
  }),
  Object.freeze({
    id: 'FACILITY_INSPECTION',
    title: 'Inspection des Installations',
    description: 'Un controle de securite souleve des questions sur l\'etat des installations.',
    category: EVENT_CATEGORIES.GYM_LIFE,
    baseChance: 0.5,
    conditions: [{ type: 'MIN_MONEY', amount: 800 }],
    weightSignals: [{ signal: 'ROSTER_SIZE', scale: 0.5 }],
    choices: [
      {
        id: 'UPGRADE_SAFETY',
        label: 'Ameliorer les protocoles de securite',
        effects: [
          { type: 'CHANGE_MONEY', amount: -700 },
          { type: 'ADJUST_PHYSICAL_FATIGUE', target: 'fighter', amount: -5 },
          { type: 'CHANGE_REPUTATION', amount: 1 },
        ],
      },
      {
        id: 'MINIMUM_COMPLIANCE',
        label: 'Faire le strict minimum',
        effects: [{ type: 'CHANGE_MONEY', amount: -100 }],
      },
    ],
  }),
]);
