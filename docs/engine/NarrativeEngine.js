/**
 * engine/NarrativeEngine.js — Pyramide Emergente, Niveau 2 (conteur)
 * ---------------------------------------------------------------------------
 * Listens for story:opportunity_detected and decides HOW to tell that
 * story: which narrative form fits (Declaration, Interview, Incident,
 * Viral Post, Contract Breach), generates the French flavor text, and
 * dispatches it — social-flavored forms land on PlayerState.socialFeed
 * (the same surface SocialEngine writes to — a peer, not a dependency),
 * more official/behind-the-scenes forms land in WorldState.globalEvents
 * (the world journal).
 *
 * Every dispatched beat also publishes narrative:published, carrying a
 * `tone` field. RelationshipEngine listens for tone === 'PROVOCATION' to
 * close the emergent loop: a narrative beat can itself deepen a rivalry's
 * tension, which StoryEngine may later read to detect the *next*
 * opportunity — "les histoires emergent des interactions."
 *
 * Absolute decoupling: imports only core/EventBus.js and data/balance.js.
 * story:opportunity_detected is subscribed to as a raw string literal (no
 * import of StoryEngine.js).
 * ---------------------------------------------------------------------------
 */

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';

/** Event names published on EventBus by NarrativeEngine. Import instead of raw strings. */
export const NARRATIVE_ENGINE_EVENTS = Object.freeze({
  PUBLISHED: 'narrative:published',
});

/** Narrative forms this engine can choose between — see BALANCE.NARRATIVE.FORM_WEIGHTS_BY_OPPORTUNITY. */
export const NARRATIVE_FORMS = Object.freeze({
  DECLARATION: 'DECLARATION',
  INTERVIEW: 'INTERVIEW',
  INCIDENT: 'INCIDENT',
  VIRAL_POST: 'VIRAL_POST',
  CONTRACT_BREACH: 'CONTRACT_BREACH',
});

/** Forms that only ever involve two adversarial entities and thus can be tagged as a provocation. */
const ADVERSARIAL_OPPORTUNITY_TYPES = Object.freeze(['CONFLICT_POTENTIAL', 'RIVALRY_IGNITED']);

let idCounter = 0;
function generateId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function pickWeightedForm(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [form, weight] of entries) {
    if (roll < weight) return form;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

function resolveName(context, entityId, fallback) {
  return context.names?.[entityId] ?? fallback;
}

/**
 * Builds the French, third-person headline for one (opportunity type, form)
 * combination. Pure text generation — no state mutation.
 */
function buildHeadline(opportunityType, form, primaryName, secondaryName) {
  switch (`${opportunityType}:${form}`) {
    case 'CONFLICT_POTENTIAL:DECLARATION':
      return `${primaryName} promet de se venger apres sa defaite face a ${secondaryName}.`;
    case 'CONFLICT_POTENTIAL:INTERVIEW':
      return `Un journaliste s'interroge sur la rivalite naissante entre ${primaryName} et ${secondaryName}.`;
    case 'CONFLICT_POTENTIAL:INCIDENT':
      return `Tension palpable dans les coulisses entre ${primaryName} et ${secondaryName} apres leur combat.`;

    case 'RIVALRY_IGNITED:DECLARATION':
      return `${primaryName} declare que ${secondaryName} n'a encore rien vu.`;
    case 'RIVALRY_IGNITED:INTERVIEW':
      return `Analyse : une veritable rivalite est nee entre ${primaryName} et ${secondaryName}.`;
    case 'RIVALRY_IGNITED:VIRAL_POST':
      return `Le clash entre ${primaryName} et ${secondaryName} enflamme les reseaux sociaux.`;

    case 'UPSET_VICTORY:VIRAL_POST':
      return `Enorme upset : ${primaryName} renverse ${secondaryName} !`;
    case 'UPSET_VICTORY:INTERVIEW':
      return `Analyse : personne n'avait vu venir la victoire de ${primaryName} face a ${secondaryName}.`;

    case 'FINANCIAL_DISCONTENT:INCIDENT':
      return `${primaryName} exprime son mecontentement face aux difficultes financieres de la salle.`;
    case 'FINANCIAL_DISCONTENT:CONTRACT_BREACH':
      return `${primaryName} menace de rompre son contrat si la situation financiere ne s'ameliore pas.`;
    case 'FINANCIAL_DISCONTENT:DECLARATION':
      return `${primaryName} declare publiquement son inquietude sur l'avenir de la salle.`;

    default:
      return `${primaryName} fait parler de lui/elle.`;
  }
}

class NarrativeEngine {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.playerState]
   * @param {Object|null} [options.worldState]
   * @param {() => number} [options.rng] - Random source in [0, 1). Defaults to Math.random.
   */
  constructor(options = {}) {
    this.playerState = options.playerState ?? null;
    this.worldState = options.worldState ?? null;
    this.rng = options.rng ?? Math.random;
    this._unsubs = [];
  }

  /**
   * @param {Object} [playerState] - Rebinds the target PlayerState if provided.
   * @param {Object} [worldState] - Rebinds the target WorldState if provided.
   * @returns {NarrativeEngine} this, for chaining.
   */
  attach(playerState, worldState) {
    if (playerState) this.playerState = playerState;
    if (worldState) this.worldState = worldState;

    this._unsubs.push(EventBus.subscribe('story:opportunity_detected', (payload) => this._onOpportunity(payload)));

    return this;
  }

  /** Unsubscribes from every event this engine listens to. */
  detach() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
  }

  // ---- event handler ----------------------------------------------------------

  _onOpportunity(opportunity) {
    const weights = BALANCE.NARRATIVE.FORM_WEIGHTS_BY_OPPORTUNITY[opportunity.type];
    if (!weights) return; // unknown/future opportunity type: nothing to narrate yet, not an error

    const form = pickWeightedForm(this.rng, weights);
    const beat = this._buildBeat(opportunity, form);

    this._dispatch(beat);
    EventBus.publish(NARRATIVE_ENGINE_EVENTS.PUBLISHED, beat);

    return beat;
  }

  // ---- internals ------------------------------------------------------------

  _buildBeat(opportunity, form) {
    const primaryId = opportunity.entities[0];
    const secondaryId = opportunity.entities[1] ?? null;
    const primaryName = resolveName(opportunity.context, primaryId, 'Un combattant');
    const secondaryName = secondaryId ? resolveName(opportunity.context, secondaryId, 'son adversaire') : null;

    const headline = buildHeadline(opportunity.type, form, primaryName, secondaryName);
    const isAdversarialDeclaration =
      form === NARRATIVE_FORMS.DECLARATION &&
      Boolean(secondaryId) &&
      ADVERSARIAL_OPPORTUNITY_TYPES.includes(opportunity.type);

    return {
      id: generateId('narrative'),
      form,
      opportunityType: opportunity.type,
      entities: opportunity.entities,
      primaryName,
      secondaryName,
      tone: isAdversarialDeclaration ? 'PROVOCATION' : 'NEUTRAL',
      headline,
      day: this.worldState?.currentDay ?? opportunity.day ?? null,
    };
  }

  _dispatch(beat) {
    const socialForms = [NARRATIVE_FORMS.DECLARATION, NARRATIVE_FORMS.INTERVIEW, NARRATIVE_FORMS.VIRAL_POST];

    if (socialForms.includes(beat.form)) {
      this._postToSocialFeed(beat);
    } else {
      this.worldState?.addGlobalEvent({
        type: 'NARRATIVE_INCIDENT',
        form: beat.form,
        headline: beat.headline,
        entities: beat.entities,
      });
    }
  }

  _postToSocialFeed(beat) {
    if (!this.playerState) return null;

    const authorType =
      beat.form === NARRATIVE_FORMS.DECLARATION
        ? 'FIGHTER_STATEMENT'
        : beat.form === NARRATIVE_FORMS.INTERVIEW
          ? 'JOURNALIST'
          : 'FAN';
    const author =
      authorType === 'FIGHTER_STATEMENT' ? beat.primaryName : authorType === 'JOURNALIST' ? 'Journaliste MMA' : 'Fan de la salle';

    return this.playerState.pushSocialFeedEntry({
      author,
      authorType,
      text: beat.headline,
      likes: this._computeLikes(beat),
    });
  }

  _computeLikes(beat) {
    const cfg = BALANCE.SOCIAL_MEDIA.POST_LIKES;
    const base = cfg.BASE_MIN + this.rng() * (cfg.BASE_MAX - cfg.BASE_MIN);
    const hype = this.playerState?.hype ?? 0;
    let likes = base + hype * cfg.HYPE_MULTIPLIER;
    if (beat.form === NARRATIVE_FORMS.VIRAL_POST) likes *= BALANCE.NARRATIVE.VIRAL_POST_LIKES_MULTIPLIER;
    return Math.max(0, Math.round(likes));
  }
}

const instance = new NarrativeEngine();
export default instance;
export { NarrativeEngine };
