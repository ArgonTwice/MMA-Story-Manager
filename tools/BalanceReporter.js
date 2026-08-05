/**
 * tools/BalanceReporter.js
 * ---------------------------------------------------------------------------
 * Formats the statistics object returned by tools/SimRunner.js#runSimulation
 * into a structured, human-readable balance report, and prints it to the
 * console. Pure formatting layer: it never touches State/Engine/EventBus,
 * only reads the plain data SimRunner already finalized.
 *
 * `formatReport` returns the report as a single string (easy to unit-test
 * without capturing console output); `printReport` is the console.log
 * convenience wrapper the CLI actually calls.
 * ---------------------------------------------------------------------------
 */

const COLUMN_GAP = '  ';

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatCurrency(value) {
  return value === null || value === undefined ? 'N/A' : `${formatNumber(value)} $`;
}

function formatPercent(value, digits = 2) {
  return value === null || value === undefined || Number.isNaN(value) ? 'N/A' : `${(value * 100).toFixed(digits)}%`;
}

function formatDecimal(value, digits = 1) {
  return value === null || value === undefined || Number.isNaN(value) ? 'N/A' : value.toFixed(digits);
}

/**
 * Renders an aligned text table: the first column left-aligned (labels),
 * every other column right-aligned (numbers/percentages).
 * @param {string[]} headers
 * @param {(string|number)[][]} rows
 * @returns {string}
 */
function renderTable(headers, rows) {
  const columnCount = headers.length;
  const widths = Array.from({ length: columnCount }, (_, col) =>
    Math.max(String(headers[col]).length, ...rows.map((row) => String(row[col]).length))
  );

  const renderRow = (cells) =>
    cells
      .map((cell, col) => (col === 0 ? String(cell).padEnd(widths[col]) : String(cell).padStart(widths[col])))
      .join(COLUMN_GAP);

  const separator = widths.map((w) => '-'.repeat(w)).join(COLUMN_GAP);
  return [renderRow(headers), separator, ...rows.map(renderRow)].join('\n');
}

function renderSectionTitle(title) {
  return `\n--- ${title} ---`;
}

function renderHeader(result) {
  const { config, durationMs } = result;
  const lines = [
    '=== RAPPORT D\'EQUILIBRAGE — MMA GYM MANAGER V2 (Phase 3.0 Headless Simulator) ===',
    `Simulation : ${formatNumber(config.seasons)} saison(s) x ${config.weeksPerSeason} semaines = ${formatNumber(config.totalWeeks)} semaines simulees`,
    `Roster maintenu : ${config.rosterSize} combattants` +
      (config.seed !== undefined ? ` | seed=${config.seed}` : ' | rng non-graine (Math.random)') +
      ` | chance de combat/paire/semaine=${formatPercent(config.fightChancePerPair, 0)}`,
    `Duree d'execution : ${formatNumber(durationMs)} ms`,
  ];
  return lines.join('\n');
}

function renderEconomySection(result) {
  const e = result.economy;
  const lines = [renderSectionTitle('ECONOMIE')];
  lines.push(`Semaines simulees            : ${formatNumber(e.weeksSimulated)}`);
  lines.push(`Tresorerie moyenne            : ${formatCurrency(e.avgBalance)}`);
  lines.push(`Tresorerie min / max observee : ${formatCurrency(e.minBalanceEver)} / ${formatCurrency(e.maxBalanceEver)}`);
  lines.push(`Revenus passifs hebdo moyens  : ${formatCurrency(e.avgWeeklyIncome)}`);
  lines.push(`Depenses hebdo moyennes       : ${formatCurrency(e.avgWeeklyExpenses)}`);
  lines.push(
    `Semaines en crise d'insolvabilite (faillite) : ${formatNumber(e.insolvencyWeeks)} / ${formatNumber(e.weeksSimulated)} (${formatPercent(e.insolvencyRate)})`
  );
  return lines.join('\n');
}

function renderRosterSection(result) {
  const lines = [renderSectionTitle('ROSTER & ARCHETYPES')];
  lines.push(`Combattants generes sur la periode : ${formatNumber(result.fighters.totalGenerated)}`);
  lines.push(`Retraites forcees observees        : ${formatNumber(result.fighters.totalRetired)}`);
  lines.push('');

  const headers = ['Archetype', 'Combats', 'V', 'D', 'N', 'Winrate', 'Retraites', 'Age moy. retraite', 'V moy. retraite'];
  const rows = Object.entries(result.archetypes).map(([archetype, a]) => {
    const total = a.wins + a.losses + a.draws;
    return [
      archetype,
      formatNumber(total),
      formatNumber(a.wins),
      formatNumber(a.losses),
      formatNumber(a.draws),
      formatPercent(a.winRate),
      formatNumber(a.retirementCount),
      formatDecimal(a.avgRetirementAge),
      formatDecimal(a.avgWinsAtRetirement),
    ];
  });
  lines.push(renderTable(headers, rows));
  return lines.join('\n');
}

function renderStyleSection(result) {
  const lines = [renderSectionTitle('DOMINANCE DES STYLES')];
  const headers = ['Style', 'Combats', 'V', 'D', 'N', 'Winrate'];
  const rows = Object.entries(result.styles).map(([style, s]) => {
    const total = s.wins + s.losses + s.draws;
    return [style, formatNumber(total), formatNumber(s.wins), formatNumber(s.losses), formatNumber(s.draws), formatPercent(s.winRate)];
  });
  lines.push(renderTable(headers, rows));
  return lines.join('\n');
}

function renderHealthSection(result) {
  const h = result.health;
  const lines = [renderSectionTitle('METRIQUES DE SANTE')];
  lines.push(
    `Blessures totales : ${formatNumber(h.totalInjuries)} ` +
      `(Combat: ${formatNumber(h.bySource.COMBAT ?? 0)}, Entrainement: ${formatNumber(h.bySource.TRAINING ?? 0)}, Sparring: ${formatNumber(h.bySource.SPARRING ?? 0)})`
  );
  lines.push('');

  const severities = Object.keys(h.bySeverity);
  if (severities.length === 0) {
    lines.push('Aucune blessure enregistree sur cette periode.');
  } else {
    const headers = ['Severite', 'Nombre', 'Duree moy. indispo (jours)'];
    const rows = severities.map((severity) => [
      severity,
      formatNumber(h.bySeverity[severity].count),
      formatDecimal(h.bySeverity[severity].avgRecoveryDays),
    ]);
    lines.push(renderTable(headers, rows));
  }
  return lines.join('\n');
}

function renderFunDetectorSection(result) {
  const f = result.fun;
  const n = result.narrative;
  const lines = [renderSectionTitle('FUN DETECTOR')];
  lines.push(
    `Semaines "creuses" (0 evenement narratif, 0 combat, 0 tension financiere) : ` +
      `${formatNumber(f.dullWeeks)} / ${formatNumber(f.totalWeeks)} (${formatPercent(f.dullWeekRate)})`
  );
  lines.push(`Beats narratifs generes par les combats (StoryEngine/NarrativeEngine) : ${formatNumber(n.totalBeats)}`);
  const tones = Object.entries(n.byTone);
  if (tones.length > 0) {
    lines.push(`  dont par ton : ${tones.map(([tone, count]) => `${tone}=${formatNumber(count)}`).join(', ')}`);
  }
  return lines.join('\n');
}

function renderFightsSection(result) {
  const lines = [renderSectionTitle('COMBATS')];
  lines.push(`Total de combats simules : ${formatNumber(result.fights.total)}`);
  const methods = Object.entries(result.fights.byMethod).sort((a, b) => b[1] - a[1]);
  if (methods.length > 0) {
    lines.push(`Repartition par methode   : ${methods.map(([method, count]) => `${method}=${formatNumber(count)}`).join(', ')}`);
  }
  return lines.join('\n');
}

function renderNotesSection(result) {
  const forcedAge = result.archetypes && Object.values(result.archetypes).find((a) => a.avgRetirementAge !== null)?.avgRetirementAge;
  const lines = [renderSectionTitle('NOTES METHODOLOGIQUES')];
  lines.push(
    '* La retraite volontaire (BALANCE.AGE.RETIREMENT.BASE_CHANCE_PER_YEAR_PAST_MIN / CHANCE_PER_LOSS_AFTER_MIN_AGE)' +
      " n'est branchee dans aucun moteur du jeu a ce jour : tous les departs observes sont des retraites forcees" +
      (forcedAge !== undefined ? ` (age ${formatDecimal(forcedAge, 0)} ans).` : ' (BALANCE.AGE.RETIREMENT.FORCED_RETIREMENT_AGE).')
  );
  lines.push(
    "* Aucun combat de championnat n'est reserve automatiquement par ce simulateur (le jeu ne possede pas encore de" +
      " moteur de matchmaking a reutiliser) : les records mostTitles/longestTitleReign ne sont donc jamais alimentes ici."
  );
  lines.push(
    '* Le matchmaking et les plans d\'entrainement de cet outil sont une "IA de coach" propre au simulateur' +
      ' (tools/SimRunner.js), pas un systeme du jeu reel.'
  );
  return lines.join('\n');
}

/**
 * @param {Object} result - The object returned by SimRunner#runSimulation.
 * @returns {string} The full multi-section report as plain text.
 */
export function formatReport(result) {
  return [
    renderHeader(result),
    renderEconomySection(result),
    renderRosterSection(result),
    renderStyleSection(result),
    renderHealthSection(result),
    renderFunDetectorSection(result),
    renderFightsSection(result),
    renderNotesSection(result),
    '',
  ].join('\n');
}

/**
 * Formats and prints the report to the console in one call.
 * @param {Object} result - The object returned by SimRunner#runSimulation.
 */
export function printReport(result) {
  console.log(formatReport(result));
}
