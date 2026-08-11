/**
 * engine/FightWeekEngine.test.js
 * Run with: node --test engine/FightWeekEngine.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import { WorldState } from '../state/WorldState.js';
import { PlayerState } from '../state/PlayerState.js';
import {
  scheduleFight,
  getDaysUntilFight,
  isFightWeek,
  isFightDue,
  setCampOrientation,
  applyWeeklyCampOrientation,
  setWeightCutChoice,
  resolveWeightCutProfileKey,
  setLogisticsChoice,
  cancelScheduledFight,
} from './FightWeekEngine.js';

function makeOpponentSnapshot(id = 'rival-fighter') {
  return new Fighter({ identity: { id, name: 'Rival Fighter', age: 26 } }).toJSON();
}

function makeBookedGame({ money = 100000, fightDay } = {}) {
  const world = new WorldState();
  const player = new PlayerState({ money });
  const fighter = new Fighter({ identity: { id: 'booked-fighter', name: 'Booked Fighter', age: 27 } });
  player.addFighter(fighter);

  const record = scheduleFight(player, world, {
    fighterId: fighter.identity.id,
    opponentSnapshot: makeOpponentSnapshot(),
    gymId: 'rival-gym',
    galaId: 'gala-1',
    orgId: 'LOCAL_FIGHTING',
    fightDay: fightDay ?? world.currentDay + 21,
  });

  return { world, player, fighter, record };
}

// ---- scheduleFight -------------------------------------------------------------

test('scheduleFight stores a Fight Launch Contract with the given fightDay/opponentSnapshot on PlayerState', () => {
  const { world, player, record } = makeBookedGame({ fightDay: 100 });
  const cfg = BALANCE.FIGHT_WEEK;

  assert.equal(player.scheduledFight, record);
  assert.equal(record.fightDay, 100);
  assert.equal(record.scheduledDay, world.currentDay);
  assert.equal(record.opponentId, 'rival-fighter');
  assert.equal(record.opponentSnapshot.identity.id, 'rival-fighter');
  assert.equal(record.gymId, 'rival-gym');
  assert.equal(record.galaId, 'gala-1');
  assert.equal(record.campOrientation, cfg.DEFAULT_CAMP_ORIENTATION);
  assert.deepEqual(record.campLog, []);
  assert.equal(record.weightCutChoice, null);
  assert.equal(record.logisticsChoice, null);
});

test('scheduleFight defaults gymId/galaId to null for an independent (gym-less) opponent', () => {
  const world = new WorldState();
  const player = new PlayerState();
  const fighter = new Fighter({ identity: { id: 'f1', name: 'F1', age: 25 } });
  player.addFighter(fighter);

  const record = scheduleFight(player, world, {
    fighterId: 'f1',
    opponentSnapshot: makeOpponentSnapshot('independent-1'),
    orgId: 'APEX',
    fightDay: 50,
  });

  assert.equal(record.gymId, null);
  assert.equal(record.galaId, null);
});

test('scheduling a new fight replaces any previous booking', () => {
  const { world, player } = makeBookedGame();
  const first = player.scheduledFight;

  const second = scheduleFight(player, world, {
    fighterId: 'booked-fighter',
    opponentSnapshot: makeOpponentSnapshot('other-fighter'),
    gymId: 'other-gym',
    orgId: 'ECL',
    fightDay: world.currentDay + 14,
  });

  assert.notEqual(player.scheduledFight, first);
  assert.equal(player.scheduledFight, second);
  assert.equal(player.scheduledFight.gymId, 'other-gym');
});

// ---- countdown helpers ----------------------------------------------------------

test('getDaysUntilFight/isFightWeek/isFightDue track the countdown correctly', () => {
  const { world, record } = makeBookedGame();
  const daysPerWeek = BALANCE.CALENDAR.DAYS_PER_WEEK;

  assert.equal(getDaysUntilFight(record, record.fightDay - 20), 20);
  assert.equal(getDaysUntilFight(record, record.fightDay + 5), 0, 'never negative once the date has passed');

  assert.equal(isFightWeek(record, record.fightDay - daysPerWeek - 1), false);
  assert.equal(isFightWeek(record, record.fightDay - daysPerWeek), true);
  assert.equal(isFightWeek(record, record.fightDay - 1), true);

  assert.equal(isFightDue(record, record.fightDay - 1), false);
  assert.equal(isFightDue(record, record.fightDay), true);
  assert.equal(isFightDue(record, record.fightDay + 3), true);
});

// ---- camp orientation -----------------------------------------------------------

test('setCampOrientation rejects an unknown orientation id', () => {
  const { player } = makeBookedGame();
  assert.throws(() => setCampOrientation(player, 'NOT_A_REAL_ORIENTATION'));
});

test('setCampOrientation updates the booking', () => {
  const { player } = makeBookedGame();
  setCampOrientation(player, 'CARDIO_FOCUS');
  assert.equal(player.scheduledFight.campOrientation, 'CARDIO_FOCUS');
});

test('applyWeeklyCampOrientation grows the chosen orientation\'s skills and costs fatigue, logging the week', () => {
  const { world, player, fighter } = makeBookedGame();
  setCampOrientation(player, 'CARDIO_FOCUS');
  const cfg = BALANCE.FIGHT_WEEK.CAMP_ORIENTATIONS.CARDIO_FOCUS;
  const before = { cardio: fighter.attributes.skills.cardio, physicalFatigue: fighter.attributes.physicalFatigue, mentalFatigue: fighter.attributes.mentalFatigue };

  const logEntry = applyWeeklyCampOrientation(player, world);

  assert.ok(logEntry);
  assert.equal(logEntry.orientationId, 'CARDIO_FOCUS');
  assert.equal(fighter.attributes.skills.cardio, before.cardio + cfg.skillGainPerWeek);
  assert.equal(fighter.attributes.physicalFatigue, before.physicalFatigue + cfg.physicalFatiguePerWeek);
  assert.equal(fighter.attributes.mentalFatigue, before.mentalFatigue + cfg.mentalFatiguePerWeek);
  assert.equal(player.scheduledFight.campLog.length, 1);
  assert.equal(player.scheduledFight.campLog[0].orientationId, 'CARDIO_FOCUS');
});

test('applyWeeklyCampOrientation is a no-op once fight week has started (camps taper)', () => {
  const { world, player, fighter, record } = makeBookedGame();
  world.currentDay = record.fightDay - BALANCE.CALENDAR.DAYS_PER_WEEK; // exactly fight week
  const skillBefore = fighter.attributes.skills.cardio;

  const result = applyWeeklyCampOrientation(player, world);

  assert.equal(result, null);
  assert.equal(fighter.attributes.skills.cardio, skillBefore);
  assert.equal(player.scheduledFight.campLog.length, 0);
});

test('applyWeeklyCampOrientation is a no-op when nothing is booked', () => {
  const world = new WorldState();
  const player = new PlayerState();
  assert.equal(applyWeeklyCampOrientation(player, world), null);
});

test('applyWeeklyCampOrientation is a safe no-op if the booked fighter left the roster mid-camp', () => {
  const { world, player } = makeBookedGame();
  player.removeFighter('booked-fighter');
  assert.equal(applyWeeklyCampOrientation(player, world), null);
});

// ---- weight cut choice ------------------------------------------------------------

test('setWeightCutChoice rejects an unknown choice id', () => {
  const { player } = makeBookedGame();
  assert.throws(() => setWeightCutChoice(player, 'NOT_A_REAL_CHOICE'));
});

test('setWeightCutChoice updates the booking, and resolveWeightCutProfileKey maps it to the right WEIGH_IN profile', () => {
  const { player } = makeBookedGame();

  assert.equal(resolveWeightCutProfileKey(player.scheduledFight), 'NATUREL', 'defaults to NATUREL before any choice is made');

  setWeightCutChoice(player, 'EXTREME');
  assert.equal(player.scheduledFight.weightCutChoice, 'EXTREME');
  assert.equal(resolveWeightCutProfileKey(player.scheduledFight), 'EXTREME');

  setWeightCutChoice(player, 'PRUDENT');
  assert.equal(resolveWeightCutProfileKey(player.scheduledFight), 'NATUREL', 'PRUDENT maps onto the existing NATUREL WEIGH_IN profile');
});

// ---- logistics choice -------------------------------------------------------------

test('setLogisticsChoice fails cleanly with no booking, insufficient funds, or an already-made choice', () => {
  const emptyPlayer = new PlayerState();
  assert.equal(setLogisticsChoice(emptyPlayer, 'STANDARD').reason, 'NO_SCHEDULED_FIGHT');

  const { player: poorPlayer } = makeBookedGame({ money: 0 });
  const poorResult = setLogisticsChoice(poorPlayer, 'LUXE');
  assert.equal(poorResult.success, false);
  assert.equal(poorResult.reason, 'INSUFFICIENT_FUNDS');

  const { player } = makeBookedGame();
  assert.equal(setLogisticsChoice(player, 'STANDARD').success, true);
  const secondAttempt = setLogisticsChoice(player, 'LUXE');
  assert.equal(secondAttempt.success, false);
  assert.equal(secondAttempt.reason, 'ALREADY_CHOSEN');
});

test('setLogisticsChoice rejects an unknown choice id', () => {
  const { player } = makeBookedGame();
  assert.throws(() => setLogisticsChoice(player, 'NOT_A_REAL_CHOICE'));
});

test('LUXE logistics deducts cost, boosts morale, and reduces physical fatigue', () => {
  const { player, fighter } = makeBookedGame();
  const cfg = BALANCE.FIGHT_WEEK.LOGISTICS.LUXE;
  const moneyBefore = player.money;
  const moraleBefore = fighter.attributes.moral;
  const fatigueBefore = fighter.attributes.physicalFatigue;

  const result = setLogisticsChoice(player, 'LUXE');

  assert.equal(result.success, true);
  assert.equal(result.cost, cfg.cost);
  assert.equal(player.money, moneyBefore - cfg.cost);
  assert.equal(fighter.attributes.moral, moraleBefore + cfg.moraleDelta);
  assert.equal(fighter.attributes.physicalFatigue, Math.max(0, fatigueBefore + cfg.physicalFatigueDelta));
  assert.equal(player.scheduledFight.logisticsChoice, 'LUXE');
});

test('ECONOMIQUE logistics is cheaper but hurts morale and adds fatigue', () => {
  const { player, fighter } = makeBookedGame();
  const cfg = BALANCE.FIGHT_WEEK.LOGISTICS.ECONOMIQUE;
  const moraleBefore = fighter.attributes.moral;

  const result = setLogisticsChoice(player, 'ECONOMIQUE');

  assert.equal(result.success, true);
  assert.equal(result.cost, cfg.cost);
  assert.ok(cfg.cost < BALANCE.FIGHT_WEEK.LOGISTICS.LUXE.cost);
  assert.equal(fighter.attributes.moral, moraleBefore + cfg.moraleDelta);
});

// ---- cancellation -----------------------------------------------------------------

test('cancelScheduledFight clears the booking outright', () => {
  const { player } = makeBookedGame();
  assert.ok(player.scheduledFight);
  cancelScheduledFight(player);
  assert.equal(player.scheduledFight, null);
});
