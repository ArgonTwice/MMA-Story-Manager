/**
 * tools/SessionTelemetry.test.js
 * Run with: node --test tools/SessionTelemetry.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionTelemetry } from './SessionTelemetry.js';

function makeTempFilePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'session-telemetry-test-')), 'sessions.json');
}

test('getAverageMsPerWeek is null with fewer than 2 startWeek() calls', () => {
  const telemetry = new SessionTelemetry({ filePath: makeTempFilePath() });
  assert.equal(telemetry.getAverageMsPerWeek(), null);

  telemetry.startWeek();
  assert.equal(telemetry.getAverageMsPerWeek(), null);
});

test('getAverageMsPerWeek averages the real gaps between startWeek() calls', () => {
  const telemetry = new SessionTelemetry({ filePath: makeTempFilePath() });
  // Directly seed timestamps to keep this test fast/deterministic instead of sleeping real time.
  telemetry._weekTimestamps = [1000, 1100, 1400];

  assert.equal(telemetry.getAverageMsPerWeek(), 200);
});

test('recordDramaChoice tallies choices per event id', () => {
  const telemetry = new SessionTelemetry({ filePath: makeTempFilePath() });
  telemetry.recordDramaChoice('SPONSOR_OFFER', 'ACCEPT');
  telemetry.recordDramaChoice('SPONSOR_OFFER', 'ACCEPT');
  telemetry.recordDramaChoice('SPONSOR_OFFER', 'DECLINE');
  telemetry.recordDramaChoice('EQUIPMENT_OPPORTUNITY', 'INVEST');

  const summary = telemetry.getSummary();
  assert.deepEqual(summary.dramaChoices, {
    SPONSOR_OFFER: { ACCEPT: 2, DECLINE: 1 },
    EQUIPMENT_OPPORTUNITY: { INVEST: 1 },
  });
});

test('recordFightResult tallies the finish method, ignoring draws', () => {
  const telemetry = new SessionTelemetry({ filePath: makeTempFilePath() });
  telemetry.recordFightResult({ winner: 'A', method: 'KO' });
  telemetry.recordFightResult({ winner: 'B', method: 'KO' });
  telemetry.recordFightResult({ winner: 'A', method: 'SUBMISSION' });
  telemetry.recordFightResult({ winner: null, method: 'DRAW' });

  assert.deepEqual(telemetry.getSummary().lossReasons, { KO: 2, SUBMISSION: 1 });
});

test('finalize()/getSummary() report completion correctly for a full vs. an aborted session', () => {
  const complete = new SessionTelemetry({ filePath: makeTempFilePath() });
  complete.finalize(52, 52);
  assert.equal(complete.getSummary().completed, true);

  const aborted = new SessionTelemetry({ filePath: makeTempFilePath() });
  aborted.finalize(52, 13);
  assert.equal(aborted.getSummary().completed, false);
  assert.equal(aborted.getSummary().weeksCompleted, 13);
});

test('persist() appends to a fresh log file and computes the aggregate completion rate across every logged session', () => {
  const filePath = makeTempFilePath();

  const first = new SessionTelemetry({ filePath });
  first.finalize(52, 52);
  const aggregateAfterFirst = first.persist();
  assert.equal(aggregateAfterFirst.totalSessions, 1);
  assert.equal(aggregateAfterFirst.completedSessions, 1);
  assert.equal(aggregateAfterFirst.completionRate, 1);

  const second = new SessionTelemetry({ filePath });
  second.finalize(52, 8);
  const aggregateAfterSecond = second.persist();
  assert.equal(aggregateAfterSecond.totalSessions, 2);
  assert.equal(aggregateAfterSecond.completedSessions, 1);
  assert.equal(aggregateAfterSecond.completionRate, 0.5);

  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.equal(onDisk.length, 2);
});

test('persist() tolerates a missing/corrupt log file by starting a fresh log', () => {
  const filePath = makeTempFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'not valid json{{{');

  const telemetry = new SessionTelemetry({ filePath });
  telemetry.finalize(10, 10);
  const aggregate = telemetry.persist();

  assert.equal(aggregate.totalSessions, 1);
  assert.equal(aggregate.completionRate, 1);
});

test('toText renders a non-empty, readable summary', () => {
  const telemetry = new SessionTelemetry({ filePath: makeTempFilePath() });
  telemetry._weekTimestamps = [1000, 1500];
  telemetry.recordDramaChoice('SPONSOR_OFFER', 'ACCEPT');
  telemetry.recordFightResult({ winner: 'A', method: 'KO' });
  telemetry.finalize(52, 52);

  const text = telemetry.toText();
  assert.ok(text.includes('TELEMETRIE DE SESSION'));
  assert.ok(text.includes('TERMINEE'));
  assert.ok(text.includes('SPONSOR_OFFER'));
  assert.ok(text.includes('KO=1'));
});
