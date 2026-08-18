/**
 * engine/InboxEngine.test.js
 * Run with: node --test engine/InboxEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import {
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
} from './InboxEngine.js';

/** A generically strong fighter — no longer eligible for a TRANSFER_BID on its own since V4.3 (see makeTransferTargetFighter below), only used where roster strength itself is irrelevant. */
function makeStrongFighter(overrides = {}) {
  const skills = { boxe: 75, jambes: 75, sol: 75, soumission: 75, cardio: 75, intelligence: 75 };
  return new Fighter({
    identity: { id: 'f1', name: 'F1', gender: 'M', weightClass: 'Poids Welter' },
    attributes: { skills },
    ...overrides,
  });
}

/** A fighter whose Hype clears BALANCE.MERCATO.RIVAL_TRANSFER_TARGET.HYPE_THRESHOLD — the default V4.3 "Debauchage Rival" eligibility path. */
function makeTransferTargetFighter(overrides = {}) {
  const skills = { boxe: 75, jambes: 75, sol: 75, soumission: 75, cardio: 75, intelligence: 75 };
  return new Fighter({
    identity: { id: 'f1', name: 'F1', gender: 'M', weightClass: 'Poids Welter' },
    attributes: { skills, hype: 60 },
    ...overrides,
  });
}

// ---- core message store -----------------------------------------------------

test('createMessage rejects an unknown category, and stores a well-shaped message otherwise', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();

  assert.throws(() => createMessage(playerState, worldState, { sender: 'X', category: 'NOT_A_CATEGORY', title: 't', body: 'b' }), TypeError);

  const message = createMessage(playerState, worldState, {
    sender: 'NordFit',
    category: 'SPONSOR_OFFER',
    title: 'Titre',
    body: 'Corps',
    actions: [{ id: 'ACCEPT', label: 'Accepter' }],
    context: { amount: 1000 },
  });

  assert.ok(message.id);
  assert.equal(message.date, worldState.currentDay);
  assert.equal(message.sender, 'NordFit');
  assert.equal(message.category, 'SPONSOR_OFFER');
  assert.equal(message.isRead, false);
  assert.equal(message.isArchived, false);
  assert.deepEqual(message.actions, [{ id: 'ACCEPT', label: 'Accepter' }]);
  assert.deepEqual(message.context, { amount: 1000 });
  assert.equal(playerState.inbox.length, 1);
});

test('MESSAGE_CATEGORIES lists exactly the 4 spec\'d categories', () => {
  assert.deepEqual([...MESSAGE_CATEGORIES].sort(), ['CONTRACT_OFFER', 'ROSTER_NEWS', 'SPONSOR_OFFER', 'TRANSFER_BID']);
});

test('getMessages excludes archived by default, newest first; includeArchived reveals them again', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const first = createMessage(playerState, worldState, { sender: 'A', category: 'ROSTER_NEWS', title: 't1', body: 'b1' });
  const second = createMessage(playerState, worldState, { sender: 'B', category: 'ROSTER_NEWS', title: 't2', body: 'b2' });
  archiveMessage(playerState, first.id);

  const active = getMessages(playerState);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, second.id);

  const all = getMessages(playerState, { includeArchived: true });
  assert.equal(all.length, 2);
  assert.equal(all[0].id, second.id, 'newest first');
});

test('getUnreadCount/markAsRead/archiveMessage behave correctly, including archiving implicitly marking read', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const message = createMessage(playerState, worldState, { sender: 'A', category: 'ROSTER_NEWS', title: 't', body: 'b' });

  assert.equal(getUnreadCount(playerState), 1);
  assert.equal(markAsRead(playerState, 'missing'), false);
  assert.equal(markAsRead(playerState, message.id), true);
  assert.equal(getUnreadCount(playerState), 0);
  assert.equal(markAsRead(playerState, message.id), false, 'already read — no-op reports nothing changed');

  const second = createMessage(playerState, worldState, { sender: 'B', category: 'ROSTER_NEWS', title: 't2', body: 'b2' });
  assert.equal(getUnreadCount(playerState), 1);
  assert.equal(archiveMessage(playerState, second.id), true);
  assert.equal(getUnreadCount(playerState), 0, 'archiving implicitly marks read too');
});

// ---- V4.2 priority curation ----------------------------------------------------

test('getMessagePriority classifies every category, defaulting unknown ones to INFO', () => {
  assert.equal(getMessagePriority('CONTRACT_OFFER'), 'PRIORITY');
  assert.equal(getMessagePriority('SPONSOR_OFFER'), 'PRIORITY');
  assert.equal(getMessagePriority('TRANSFER_BID'), 'PRIORITY');
  assert.equal(getMessagePriority('ROSTER_NEWS'), 'INFO');
  assert.equal(getMessagePriority('NOT_A_CATEGORY'), 'INFO');
});

test('groupMessagesByPriority always returns all 3 PRIORITY_LEVELS in order, each keeping newest-first ordering', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const news1 = createMessage(playerState, worldState, { sender: 'A', category: 'ROSTER_NEWS', title: 't1', body: 'b1' });
  const contract = createMessage(playerState, worldState, {
    sender: 'ECL', category: 'CONTRACT_OFFER', title: 't2', body: 'b2', context: { fighterId: 'f1', orgId: 'ECL' },
  });
  const sponsor = createMessage(playerState, worldState, {
    sender: 'Volt Athletics', category: 'SPONSOR_OFFER', title: 't3', body: 'b3', context: { fighterId: 'f1', offerId: 'SPONSOR_30' },
  });
  const bid = createMessage(playerState, worldState, { sender: 'Rival', category: 'TRANSFER_BID', title: 't4', body: 'b4' });
  const news2 = createMessage(playerState, worldState, { sender: 'B', category: 'ROSTER_NEWS', title: 't5', body: 'b5' });

  const groups = groupMessagesByPriority(playerState);
  assert.deepEqual(groups.map((g) => g.level), PRIORITY_LEVELS);
  assert.deepEqual(groups.map((g) => g.label), PRIORITY_LEVELS.map((level) => PRIORITY_LABELS[level]));

  const priorityGroup = groups.find((g) => g.level === 'PRIORITY');
  assert.deepEqual(priorityGroup.messages.map((m) => m.id), [bid.id, sponsor.id, contract.id], 'newest first within the group');

  const opportunityGroup = groups.find((g) => g.level === 'OPPORTUNITY');
  assert.deepEqual(opportunityGroup.messages, [], 'no category maps to OPPORTUNITY as of V4.3');

  const infoGroup = groups.find((g) => g.level === 'INFO');
  assert.deepEqual(infoGroup.messages.map((m) => m.id), [news2.id, news1.id]);
});

test('groupMessagesByPriority excludes archived messages by default and honors includeArchived', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const news = createMessage(playerState, worldState, { sender: 'A', category: 'ROSTER_NEWS', title: 't', body: 'b' });
  archiveMessage(playerState, news.id);

  const withoutArchived = groupMessagesByPriority(playerState);
  assert.deepEqual(withoutArchived.find((g) => g.level === 'INFO').messages, []);

  const withArchived = groupMessagesByPriority(playerState, { includeArchived: true });
  assert.equal(withArchived.find((g) => g.level === 'INFO').messages.length, 1);
});

// ---- SPONSOR_OFFER ------------------------------------------------------------

test('evaluateSponsorOffers only fires below WEEKLY_CHANCE, and resolveAction ACCEPT/DECLINE behave correctly', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 10 });
  const worldState = new WorldState();
  const cfg = BALANCE.INBOX.SPONSOR_OFFER;

  assert.equal(evaluateSponsorOffers(playerState, worldState, () => cfg.WEEKLY_CHANCE), null);

  const message = evaluateSponsorOffers(playerState, worldState, () => 0);
  assert.ok(message);
  assert.equal(message.category, 'SPONSOR_OFFER');
  assert.ok(message.context.amount >= cfg.MIN_AMOUNT);

  const moneyBefore = playerState.money;
  const reputationBefore = playerState.reputation;
  const result = resolveAction(playerState, worldState, message.id, 'ACCEPT');
  assert.equal(result.success, true);
  assert.equal(playerState.money, moneyBefore + message.context.amount);
  assert.equal(playerState.reputation, reputationBefore + cfg.REPUTATION_BONUS);
  assert.equal(getMessages(playerState).length, 0, 'accepted offer is archived');

  const second = createMessage(playerState, worldState, {
    sender: 'X', category: 'SPONSOR_OFFER', title: 't', body: 'b',
    actions: [{ id: 'ACCEPT', label: 'Accepter' }, { id: 'DECLINE', label: 'Refuser' }],
    context: { amount: 500, reputationBonus: 2 },
  });
  const moneyBeforeDecline = playerState.money;
  const declineResult = resolveAction(playerState, worldState, second.id, 'DECLINE');
  assert.equal(declineResult.success, true);
  assert.equal(playerState.money, moneyBeforeDecline, 'declining a sponsor offer must not move money');
});

// ---- TRANSFER_BID (V4.3 "Debauchage Rival") ------------------------------------

test('evaluateTransferBids does nothing with no rival gyms, no eligible fighter, or a failed roll', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const target = makeTransferTargetFighter();
  playerState.addFighter(target);

  assert.equal(evaluateTransferBids(playerState, worldState, () => 0), null, 'no rival gyms yet');

  worldState.addRivalGym({ name: 'Rival Gym', reputation: 40 });
  assert.equal(evaluateTransferBids(playerState, worldState, () => 0.99), null, 'roll never clears WEEKLY_CHANCE_PER_FIGHTER');

  const unremarkable = makeStrongFighter({ identity: { id: 'f2', name: 'Unremarkable', gender: 'M', weightClass: 'Poids Welter' } });
  const unremarkableOnlyPlayer = new PlayerState({ money: 25000 });
  unremarkableOnlyPlayer.addFighter(unremarkable);
  const worldWithGym = new WorldState();
  worldWithGym.addRivalGym({ name: 'Rival Gym', reputation: 40 });
  assert.equal(
    evaluateTransferBids(unremarkableOnlyPlayer, worldWithGym, () => 0),
    null,
    'clearing none of HYPE_THRESHOLD/WIN_STREAK_THRESHOLD/isChampion never bids'
  );
});

test('evaluateTransferBids fires for a fighter above HYPE_THRESHOLD; BaseValue matches Overall*200 + Hype*150; resolveAction ACCEPT sells them to the bidding rival gym', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const target = makeTransferTargetFighter();
  playerState.addFighter(target);
  const gym = worldState.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [] });

  const message = evaluateTransferBids(playerState, worldState, () => 0);
  assert.ok(message);
  assert.equal(message.category, 'TRANSFER_BID');
  assert.equal(message.context.fighterId, 'f1');
  assert.equal(message.context.gymId, gym.id);
  const cfg = BALANCE.MERCATO.RIVAL_TRANSFER_TARGET;
  assert.equal(message.context.fee, Math.round(target.getOverallRating() * cfg.OVERALL_MULTIPLIER + target.attributes.hype * cfg.HYPE_MULTIPLIER));
  assert.deepEqual(message.actions.map((a) => a.id).sort(), ['ACCEPT', 'COUNTER', 'DECLINE'].sort());

  // A second roll must not duplicate a bid already pending on the same fighter.
  assert.equal(evaluateTransferBids(playerState, worldState, () => 0), null);

  const moneyBefore = playerState.money;
  const result = resolveAction(playerState, worldState, message.id, 'ACCEPT');
  assert.equal(result.success, true);
  assert.equal(result.fee, message.context.fee);
  assert.equal(playerState.money, moneyBefore + message.context.fee);
  assert.equal(playerState.getFighter('f1'), undefined, 'the sold fighter leaves the player roster');

  const updatedGym = worldState.rivalGyms.find((entry) => entry.id === gym.id);
  assert.ok(updatedGym.roster.some((entry) => entry.identity.id === 'f1'), 'the sold fighter joins the rival gym roster');
});

test('evaluateTransferBids also fires for a >=3 win streak or a champion, independent of Hype', () => {
  const worldState = new WorldState();
  worldState.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [] });

  const streaker = new Fighter({ identity: { id: 'f1', name: 'Streaker', gender: 'M', weightClass: 'Poids Welter' } });
  streaker.recordFightResult({ outcome: 'win' });
  streaker.recordFightResult({ outcome: 'win' });
  streaker.recordFightResult({ outcome: 'win' });
  const streakerPlayer = new PlayerState({ money: 25000 });
  streakerPlayer.addFighter(streaker);
  assert.ok(evaluateTransferBids(streakerPlayer, worldState, () => 0), 'a 3-win streak alone clears WIN_STREAK_THRESHOLD');
});

test('resolveAction DECLINE on a TRANSFER_BID keeps the fighter on the player roster, moves no money, and only penalizes Loyalty when the fighter wanted to leave', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 40 }); // hype 60 vs reputation 40 -> a 20-point gap, below HYPE_OUTGROWS_GYM_GAP (30); loyalty starts healthy too.
  const worldState = new WorldState();
  const target = makeTransferTargetFighter();
  playerState.addFighter(target);
  worldState.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [] });

  const message = evaluateTransferBids(playerState, worldState, () => 0);
  assert.equal(message.context.wantsToLeave, false, 'neither trigger condition holds');
  const loyaltyBefore = target.psychology.loyalty;
  const moneyBefore = playerState.money;
  const result = resolveAction(playerState, worldState, message.id, 'DECLINE');

  assert.equal(result.success, true);
  assert.equal(result.loyaltyPenalty, false);
  assert.equal(playerState.money, moneyBefore);
  assert.equal(target.psychology.loyalty, loyaltyBefore, 'no Loyalty penalty when the fighter did not want to leave');
  assert.ok(playerState.getFighter('f1'));
});

test('resolveAction DECLINE knocks -5 Loyalty when the fighter wanted to leave (context.wantsToLeave snapshotted at bid creation)', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 40 });
  const worldState = new WorldState();
  const target = makeTransferTargetFighter();
  target.adjustLoyalty(-40); // 60 starting -> 20, below LOW_LOYALTY_THRESHOLD (35) but with headroom left to still drop 5 more.
  playerState.addFighter(target);
  worldState.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [] });

  const message = evaluateTransferBids(playerState, worldState, () => 0);
  assert.equal(message.context.wantsToLeave, true);
  const loyaltyBefore = target.psychology.loyalty;
  const result = resolveAction(playerState, worldState, message.id, 'DECLINE');

  assert.equal(result.loyaltyPenalty, true);
  assert.equal(target.psychology.loyalty, loyaltyBefore - 5);
});

test('resolveAction COUNTER sells at fee*1.25 when the rival AI accepts, and walks away (no money, fighter stays) otherwise', () => {
  const cfg = BALANCE.MERCATO.RIVAL_TRANSFER_TARGET;

  // Accepted path: rng() < COUNTER_OFFER_ACCEPT_CHANCE.
  const acceptedPlayer = new PlayerState({ money: 25000 });
  const acceptedWorld = new WorldState();
  const acceptedTarget = makeTransferTargetFighter();
  acceptedPlayer.addFighter(acceptedTarget);
  acceptedWorld.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [] });
  const acceptedMessage = evaluateTransferBids(acceptedPlayer, acceptedWorld, () => 0);
  const moneyBefore = acceptedPlayer.money;
  const acceptedResult = resolveAction(acceptedPlayer, acceptedWorld, acceptedMessage.id, 'COUNTER', () => 0);

  assert.equal(acceptedResult.success, true);
  assert.equal(acceptedResult.countered, true);
  assert.equal(acceptedResult.accepted, true);
  assert.equal(acceptedResult.fee, Math.round(acceptedMessage.context.fee * cfg.COUNTER_OFFER_MULTIPLIER));
  assert.equal(acceptedPlayer.money, moneyBefore + acceptedResult.fee);
  assert.equal(acceptedPlayer.getFighter('f1'), undefined, 'sold at the bumped fee');

  // Rejected path: rng() >= COUNTER_OFFER_ACCEPT_CHANCE — the rival walks away.
  const rejectedPlayer = new PlayerState({ money: 25000 });
  const rejectedWorld = new WorldState();
  const rejectedTarget = makeTransferTargetFighter();
  rejectedPlayer.addFighter(rejectedTarget);
  rejectedWorld.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [] });
  const rejectedMessage = evaluateTransferBids(rejectedPlayer, rejectedWorld, () => 0);
  const moneyBeforeRejected = rejectedPlayer.money;
  const rejectedResult = resolveAction(rejectedPlayer, rejectedWorld, rejectedMessage.id, 'COUNTER', () => 0.999);

  assert.equal(rejectedResult.success, true);
  assert.equal(rejectedResult.countered, true);
  assert.equal(rejectedResult.accepted, false);
  assert.equal(rejectedPlayer.money, moneyBeforeRejected, 'no money changes hands when the rival walks away');
  assert.ok(rejectedPlayer.getFighter('f1'), 'the fighter stays on the roster');
  assert.equal(getMessages(rejectedPlayer).length, 0, 'the withdrawn offer is archived either way');
});

// ---- ROSTER_NEWS ----------------------------------------------------------------

test('evaluateRosterNews alerts once per low-loyalty fighter, never duplicating while the alert is still unarchived', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighter = makeStrongFighter();
  playerState.addFighter(fighter);
  fighter.adjustLoyalty(-999); // clamps to PSYCHOLOGY.MIN, well below LOW_LOYALTY_THRESHOLD.

  const first = evaluateRosterNews(playerState, worldState);
  assert.equal(first.length, 1);
  assert.equal(first[0].category, 'ROSTER_NEWS');
  assert.equal(first[0].context.fighterId, 'f1');

  const second = evaluateRosterNews(playerState, worldState);
  assert.deepEqual(second, [], 'no duplicate alert while the first is still active');

  archiveMessage(playerState, first[0].id);
  const third = evaluateRosterNews(playerState, worldState);
  assert.equal(third.length, 1, 'dismissing the old alert allows a fresh one');
});

test('evaluateRosterNews (V4.3) also alerts once per fighter whose Hype has outgrown the gym Reputation, independently of the Loyalty alert', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 5 });
  const worldState = new WorldState();
  const fighter = makeTransferTargetFighter(); // hype 60, healthy loyalty — reputation 5 means a 55-point gap, well past HYPE_OUTGROWS_GYM_GAP (30).
  playerState.addFighter(fighter);

  const first = evaluateRosterNews(playerState, worldState);
  assert.equal(first.length, 1);
  assert.equal(first[0].context.alertType, 'HYPE_OUTGROWS_GYM');

  const second = evaluateRosterNews(playerState, worldState);
  assert.deepEqual(second, [], 'no duplicate alert while the first is still active');

  archiveMessage(playerState, first[0].id);
  const third = evaluateRosterNews(playerState, worldState);
  assert.equal(third.length, 1, 'dismissing the old alert allows a fresh one');
});

test('evaluateRosterNews can fire BOTH alert types the same call for a fighter who is both unhappy and has outgrown the gym', () => {
  const playerState = new PlayerState({ money: 25000, reputation: 5 });
  const worldState = new WorldState();
  const fighter = makeTransferTargetFighter();
  fighter.adjustLoyalty(-999);
  playerState.addFighter(fighter);

  const created = evaluateRosterNews(playerState, worldState);
  assert.deepEqual(created.map((m) => m.context.alertType).sort(), ['HYPE_OUTGROWS_GYM', 'LOW_LOYALTY']);
});

test('evaluateRosterNews stays silent for a fighter at/above the loyalty threshold', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const fighter = makeStrongFighter();
  playerState.addFighter(fighter);

  assert.deepEqual(evaluateRosterNews(playerState, worldState), []);
});

test('resolveAction reports MESSAGE_NOT_FOUND, ALREADY_RESOLVED, and UNSUPPORTED_CATEGORY (CONTRACT_OFFER routes through LeagueEngine instead)', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();

  assert.equal(resolveAction(playerState, worldState, 'missing', 'ACCEPT').reason, 'MESSAGE_NOT_FOUND');

  const contractOffer = createMessage(playerState, worldState, {
    sender: 'ECL', category: 'CONTRACT_OFFER', title: 't', body: 'b',
    actions: [{ id: 'ACCEPT', label: 'Signer' }],
    context: { fighterId: 'f1', orgId: 'ECL' },
  });
  assert.equal(resolveAction(playerState, worldState, contractOffer.id, 'ACCEPT').reason, 'UNSUPPORTED_CATEGORY');

  const dismissed = createMessage(playerState, worldState, { sender: 'X', category: 'ROSTER_NEWS', title: 't', body: 'b', actions: [{ id: 'DISMISS', label: 'OK' }] });
  archiveMessage(playerState, dismissed.id);
  assert.equal(resolveAction(playerState, worldState, dismissed.id, 'DISMISS').reason, 'ALREADY_RESOLVED');
});

test('resolveAction routes a V4.2 fighter-level SPONSOR_OFFER (context.fighterId present) to UNSUPPORTED_CATEGORY, leaving it for SponsorEngine.js', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();

  const fighterSponsorOffer = createMessage(playerState, worldState, {
    sender: 'Volt Athletics', category: 'SPONSOR_OFFER', title: 't', body: 'b',
    actions: [{ id: 'ACCEPT', label: 'Signer le sponsor' }, { id: 'DECLINE', label: 'Refuser' }],
    context: { fighterId: 'f1', offerId: 'SPONSOR_30' },
  });
  const result = resolveAction(playerState, worldState, fighterSponsorOffer.id, 'ACCEPT');
  assert.equal(result.reason, 'UNSUPPORTED_CATEGORY');
  assert.equal(playerState.money, 25000, 'must not touch money — this is not the gym-wide flow');
  assert.equal(getMessages(playerState).length, 1, 'left unresolved for the UI to route through SponsorEngine.js');
});
