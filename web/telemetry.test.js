/**
 * web/telemetry.test.js
 * Run with: node --test web/telemetry.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import { Telemetry } from './telemetry.js';

/** In-memory storage adapter, one per test, so tests never share state through a real localStorage. */
function memoryAdapter() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
}

function fighterWithMoral(id, moral) {
  return { identity: { id }, attributes: { moral } };
}

function fakePlayerState(roster, money = 1000) {
  return { roster, money };
}

test('startSession opens a fresh session, and a second startSession() closes out the first one into sessions[]', () => {
  const telemetry = new Telemetry(memoryAdapter());
  telemetry.startSession();
  telemetry.recordWeekResolved();
  telemetry.recordWeekResolved();
  telemetry.recordWeekResolved();

  telemetry.startSession();
  const summary = telemetry.getSummary();

  assert.equal(summary.sessions.length, 2, 'the closed-out first session plus the freshly-opened second one');
  assert.equal(summary.sessions[0].weeksPlayed, 3);
  assert.equal(summary.sessions[1].weeksPlayed, 0);
  assert.equal(summary.totalWeeksPlayed, 3);
});

test('recordWeekResolved auto-starts a session if none is open yet', () => {
  const telemetry = new Telemetry(memoryAdapter());
  telemetry.recordWeekResolved();
  telemetry.recordWeekResolved();

  assert.equal(telemetry.getSummary().totalWeeksPlayed, 2);
});

test('telemetry state round-trips through a persisted storage adapter across separate Telemetry instances', () => {
  const adapter = memoryAdapter();
  const first = new Telemetry(adapter);
  first.startSession();
  first.recordWeekResolved();
  first.recordDramaChoice('SPONSOR_OFFER', 'accept');

  const second = new Telemetry(adapter);
  const summary = second.getSummary();
  assert.equal(summary.totalWeeksPlayed, 1);
  assert.equal(summary.dramaChoiceCounts['SPONSOR_OFFER:accept'], 1);
});

test('recordDramaChoice logs each pick and tallies counts per (eventId, choiceId) pair', () => {
  const telemetry = new Telemetry(memoryAdapter());
  telemetry.recordDramaChoice('SPONSOR_OFFER', 'accept');
  telemetry.recordDramaChoice('SPONSOR_OFFER', 'accept');
  telemetry.recordDramaChoice('SPONSOR_OFFER', 'decline');

  const summary = telemetry.getSummary();
  assert.equal(summary.dramaChoiceCounts['SPONSOR_OFFER:accept'], 2);
  assert.equal(summary.dramaChoiceCounts['SPONSOR_OFFER:decline'], 1);
});

test('fighter retention: retentionRate is null until at least one fighter has ever been recruited, then reflects currentRosterSize / totalFightersRecruited', () => {
  const telemetry = new Telemetry(memoryAdapter());
  assert.equal(telemetry.getSummary(5).retentionRate, null);

  for (let i = 0; i < 6; i += 1) telemetry.recordFighterRecruited();
  assert.equal(telemetry.getSummary(6).retentionRate, 1);
  assert.equal(telemetry.getSummary(3).retentionRate, 0.5);
});

test('bankruptcy frustration signal is edge-triggered: logs once on going negative, not once per week while negative, and can re-trigger after a recovery', () => {
  const telemetry = new Telemetry(memoryAdapter());
  const player = fakePlayerState([], 1000);

  telemetry.checkFrustrationSignals(player);
  assert.equal(telemetry.getSummary().frustrationEvents.length, 0);

  player.money = -50;
  telemetry.checkFrustrationSignals(player);
  telemetry.checkFrustrationSignals(player);
  telemetry.checkFrustrationSignals(player);
  let events = telemetry.getSummary().frustrationEvents.filter((e) => e.type === 'BANKRUPTCY');
  assert.equal(events.length, 1, 'staying negative for several checks should not re-log the same bankruptcy');

  player.money = 200;
  telemetry.checkFrustrationSignals(player);
  player.money = -10;
  telemetry.checkFrustrationSignals(player);
  events = telemetry.getSummary().frustrationEvents.filter((e) => e.type === 'BANKRUPTCY');
  assert.equal(events.length, 2, 'a fresh dip into insolvency after recovering should log again');
});

test('prolonged low morale frustration signal fires exactly once when the streak crosses BALANCE.TELEMETRY.LOW_MORALE_STREAK_WEEKS_THRESHOLD, not every week after', () => {
  const telemetry = new Telemetry(memoryAdapter());
  const threshold = BALANCE.TELEMETRY.LOW_MORALE_STREAK_WEEKS_THRESHOLD;
  const roster = [fighterWithMoral('f1', BALANCE.TELEMETRY.LOW_MORALE_THRESHOLD - 5)];
  const player = fakePlayerState(roster);

  for (let week = 1; week <= threshold + 3; week += 1) {
    telemetry.checkFrustrationSignals(player);
  }

  const events = telemetry.getSummary().frustrationEvents.filter((e) => e.type === 'LOW_MORALE_PROLONGED');
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.fighterId, 'f1');
});

test('a morale recovery above the threshold resets the streak, so a later dip needs the full streak again before re-triggering', () => {
  const telemetry = new Telemetry(memoryAdapter());
  const threshold = BALANCE.TELEMETRY.LOW_MORALE_STREAK_WEEKS_THRESHOLD;
  const lowMoral = BALANCE.TELEMETRY.LOW_MORALE_THRESHOLD - 5;
  const roster = [fighterWithMoral('f1', lowMoral)];
  const player = fakePlayerState(roster);

  for (let week = 1; week < threshold; week += 1) telemetry.checkFrustrationSignals(player);
  assert.equal(telemetry.getSummary().frustrationEvents.length, 0, 'not yet at the threshold');

  roster[0].attributes.moral = 60; // recovers
  telemetry.checkFrustrationSignals(player);
  roster[0].attributes.moral = lowMoral; // dips again
  for (let week = 1; week < threshold; week += 1) telemetry.checkFrustrationSignals(player);
  assert.equal(telemetry.getSummary().frustrationEvents.length, 0, 'the reset streak should not have reached the threshold yet');

  telemetry.checkFrustrationSignals(player);
  assert.equal(telemetry.getSummary().frustrationEvents.length, 1);
});

test('a fighter who leaves the roster stops accumulating (and cannot retroactively trigger) a morale streak', () => {
  const telemetry = new Telemetry(memoryAdapter());
  const threshold = BALANCE.TELEMETRY.LOW_MORALE_STREAK_WEEKS_THRESHOLD;
  const lowMoral = BALANCE.TELEMETRY.LOW_MORALE_THRESHOLD - 5;
  const roster = [fighterWithMoral('f1', lowMoral)];
  const player = fakePlayerState(roster);

  for (let week = 1; week < threshold; week += 1) telemetry.checkFrustrationSignals(player);
  roster.length = 0; // f1 retires mid-streak
  for (let week = 1; week <= threshold; week += 1) telemetry.checkFrustrationSignals(player);

  assert.equal(telemetry.getSummary().frustrationEvents.length, 0);
});

test('exportAsJSON returns parseable JSON matching getSummary, and never leaks player-identifying fields', () => {
  const telemetry = new Telemetry(memoryAdapter());
  telemetry.startSession();
  telemetry.recordWeekResolved();
  telemetry.recordDramaChoice('SPONSOR_OFFER', 'accept');
  telemetry.recordFighterRecruited();

  const json = telemetry.exportAsJSON(1);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, telemetry.getSummary(1));
  assert.ok(!json.includes('gymName'));
});

test('a corrupted or unrecognized-version storage payload is treated as empty rather than throwing', () => {
  const adapter = memoryAdapter();
  adapter.setItem('mma_gym_manager.telemetry', 'not json at all {{{');
  const telemetry = new Telemetry(adapter);
  assert.equal(telemetry.getSummary().totalWeeksPlayed, 0);

  const adapter2 = memoryAdapter();
  adapter2.setItem('mma_gym_manager.telemetry', JSON.stringify({ version: 999, sessions: [{ weeksPlayed: 42 }] }));
  const telemetry2 = new Telemetry(adapter2);
  assert.equal(telemetry2.getSummary().totalWeeksPlayed, 0);
});
