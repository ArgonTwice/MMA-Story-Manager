/**
 * tools/SessionTelemetry.js — Phase 4.4 ("Playtests, Polish, Long-Term
 * Economics & Release Candidate")
 * ---------------------------------------------------------------------------
 * Lightweight playtest-session telemetry for tools/play-vertical-slice.js:
 * average real (wall-clock) time spent per week, which Drama Engine choices
 * got picked, whether the session actually reached its target week count
 * (the "season 52 completion rate"), and why the player's fighters lost the
 * demo fights they lost.
 *
 * Node-only by design (uses node:fs), same scope as every other tools/*.js
 * script — unlike engine/state/models, which must stay browser-compatible,
 * this file is never imported by anything outside tools/.
 *
 * "Completion rate" only means something aggregated across MULTIPLE
 * playtest sessions, so persist() appends this session's summary to a local
 * JSON log (default: tools/.telemetry/sessions.json, gitignored) and
 * returns the aggregate across every session ever logged there — never
 * called unless the caller opts in (see tools/play-vertical-slice.js's
 * --telemetry-file flag), so a plain run never writes to disk.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TELEMETRY_FILE = fileURLToPath(new URL('.telemetry/sessions.json', import.meta.url));

export class SessionTelemetry {
  /**
   * @param {Object} [options]
   * @param {string} [options.filePath] - Where persist() reads/writes the
   *   cross-session log. Defaults to tools/.telemetry/sessions.json.
   */
  constructor(options = {}) {
    this.filePath = options.filePath ?? DEFAULT_TELEMETRY_FILE;
    this._startedAt = Date.now();
    this._weekTimestamps = [];
    this._dramaChoices = {};
    this._lossReasons = {};
    this._weeksTarget = 0;
    this._weeksCompleted = 0;
  }

  /** Call once at the start of every simulated week — the timestamp gap between consecutive calls is what avgMsPerWeek is built from. */
  startWeek() {
    this._weekTimestamps.push(Date.now());
  }

  /**
   * @param {string} eventId - A data/events.js DRAMA_EVENTS id.
   * @param {string} choiceId - The choice actually picked for it.
   */
  recordDramaChoice(eventId, choiceId) {
    const bucket = this._dramaChoices[eventId] ?? (this._dramaChoices[eventId] = {});
    bucket[choiceId] = (bucket[choiceId] ?? 0) + 1;
  }

  /**
   * Records why a demo fight's losing corner lost — the finish method
   * (KO/TKO/SUBMISSION/*_DECISION). A draw has no loser and is ignored.
   * @param {Object} result - A CombatEngine result payload (winner, method).
   */
  recordFightResult(result) {
    if (!result || result.winner === null || result.winner === undefined) return;
    this._lossReasons[result.method] = (this._lossReasons[result.method] ?? 0) + 1;
  }

  /**
   * Call once at the very end of the session (however it ended).
   * @param {number} weeksTarget - How many weeks the session was supposed to reach.
   * @param {number} weeksCompleted - How many weeks it actually reached.
   */
  finalize(weeksTarget, weeksCompleted) {
    this._weeksTarget = weeksTarget;
    this._weeksCompleted = weeksCompleted;
  }

  /** @returns {number|null} Average real milliseconds elapsed per simulated week, or null if fewer than 2 weeks were started. */
  getAverageMsPerWeek() {
    if (this._weekTimestamps.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < this._weekTimestamps.length; i += 1) {
      gaps.push(this._weekTimestamps[i] - this._weekTimestamps[i - 1]);
    }
    return gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  }

  /** @returns {Object} This session's own summary — the unit persist() appends to the cross-session log. */
  getSummary() {
    return {
      startedAt: this._startedAt,
      endedAt: Date.now(),
      avgMsPerWeek: this.getAverageMsPerWeek(),
      dramaChoices: this._dramaChoices,
      weeksTarget: this._weeksTarget,
      weeksCompleted: this._weeksCompleted,
      completed: this._weeksTarget > 0 && this._weeksCompleted >= this._weeksTarget,
      lossReasons: this._lossReasons,
    };
  }

  /**
   * Appends getSummary() to the cross-session JSON log at this.filePath
   * (creating the directory/file if needed) and returns the aggregate
   * "season 52 completion rate" across every session ever logged there,
   * including this one.
   * @returns {{ totalSessions: number, completedSessions: number, completionRate: number|null }}
   */
  persist() {
    const log = this._readLog();
    log.push(this.getSummary());
    this._writeLog(log);
    return this._computeAggregate(log);
  }

  /**
   * @returns {string} A short, human-readable text rendering of this
   *   session's own telemetry, for the CLI to print at the end of a run.
   */
  toText() {
    const lines = [];
    lines.push('=== TELEMETRIE DE SESSION ===');
    const avgMs = this.getAverageMsPerWeek();
    lines.push(`Duree moyenne par semaine (temps reel) : ${avgMs === null ? 'N/A (session trop courte)' : `${(avgMs / 1000).toFixed(1)}s`}`);
    lines.push(
      `Completion : ${this._weeksCompleted} / ${this._weeksTarget} semaine(s) ` +
        `(${this._weeksTarget > 0 && this._weeksCompleted >= this._weeksTarget ? 'TERMINEE' : 'INCOMPLETE'})`
    );

    const dramaEntries = Object.entries(this._dramaChoices);
    if (dramaEntries.length > 0) {
      lines.push('Decisions Drama Engine :');
      for (const [eventId, choices] of dramaEntries) {
        const choicesText = Object.entries(choices)
          .map(([choiceId, count]) => `${choiceId}=${count}`)
          .join(', ');
        lines.push(`  ${eventId} : ${choicesText}`);
      }
    }

    const lossEntries = Object.entries(this._lossReasons);
    if (lossEntries.length > 0) {
      lines.push(`Raisons de defaite (combats de demo) : ${lossEntries.map(([method, count]) => `${method}=${count}`).join(', ')}`);
    }

    return lines.join('\n');
  }

  // ---- internals ------------------------------------------------------------

  _readLog() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _writeLog(log) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(log, null, 2));
  }

  _computeAggregate(log) {
    const completedSessions = log.filter((session) => session.completed).length;
    return {
      totalSessions: log.length,
      completedSessions,
      completionRate: log.length > 0 ? completedSessions / log.length : null,
    };
  }
}

export default SessionTelemetry;
