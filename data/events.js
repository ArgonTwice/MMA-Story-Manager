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
 *     id           - unique string key.
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
    id: 'PERSONAL_SETBACK',
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
    id: 'SPONSOR_OFFER',
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
    id: 'TRASH_TALK_CHALLENGE',
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
    id: 'EQUIPMENT_OPPORTUNITY',
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
]);
