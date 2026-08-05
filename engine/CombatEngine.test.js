/**
 * engine/CombatEngine.test.js
 * ---------------------------------------------------------------------------
 * Functional tests for CombatEngine. Run with:
 *   node --test engine/CombatEngine.test.js
 * or directly:
 *   node engine/CombatEngine.test.js
 *
 * Uses only Node's built-in test runner/assert (node:test, node:assert) —
 * no external dependencies. Randomness is seeded (createSeededRng) so every
 * scenario below is fully reproducible; each seed used was picked by
 * empirically confirming it lands the intended outcome (decision vs KO),
 * not by asserting on the exact numeric values it produces.
 * ---------------------------------------------------------------------------
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import EventBus from '../core/EventBus.js';
import BALANCE from '../data/balance.js';
import Fighter from '../models/Fighter.js';
import PlayerState from '../state/PlayerState.js';
import WorldState from '../state/WorldState.js';
import {
  CombatEngine,
  createSeededRng,
  COMBAT_STATES,
  COMBAT_EVENTS,
  FINISH_METHODS,
} from './CombatEngine.js';

const DECISION_METHODS = new Set([
  FINISH_METHODS.UNANIMOUS_DECISION,
  FINISH_METHODS.SPLIT_DECISION,
  FINISH_METHODS.MAJORITY_DECISION,
  FINISH_METHODS.DRAW,
]);

function makeFighter(name, val, overrides = {}) {
  return new Fighter({
    identity: { name, age: 28, style: 'Freestyle', weightClass: 'Lightweight', ...overrides.identity },
    attributes: {
      skills: { boxe: val, jambes: val, sol: val, soumission: val, cardio: val, intelligence: val },
      ...overrides.attributes,
    },
    career: overrides.career,
  });
}

function collectEvents(eventNames) {
  const events = [];
  const unsubs = eventNames.map((name) => EventBus.subscribe(name, (payload) => events.push([name, payload])));
  return { events, stop: () => unsubs.forEach((unsub) => unsub()) };
}

test('full match reaches a decision when both fighters are even and conservative', () => {
  const { events, stop } = collectEvents(Object.values(COMBAT_EVENTS));

  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const a = makeFighter('Decision A', 40);
  const b = makeFighter('Decision B', 40);

  engine.setupMatch(a, b, 'WFC', false);
  assert.equal(engine.state, COMBAT_STATES.INIT);

  engine.setGameplan('A', { target: 'BODY', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'STRIKING', tempo: 'CONSERVATIVE' });

  const result = engine.simulateFullMatch();
  stop();

  assert.equal(engine.state, COMBAT_STATES.FINISHED);
  assert.ok(DECISION_METHODS.has(result.method), `expected a decision-family method, got ${result.method}`);
  assert.equal(result.round, BALANCE.COMBAT.ROUNDS_PER_FIGHT.UNDERCARD);
  assert.equal(a.career.wins + b.career.wins, result.winner ? 1 : 0);
  assert.equal(a.career.draws, b.career.draws);

  const roundCompleted = events.filter(([name]) => name === COMBAT_EVENTS.ROUND_COMPLETED);
  assert.equal(roundCompleted.length, BALANCE.COMBAT.ROUNDS_PER_FIGHT.UNDERCARD);

  const finished = events.filter(([name]) => name === COMBAT_EVENTS.FINISHED);
  assert.equal(finished.length, 1);
  assert.equal(finished[0][1].method, result.method);
  assert.ok('purses' in finished[0][1]);
  assert.ok('reputationDeltas' in finished[0][1]);
  assert.ok('injuries' in finished[0][1]);

  const stateChanged = events.filter(([name]) => name === COMBAT_EVENTS.STATE_CHANGED);
  assert.ok(stateChanged.length >= 9, 'expected at least 9 state transitions across a full 3-round decision fight');
  assert.deepEqual(
    { from: stateChanged[0][1].from, to: stateChanged[0][1].to },
    { from: COMBAT_STATES.IDLE, to: COMBAT_STATES.INIT }
  );
  assert.equal(stateChanged.at(-1)[1].to, COMBAT_STATES.FINISHED);
});

test('a heavily mismatched, aggressive match ends in a KO before the scheduled distance, and credits the gym', () => {
  const player = new PlayerState({ gymName: 'Test Gym' });
  const world = new WorldState();
  world.advanceDay(10);

  const strong = makeFighter('KO Winner', 90);
  const weak = makeFighter('KO Loser', 15);
  assert.equal(player.addFighter(strong), true);

  const moneyBefore = player.money;
  const repBefore = player.reputation;
  const hypeBefore = player.hype;

  const { events, stop } = collectEvents([COMBAT_EVENTS.FINISHED]);

  const engine = new CombatEngine({ rng: createSeededRng(1), playerState: player, worldState: world });
  engine.setupMatch(strong, weak, 'WFC', false);
  engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });

  const result = engine.simulateFullMatch();
  stop();

  assert.equal(result.method, FINISH_METHODS.KO);
  assert.equal(result.winner, 'A');
  assert.ok(result.round < BALANCE.COMBAT.ROUNDS_PER_FIGHT.UNDERCARD);
  assert.equal(strong.career.wins, 1);
  assert.equal(strong.career.finishes, 1);
  assert.equal(weak.career.losses, 1);

  assert.ok(player.money > moneyBefore, 'gym should be credited after its fighter wins by finish');
  assert.ok(player.reputation >= repBefore);
  assert.ok(player.hype >= hypeBefore);
  assert.equal(events.length, 1);
  assert.ok(events[0][1].purses.A.gymShare > 0);
});

test('missing weight on a title fight forfeits the title and applies a fight-local form penalty', () => {
  const alwaysMissWeight = () => 0.001; // beats every WEIGH_IN.PROFILES[*].missChance
  const engine = new CombatEngine({ rng: alwaysMissWeight });
  const a = makeFighter('Cutter', 50);
  const b = makeFighter('Champ', 50, { career: { titles: ['WFC Lightweight'] } });

  engine.setupMatch(a, b, 'WFC', true);
  assert.equal(engine.context.maxRounds, BALANCE.COMBAT.ROUNDS_PER_FIGHT.MAIN_EVENT);
  assert.equal(engine.context.corners.red, 'B', 'the reigning champion should be assigned the red corner');

  engine.selectWeightCutProfile('A', 'EXTREME');
  engine.executeNextStep(); // INIT -> WEIGH_IN
  assert.equal(engine.state, COMBAT_STATES.WEIGH_IN);

  const weighInResult = engine.executeNextStep(); // WEIGH_IN -> INTRO
  assert.equal(engine.state, COMBAT_STATES.INTRO);
  assert.equal(weighInResult.weightCut.A.missedWeight, true);
  assert.equal(engine.context.isTitle, false, 'missed weight should forfeit the title for this bout');
  assert.equal(engine.context.titleForfeitedBy, 'A');
  assert.ok(engine.context.live.A.forme < a.attributes.forme, 'EXTREME cut should reduce fight-local forme');
});

test('advanceState() steps the FSM one phase at a time, and CORNER_PAUSE only lets fighter A adjust its gameplan', () => {
  const engine = new CombatEngine({ rng: createSeededRng(42) });
  const a = makeFighter('Stepper A', 45);
  const b = makeFighter('Stepper B', 45);

  engine.setupMatch(a, b, 'WFC', false);
  engine.advanceState(); // INIT -> WEIGH_IN
  engine.advanceState(); // WEIGH_IN -> INTRO
  engine.advanceState(); // INTRO -> ROUND_START
  assert.equal(engine.state, COMBAT_STATES.ROUND_START);

  engine.advanceState(); // ROUND_START -> ROUND_SIMULATION
  const roundResult = engine.advanceState(); // ROUND_SIMULATION -> CORNER_PAUSE (usually)

  if (engine.state === COMBAT_STATES.CORNER_PAUSE) {
    assert.ok('log' in roundResult);
    assert.throws(() => engine.setGameplan('B', { tempo: 'AGGRESSIVE' }));
    const updated = engine.setGameplan('A', { tempo: 'AGGRESSIVE' });
    assert.equal(updated.tempo, 'AGGRESSIVE');
  }

  engine.reset();
  assert.equal(engine.state, COMBAT_STATES.IDLE);
  assert.equal(engine.context, null);
});

test('control methods reject invalid calls', () => {
  const engine = new CombatEngine({ rng: createSeededRng(7) });

  assert.throws(() => engine.executeNextStep(), /no active match/);

  const a = makeFighter('Guard A', 50);
  const b = makeFighter('Guard B', 50);
  engine.setupMatch(a, b, 'WFC', false);

  assert.throws(() => engine.setupMatch(a, b, 'WFC', false), /match is in progress/);
  assert.throws(() => engine.setGameplan('A', { target: 'NOT_A_TARGET' }));
  assert.throws(() => engine.selectWeightCutProfile('A', 'NOT_A_PROFILE'));

  engine.advanceState(); // INIT -> WEIGH_IN
  engine.advanceState(); // WEIGH_IN -> INTRO
  assert.throws(() => engine.selectWeightCutProfile('A', 'NATUREL'), /before the WEIGH_IN phase resolves/);
});

test('a career-finish milestone unlocks the FINISHER perk and reports it in the match result', () => {
  const player = new PlayerState({ gymName: 'Perk Gym' });
  const threshold = BALANCE.PERKS.UNLOCK_THRESHOLDS.FINISHER_CAREER_FINISHES;
  const nearFinisher = makeFighter('Near Finisher', 90, {
    career: { wins: 10, losses: 0, finishes: threshold - 1 },
  });
  const fodder = makeFighter('Fodder', 10);
  player.addFighter(nearFinisher);

  const engine = new CombatEngine({ rng: createSeededRng(1), playerState: player });
  engine.setupMatch(nearFinisher, fodder, 'WFC', false);
  engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
  const result = engine.simulateFullMatch();

  assert.ok(nearFinisher.career.finishes >= threshold - 1);
  if (nearFinisher.career.finishes >= threshold) {
    assert.ok(nearFinisher.hasPerk('FINISHER'));
    assert.ok(result.perksUnlocked.A.includes('FINISHER'));
  }
});

test('combatMetrics telemetry: a fighter kept entirely on STRIKING never accumulates ground/submission signals', () => {
  const engine = new CombatEngine({ rng: createSeededRng(3) });
  const a = makeFighter('Striker A', 40);
  const b = makeFighter('Striker B', 40);

  engine.setupMatch(a, b, 'WFC', false);
  engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  for (const key of ['A', 'B']) {
    const m = result.combatMetrics[key];
    assert.equal(m.standingRounds, result.round);
    assert.equal(m.groundRounds, 0);
    assert.equal(m.clinchRounds, 0);
    assert.equal(m.takedownAttempts, 0);
    assert.equal(m.takedownSuccess, 0);
    assert.equal(m.takedownDefended, 0, 'no takedown-defense mechanic exists yet, so this must stay at 0');
    assert.equal(m.submissionAttempts, 0);
    assert.equal(m.countersTriggered, 0);
    assert.equal(m.groundDamageDealt, 0);
    assert.ok(m.standingDamageDealt > 0);
    assert.ok(m.judgePointsFromGroundControl === 0);
  }
});

test('combatMetrics telemetry: a fighter kept entirely on GROUND logs one takedown/submission attempt per round it survives, faithfully at a 100% success/0% defense rate', () => {
  const engine = new CombatEngine({ rng: createSeededRng(11) });
  const a = makeFighter('Grappler A', 40);
  const b = makeFighter('Grappler B', 40);

  engine.setupMatch(a, b, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  for (const key of ['A', 'B']) {
    const m = result.combatMetrics[key];
    assert.equal(m.groundRounds, result.round);
    assert.equal(m.standingRounds, 0);
    assert.equal(m.takedownAttempts, result.round);
    assert.equal(m.takedownSuccess, m.takedownAttempts, 'no takedown contest exists yet, so success always matches attempts');
    assert.equal(m.takedownDefended, 0);
    assert.equal(m.submissionAttempts, result.round);
    assert.ok(m.submissionSuccess <= m.submissionAttempts);
    assert.ok(m.groundDamageDealt > 0 || result.round === 0);
    assert.ok(m.judgePointsFromGroundControl > 0);
  }

  // Every failed submission attempt by one corner is a counted counter
  // opportunity for the other corner — the two must add up exactly, since
  // that's the only source of countersTriggered on either side.
  const failedSubsA = result.combatMetrics.A.submissionAttempts - result.combatMetrics.A.submissionSuccess;
  const failedSubsB = result.combatMetrics.B.submissionAttempts - result.combatMetrics.B.submissionSuccess;
  assert.equal(result.combatMetrics.B.countersTriggered, failedSubsA);
  assert.equal(result.combatMetrics.A.countersTriggered, failedSubsB);
});

test('combatMetrics telemetry is also mirrored onto runtimeState.lastCombatMetrics when a runtimeState is provided', () => {
  const runtimeState = {};
  const engine = new CombatEngine({ rng: createSeededRng(1), runtimeState });
  const a = makeFighter('Runtime A', 40);
  const b = makeFighter('Runtime B', 40);

  engine.setupMatch(a, b, 'WFC', false);
  const result = engine.simulateFullMatch();

  assert.deepEqual(runtimeState.lastCombatMetrics, result.combatMetrics);
});

test('actionMetrics: a LEGS-targeted striker logs every round under LEG_STRIKE, and cloned results never alias engine-internal state', () => {
  const engine = new CombatEngine({ rng: createSeededRng(5) });
  const a = makeFighter('Leg Kicker', 40);
  const b = makeFighter('Turtle', 40);

  engine.setupMatch(a, b, 'WFC', false);
  engine.setGameplan('A', { target: 'LEGS', distance: 'STRIKING', tempo: 'BALANCED' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'BALANCED' });
  const result = engine.simulateFullMatch();

  const legBucket = result.combatMetrics.A.actionMetrics.LEG_STRIKE;
  assert.equal(legBucket.attempts, result.round);
  assert.equal(legBucket.successes, legBucket.attempts, 'strikes have no discrete pass/fail roll, so success always matches attempts');
  assert.ok(legBucket.totalDamage > 0);
  assert.equal(legBucket.totalControlRounds, 0, 'STRIKING never wins ground/control time');
  assert.equal(result.combatMetrics.A.actionMetrics.HEAD_STRIKE.attempts, 0);
  assert.equal(result.combatMetrics.A.actionMetrics.SUBMISSION_ATTEMPT.attempts, 0);

  // Mutating the returned result must never leak back into the engine's own
  // running state (see _cloneCombatMetrics) — mirrors this file's existing
  // expectations for damageTally/purses/etc being independent snapshots.
  result.combatMetrics.A.actionMetrics.LEG_STRIKE.attempts = 999999;
  result.combatMetrics.A.tempoMetrics.BALANCED.rounds = 999999;
  assert.notEqual(engine.context.combatMetrics.A.actionMetrics.LEG_STRIKE.attempts, 999999);
  assert.notEqual(engine.context.combatMetrics.A.tempoMetrics.BALANCED.rounds, 999999);
});

test('tempoMetrics: an AGGRESSIVE fighter accumulates all their rounds under AGGRESSIVE, matching their standing damage', () => {
  const engine = new CombatEngine({ rng: createSeededRng(7) });
  const a = makeFighter('Aggressive A', 40);
  const b = makeFighter('Conservative B', 40);

  engine.setupMatch(a, b, 'WFC', false);
  engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  const tempoA = result.combatMetrics.A.tempoMetrics;
  assert.equal(tempoA.AGGRESSIVE.rounds, result.round);
  assert.equal(tempoA.CONSERVATIVE.rounds, 0);
  assert.equal(tempoA.BALANCED.rounds, 0);
  assert.equal(tempoA.AGGRESSIVE.totalDamage, result.combatMetrics.A.standingDamageDealt);
});

test('styleIdentityScores: a fighter whose skills perfectly favor their style scores far higher than one whose skills favor the opposite distance', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const groundSpecialist = makeFighter('Ground Specialist', 10, {
    identity: { style: 'Lutte' },
    attributes: { skills: { boxe: 0, jambes: 0, sol: 100, soumission: 100, cardio: 50, intelligence: 30 } },
  });
  const strikerInDisguise = makeFighter('Miscast Striker', 10, {
    identity: { style: 'Lutte' },
    attributes: { skills: { boxe: 100, jambes: 100, sol: 0, soumission: 0, cardio: 50, intelligence: 30 } },
  });

  engine.setupMatch(groundSpecialist, strikerInDisguise, 'WFC', false);
  const result = engine.simulateFullMatch();

  assert.ok(result.styleIdentityScores.A > result.styleIdentityScores.B);
  assert.ok(result.styleIdentityScores.A > 50);
  assert.ok(result.styleIdentityScores.B <= 20);
});

test('styleIdentityScores is null for a style with no distance affinity (Freestyle)', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const a = makeFighter('Freestyler', 40, { identity: { style: 'Freestyle' } });
  const b = makeFighter('Opponent', 40);

  engine.setupMatch(a, b, 'WFC', false);
  const result = engine.simulateFullMatch();

  assert.equal(result.styleIdentityScores.A, null);
});
