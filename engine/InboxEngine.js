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
 *   - SPONSOR_OFFER: a new, independent weekly-chance cash+Reputation offer
 *     (see evaluateSponsorOffers; V4.4 "Nettoyage Hype du Gym" redirected
 *     its reward off the retired gym-Hype stat onto Reputation) —
 *     deliberately NOT the same mechanic as the
 *     pre-existing BALANCE.NARRATIVE_EVENTS.SPONSOR_OFFER (engine/
 *     EventEngine.js, auto-applies with no player choice) or BALANCE.DRAMA's
 *     own weighted-lottery SPONSOR_OFFER choice (engine/DramaEngine.js) —
 *     both of those are left completely untouched. This file's own
 *     BALANCE.INBOX.SPONSOR_OFFER config is a separate, additive channel.
 *   - TRANSFER_BID: a rival gym proposing to BUY one of the player's own
 *     fighters (see evaluateTransferBids) — the inverse of engine/
 *     MercatoEngine.js#buyoutRivalFighter (player buys FROM a rival).
 *     V4.3 "Debauchage Rival" reworked eligibility/pricing to read off
 *     engine/MercatoEngine.js#isRivalTransferTarget/computeRivalTransferValue
 *     (Hype/win-streak/title, not a flat rating floor) and added a
 *     Contre-proposition action (see resolveTransferBid). Distinct from
 *     BALANCE.MERCATO.POACHING (engine/MercatoEngine.js#rollWeeklyPoaching),
 *     which silently removes a low-Loyalty fighter with no player choice at
 *     all — a TRANSFER_BID always waits for a decision.
 *   - ROSTER_NEWS: informational alerts about the player's own roster (see
 *     evaluateRosterNews) — a low-Loyalty warning, and (V4.3) an "envie de
 *     depart" alert once a fighter's own Hype has outgrown the gym's own
 *     Reputation (engine/MercatoEngine.js#fighterWantsToLeave) — both
 *     dismissed rather than acted on.
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
import { isRivalTransferTarget, computeRivalTransferValue, fighterWantsToLeave } from './MercatoEngine.js';

/** The only valid PlayerState#inbox message categories — see this file's own header for what each means. */
export const MESSAGE_CATEGORIES = Object.freeze(['CONTRACT_OFFER', 'SPONSOR_OFFER', 'TRANSFER_BID', 'ROSTER_NEWS']);

/**
 * V4.2 "Curation Inbox": every message category maps to one of three
 * priority buckets, in display order — 🔥 Prioritaire (offers that gate a
 * fighter's career: league contracts, sponsorships, and — V4.3 — rival
 * transfer bids), 💰 Opportunités (reserved for a future lower-urgency
 * cash-opportunity category), ℹ️ Infos (informational, nothing to sign).
 * CONTRACT_OFFER, SPONSOR_OFFER, and TRANSFER_BID all share the PRIORITY
 * bucket — a transfer bid is time-boxed and moves real money, same urgency
 * class as a contract/sponsor offer (see this file's header note).
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
  TRANSFER_BID: 'PRIORITY',
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
 * Weekly chance of an independent sponsor cash+Reputation offer — see this
 * file's header for why this is a separate channel from the two
 * pre-existing sponsor mechanics. V4.4 "Nettoyage Hype du Gym": this used
 * to grant gym-wide Hype; redirected to Reputation so no visible reward
 * touches the retired gym-Hype stat anymore (see BALANCE.INBOX
 * .SPONSOR_OFFER.REPUTATION_BONUS).
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
    body: `${sponsor} propose ${amount.toLocaleString('fr-FR')}$ et +${cfg.REPUTATION_BONUS} de Reputation en echange d'une mise en avant de votre salle.`,
    actions: [
      { id: 'ACCEPT', label: 'Accepter' },
      { id: 'DECLINE', label: 'Refuser' },
    ],
    context: { amount, reputationBonus: cfg.REPUTATION_BONUS },
  });
}

function resolveSponsorOffer(playerState, message, actionId) {
  if (actionId === 'ACCEPT') {
    playerState.changeMoney(message.context.amount, 'INBOX:SPONSOR_OFFER_ACCEPTED');
    playerState.changeReputation(message.context.reputationBonus, 'INBOX:SPONSOR_OFFER_ACCEPTED');
  }
  playerState.archiveInboxMessage(message.id);
  return { success: true, applied: actionId === 'ACCEPT' };
}

// ---- TRANSFER_BID -------------------------------------------------------------

/** Builds the "Motivation du combattant" line — see evaluateTransferBids. */
function describeMotivation(fighter, wantsToLeave, reason) {
  if (wantsToLeave) {
    return `${fighter.identity.name} n'est plus epanoui(e) dans la salle et pourrait bien accepter de partir.`;
  }
  const byReason = {
    HYPE: `${fighter.identity.name} attire les regards avec sa Hype montante, mais reste attache(e) a la salle.`,
    WIN_STREAK: `${fighter.identity.name} enchaine les victoires et fait tourner les tetes, mais reste attache(e) a la salle.`,
    TITLE: `${fighter.identity.name} porte fierement son titre, mais reste attache(e) a la salle.`,
  };
  return byReason[reason] ?? `${fighter.identity.name} reste attache(e) a la salle malgre l'interet exterieur.`;
}

/** @returns {'HYPE'|'WIN_STREAK'|'TITLE'} Which BALANCE.MERCATO.RIVAL_TRANSFER_TARGET trigger this fighter cleared — for the message's own flavor text (see describeMotivation). Checked in the same precedence order as isRivalTransferTarget(). */
function describeTransferReason(fighter) {
  const cfg = BALANCE.MERCATO.RIVAL_TRANSFER_TARGET;
  if (fighter.attributes.hype > cfg.HYPE_THRESHOLD) return 'HYPE';
  if (fighter.career.currentWinStreak >= cfg.WIN_STREAK_THRESHOLD) return 'WIN_STREAK';
  return 'TITLE';
}

/**
 * "Debauchage Rival" (V4.3): weekly evaluation of the player's OWN roster
 * by rival gyms — see this file's header and engine/MercatoEngine.js
 * #isRivalTransferTarget/computeRivalTransferValue for the eligibility/
 * pricing rules. At most one bid is created per call (kept rare and
 * readable, one at a time, same precedent as the pre-V4.3 version).
 * @returns {Object|null} The created message, or null if none fired.
 */
export function evaluateTransferBids(playerState, worldState, rng = Math.random) {
  const cfg = BALANCE.INBOX.TRANSFER_BID;
  if (worldState.rivalGyms.length === 0) return null;

  const candidates = playerState.roster.filter(
    (fighter) =>
      isRivalTransferTarget(fighter) &&
      !playerState.inbox.some((m) => m.category === 'TRANSFER_BID' && !m.isArchived && m.context.fighterId === fighter.identity.id)
  );

  for (const fighter of candidates) {
    if (rng() >= cfg.WEEKLY_CHANCE_PER_FIGHTER) continue;

    const gym = worldState.rivalGyms[Math.floor(rng() * worldState.rivalGyms.length)];
    const fee = computeRivalTransferValue(fighter);
    const gymLabel = gym.name ?? gym.id;
    const wantsToLeave = fighterWantsToLeave(fighter, playerState);
    const motivation = describeMotivation(fighter, wantsToLeave, describeTransferReason(fighter));

    return createMessage(playerState, worldState, {
      sender: gymLabel,
      category: 'TRANSFER_BID',
      title: `Offre de rachat pour ${fighter.identity.name}`,
      body: `${gymLabel} propose ${fee.toLocaleString('fr-FR')}$ pour recruter ${fighter.identity.name} dans son roster. ${motivation}`,
      actions: [
        { id: 'ACCEPT', label: 'Accepter le transfert' },
        { id: 'COUNTER', label: 'Contre-proposition +25%' },
        { id: 'DECLINE', label: 'Refuser' },
      ],
      context: { fighterId: fighter.identity.id, fighterName: fighter.identity.name, gymId: gym.id, fee, wantsToLeave },
    });
  }

  return null;
}

/** Moves `fighter` from PlayerState#roster onto rival gym `gymId`'s own roster and credits `fee` — shared by resolveTransferBid's ACCEPT and accepted-COUNTER paths. */
function sellFighterToRival(playerState, worldState, fighter, gymId, fee, reason) {
  const gym = worldState.rivalGyms.find((entry) => entry.id === gymId);
  playerState.removeFighter(fighter.identity.id);
  if (gym) {
    fighter.contracts.currentContract = { leagueId: null, gymId: gym.id, signedYear: worldState.year, expiresYear: worldState.year + 1 };
    worldState.updateRivalGym(gym.id, { roster: [...(gym.roster ?? []), fighter.toJSON()] });
  }
  playerState.changeMoney(fee, reason);
}

/**
 * V4.3: resolves ACCEPT/DECLINE/COUNTER on a TRANSFER_BID.
 *   - ACCEPT: sells the fighter for the offer's own `fee`.
 *   - DECLINE: keeps the fighter; if context.wantsToLeave (see
 *     engine/MercatoEngine.js#fighterWantsToLeave, snapshotted onto the
 *     message when it was created), knocks -5 Loyalty — refusing a fighter
 *     who already wanted to go costs their trust.
 *   - COUNTER: "Contre-proposition +25%" — COUNTER_OFFER_ACCEPT_CHANCE odds
 *     the rival AI accepts fee*COUNTER_OFFER_MULTIPLIER outright (sells at
 *     the bumped fee); otherwise the rival walks away (message archived,
 *     fighter stays, no money changes hands, no Loyalty penalty — the
 *     player tried to negotiate rather than refusing outright).
 */
function resolveTransferBid(playerState, worldState, message, actionId, rng = Math.random) {
  const { fighterId, fee, wantsToLeave } = message.context;

  if (actionId === 'ACCEPT') {
    const fighter = playerState.getFighter(fighterId);
    if (!fighter) {
      playerState.archiveInboxMessage(message.id);
      return { success: false, reason: 'FIGHTER_NOT_FOUND' };
    }
    sellFighterToRival(playerState, worldState, fighter, message.context.gymId, fee, 'INBOX:TRANSFER_BID_ACCEPTED');
    playerState.archiveInboxMessage(message.id);
    return { success: true, applied: true, fee };
  }

  if (actionId === 'COUNTER') {
    const fighter = playerState.getFighter(fighterId);
    if (!fighter) {
      playerState.archiveInboxMessage(message.id);
      return { success: false, reason: 'FIGHTER_NOT_FOUND' };
    }
    const cfg = BALANCE.MERCATO.RIVAL_TRANSFER_TARGET;
    const counterFee = Math.round(fee * cfg.COUNTER_OFFER_MULTIPLIER);
    const accepted = rng() < cfg.COUNTER_OFFER_ACCEPT_CHANCE;
    playerState.archiveInboxMessage(message.id);
    if (!accepted) return { success: true, applied: false, countered: true, accepted: false };

    sellFighterToRival(playerState, worldState, fighter, message.context.gymId, counterFee, 'INBOX:TRANSFER_BID_COUNTERED');
    return { success: true, applied: true, countered: true, accepted: true, fee: counterFee };
  }

  // DECLINE (or any other action id defaults to a decline).
  if (wantsToLeave) {
    const fighter = playerState.getFighter(fighterId);
    fighter?.adjustLoyalty(-5);
  }
  playerState.archiveInboxMessage(message.id);
  return { success: true, applied: false, loyaltyPenalty: Boolean(wantsToLeave) };
}

// ---- ROSTER_NEWS ----------------------------------------------------------------

/** @returns {boolean} True if an unarchived ROSTER_NEWS alert of this alertType already exists for this fighter — shared dedup check for both alert kinds below. */
function alreadyAlerted(playerState, fighterId, alertType) {
  return playerState.inbox.some(
    (m) => m.category === 'ROSTER_NEWS' && !m.isArchived && m.context.fighterId === fighterId && m.context.alertType === alertType
  );
}

/**
 * Checks every roster fighter against two independent "envie de depart"
 * triggers and sends at most one alert per fighter per trigger (never
 * duplicated while an unarchived alert of that alertType already exists —
 * dismiss it to allow a fresh one later):
 *   - LOW_LOYALTY: Loyalty below ROSTER_NEWS.LOW_LOYALTY_THRESHOLD.
 *   - HYPE_OUTGROWS_GYM (V4.3): the fighter's own Hype has cleared the
 *     gym's own Reputation by ROSTER_NEWS.HYPE_OUTGROWS_GYM_GAP points or
 *     more — a star who has outgrown their own gym.
 * Both conditions are also engine/MercatoEngine.js#fighterWantsToLeave's
 * own definition of "wants to leave", reused by resolveTransferBid's own
 * DECLINE Loyalty-penalty branch.
 * @returns {Object[]} Every message created this call.
 */
export function evaluateRosterNews(playerState, worldState) {
  const cfg = BALANCE.INBOX.ROSTER_NEWS;
  const created = [];

  for (const fighter of playerState.roster) {
    if (fighter.psychology.loyalty < cfg.LOW_LOYALTY_THRESHOLD && !alreadyAlerted(playerState, fighter.identity.id, 'LOW_LOYALTY')) {
      created.push(
        createMessage(playerState, worldState, {
          sender: 'Vestiaire',
          category: 'ROSTER_NEWS',
          title: `Loyaute en baisse : ${fighter.identity.name}`,
          body: `${fighter.identity.name} exprime des doutes sur son avenir dans la salle (Loyaute : ${Math.round(fighter.psychology.loyalty)}). Un rival pourrait en profiter.`,
          actions: [{ id: 'DISMISS', label: 'Pris note' }],
          context: { fighterId: fighter.identity.id, alertType: 'LOW_LOYALTY' },
        })
      );
    }

    if (
      fighter.attributes.hype - playerState.reputation >= cfg.HYPE_OUTGROWS_GYM_GAP &&
      !alreadyAlerted(playerState, fighter.identity.id, 'HYPE_OUTGROWS_GYM')
    ) {
      created.push(
        createMessage(playerState, worldState, {
          sender: 'Vestiaire',
          category: 'ROSTER_NEWS',
          title: `Envie de depart : ${fighter.identity.name}`,
          body: `${fighter.identity.name} (Hype ${Math.round(fighter.attributes.hype)}) a depasse la reputation de la salle (${Math.round(playerState.reputation)}) — des rivaux pourraient bientot faire une offre.`,
          actions: [{ id: 'DISMISS', label: 'Pris note' }],
          context: { fighterId: fighter.identity.id, alertType: 'HYPE_OUTGROWS_GYM' },
        })
      );
    }
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
 * {amount, reputationBonus}, resolved below by resolveSponsorOffer) and
 * engine/SponsorEngine.js's individual fighter sponsorships (context:
 * {fighterId, offerId}, no amount/reputationBonus). The latter is deliberately
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
 * @param {() => number} [rng] - Only consulted by TRANSFER_BID's COUNTER action (see resolveTransferBid).
 * @returns {{ success: boolean, reason?: string }}
 */
export function resolveAction(playerState, worldState, messageId, actionId, rng = Math.random) {
  const message = playerState.inbox.find((entry) => entry.id === messageId);
  if (!message) return { success: false, reason: 'MESSAGE_NOT_FOUND' };
  if (message.isArchived) return { success: false, reason: 'ALREADY_RESOLVED' };

  if (message.category === 'SPONSOR_OFFER' && message.context.fighterId == null) return resolveSponsorOffer(playerState, message, actionId);
  if (message.category === 'TRANSFER_BID') return resolveTransferBid(playerState, worldState, message, actionId, rng);
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
