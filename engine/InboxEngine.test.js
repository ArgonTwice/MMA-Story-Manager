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
  createMessage,
  getMessages,
  getUnreadCount,
  markAsRead,
  archiveMessage,
  evaluateSponsorOffers,
  evaluateTransferBids,
  evaluateRosterNews,
  resolveAction,
} from './InboxEngine.js';

/** A fighter whose getOverallRating() clears BALANCE.INBOX.TRANSFER_BID.MIN_OVERALL. */
function makeStrongFighter(overrides = {}) {
  const skills = { boxe: 75, jambes: 75, sol: 75, soumission: 75, cardio: 75, intelligence: 75 };
  return new Fighter({
    identity: { id: 'f1', name: 'F1', gender: 'M', weightClass: 'Poids Welter' },
    attributes: { skills },
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

// ---- SPONSOR_OFFER ------------------------------------------------------------

test('evaluateSponsorOffers only fires below WEEKLY_CHANCE, and resolveAction ACCEPT/DECLINE behave correctly', () => {
  const playerState = new PlayerState({ money: 25000, hype: 10 });
  const worldState = new WorldState();
  const cfg = BALANCE.INBOX.SPONSOR_OFFER;

  assert.equal(evaluateSponsorOffers(playerState, worldState, () => cfg.WEEKLY_CHANCE), null);

  const message = evaluateSponsorOffers(playerState, worldState, () => 0);
  assert.ok(message);
  assert.equal(message.category, 'SPONSOR_OFFER');
  assert.ok(message.context.amount >= cfg.MIN_AMOUNT);

  const moneyBefore = playerState.money;
  const hypeBefore = playerState.hype;
  const result = resolveAction(playerState, worldState, message.id, 'ACCEPT');
  assert.equal(result.success, true);
  assert.equal(playerState.money, moneyBefore + message.context.amount);
  assert.equal(playerState.hype, hypeBefore + cfg.HYPE_BONUS);
  assert.equal(getMessages(playerState).length, 0, 'accepted offer is archived');

  const second = createMessage(playerState, worldState, {
    sender: 'X', category: 'SPONSOR_OFFER', title: 't', body: 'b',
    actions: [{ id: 'ACCEPT', label: 'Accepter' }, { id: 'DECLINE', label: 'Refuser' }],
    context: { amount: 500, hypeBonus: 2 },
  });
  const moneyBeforeDecline = playerState.money;
  const declineResult = resolveAction(playerState, worldState, second.id, 'DECLINE');
  assert.equal(declineResult.success, true);
  assert.equal(playerState.money, moneyBeforeDecline, 'declining a sponsor offer must not move money');
});

// ---- TRANSFER_BID -------------------------------------------------------------

test('evaluateTransferBids does nothing with no rival gyms, no eligible fighter, or a failed roll', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const strong = makeStrongFighter();
  playerState.addFighter(strong);

  assert.equal(evaluateTransferBids(playerState, worldState, () => 0), null, 'no rival gyms yet');

  worldState.addRivalGym({ name: 'Rival Gym', reputation: 40 });
  assert.equal(evaluateTransferBids(playerState, worldState, () => 0.99), null, 'roll never clears WEEKLY_CHANCE_PER_FIGHTER');

  const weak = new Fighter({ identity: { id: 'f2', name: 'Weak', gender: 'M', weightClass: 'Poids Welter' } });
  const weakOnlyPlayer = new PlayerState({ money: 25000 });
  weakOnlyPlayer.addFighter(weak);
  const worldWithGym = new WorldState();
  worldWithGym.addRivalGym({ name: 'Rival Gym', reputation: 40 });
  assert.equal(evaluateTransferBids(weakOnlyPlayer, worldWithGym, () => 0), null, 'below MIN_OVERALL never bids');
});

test('evaluateTransferBids fires for an eligible fighter, and resolveAction ACCEPT sells them to the bidding rival gym', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const strong = makeStrongFighter();
  playerState.addFighter(strong);
  const gym = worldState.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [] });

  const message = evaluateTransferBids(playerState, worldState, () => 0);
  assert.ok(message);
  assert.equal(message.category, 'TRANSFER_BID');
  assert.equal(message.context.fighterId, 'f1');
  assert.equal(message.context.gymId, gym.id);
  assert.ok(message.context.fee > 0);

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

test('resolveAction DECLINE on a TRANSFER_BID keeps the fighter on the player roster and moves no money', () => {
  const playerState = new PlayerState({ money: 25000 });
  const worldState = new WorldState();
  const strong = makeStrongFighter();
  playerState.addFighter(strong);
  worldState.addRivalGym({ name: 'Rival Gym', reputation: 40, roster: [] });

  const message = evaluateTransferBids(playerState, worldState, () => 0);
  const moneyBefore = playerState.money;
  const result = resolveAction(playerState, worldState, message.id, 'DECLINE');

  assert.equal(result.success, true);
  assert.equal(playerState.money, moneyBefore);
  assert.ok(playerState.getFighter('f1'));
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
