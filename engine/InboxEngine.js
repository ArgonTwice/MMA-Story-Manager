/**
 * engine/InboxEngine.js
 * ---------------------------------------------------------------------------
 * V4.1 "Centre de Messagerie": a single, unified inbox (PlayerState#inbox,
 * written exclusively through createMessage() here) centralizing every
 * proactive, player-facing offer/notification the gym receives, across four
 * categories:
 *
 *   - CONTRACT_OFFER: created by engine/LeagueEngine.js#evaluateLeagueOffers
 *     (V4.0) — a league (ECL/APEX) proposing to sign a fighter. Resolved by
 *     that same file's acceptLeagueOffer/declineLeagueOffer; this module
 *     never touches league contracts itself (see resolveAction's own note).
 *   - SPONSOR_OFFER: a new, independent weekly-chance cash+Hype offer (see
 *     evaluateSponsorOffers) — deliberately NOT the same mechanic as the
 *     pre-existing BALANCE.NARRATIVE_EVENTS.SPONSOR_OFFER (engine/
 *     EventEngine.js, auto-applies with no player choice) or BALANCE.DRAMA's
 *     own weighted-lottery SPONSOR_OFFER choice (engine/DramaEngine.js) —
 *     both of those are left completely untouched. This file's own
 *     BALANCE.INBOX.SPONSOR_OFFER config is a separate, additive channel.
 *   - TRANSFER_BID: a rival gym proposing to BUY one of the player's own
 *     fighters (see evaluateTransferBids) — the inverse of engine/
 *     MercatoEngine.js#buyoutRivalFighter (player buys FROM a rival),
 *     reusing that file's own computeBuyoutFee() for a consistent price.
 *     Distinct from BALANCE.MERCATO.POACHING (engine/MercatoEngine.js
 *     #rollWeeklyPoaching), which silently removes a low-Loyalty fighter
 *     with no player choice at all — a TRANSFER_BID always waits for a
 *     decision.
 *   - ROSTER_NEWS: informational alerts about the player's own roster (see
 *     evaluateRosterNews) — today just a low-Loyalty warning, dismissed
 *     rather than acted on.
 *
 * Every message shares one shape: { id, date, sender, category, title,
 * body, actions, context, isRead, isArchived }. `actions` is a list of
 * { id, label } buttons a UI renders; `context` carries whatever payload
 * resolveAction (or, for CONTRACT_OFFER, the UI's own call into
 * LeagueEngine.js) needs to actually apply the chosen action — not part of
 * the literal spec's own field list, but unavoidable: an action button is
 * meaningless without knowing what it applies to.
 * ---------------------------------------------------------------------------
 */

import BALANCE from '../data/balance.js';
import { computeBuyoutFee } from './MercatoEngine.js';

/** The only valid PlayerState#inbox message categories — see this file's own header for what each means. */
export const MESSAGE_CATEGORIES = Object.freeze(['CONTRACT_OFFER', 'SPONSOR_OFFER', 'TRANSFER_BID', 'ROSTER_NEWS']);

/**
 * V4.2 "Curation Inbox": every message category maps to one of three
 * priority buckets, in display order — 🔥 Prioritaire (offers that gate a
 * fighter's career: league contracts and sponsorships), 💰 Opportunités
 * (a rival's cash offer for a roster fighter), ℹ️ Infos (informational,
 * nothing to sign). Both CONTRACT_OFFER and SPONSOR_OFFER share the
 * PRIORITY bucket regardless of which SPONSOR_OFFER flow produced them
 * (this file's own gym-wide evaluateSponsorOffers, or engine/
 * SponsorEngine.js's individual fighter offers).
 */
export const PRIORITY_LEVELS = Object.freeze(['PRIORITY', 'OPPORTUNITY', 'INFO']);

export const PRIORITY_LABELS = Object.freeze({
  PRIORITY: '🔥 Prioritaire',
  OPPORTUNITY: '💰 Opportunités',
  INFO: 'ℹ️ Infos',
});

const CATEGORY_PRIORITY = Object.freeze({
  CONTRACT_OFFER: 'PRIORITY',
  SPONSOR_OFFER: 'PRIORITY',
  TRANSFER_BID: 'OPPORTUNITY',
  ROSTER_NEWS: 'INFO',
});

/** @returns {string} One of PRIORITY_LEVELS for this message category — unknown categories default to 'INFO'. */
export function getMessagePriority(category) {
  return CATEGORY_PRIORITY[category] ?? 'INFO';
}

const SPONSOR_NAMES = Object.freeze(['NordFit', 'IronCore Nutrition', 'Apex Wear', 'Volt Energy', 'Titan Supplements', 'Fusion Gear']);

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

// ---- core message store (thin wrappers over PlayerState's own inbox methods) ----

/**
 * Builds and stores a new inbox message — the SOLE way any message ever
 * enters PlayerState#inbox (every category's generator below, and
 * engine/LeagueEngine.js#evaluateLeagueOffers for CONTRACT_OFFER, funnel
 * through this one function).
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {Object} options
 * @param {string} options.sender
 * @param {string} options.category - One of MESSAGE_CATEGORIES.
 * @param {string} options.title
 * @param {string} options.body
 * @param {{ id: string, label: string }[]} [options.actions]
 * @param {Object} [options.context]
 * @returns {Object} The stored message.
 */
export function createMessage(playerState, worldState, { sender, category, title, body, actions = [], context = {} }) {
  if (!MESSAGE_CATEGORIES.includes(category)) {
    throw new TypeError(`InboxEngine.createMessage: unknown category "${category}".`);
  }

  return playerState.pushInboxMessage({
    date: worldState.currentDay,
    sender,
    category,
    title,
    body,
    actions: actions.map((action) => ({ ...action })),
    context: { ...context },
  });
}

/** @returns {Object[]} Every non-archived message, newest first — the UI's default inbox list. */
export function getMessages(playerState, { includeArchived = false } = {}) {
  const messages = includeArchived ? playerState.inbox : playerState.inbox.filter((message) => !message.isArchived);
  return [...messages].reverse();
}

/**
 * V4.2 "Curation Inbox": buckets getMessages()'s own result into the three
 * PRIORITY_LEVELS, in display order, each group keeping the same
 * newest-first ordering getMessages already provides.
 * @returns {{ level: string, label: string, messages: Object[] }[]} One entry per PRIORITY_LEVELS, always all three (possibly empty).
 */
export function groupMessagesByPriority(playerState, options) {
  const messages = getMessages(playerState, options);
  const groups = new Map(PRIORITY_LEVELS.map((level) => [level, []]));
  for (const message of messages) {
    groups.get(getMessagePriority(message.category)).push(message);
  }
  return PRIORITY_LEVELS.map((level) => ({ level, label: PRIORITY_LABELS[level], messages: groups.get(level) }));
}

/** @returns {number} Count of unread, non-archived messages — the nav badge's own source of truth. */
export function getUnreadCount(playerState) {
  return playerState.inbox.filter((message) => !message.isRead && !message.isArchived).length;
}

export function markAsRead(playerState, messageId) {
  return playerState.markInboxMessageRead(messageId);
}

export function archiveMessage(playerState, messageId) {
  return playerState.archiveInboxMessage(messageId);
}

// ---- SPONSOR_OFFER -----------------------------------------------------------

/**
 * Weekly chance of an independent sponsor cash+Hype offer — see this
 * file's header for why this is a separate channel from the two
 * pre-existing sponsor mechanics.
 * @returns {Object|null} The created message, or null if it didn't fire.
 */
export function evaluateSponsorOffers(playerState, worldState, rng = Math.random) {
  const cfg = BALANCE.INBOX.SPONSOR_OFFER;
  if (rng() >= cfg.WEEKLY_CHANCE) return null;

  const amount = Math.round(cfg.MIN_AMOUNT + rng() * (cfg.MAX_AMOUNT - cfg.MIN_AMOUNT));
  const sponsor = pick(rng, SPONSOR_NAMES);

  return createMessage(playerState, worldState, {
    sender: sponsor,
    category: 'SPONSOR_OFFER',
    title: `Proposition de sponsoring de ${sponsor}`,
    body: `${sponsor} propose ${amount.toLocaleString('fr-FR')}$ et +${cfg.HYPE_BONUS} de Hype en echange d'une mise en avant de votre salle.`,
    actions: [
      { id: 'ACCEPT', label: 'Accepter' },
      { id: 'DECLINE', label: 'Refuser' },
    ],
    context: { amount, hypeBonus: cfg.HYPE_BONUS },
  });
}

function resolveSponsorOffer(playerState, message, actionId) {
  if (actionId === 'ACCEPT') {
    playerState.changeMoney(message.context.amount, 'INBOX:SPONSOR_OFFER_ACCEPTED');
    playerState.changeHype(message.context.hypeBonus, 'INBOX:SPONSOR_OFFER_ACCEPTED');
  }
  playerState.archiveInboxMessage(message.id);
  return { success: true, applied: actionId === 'ACCEPT' };
}

// ---- TRANSFER_BID -------------------------------------------------------------

/**
 * Weekly chance a rival gym bids to buy one of the player's own fighters —
 * see this file's header for how this differs from POACHING. At most one
 * bid is created per call (kept rare and readable, one at a time).
 * @returns {Object|null} The created message, or null if none fired.
 */
export function evaluateTransferBids(playerState, worldState, rng = Math.random) {
  const cfg = BALANCE.INBOX.TRANSFER_BID;
  if (worldState.rivalGyms.length === 0) return null;

  const candidates = playerState.roster.filter(
    (fighter) =>
      fighter.getOverallRating() >= cfg.MIN_OVERALL &&
      !playerState.inbox.some((m) => m.category === 'TRANSFER_BID' && !m.isArchived && m.context.fighterId === fighter.identity.id)
  );

  for (const fighter of candidates) {
    if (rng() >= cfg.WEEKLY_CHANCE_PER_FIGHTER) continue;

    const gym = worldState.rivalGyms[Math.floor(rng() * worldState.rivalGyms.length)];
    const fee = computeBuyoutFee(fighter);
    const gymLabel = gym.name ?? gym.id;

    return createMessage(playerState, worldState, {
      sender: gymLabel,
      category: 'TRANSFER_BID',
      title: `Offre de rachat pour ${fighter.identity.name}`,
      body: `${gymLabel} propose ${fee.toLocaleString('fr-FR')}$ pour recruter ${fighter.identity.name} dans son roster.`,
      actions: [
        { id: 'ACCEPT', label: 'Vendre' },
        { id: 'DECLINE', label: 'Garder' },
      ],
      context: { fighterId: fighter.identity.id, fighterName: fighter.identity.name, gymId: gym.id, fee },
    });
  }

  return null;
}

function resolveTransferBid(playerState, worldState, message, actionId) {
  if (actionId === 'ACCEPT') {
    const fighter = playerState.getFighter(message.context.fighterId);
    if (!fighter) {
      playerState.archiveInboxMessage(message.id);
      return { success: false, reason: 'FIGHTER_NOT_FOUND' };
    }

    const gym = worldState.rivalGyms.find((entry) => entry.id === message.context.gymId);
    playerState.removeFighter(fighter.identity.id);
    if (gym) {
      fighter.contracts.currentContract = { leagueId: null, gymId: gym.id, signedYear: worldState.year, expiresYear: worldState.year + 1 };
      worldState.updateRivalGym(gym.id, { roster: [...(gym.roster ?? []), fighter.toJSON()] });
    }
    playerState.changeMoney(message.context.fee, 'INBOX:TRANSFER_BID_ACCEPTED');
    playerState.archiveInboxMessage(message.id);
    return { success: true, fee: message.context.fee };
  }

  playerState.archiveInboxMessage(message.id);
  return { success: true, applied: false };
}

// ---- ROSTER_NEWS ----------------------------------------------------------------

/**
 * Checks every roster fighter's Loyalty against LOW_LOYALTY_THRESHOLD and
 * sends one informational alert per fighter (never duplicated while an
 * unarchived alert for that fighter already exists — dismiss it to allow a
 * fresh one later).
 * @returns {Object[]} Every message created this call.
 */
export function evaluateRosterNews(playerState, worldState) {
  const cfg = BALANCE.INBOX.ROSTER_NEWS;
  const created = [];

  for (const fighter of playerState.roster) {
    if (fighter.psychology.loyalty >= cfg.LOW_LOYALTY_THRESHOLD) continue;

    const alreadyAlerted = playerState.inbox.some(
      (m) => m.category === 'ROSTER_NEWS' && !m.isArchived && m.context.fighterId === fighter.identity.id && m.context.alertType === 'LOW_LOYALTY'
    );
    if (alreadyAlerted) continue;

    const message = createMessage(playerState, worldState, {
      sender: 'Vestiaire',
      category: 'ROSTER_NEWS',
      title: `Loyaute en baisse : ${fighter.identity.name}`,
      body: `${fighter.identity.name} exprime des doutes sur son avenir dans la salle (Loyaute : ${Math.round(fighter.psychology.loyalty)}). Un rival pourrait en profiter.`,
      actions: [{ id: 'DISMISS', label: 'Pris note' }],
      context: { fighterId: fighter.identity.id, alertType: 'LOW_LOYALTY' },
    });
    created.push(message);
  }

  return created;
}

// ---- action dispatch ----------------------------------------------------------

/**
 * Resolves an action button for SPONSOR_OFFER/TRANSFER_BID/ROSTER_NEWS.
 * CONTRACT_OFFER is deliberately NOT handled here — this module never
 * imports engine/LeagueEngine.js (that file imports THIS one, to create
 * CONTRACT_OFFER messages, so the reverse would be circular). A UI acting
 * on a CONTRACT_OFFER message calls LeagueEngine's acceptLeagueOffer/
 * declineLeagueOffer directly, then archiveMessage() here to clear the card.
 *
 * V4.2: the SAME 'SPONSOR_OFFER' category now covers two independent
 * flows — this file's own gym-wide evaluateSponsorOffers (context:
 * {amount, hypeBonus}, resolved below by resolveSponsorOffer) and engine/
 * SponsorEngine.js's individual fighter sponsorships (context:
 * {fighterId, offerId}, no amount/hypeBonus). The latter is deliberately
 * NOT handled here either, for the same reason as CONTRACT_OFFER — this
 * module never imports engine/SponsorEngine.js (that file imports THIS
 * one). A UI acting on a fighter-level SPONSOR_OFFER (context.fighterId
 * present) must call SponsorEngine's acceptSponsorshipOffer/
 * declineSponsorshipOffer directly, then archiveMessage() here.
 *
 * @param {Object} playerState
 * @param {Object} worldState
 * @param {string} messageId
 * @param {string} actionId
 * @returns {{ success: boolean, reason?: string }}
 */
export function resolveAction(playerState, worldState, messageId, actionId) {
  const message = playerState.inbox.find((entry) => entry.id === messageId);
  if (!message) return { success: false, reason: 'MESSAGE_NOT_FOUND' };
  if (message.isArchived) return { success: false, reason: 'ALREADY_RESOLVED' };

  if (message.category === 'SPONSOR_OFFER' && message.context.fighterId == null) return resolveSponsorOffer(playerState, message, actionId);
  if (message.category === 'TRANSFER_BID') return resolveTransferBid(playerState, worldState, message, actionId);
  if (message.category === 'ROSTER_NEWS') {
    playerState.archiveInboxMessage(message.id);
    return { success: true };
  }

  return { success: false, reason: 'UNSUPPORTED_CATEGORY' };
}

export default {
  MESSAGE_CATEGORIES,
  PRIORITY_LEVELS,
  PRIORITY_LABELS,
  getMessagePriority,
  createMessage,
  getMessages,
  groupMessagesByPriority,
  getUnreadCount,
  markAsRead,
  archiveMessage,
  evaluateSponsorOffers,
  evaluateTransferBids,
  evaluateRosterNews,
  resolveAction,
};
