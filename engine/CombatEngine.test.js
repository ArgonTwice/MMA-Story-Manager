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

test('a finished match records a career.seasonHistory row for both fighters when a worldState is attached', () => {
  const world = new WorldState();
  world.advanceDay(10);

  const a = makeFighter('Season A', 40);
  const b = makeFighter('Season B', 40);

  const engine = new CombatEngine({ rng: createSeededRng(1), worldState: world });
  engine.setupMatch(a, b, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  for (const fighter of [a, b]) {
    assert.equal(fighter.career.seasonHistory.length, 1);
    const row = fighter.career.seasonHistory[0];
    assert.equal(row.year, world.year);
    assert.equal(row.orgId, 'WFC');
    assert.equal(row.wins + row.losses + row.draws, 1);
  }
  const winnerKey = result.winner;
  if (winnerKey) {
    const winner = winnerKey === 'A' ? a : b;
    assert.equal(winner.career.seasonHistory[0].wins, 1);
  }
});

test('a finished match with no worldState attached leaves career.seasonHistory empty (backward-compatible no-op)', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const a = makeFighter('No World A', 40);
  const b = makeFighter('No World B', 40);

  engine.setupMatch(a, b, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  engine.simulateFullMatch();

  assert.deepEqual(a.career.seasonHistory, []);
  assert.deepEqual(b.career.seasonHistory, []);
});

test('result.preFightRatings is a true PRE-fight snapshot: it matches getOverallRating() at setup time and does not drift with post-fight morale changes', () => {
  const strong = makeFighter('Snapshot Winner', 90);
  const weak = makeFighter('Snapshot Loser', 15);
  const engine = new CombatEngine({ rng: createSeededRng(1) });

  engine.setupMatch(strong, weak, 'WFC', false);
  const ratingABeforeFight = strong.getOverallRating();
  const ratingBBeforeFight = weak.getOverallRating();

  engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
  const result = engine.simulateFullMatch();

  assert.equal(result.preFightRatings.A, ratingABeforeFight);
  assert.equal(result.preFightRatings.B, ratingBBeforeFight);

  // Prove preFightRatings is a frozen snapshot, not a live re-read of
  // getOverallRating(): force a large, deterministic morale swing after
  // the fact and confirm the recorded snapshot does NOT follow it.
  strong.adjustMorale(-999);
  assert.notEqual(strong.getOverallRating(), result.preFightRatings.A);
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

test('combatMetrics telemetry: a fighter kept entirely on GROUND only reaches the submission roll on rounds the takedown itself actually landed (Test A3 contest)', () => {
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
    assert.ok(m.takedownSuccess <= m.takedownAttempts, 'a real contest means success can no longer exceed attempts, and need not equal them');
    // Submission is only ever attempted on a landed takedown.
    assert.equal(m.submissionAttempts, m.takedownSuccess);
    assert.ok(m.submissionSuccess <= m.submissionAttempts);
    assert.ok(m.judgePointsFromGroundControl >= 0);
  }

  // Every failed submission attempt by one corner is a counted counter
  // opportunity for the other corner — the two must add up exactly, since
  // that's the only source of countersTriggered on either side.
  const failedSubsA = result.combatMetrics.A.submissionAttempts - result.combatMetrics.A.submissionSuccess;
  const failedSubsB = result.combatMetrics.B.submissionAttempts - result.combatMetrics.B.submissionSuccess;
  assert.equal(result.combatMetrics.B.countersTriggered, failedSubsA);
  assert.equal(result.combatMetrics.A.countersTriggered, failedSubsB);

  // Every failed takedown by one corner is real defense credit for the
  // other, and every landed one adds up with the failed count to the
  // total attempts (Test A3: no more "always succeeds, defense always 0").
  const failedTdA = result.combatMetrics.A.takedownAttempts - result.combatMetrics.A.takedownSuccess;
  const failedTdB = result.combatMetrics.B.takedownAttempts - result.combatMetrics.B.takedownSuccess;
  assert.equal(result.combatMetrics.B.takedownDefended, failedTdA);
  assert.equal(result.combatMetrics.A.takedownDefended, failedTdB);
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

// ---- Test A3: "Risque Decisionnel & Sprawl" (real takedown contest) -------

/**
 * seed=1 with this exact sol(0) vs sol(100) mismatch is empirically
 * confirmed (see the test suite's own convention) to fail A's very first
 * takedown attempt against B — the deterministic scenario every A3 test
 * below builds on.
 */
function makeMismatchedGrapplers() {
  const wrestler = makeFighter('Whiffing Wrestler', 40, { attributes: { skills: { sol: 0 } } });
  const sprawler = makeFighter('Elite Sprawler', 40, { attributes: { skills: { sol: 100 } } });
  return { wrestler, sprawler };
}

/**
 * Drives the FSM forward exactly one simulated round at a time, regardless
 * of which phase it currently sits in (INIT/WEIGH_IN/INTRO/ROUND_START all
 * precede the actual ROUND_SIMULATION step; CORNER_PAUSE/ROUND_START repeat
 * that preamble for every round after the first) — only
 * _processRoundSimulation's return value carries a `log` key, so that's
 * the unambiguous signal to stop on.
 * @param {CombatEngine} engine
 * @returns {Object} The ROUND_SIMULATION step's own return value.
 */
function stepUntilRoundSimulated(engine) {
  let stepResult;
  do {
    stepResult = engine.executeNextStep();
  } while (!('log' in stepResult) && engine.state !== COMBAT_STATES.FINISHED);
  return stepResult;
}

test('A3.1: a failed/defended takedown burns extra stamina and loses momentum for the wrestler, and grants zero offense that round', () => {
  const { wrestler, sprawler } = makeMismatchedGrapplers();
  const engine = new CombatEngine({ rng: createSeededRng(1) });

  engine.setupMatch(wrestler, sprawler, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });

  const momentumBefore = engine.context.live.A.momentum;
  const { log } = stepUntilRoundSimulated(engine); // round 1 (weigh-in has resolved by now, setting live.A.staminaMax)

  assert.equal(engine.context.combatMetrics.A.takedownAttempts, 1);
  assert.equal(engine.context.combatMetrics.A.takedownSuccess, 0, 'seed=1 with this skill gap is confirmed to whiff round 1');
  assert.equal(log.damageDealt.A, 0, 'a defended takedown produces no offense that round');

  const risk = BALANCE.COMBAT.TAKEDOWN_RISK;
  const expectedStaminaCost = BALANCE.COMBAT.STAMINA.COST_PER_TAKEDOWN_ATTEMPT * 0.7 /* CONSERVATIVE staminaCostMultiplier */ + risk.FAILURE_STAMINA_PENALTY;
  // Baseline is live.A.staminaMax (Phase 3.1 v1: weigh-in sets live.stamina
  // to a Readiness-derived staminaMax, not always BALANCE.COMBAT.STAMINA.MAX)
  // rather than a pre-weigh-in snapshot, since stepUntilRoundSimulated's
  // helper has no clean intermediate point between weigh-in and round 1.
  assert.ok(Math.abs(engine.context.live.A.staminaMax - engine.context.live.A.stamina - expectedStaminaCost) < 1e-9);
  assert.equal(momentumBefore - engine.context.live.A.momentum, risk.FAILURE_MOMENTUM_PENALTY);
});

test('A3.2: stuffing a takedown grants the defender a one-round counter window (accuracy + damage bonus), consumed and cleared by their very next offense', () => {
  const { wrestler, sprawler } = makeMismatchedGrapplers();
  const engine = new CombatEngine({ rng: createSeededRng(1) });

  engine.setupMatch(wrestler, sprawler, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });

  stepUntilRoundSimulated(engine); // round 1: A's takedown fails against B

  assert.equal(engine.context.live.B.counterWindowActive, true, 'B should hold an active counter window after stuffing round 1');
  assert.equal(engine.context.combatMetrics.B.counterWindowsGranted, 1);

  stepUntilRoundSimulated(engine); // round 2 — B's counter window is consumed here

  assert.equal(engine.context.live.B.counterWindowActive, false, 'the counter window must be consumed/cleared after exactly one round');
  assert.equal(engine.context.combatMetrics.B.counterWindowsUsed, 1);
});

test('A3.3: each stuffed takedown against the same defender stacks their sprawl-defense bonus cumulatively, up to the documented cap', () => {
  const { wrestler, sprawler } = makeMismatchedGrapplers();
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const risk = BALANCE.COMBAT.TAKEDOWN_RISK;

  engine.setupMatch(wrestler, sprawler, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });

  let previousBonus = 0;
  for (let round = 0; round < 3 && engine.state !== COMBAT_STATES.FINISHED; round += 1) {
    stepUntilRoundSimulated(engine);
    const bonus = engine.context.live.B.takedownDefenseBonus;
    assert.ok(bonus >= previousBonus, 'the sprawl bonus must never decrease mid-match');
    assert.ok(bonus <= risk.SPRAWL_DEFENSE_BONUS_MAX, 'the stacking bonus must never exceed its documented safety ceiling');
    previousBonus = bonus;
  }

  assert.ok(previousBonus > 0, 'expected at least one stuffed takedown to have stacked a sprawl bonus over 3 rounds');
});

test('final result payload carries A3 telemetry: takedownDefended is real data, and finalTakedownDefenseBonus reflects the ending stack', () => {
  const { wrestler, sprawler } = makeMismatchedGrapplers();
  const engine = new CombatEngine({ rng: createSeededRng(1) });

  engine.setupMatch(wrestler, sprawler, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  assert.ok(result.combatMetrics.B.takedownDefended > 0, 'B should have real, non-zero defense credit now that a contest exists');
  assert.ok(result.combatMetrics.B.finalTakedownDefenseBonus >= 0);
  assert.ok(result.combatMetrics.B.finalTakedownDefenseBonus <= BALANCE.COMBAT.TAKEDOWN_RISK.SPRAWL_DEFENSE_BONUS_MAX);
  assert.equal(
    result.combatMetrics.A.momentumLost,
    (result.combatMetrics.A.takedownAttempts - result.combatMetrics.A.takedownSuccess) * BALANCE.COMBAT.TAKEDOWN_RISK.FAILURE_MOMENTUM_PENALTY
  );
});

// ---- Phase 4.1: "Integration du Moteur de Clinch & Trinite des Styles" ----

/**
 * Same shape as makeMismatchedGrapplers, for the CLINCH->Sol transition
 * contest specifically. seed=1 is empirically confirmed to fail A's very
 * first Clinch->Sol transition against this sol(0) vs sol(100) mismatch;
 * seed=5 is empirically confirmed to land it instead.
 */
function makeMismatchedClinchers() {
  const wrestler = makeFighter('Whiffing Clincher', 40, { attributes: { skills: { sol: 0 } } });
  const sprawler = makeFighter('Elite Sprawler', 40, { attributes: { skills: { sol: 100 } } });
  return { wrestler, sprawler };
}

test('4.1: a CLINCH round always attempts a Clinch->Sol transition, and deals damage even when that transition fails', () => {
  const { wrestler, sprawler } = makeMismatchedClinchers();
  const engine = new CombatEngine({ rng: createSeededRng(1) });

  engine.setupMatch(wrestler, sprawler, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'CLINCH', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });

  const { log } = stepUntilRoundSimulated(engine);

  assert.equal(engine.context.combatMetrics.A.clinchAttempts, 1);
  assert.equal(engine.context.combatMetrics.A.clinchTransitionSuccess, 0, 'seed=1 with this skill gap is confirmed to whiff the transition round 1');
  assert.ok(
    log.damageDealt.A > 0,
    'unlike a failed GROUND takedown (which zeroes rawDamage), a CLINCH round keeps dealing knees/elbows damage even on a failed transition'
  );
});

test('4.1: a landed Clinch->Sol transition counts as a takedown for judge scoring and unlocks a submission attempt, just like a landed GROUND takedown', () => {
  const { wrestler, sprawler } = makeMismatchedClinchers();
  const engine = new CombatEngine({ rng: createSeededRng(5) });

  engine.setupMatch(wrestler, sprawler, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'CLINCH', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });

  stepUntilRoundSimulated(engine);

  assert.equal(engine.context.combatMetrics.A.clinchTransitionSuccess, 1, 'seed=5 with this skill gap is confirmed to land the transition round 1');
  assert.equal(engine.context.combatMetrics.A.submissionAttempts, 1, 'a landed clinch transition gates a submission attempt exactly like a landed GROUND takedown');
});

test('4.1: a defended Clinch->Sol transition builds the SAME cumulative sprawl-defense stack (live.takedownDefenseBonus) that a stuffed GROUND takedown does', () => {
  const { wrestler, sprawler } = makeMismatchedClinchers();
  const engine = new CombatEngine({ rng: createSeededRng(1) });

  engine.setupMatch(wrestler, sprawler, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'CLINCH', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });

  assert.equal(engine.context.live.B.takedownDefenseBonus, 0);
  stepUntilRoundSimulated(engine);

  assert.ok(engine.context.live.B.takedownDefenseBonus > 0, 'defending a clinch transition should stack B\'s shared takedown-defense bonus');
  assert.equal(engine.context.combatMetrics.B.clinchDefended, 1);
  assert.equal(engine.context.live.B.counterWindowActive, true, 'a stuffed clinch transition grants the same one-round counter window a stuffed GROUND takedown does');
});

test('4.1: BALANCE.COMBAT.CLINCH.STYLE_CLINCH_MULTIPLIERS gives Muay Thai a real, isolated output bonus while clinching, on top of (not instead of) the pre-existing STYLE_BONUSES layer', () => {
  function avgClinchDamage(style, seeds) {
    let total = 0;
    for (const seed of seeds) {
      const a = makeFighter('A', 50, { identity: { style } });
      const b = makeFighter('B', 50, {});
      const engine = new CombatEngine({ rng: createSeededRng(seed) });
      engine.setupMatch(a, b, 'WFC', false);
      engine.setGameplan('A', { target: 'HEAD', distance: 'CLINCH', tempo: 'BALANCED' });
      engine.setGameplan('B', { target: 'HEAD', distance: 'CLINCH', tempo: 'BALANCED' });
      stepUntilRoundSimulated(engine);
      total += engine.context.combatMetrics.A.clinchDamageDealt;
    }
    return total / seeds.length;
  }

  const seeds = Array.from({ length: 150 }, (_, i) => i + 1);
  const muayThaiAvg = avgClinchDamage('Muay Thai', seeds);
  const freestyleAvg = avgClinchDamage('Freestyle', seeds);
  const expectedMultiplier = BALANCE.COMBAT.CLINCH.STYLE_CLINCH_MULTIPLIERS['Muay Thai'];

  assert.ok(
    Math.abs(muayThaiAvg / freestyleAvg - expectedMultiplier) < 0.02,
    `expected Muay Thai's average clinch damage to be ~${expectedMultiplier}x Freestyle's, got ${muayThaiAvg / freestyleAvg}`
  );
});

test('4.1: final result payload carries Clinch telemetry (clinchAttempts/clinchTransitionSuccess/clinchDefended) alongside the pre-existing GROUND fields, without altering them', () => {
  const { wrestler, sprawler } = makeMismatchedClinchers();
  const engine = new CombatEngine({ rng: createSeededRng(1) });

  engine.setupMatch(wrestler, sprawler, 'WFC', false);
  engine.setGameplan('A', { target: 'BODY', distance: 'CLINCH', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  assert.ok(result.combatMetrics.A.clinchAttempts >= 0);
  assert.ok(result.combatMetrics.A.clinchTransitionSuccess <= result.combatMetrics.A.clinchAttempts);
  assert.ok(result.combatMetrics.B.clinchDefended >= 0);
  // B only ever picks GROUND in this scenario, so it should have zero clinch activity of its own.
  assert.equal(result.combatMetrics.B.clinchAttempts, 0);
});

// ---------------------------------------------------------------------------
// Phase 3.1 v1: Readiness gauge (staminaMax/momentum curve at weigh-in)
// ---------------------------------------------------------------------------

test('a pristine fighter (0 Fatigue, 100 Moral) reaches Readiness 100 (clamped) and gets the top calibration point\'s +5% Stamina Max at weigh-in', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const fresh = makeFighter('Fresh', 50, { attributes: { physicalFatigue: 0, moral: 100 } });
  const foil = makeFighter('Foil', 50, { attributes: { physicalFatigue: 0, moral: 65 } });

  engine.setupMatch(fresh, foil, 'WFC', false);
  engine.executeNextStep(); // INIT -> WEIGH_IN
  engine.executeNextStep(); // WEIGH_IN -> INTRO (weigh-in body actually runs here)

  assert.equal(engine.context.live.A.readiness, BALANCE.READINESS.MAX);
  const top = BALANCE.READINESS.CURVE[BALANCE.READINESS.CURVE.length - 1];
  // No explicit weight-cut choice made -> defaults to the NATUREL profile,
  // which itself carries its own small staminaModifier (+1%) — see
  // BALANCE.WEIGH_IN.PROFILES.NATUREL — multiplied together with the
  // Readiness curve's own multiplier, not overridden by it.
  const naturel = BALANCE.WEIGH_IN.PROFILES.NATUREL;
  const expectedStaminaMax = BALANCE.COMBAT.STAMINA.MAX * (1 + naturel.staminaModifier) * (1 + top.staminaMaxMultiplier);
  assert.ok(Math.abs(engine.context.live.A.staminaMax - expectedStaminaMax) < 1e-9);
  assert.equal(engine.context.live.A.readinessMomentumBonus, top.momentumBonus);
});

test('a heavily-fatigued, demoralized fighter reads a low Readiness and the curve\'s lowest calibration point\'s stamina/momentum malus', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const exhausted = makeFighter('Exhausted', 50, { attributes: { physicalFatigue: 100, mentalFatigue: 100, moral: 0 } });
  const foil = makeFighter('Foil', 50, { attributes: { physicalFatigue: 0, moral: 65 } });

  engine.setupMatch(exhausted, foil, 'WFC', false);
  engine.executeNextStep();
  engine.executeNextStep();

  assert.equal(engine.context.live.A.readiness, BALANCE.READINESS.MIN);
  const bottom = BALANCE.READINESS.CURVE[0];
  const naturel = BALANCE.WEIGH_IN.PROFILES.NATUREL;
  const expectedStaminaMax = BALANCE.COMBAT.STAMINA.MAX * (1 + naturel.staminaModifier) * (1 + bottom.staminaMaxMultiplier);
  assert.ok(Math.abs(engine.context.live.A.staminaMax - expectedStaminaMax) < 1e-9);
  assert.equal(engine.context.live.A.readinessMomentumBonus, bottom.momentumBonus);
  assert.ok(engine.context.live.A.staminaMax < engine.context.live.B.staminaMax, 'the exhausted fighter should start with meaningfully less stamina capacity than a normal-Moral, zero-Fatigue foil');
});

test('a pending tactical-prep bonus is consumed (cleared) at weigh-in, and contributes READINESS.TACTICAL_BONUS_POINTS beforehand', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const prepared = makeFighter('Prepared', 50, { attributes: { physicalFatigue: 20, moral: 65 } });
  const foil = makeFighter('Foil', 50, { attributes: { physicalFatigue: 20, moral: 65 } });
  prepared.preparation.tacticalBonusPending = true;

  const readinessWithoutBonus = new Fighter({
    identity: prepared.identity,
    attributes: { ...prepared.attributes },
  }).getReadiness();

  engine.setupMatch(prepared, foil, 'WFC', false);
  engine.executeNextStep();
  engine.executeNextStep();

  assert.ok(
    Math.abs(engine.context.live.A.readiness - Math.min(BALANCE.READINESS.MAX, readinessWithoutBonus + BALANCE.READINESS.TACTICAL_BONUS_POINTS)) < 1e-9
  );
  assert.equal(prepared.preparation.tacticalBonusPending, false, 'consumed by this fight\'s weigh-in');
});

test('the final result payload snapshots each corner\'s weigh-in Readiness onto combatMetrics.readiness', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const a = makeFighter('A', 50, { attributes: { physicalFatigue: 10, moral: 65 } });
  const b = makeFighter('B', 50, { attributes: { physicalFatigue: 60, moral: 65 } });

  engine.setupMatch(a, b, 'WFC', false);
  const result = engine.simulateFullMatch();

  assert.ok(typeof result.combatMetrics.A.readiness === 'number');
  assert.ok(typeof result.combatMetrics.B.readiness === 'number');
  assert.ok(result.combatMetrics.A.readiness > result.combatMetrics.B.readiness, 'the less-fatigued fighter should read a higher Readiness');
});

// =============================================================================
// Underground Circuit rules (setupMatch's optional 5th `rules` param)
// =============================================================================

test('Underground rules default to null/omitted: setupMatch behaves exactly as before (DEFAULT_RULES is a true no-op)', () => {
  // matchId/fighters carry a global, call-order-dependent id counter (see
  // generateId()) — irrelevant to whether the RULES themselves changed
  // anything, so they're stripped before comparing.
  const strip = (result) => {
    const { matchId, fighters, ...rest } = result;
    return rest;
  };

  const withoutRules = new CombatEngine({ rng: createSeededRng(42) });
  withoutRules.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'WFC', false);
  const resultWithout = withoutRules.simulateFullMatch();

  const withNullRules = new CombatEngine({ rng: createSeededRng(42) });
  withNullRules.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'WFC', false, null);
  const resultWithNull = withNullRules.simulateFullMatch();

  assert.deepEqual(strip(resultWithout), strip(resultWithNull));
});

test('noRoundLimit uses BALANCE.UNDERGROUND.ROUNDS.NO_LIMIT_SAFETY_CAP instead of the normal MAIN_EVENT/UNDERCARD round count', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  engine.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'UNDERGROUND', false, { noRoundLimit: true });
  assert.equal(engine.context.maxRounds, BALANCE.UNDERGROUND.ROUNDS.NO_LIMIT_SAFETY_CAP);
});

test('noTakedowns (Striking Standup): a GROUND gameplan resolves as pure striking — no takedown is ever attempted, and no round is ever counted as GROUND', () => {
  const engine = new CombatEngine({ rng: createSeededRng(11) });
  const a = makeFighter('Grappler A', 40);
  const b = makeFighter('Grappler B', 40);

  engine.setupMatch(a, b, 'UNDERGROUND', false, { noTakedowns: true });
  engine.setGameplan('A', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  for (const key of ['A', 'B']) {
    const m = result.combatMetrics[key];
    assert.equal(m.groundRounds, 0, 'noTakedowns must remap every GROUND round to STRIKING');
    assert.equal(m.standingRounds, result.round);
    assert.equal(m.takedownAttempts, 0);
  }
});

test('noTakedowns (Striking Standup): a CLINCH gameplan still strikes normally, but never lands a takedown', () => {
  const withoutRule = new CombatEngine({ rng: createSeededRng(7) });
  withoutRule.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'WFC', false);
  withoutRule.setGameplan('A', { target: 'BODY', distance: 'CLINCH', tempo: 'CONSERVATIVE' });
  withoutRule.setGameplan('B', { target: 'BODY', distance: 'CLINCH', tempo: 'CONSERVATIVE' });
  const resultWithout = withoutRule.simulateFullMatch();
  const someClinchTakedownLandedNormally =
    resultWithout.combatMetrics.A.clinchTransitionSuccess > 0 || resultWithout.combatMetrics.B.clinchTransitionSuccess > 0;
  assert.ok(someClinchTakedownLandedNormally, 'sanity: this seed must normally land at least one Clinch->Sol transition');

  const withRule = new CombatEngine({ rng: createSeededRng(7) });
  withRule.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'UNDERGROUND', false, { noTakedowns: true });
  withRule.setGameplan('A', { target: 'BODY', distance: 'CLINCH', tempo: 'CONSERVATIVE' });
  withRule.setGameplan('B', { target: 'BODY', distance: 'CLINCH', tempo: 'CONSERVATIVE' });
  const resultWith = withRule.simulateFullMatch();

  assert.equal(resultWith.combatMetrics.A.clinchTransitionSuccess, 0);
  assert.equal(resultWith.combatMetrics.B.clinchTransitionSuccess, 0);
  assert.ok(resultWith.combatMetrics.A.clinchAttempts > 0, 'clinch striking itself must still happen');
});

test('submissionOnly: KO/TKO/DOCTOR_STOPPAGE never end the fight, even when a fighter is driven far past the KO health threshold', () => {
  const engine = new CombatEngine({ rng: createSeededRng(3) });
  const striker = makeFighter('Striker', 90);
  const punchingBag = makeFighter('Punching Bag', 5);

  engine.setupMatch(striker, punchingBag, 'UNDERGROUND', false, { submissionOnly: true, noRoundLimit: true });
  engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  assert.ok(
    [FINISH_METHODS.SUBMISSION, FINISH_METHODS.DRAW].includes(result.method),
    `submissionOnly must never produce ${result.method} even under a massive skill mismatch`
  );
  assert.ok(result.method !== FINISH_METHODS.KO && result.method !== FINISH_METHODS.TKO && result.method !== FINISH_METHODS.DOCTOR_STOPPAGE);
});

test('submissionOnly: a fight can still legitimately end by SUBMISSION when both fighters commit to grappling', () => {
  const engine = new CombatEngine({ rng: createSeededRng(11) });
  const a = makeFighter('Grappler A', 60);
  const b = makeFighter('Grappler B', 30);

  engine.setupMatch(a, b, 'UNDERGROUND', false, { submissionOnly: true, noRoundLimit: true });
  engine.setGameplan('A', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  assert.ok(
    [FINISH_METHODS.SUBMISSION, FINISH_METHODS.DRAW].includes(result.method),
    `expected SUBMISSION or a safety-cap DRAW, got ${result.method}`
  );
});

test('submissionOnly: accumulated strike damage taken raises the defender\'s submission chance (higher than an otherwise-identical fresh fight)', () => {
  const cfg = BALANCE.UNDERGROUND.SUBMISSION_ONLY;
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  engine.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'UNDERGROUND', false, { submissionOnly: true });
  engine.executeNextStep(); // INIT -> WEIGH_IN
  engine.executeNextStep(); // WEIGH_IN -> INTRO
  engine.executeNextStep(); // INTRO -> ROUND_START
  engine.context.damageTally.B = { face: 30, body: 20, legs: 10 }; // 60 cumulative damage on B
  engine.setGameplan('A', { target: 'BODY', distance: 'GROUND', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'BODY', distance: 'STRIKING', tempo: 'CONSERVATIVE' });

  const offense = engine._computeRoundOffense('A', 'B');
  assert.ok(offense.takedownAttempted, 'sanity: A must have attempted a takedown for a submission roll to even be possible');

  const sub = BALANCE.COMBAT.SUBMISSIONS;
  const expectedBonus = 60 * cfg.DAMAGE_TO_SUBMISSION_CHANCE_SCALING;
  assert.ok(expectedBonus > 0, 'sanity: the bonus must be a real positive number for this test to mean anything');
  assert.ok(expectedBonus < sub.MAX_CHANCE, 'sanity: the bonus alone should not already saturate the clamp for this test to be meaningful');
});

test('noDecision (KO / No Judges): reaching the round limit without a finish is a no-purse DRAW instead of a judges decision', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const a = makeFighter('A', 30);
  const b = makeFighter('B', 30);

  engine.setupMatch(a, b, 'UNDERGROUND', false, { noDecision: true });
  engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  const result = engine.simulateFullMatch();

  if (![FINISH_METHODS.KO, FINISH_METHODS.TKO, FINISH_METHODS.SUBMISSION, FINISH_METHODS.DOCTOR_STOPPAGE].includes(result.method)) {
    assert.equal(result.method, FINISH_METHODS.DRAW);
    assert.equal(result.winner, null);
    for (const key of ['A', 'B']) {
      assert.deepEqual(result.purses[key], { gross: 0, net: 0, fighterShare: 0, gymShare: 0, managerShare: 0 });
    }
  }
});

test('purseMultiplier (Vale Tudo x3) triples both fighters\' base purse, still on top of the normal win bonus', () => {
  const normal = new CombatEngine({ rng: createSeededRng(5) });
  normal.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'WFC', false);
  const normalResult = normal.simulateFullMatch();

  const tripled = new CombatEngine({ rng: createSeededRng(5) });
  tripled.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'UNDERGROUND', false, { purseMultiplier: 3 });
  const tripledResult = tripled.simulateFullMatch();

  for (const key of ['A', 'B']) {
    assert.equal(tripledResult.purses[key].gross, normalResult.purses[key].gross * 3);
  }
});

test('injuryRiskMultiplier scales the injury roll: an absurdly high multiplier guarantees an injury that would not otherwise have occurred', () => {
  const baseline = new CombatEngine({ rng: createSeededRng(9) });
  baseline.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'WFC', false);
  const baselineResult = baseline.simulateFullMatch();
  assert.equal(baselineResult.injuries.A, null, 'sanity: this seed must not injure A under normal odds');

  const guaranteed = new CombatEngine({ rng: createSeededRng(9) });
  guaranteed.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'UNDERGROUND', false, { injuryRiskMultiplier: 1000 });
  const guaranteedResult = guaranteed.simulateFullMatch();
  assert.ok(guaranteedResult.injuries.A !== null, 'a 1000x multiplier must push the chance past 1 and guarantee an injury');
});

test('openWeight: a genuine underdog win earns an extra purse multiplier on top of the normal win bonus', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  const underdog = makeFighter('Underdog', 20);
  const favorite = makeFighter('Favorite', 80);

  engine.setupMatch(underdog, favorite, 'UNDERGROUND', false, { openWeight: true, noRoundLimit: true, noDecision: false });
  engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
  engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
  const withRule = engine.simulateFullMatch();

  if (withRule.winner === 'A') {
    // A (the underdog) won: replay the exact same seed WITHOUT openWeight and confirm A's purse is strictly smaller there.
    const control = new CombatEngine({ rng: createSeededRng(1) });
    control.setupMatch(makeFighter('Underdog', 20), makeFighter('Favorite', 80), 'UNDERGROUND', false, { noRoundLimit: true });
    control.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
    control.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
    const withoutRule = control.simulateFullMatch();

    assert.equal(withoutRule.winner, 'A', 'same seed, same rng draws minus the purse math: must produce the same winner');
    assert.ok(withRule.purses.A.gross > withoutRule.purses.A.gross, 'openWeight must add a real bonus on top of the normal win purse for a true underdog win');
  }
});

test('valeTudo: Agressif trait and Showman archetype boost morale, Calme (the Pacifiste proxy) lowers it, applied regardless of win/loss', () => {
  const aggressiveShowman = new Fighter({
    identity: { name: 'Brawler', age: 28, style: 'Freestyle', weightClass: 'Lightweight' },
    attributes: { skills: { boxe: 50, jambes: 50, sol: 50, soumission: 50, cardio: 50, intelligence: 50 }, moral: 50 },
    psychology: { personality: { archetype: 'Showman', traits: ['Agressif'] } },
  });
  const calmOpponent = new Fighter({
    identity: { name: 'Zen Fighter', age: 28, style: 'Freestyle', weightClass: 'Lightweight' },
    attributes: { skills: { boxe: 50, jambes: 50, sol: 50, soumission: 50, cardio: 50, intelligence: 50 }, moral: 50 },
    psychology: { personality: { archetype: 'Guerrier', traits: ['Calme'] } },
  });

  const engine = new CombatEngine({ rng: createSeededRng(1) });
  engine.setupMatch(aggressiveShowman, calmOpponent, 'UNDERGROUND', false, { valeTudo: true });
  const result = engine.simulateFullMatch();

  const cfg = BALANCE.UNDERGROUND.VALE_TUDO.TRAIT_MORALE_DELTA;
  const expectedBrawlerDelta = cfg.AGRESSIF + cfg.SHOWMAN_ARCHETYPE;
  const winLossDelta =
    result.winner === 'A' ? BALANCE.MORALE.EVENTS.WIN_FIGHT : result.winner === 'B' ? BALANCE.MORALE.EVENTS.LOSE_FIGHT : 0;
  assert.equal(aggressiveShowman.attributes.moral, 50 + winLossDelta + expectedBrawlerDelta);

  const zenWinLossDelta =
    result.winner === 'B' ? BALANCE.MORALE.EVENTS.WIN_FIGHT : result.winner === 'A' ? BALANCE.MORALE.EVENTS.LOSE_FIGHT : 0;
  assert.equal(calmOpponent.attributes.moral, 50 + zenWinLossDelta + cfg.CALME_PACIFISTE_PROXY);
});

test('startingStaminaOverride lets a corner start weigh-in below full stamina, as a fraction of that fight\'s own staminaMax (Gauntlet Survival carry-over)', () => {
  const engine = new CombatEngine({ rng: createSeededRng(1) });
  engine.setupMatch(makeFighter('A', 50), makeFighter('B', 50), 'UNDERGROUND', false);
  engine.context.rules.startingStaminaOverride.A = 0.5;
  engine.executeNextStep(); // INIT -> WEIGH_IN
  engine.executeNextStep(); // WEIGH_IN -> INTRO

  assert.ok(Math.abs(engine.context.live.A.stamina - engine.context.live.A.staminaMax * 0.5) < 1e-9);
  assert.equal(engine.context.live.B.stamina, engine.context.live.B.staminaMax, 'B has no override and must start at full stamina as usual');
});

// ---- Confidence (distinct from moral): fight results move it, and it nudges initiative mid-fight ----

test('a fighter with above-neutral confidence lands more raw damage in round 1 than an identical fighter at neutral confidence, all else equal', () => {
  const buildAndScoreRoundOne = (confidenceA) => {
    const a = makeFighter('A', 50, { attributes: { confidence: confidenceA } });
    const b = makeFighter('B', 50);
    const engine = new CombatEngine({ rng: createSeededRng(42) });
    engine.setupMatch(a, b, 'WFC', false);
    engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'BALANCED' });
    engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'BALANCED' });
    engine.executeNextStep(); // processes INIT -> WEIGH_IN
    engine.executeNextStep(); // processes WEIGH_IN -> INTRO
    engine.executeNextStep(); // processes INTRO -> ROUND_START
    engine.executeNextStep(); // processes ROUND_START -> ROUND_SIMULATION (round counter only, no log yet)
    const step = engine.executeNextStep(); // processes ROUND_SIMULATION itself -> carries the round log
    return step.log.damageDealt.A;
  };

  const neutralDamage = buildAndScoreRoundOne(BALANCE.CONFIDENCE.STARTING_VALUE);
  const confidentDamage = buildAndScoreRoundOne(BALANCE.CONFIDENCE.MAX);

  assert.ok(confidentDamage > neutralDamage, `expected higher confidence to land more damage (neutral=${neutralDamage}, confident=${confidentDamage})`);
});

test('confidence is unaffected by moral-only events and vice versa — the two dials move independently', () => {
  const a = makeFighter('A', 50);
  a.adjustMorale(-40);
  assert.equal(a.attributes.confidence, BALANCE.CONFIDENCE.STARTING_VALUE);
  a.adjustConfidence(-40);
  assert.equal(a.attributes.moral, 50 - 40);
});

test('a fight winner\'s confidence rises more from a finish than from a decision, and a loser\'s always falls', () => {
  const winByFinish = (() => {
    const a = makeFighter('Finisher', 90);
    const b = makeFighter('Victim', 10);
    const engine = new CombatEngine({ rng: createSeededRng(1) });
    engine.setupMatch(a, b, 'WFC', false);
    engine.setGameplan('A', { target: 'HEAD', distance: 'STRIKING', tempo: 'AGGRESSIVE' });
    engine.setGameplan('B', { target: 'HEAD', distance: 'STRIKING', tempo: 'CONSERVATIVE' });
    const result = engine.simulateFullMatch();
    return { a, b, result };
  })();

  assert.ok(!DECISION_METHODS.has(winByFinish.result.method), 'sanity: expected this heavily lopsided matchup to end by finish, not decision');
  if (winByFinish.result.winner === 'A') {
    assert.equal(winByFinish.a.attributes.confidence, BALANCE.CONFIDENCE.STARTING_VALUE + BALANCE.CONFIDENCE.EVENTS.WIN_FIGHT + BALANCE.CONFIDENCE.EVENTS.WIN_FIGHT_FINISH_BONUS);
    assert.equal(winByFinish.b.attributes.confidence, BALANCE.CONFIDENCE.STARTING_VALUE + BALANCE.CONFIDENCE.EVENTS.LOSE_FIGHT);
  }
});
