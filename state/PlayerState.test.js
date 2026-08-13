/**
 * state/PlayerState.test.js
 * Run with: node --test state/PlayerState.test.js
 *
 * Focused coverage for Phase V2.6's awardCoachTrophy() — the rest of
 * PlayerState is already exercised indirectly across the engine test suite
 * (EconomyEngine.test.js, TrainingEngine.test.js, DramaEngine.test.js, etc.).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PlayerState } from './PlayerState.js';

test('awardCoachTrophy appends a copy to coach.awards, creating it on first use, and returns false for an unknown coach', () => {
  const player = new PlayerState();
  const coach = player.addCoach({ name: 'Mentor Coach', skill: 70 });

  assert.equal(player.awardCoachTrophy(coach.id, { category: 'COACH_OF_THE_YEAR', label: "Coach de l'Annee", year: 1 }), true);
  assert.deepEqual(coach.awards, [{ category: 'COACH_OF_THE_YEAR', label: "Coach de l'Annee", year: 1 }]);

  player.awardCoachTrophy(coach.id, { category: 'COACH_OF_THE_YEAR', label: "Coach de l'Annee", year: 2 });
  assert.equal(coach.awards.length, 2);

  assert.equal(player.awardCoachTrophy('nonexistent-coach-id', { category: 'X', label: 'X', year: 1 }), false);
});

test('coach.awards round-trips through toJSON/fromJSON as an independent copy (not a shared array reference)', () => {
  const player = new PlayerState();
  const coach = player.addCoach({ name: 'Mentor Coach', skill: 70 });
  player.awardCoachTrophy(coach.id, { category: 'COACH_OF_THE_YEAR', label: "Coach de l'Annee", year: 1 });

  const snapshot = player.toJSON();
  assert.deepEqual(snapshot.coaches[0].awards, [{ category: 'COACH_OF_THE_YEAR', label: "Coach de l'Annee", year: 1 }]);

  // Mutating the live coach's awards after snapshotting must not leak into the already-taken snapshot.
  player.awardCoachTrophy(coach.id, { category: 'COACH_OF_THE_YEAR', label: "Coach de l'Annee", year: 2 });
  assert.equal(snapshot.coaches[0].awards.length, 1);

  const rebuilt = PlayerState.fromJSON(snapshot);
  assert.deepEqual(rebuilt.coaches[0].awards, [{ category: 'COACH_OF_THE_YEAR', label: "Coach de l'Annee", year: 1 }]);
});

test('a coach with no awards yet serializes without an awards field', () => {
  const player = new PlayerState();
  player.addCoach({ name: 'Fresh Coach', skill: 40 });

  const snapshot = player.toJSON();
  assert.equal('awards' in snapshot.coaches[0], false);
});

test('seizeFacilityLevel decrements equipLevel by 1 with no cost, floors at 0, and no-ops (returns false) once already at 0', () => {
  const player = new PlayerState({ equipLevel: 2 });
  const moneyBefore = player.money;

  assert.equal(player.seizeFacilityLevel(), true);
  assert.equal(player.equipLevel, 1);
  assert.equal(player.money, moneyBefore, 'seizure is free — it never touches money, unlike upgradeFacility');

  assert.equal(player.seizeFacilityLevel(), true);
  assert.equal(player.equipLevel, 0);

  assert.equal(player.seizeFacilityLevel(), false, 'nothing left to seize at equipLevel 0');
  assert.equal(player.equipLevel, 0);
});

test('addActiveDeal/removeActiveDeal manage playerState.activeDeals, and toJSON/fromJSON round-trips them as independent copies', () => {
  const player = new PlayerState();
  assert.deepEqual(player.activeDeals, []);

  const deal = player.addActiveDeal({ type: 'SPONSORSHIP_RAID', weeklyAmount: 2000, weeksRemaining: 10 });
  assert.equal(player.activeDeals.length, 1);
  assert.ok(deal.id, 'addActiveDeal must assign an id when none is provided');

  const snapshot = player.toJSON();
  assert.deepEqual(snapshot.activeDeals, [deal]);

  assert.equal(player.removeActiveDeal(deal.id), true);
  assert.equal(player.activeDeals.length, 0);
  assert.equal(player.removeActiveDeal('nonexistent-deal-id'), false);

  // The earlier snapshot must be unaffected by the later removal (independent copy, not a shared array reference).
  assert.equal(snapshot.activeDeals.length, 1);

  const rebuilt = PlayerState.fromJSON(snapshot);
  assert.deepEqual(rebuilt.activeDeals, [deal]);
  rebuilt.removeActiveDeal(deal.id);
  assert.equal(snapshot.activeDeals.length, 1, 'mutating the rebuilt copy must never reach back into the original snapshot');
});

test('pushInboxMessage/markInboxMessageRead/archiveInboxMessage manage playerState.inbox, and toJSON/fromJSON round-trips it as an independent copy', () => {
  const player = new PlayerState();
  assert.deepEqual(player.inbox, []);

  const message = player.pushInboxMessage({
    sender: 'NordFit',
    category: 'SPONSOR_OFFER',
    title: 'Titre',
    body: 'Corps',
    actions: [{ id: 'ACCEPT', label: 'Accepter' }],
    context: { amount: 1000 },
  });
  assert.ok(message.id, 'pushInboxMessage must assign an id when none is provided');
  assert.equal(message.isRead, false);
  assert.equal(message.isArchived, false);
  assert.equal(player.inbox.length, 1);

  assert.equal(player.markInboxMessageRead(message.id), true);
  assert.equal(player.inbox[0].isRead, true);
  assert.equal(player.markInboxMessageRead(message.id), false, 'already read — no-op reports nothing changed');
  assert.equal(player.markInboxMessageRead('nonexistent-message-id'), false);

  const snapshot = player.toJSON();
  assert.deepEqual(snapshot.inbox, player.inbox);

  assert.equal(player.archiveInboxMessage(message.id), true);
  assert.equal(player.inbox[0].isArchived, true);
  assert.equal(player.archiveInboxMessage(message.id), false, 'already archived — no-op reports nothing changed');
  assert.equal(player.archiveInboxMessage('nonexistent-message-id'), false);

  // The earlier snapshot must be unaffected by the later archive (independent copy, not a shared array/object reference).
  assert.equal(snapshot.inbox[0].isArchived, false);

  const rebuilt = PlayerState.fromJSON(snapshot);
  assert.deepEqual(rebuilt.inbox, snapshot.inbox);
  rebuilt.archiveInboxMessage(message.id);
  assert.equal(snapshot.inbox[0].isArchived, false, 'mutating the rebuilt copy must never reach back into the original snapshot');
});

test('MESSAGE_HISTORY_LIMIT trims the oldest inbox messages first, keeping only the newest ones', () => {
  const player = new PlayerState();
  // Push well past the real BALANCE.INBOX.MESSAGE_HISTORY_LIMIT to confirm trimming happens at all, without hardcoding its exact value here.
  for (let i = 0; i < 200; i += 1) {
    player.pushInboxMessage({ sender: 'X', category: 'ROSTER_NEWS', title: `t${i}`, body: 'b' });
  }
  assert.ok(player.inbox.length < 200, 'the inbox must trim past its own history limit');
  assert.equal(player.inbox[player.inbox.length - 1].title, 't199', 'the newest message must survive trimming');
});
