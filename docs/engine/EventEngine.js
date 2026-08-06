/**
 * engine/EventEngine.js
 * ---------------------------------------------------------------------------
 * Weekly narrative event generator: the "soul" layer. Once a week (driven by
 * ProgressionEngine.advanceWeek), rolls whether a random story beat happens
 * — a sponsor offer, a sparring injury, a media clash, a doping control, a
 * fighter's mood swinging, or an alumni donation — and applies its effect
 * directly to State through existing PlayerState/Fighter mutation methods.
 *
 * At most one event fires per week, matching a light "news ticker" pace
 * rather than overwhelming the player. All chances/amounts come from
 * BALANCE.NARRATIVE_EVENTS; only the narrative copy (headlines) lives here,
 * since flavor text isn't a balance number.
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

/** Event names published on EventBus by EventEngine. Import instead of raw strings. */
export const EVENT_ENGINE_EVENTS = Object.freeze({
  TRIGGERED: 'event:triggered',
});

let idCounter = 0;
function generateId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function randomInRange(rng, min, max) {
  return min + rng() * (max - min);
}

function pickWeightedCategory(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [category, weight] of entries) {
    if (roll < weight) return category;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

function pickRandomFighter(rng, roster) {
  if (!roster || roster.length === 0) return null;
  return roster[Math.floor(rng() * roster.length)];
}

function rollWeightedSeverity(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [severity, weight] of entries) {
    if (roll < weight) return severity;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

function handleSponsorOffer(gameState, rng) {
  const cfg = BALANCE.NARRATIVE_EVENTS.SPONSOR_OFFER;
  const amount = Math.round(randomInRange(rng, cfg.MIN_AMOUNT, cfg.MAX_AMOUNT));

  gameState.playerState.changeMoney(amount, 'NARRATIVE_EVENT:SPONSOR_OFFER');
  gameState.playerState.changeHype(cfg.HYPE_BONUS, 'NARRATIVE_EVENT:SPONSOR_OFFER');

  return {
    category: 'SPONSOR_OFFER',
    headline: 'Un sponsor local investit dans votre salle.',
    detail: `+${amount}$ et un coup de projecteur bienvenu.`,
    amount,
  };
}

function handleSparringInjury(gameState, rng) {
  const fighter = pickRandomFighter(rng, gameState.playerState.roster);
  if (!fighter) return null;

  const severity = rollWeightedSeverity(rng, BALANCE.INJURIES.SEVERITY_WEIGHTS);
  const bodyPart = BALANCE.INJURIES.BODY_PARTS[Math.floor(rng() * BALANCE.INJURIES.BODY_PARTS.length)];
  const dayAnchor = gameState.worldState.currentDay;
  const injury = {
    severity,
    bodyPart,
    occurredOnDay: dayAnchor,
    injuredUntilDay: dayAnchor + BALANCE.INJURIES.RECOVERY_DAYS[severity],
  };

  fighter.applyInjury(injury);
  fighter.adjustMorale(BALANCE.MORALE.EVENTS.INJURY_SUSTAINED);

  return {
    category: 'SPARRING_INJURY',
    fighterId: fighter.identity.id,
    headline: `${fighter.identity.name} se blesse a l'entrainement (${bodyPart}).`,
    detail: `Indisponible jusqu'au jour ${injury.injuredUntilDay}.`,
    severity,
  };
}

function handleMediaClash(gameState, rng) {
  const fighter = pickRandomFighter(rng, gameState.playerState.roster);
  if (!fighter) return null;

  const cfg = BALANCE.NARRATIVE_EVENTS.MEDIA_CLASH;
  const moraleDelta = Math.round(randomInRange(rng, cfg.MORALE_DELTA_MIN, cfg.MORALE_DELTA_MAX));
  const reputationDelta = Math.round(randomInRange(rng, cfg.REPUTATION_DELTA_MIN, cfg.REPUTATION_DELTA_MAX));

  fighter.adjustMorale(moraleDelta);
  gameState.playerState.changeReputation(reputationDelta, 'NARRATIVE_EVENT:MEDIA_CLASH');

  const tone = moraleDelta >= 0 ? 'un coup d\'eclat' : 'une polemique';
  return {
    category: 'MEDIA_CLASH',
    fighterId: fighter.identity.id,
    headline: `${fighter.identity.name} fait parler de lui/elle dans les medias : ${tone}.`,
    detail: `Moral ${moraleDelta >= 0 ? '+' : ''}${moraleDelta}, reputation du gym ${reputationDelta >= 0 ? '+' : ''}${reputationDelta}.`,
    moraleDelta,
    reputationDelta,
  };
}

function handleDopingControl(gameState, rng) {
  const fighter = pickRandomFighter(rng, gameState.playerState.roster);
  if (!fighter) return null;

  const cfg = BALANCE.NARRATIVE_EVENTS.DOPING_CONTROL;
  const failed = rng() < cfg.FAIL_CHANCE;

  if (!failed) {
    return {
      category: 'DOPING_CONTROL',
      fighterId: fighter.identity.id,
      headline: `${fighter.identity.name} passe un controle antidopage inopine : test negatif.`,
      detail: 'Rien a signaler.',
      failed: false,
    };
  }

  fighter.adjustMorale(cfg.MORALE_PENALTY);
  gameState.playerState.changeReputation(cfg.REPUTATION_PENALTY, 'NARRATIVE_EVENT:DOPING_CONTROL_FAILED');

  return {
    category: 'DOPING_CONTROL',
    fighterId: fighter.identity.id,
    headline: `${fighter.identity.name} est controle positif lors d'un test antidopage.`,
    detail: `Scandale : reputation ${cfg.REPUTATION_PENALTY}, moral ${cfg.MORALE_PENALTY}.`,
    failed: true,
  };
}

function handleMoraleSwing(gameState, rng) {
  const fighter = pickRandomFighter(rng, gameState.playerState.roster);
  if (!fighter) return null;

  const cfg = BALANCE.NARRATIVE_EVENTS.MORALE_SWING;
  const delta = Math.round(randomInRange(rng, cfg.MIN_DELTA, cfg.MAX_DELTA));
  fighter.adjustMorale(delta);

  const headline =
    delta >= 0
      ? `${fighter.identity.name} arrive motive(e) a la salle cette semaine.`
      : `${fighter.identity.name} semble contrarie(e) ces derniers jours.`;

  return {
    category: 'MORALE_SWING',
    fighterId: fighter.identity.id,
    headline,
    detail: `Moral ${delta >= 0 ? '+' : ''}${delta}.`,
    delta,
  };
}

function handleAlumniDonation(gameState, rng) {
  const cfg = BALANCE.NARRATIVE_EVENTS.ALUMNI_DONATION;
  const amount = Math.round(randomInRange(rng, cfg.MIN_AMOUNT, cfg.MAX_AMOUNT));

  gameState.playerState.changeMoney(amount, 'NARRATIVE_EVENT:ALUMNI_DONATION');
  gameState.playerState.changeReputation(cfg.REPUTATION_BONUS, 'NARRATIVE_EVENT:ALUMNI_DONATION');

  return {
    category: 'ALUMNI_DONATION',
    headline: "Un ancien combattant de la salle fait un don genereux.",
    detail: `+${amount}$ pour le club.`,
    amount,
  };
}

const CATEGORY_HANDLERS = Object.freeze({
  SPONSOR_OFFER: handleSponsorOffer,
  SPARRING_INJURY: handleSparringInjury,
  MEDIA_CLASH: handleMediaClash,
  DOPING_CONTROL: handleDopingControl,
  MORALE_SWING: handleMoraleSwing,
  ALUMNI_DONATION: handleAlumniDonation,
});

/**
 * Rolls for (and, if triggered, applies) this week's narrative event.
 *
 * @param {Object} gameState - A GameState instance (uses .playerState and .worldState).
 * @param {Object} [options]
 * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
 * @returns {{ triggered: Object[] }} Zero or one triggered event record.
 */
export function evaluateWeeklyEvents(gameState, options = {}) {
  const rng = options.rng ?? Math.random;
  const cfg = BALANCE.NARRATIVE_EVENTS;

  if (rng() >= cfg.WEEKLY_TRIGGER_CHANCE) {
    return { triggered: [] };
  }

  const category = pickWeightedCategory(rng, cfg.CATEGORY_WEIGHTS);
  const handler = CATEGORY_HANDLERS[category];
  const event = handler ? handler(gameState, rng) : null;

  if (!event) {
    return { triggered: [] };
  }

  const record = {
    id: generateId('narrative'),
    day: gameState.worldState.currentDay,
    ...event,
  };

  gameState.worldState.addGlobalEvent({
    type: 'NARRATIVE_EVENT',
    category: record.category,
    narrativeEventId: record.id,
  });

  EventBus.publish(EVENT_ENGINE_EVENTS.TRIGGERED, record);

  return { triggered: [record] };
}
