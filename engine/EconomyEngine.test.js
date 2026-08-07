/**
 * engine/EconomyEngine.test.js
 * Run with: node --test engine/EconomyEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import { processWeeklyExpenses, ECONOMY_EVENTS } from './EconomyEngine.js';

test('a normal week deducts rent, coach payroll and equipment upkeep, and credits passive income', () => {
  const player = new PlayerState({ gymName: 'Solvent Gym', money: 1000, reputation: 20, hype: 10 });
  player.addCoach({ name: 'Coach A', skill: 30, salary: 300 });
  player.addEquipmentItem({ id: 'OCTAGON_PRO' });

  const events = [];
  const unsub = EventBus.subscribe(ECONOMY_EVENTS.WEEKLY_PROCESSED, (payload) => events.push(payload));

  const summary = processWeeklyExpenses(player);
  unsub();

  const econ = BALANCE.ECONOMY;
  const expectedRent = econ.BASE_WEEKLY_UPKEEP + player.equipLevel * econ.UPKEEP_PER_FACILITY_LEVEL;
  assert.equal(summary.rent, expectedRent);
  assert.equal(summary.coachPayroll, 300);
  assert.equal(summary.equipmentMaintenance, BALANCE.EQUIPMENT.DEFINITIONS.OCTAGON_PRO.weeklyMaintenanceCost);
  assert.equal(
    summary.passiveIncome,
    econ.PASSIVE_INCOME.BASE_WEEKLY +
      player.reputation * econ.PASSIVE_INCOME.PER_REPUTATION_POINT +
      player.hype * econ.PASSIVE_INCOME.PER_HYPE_POINT
  );
  assert.equal(summary.netChange, summary.passiveIncome - summary.rent - summary.coachPayroll - summary.equipmentMaintenance);
  assert.equal(player.money, 1000 + summary.netChange);
  assert.equal(summary.insolvent, false);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], summary);
});

test('a coach with no explicit salary falls back to BALANCE.ECONOMY.SALARIES.COACH_BASE_WEEKLY', () => {
  const player = new PlayerState({ gymName: 'Default Salary Gym', money: 5000 });
  player.addCoach({ name: 'No Salary Set' });

  const summary = processWeeklyExpenses(player);

  assert.equal(summary.coachPayroll, BALANCE.ECONOMY.SALARIES.COACH_BASE_WEEKLY);
});

test('roster fighters with a weeklySalary set are deducted as fighterPayroll; a fighter with no salary (0) costs nothing', () => {
  const player = new PlayerState({ gymName: 'Payroll Gym', money: 10000 });
  const paidFighter = new Fighter({ identity: { name: 'Paid Fighter' } });
  paidFighter.weeklySalary = 900;
  const freeFighter = new Fighter({ identity: { name: 'Free Fighter' } });
  player.addFighter(paidFighter);
  player.addFighter(freeFighter);

  const summary = processWeeklyExpenses(player);

  assert.equal(summary.fighterPayroll, 900);
  assert.equal(
    summary.netChange,
    summary.passiveIncome - summary.rent - summary.coachPayroll - summary.fighterPayroll - summary.equipmentMaintenance
  );
});

test('breaching the debt threshold triggers an insolvency crisis: lays off the weakest coach and costs reputation', () => {
  const player = new PlayerState({ gymName: 'Bankrupt Gym', money: -4900, reputation: 50 });
  player.addCoach({ name: 'Weak Coach', skill: 10 });
  player.addCoach({ name: 'Strong Coach', skill: 80 });

  // NOTE: PlayerState.changeMoney (see state/PlayerState.js) already fires its
  // own 'economy:insolvent' whenever a single transaction leaves the balance
  // negative — a lighter-weight, per-transaction signal. EconomyEngine's
  // crisis-level event intentionally shares that exact name (as specified),
  // but carries a richer payload (threshold/firedCoachId), so we identify it
  // by shape rather than assuming it's the only 'economy:insolvent' firing.
  const insolventEvents = [];
  const firedEvents = [];
  const unsubA = EventBus.subscribe(ECONOMY_EVENTS.INSOLVENT, (payload) => insolventEvents.push(payload));
  const unsubB = EventBus.subscribe(ECONOMY_EVENTS.STAFF_FIRED_AUTOFINANCE, (payload) => firedEvents.push(payload));

  const repBefore = player.reputation;
  const summary = processWeeklyExpenses(player);
  unsubA();
  unsubB();

  assert.equal(summary.insolvent, true);
  assert.equal(player.coaches.length, 1);
  assert.equal(player.coaches[0].name, 'Strong Coach', 'the lowest-skill coach should be the one let go');
  assert.equal(player.reputation, repBefore + BALANCE.ECONOMY.INSOLVENCY.REPUTATION_PENALTY);

  const crisisEvents = insolventEvents.filter((e) => 'threshold' in e);
  assert.equal(crisisEvents.length, 1, 'exactly one EconomyEngine-level crisis event should have fired');
  assert.equal(firedEvents.length, 1);
  assert.equal(firedEvents[0].reason, 'INSOLVENCY');
  assert.equal(crisisEvents[0].firedCoachId, firedEvents[0].coachId, 'both events should reference the same fired coach');
});

test('an insolvency crisis with no coaches on staff still fires economy:insolvent, without a layoff event', () => {
  const player = new PlayerState({ gymName: 'Broke Solo Gym', money: -4900 });

  const insolventEvents = [];
  const firedEvents = [];
  const unsubA = EventBus.subscribe(ECONOMY_EVENTS.INSOLVENT, (payload) => insolventEvents.push(payload));
  const unsubB = EventBus.subscribe(ECONOMY_EVENTS.STAFF_FIRED_AUTOFINANCE, (payload) => firedEvents.push(payload));

  const summary = processWeeklyExpenses(player);
  unsubA();
  unsubB();

  assert.equal(summary.insolvent, true);
  assert.equal(summary.firedCoachId, null);

  const crisisEvents = insolventEvents.filter((e) => 'threshold' in e);
  assert.equal(crisisEvents.length, 1, 'exactly one EconomyEngine-level crisis event should have fired');
  assert.equal(crisisEvents[0].firedCoachId, null);
  assert.equal(firedEvents.length, 0);
});
