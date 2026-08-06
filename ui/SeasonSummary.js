/**
 * ui/SeasonSummary.js — Phase 4.3 ("Player Experience & Vertical Slice")
 * ---------------------------------------------------------------------------
 * Builds the recap the spec asks for "en fin de saison" (every 52 weeks —
 * one in-world year, BALANCE.CALENDAR.WEEKS_PER_SEASON * SEASONS_PER_YEAR):
 * financial trajectory, fights fought, Drama Engine activity, every
 * retirement/reconversion that happened, and a snapshot of the roster and
 * the world's records as they stand right now.
 *
 * Pull-based, not EventBus-reactive, like ui/GymHub.js: the caller (e.g.
 * tools/play-vertical-slice.js) accumulates each week's
 * ui/WeeklyFlowController.js result and each fight's result over the
 * window, then hands them here in one build() call at the end of the year.
 * SeasonSummary never mutates State — it only reads/summarizes.
 * ---------------------------------------------------------------------------
 */

export class SeasonSummary {
  /**
   * @param {Object} options
   * @param {Object} options.playerState - A PlayerState instance.
   * @param {Object} options.worldState - A WorldState instance.
   */
  constructor({ playerState, worldState }) {
    this.playerState = playerState;
    this.worldState = worldState;
  }

  /**
   * @param {Object} [window]
   * @param {Object[]} [window.weeklyResults] - Every ui/WeeklyFlowController.js#resolveWeek/resolveDramaChoice result collected over the window.
   * @param {Object[]} [window.fightResults] - Every CombatEngine result (see ui/FightNightView.js's resultBanner, or the raw CombatEngine result) fought over the window.
   * @param {number|null} [window.startMoney] - Treasury at the start of the window, for a net-change figure. Null if unknown.
   * @param {number|null} [window.startDay] - World day at the start of the window, for display only.
   * @returns {Object} A structured recap view model.
   */
  build({ weeklyResults = [], fightResults = [], startMoney = null, startDay = null } = {}) {
    const weekSummaries = weeklyResults.map((r) => r.weekSummary).filter(Boolean);
    const retirements = weekSummaries.flatMap((s) => s.retirements ?? []);
    // The TRUE net change over the window, not just the recurring economy
    // engine's own component (rent/payroll/passive income) — fight purses
    // and Drama Engine money effects both move playerState.money outside
    // economyReport, so summing economyReport.netChange alone would
    // silently under/over-count whenever either of those fired this window.
    const netMoneyChange = startMoney === null ? null : this.playerState.money - startMoney;
    const dramaEventsResolved = weeklyResults.filter((r) => r.dramaReport).length;

    const methodCounts = {};
    for (const result of fightResults) {
      const method = result.method ?? 'INCONNU';
      methodCounts[method] = (methodCounts[method] ?? 0) + 1;
    }

    const titleWins = fightResults
      .filter((result) => result.titleOnTheLine && result.winner !== null)
      .map((result) => ({
        winnerName: result.names?.[result.winner] ?? result.winner,
        weightClass: result.weightClasses?.[result.winner] ?? null,
        method: result.method,
      }));

    return {
      weeksSimulated: weeklyResults.length,
      startDay,
      endDay: this.worldState.currentDay,
      money: { start: startMoney, end: this.playerState.money, netChange: netMoneyChange },
      reputation: this.playerState.reputation,
      hype: this.playerState.hype,
      fights: { total: fightResults.length, byMethod: methodCounts },
      dramaEventsResolved,
      retirements: retirements.map((r) => ({
        name: r.name,
        age: r.age,
        record: `${r.wins}-${r.losses}-${r.draws}`,
        outcome: r.reconversion.outcome,
        isHallOfFamer: r.reconversion.isHallOfFamer,
        nickname: r.reconversion.nickname,
      })),
      hallOfFameInductionsThisWindow: retirements.filter((r) => r.reconversion.isHallOfFamer).length,
      titleWins,
      rosterSnapshot: this.playerState.roster.map((fighter) => ({
        name: fighter.identity.name,
        nickname: fighter.identity.nickname,
        record: fighter.getRecordString(),
        legacyStage: fighter.getLegacyStage(),
        readiness: Math.round(fighter.getReadiness()),
      })),
      worldRecords: this.worldState.records,
      hallOfFameTotal: this.worldState.getHallOfFame().length,
    };
  }

  /**
   * @param {Object} summary - A build() result.
   * @returns {string} The recap as plain text.
   */
  toText(summary) {
    const lines = [];
    lines.push(`=== BILAN DE SAISON (${summary.weeksSimulated} semaines, jour ${summary.startDay ?? '?'} -> ${summary.endDay}) ===`);
    const netChangeText =
      summary.money.netChange === null ? '' : ` (${summary.money.netChange >= 0 ? '+' : ''}${Math.round(summary.money.netChange)}$)`;
    lines.push(`Tresorerie : ${summary.money.start ?? '?'}$ -> ${summary.money.end}$${netChangeText}`);
    lines.push(`Reputation : ${summary.reputation}  |  Hype : ${summary.hype}`);
    const methodsText = Object.entries(summary.fights.byMethod)
      .map(([method, count]) => `${method}=${count}`)
      .join(', ');
    lines.push(`Combats disputes : ${summary.fights.total}${methodsText ? ` (${methodsText})` : ''}`);
    lines.push(`Evenements Drama Engine resolus : ${summary.dramaEventsResolved}`);

    if (summary.titleWins.length > 0) {
      lines.push('');
      lines.push('\u{1F947} TITRES EN JEU CETTE SAISON :');
      for (const title of summary.titleWins) {
        lines.push(`  \u{1F947} ${title.winnerName} remporte le titre ${title.weightClass ?? ''} par ${title.method} !`);
      }
    }

    if (summary.retirements.length > 0) {
      lines.push('');
      lines.push('RETRAITES DE LA SAISON :');
      for (const retirement of summary.retirements) {
        const nicknameTag = retirement.nickname ? ` "${retirement.nickname}"` : '';
        if (retirement.isHallOfFamer) {
          lines.push(
            `  \u{1F3C6}✨ ${retirement.name}${nicknameTag} (${retirement.age} ans, ${retirement.record}) ENTRE AU HALL OF FAME ✨\u{1F3C6} -> ${retirement.outcome}`
          );
        } else {
          lines.push(`  ${retirement.name}${nicknameTag} (${retirement.age} ans, ${retirement.record}) -> ${retirement.outcome}`);
        }
      }
    }

    lines.push('');
    lines.push(`ROSTER ACTUEL (Hall of Fame total du monde : ${summary.hallOfFameTotal}) :`);
    for (const fighter of summary.rosterSnapshot) {
      const nicknameTag = fighter.nickname ? ` "${fighter.nickname}"` : '';
      lines.push(`  ${fighter.name}${nicknameTag} (${fighter.record}, ${fighter.legacyStage}) — Readiness ${fighter.readiness}`);
    }

    return lines.join('\n');
  }
}

export default SeasonSummary;
