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

function renderCombatTelemetryHeader() {
  return '\n=== COMBAT METRICS (TELEMETRY) ===';
}

function renderTakedownsSubsection(result) {
  const c = result.combat;
  const lines = [renderSectionTitle('TAKEDOWNS & CONTROLE')];
  lines.push(`Tentatives de takedown (distance GROUND choisie) : ${formatNumber(c.takedownAttempts)}`);
  lines.push(`Taux de reussite des takedowns                    : ${formatPercent(c.takedownSuccessRate)}`);
  lines.push(`Taux de defense des takedowns                     : ${formatPercent(c.takedownDefenseRate)}`);
  return lines.join('\n');
}

function renderTimeSplitSubsection(result) {
  const c = result.combat;
  const lines = [renderSectionTitle('REPARTITION DU TEMPS DE COMBAT')];
  lines.push(`Temps Debout (STRIKING) : ${formatPercent(c.standingTimeShare)} (${formatNumber(c.standingRounds)} rounds)`);
  lines.push(`Temps Clinch            : ${formatPercent(c.clinchTimeShare)} (${formatNumber(c.clinchRounds)} rounds)`);
  lines.push(`Temps au Sol (GROUND)   : ${formatPercent(c.groundTimeShare)} (${formatNumber(c.groundRounds)} rounds)`);
  lines.push('');
  lines.push(`Degats moyens par round Debout : ${formatDecimal(c.avgStandingDamagePerRound)}`);
  lines.push(`Degats moyens par round Sol    : ${formatDecimal(c.avgGroundDamagePerRound)}`);
  return lines.join('\n');
}

function renderSubmissionsSubsection(result) {
  const c = result.combat;
  const lines = [renderSectionTitle('SOUMISSIONS & CONTRES')];
  lines.push(`Tentatives de soumission          : ${formatNumber(c.submissionAttempts)}`);
  lines.push(`Taux de reussite des soumissions   : ${formatPercent(c.submissionSuccessRate)}`);
  lines.push(`Contres declenches (opportunites)  : ${formatNumber(c.countersTriggered)}`);
  lines.push(`Taux d'opportunite de contre       : ${formatPercent(c.counterOpportunityRate)}`);
  return lines.join('\n');
}

function renderJudgeBiasSubsection(result) {
  const c = result.combat;
  const lines = [renderSectionTitle('BIAIS D\'EVALUATION DES JUGES')];
  lines.push(`Points de score cumules issus des degats        : ${formatDecimal(c.judgePointsFromDamage, 0)}`);
  lines.push(`Points de score cumules issus du controle au sol : ${formatDecimal(c.judgePointsFromGroundControl, 0)}`);
  lines.push(`Ecart moyen (controle sol - degats) par combat   : ${formatDecimal(c.avgJudgePointsGapPerFight)}`);
  lines.push(
    `Combats a la decision avec controle sol dominant : ${formatNumber(c.groundDominantDecisionFights)} / ${formatNumber(c.decisionFights)}`
  );
  lines.push(
    `Winrate a la decision quand le controle sol est dominant : ${formatPercent(c.groundDominantWinRate)}`
  );
  return lines.join('\n');
}

function renderStyleMatchupSubsection(result) {
  const lines = [renderSectionTitle('MATRICE DE MATCHUP PAR STYLE (ligne vs colonne)')];
  const matrix = result.styleMatchups;
  const styleKeys = Object.keys(matrix);

  const headers = ['Style \\ Adversaire', ...styleKeys];
  const rows = styleKeys.map((rowStyle) => [
    rowStyle,
    ...styleKeys.map((colStyle) => {
      const cell = matrix[rowStyle][colStyle];
      const total = cell.wins + cell.losses + cell.draws;
      return total === 0 ? '—' : `${formatPercent(cell.winRate, 0)} (${cell.wins}-${cell.losses}-${cell.draws})`;
    }),
  ]);
  lines.push(renderTable(headers, rows));
  return lines.join('\n');
}

function renderCombatTelemetrySection(result) {
  return [
    renderCombatTelemetryHeader(),
    renderTakedownsSubsection(result),
    renderTimeSplitSubsection(result),
    renderSubmissionsSubsection(result),
    renderJudgeBiasSubsection(result),
    renderStyleMatchupSubsection(result),
  ].join('\n');
}

const ACTION_LABELS = Object.freeze({
  HEAD_STRIKE: 'Frappes Tete (Debout)',
  BODY_STRIKE: 'Frappes Corps (Debout)',
  LEG_STRIKE: 'Coups de Jambes (Debout)',
  CLINCH: 'Clinch',
  TAKEDOWN: 'Takedown / Controle Sol',
  SUBMISSION_ATTEMPT: 'Tentative de Soumission',
});

function renderMetaHealthHeader() {
  return '\n=== META HEALTH DASHBOARD ===';
}

function renderWinConditionSubsection(result) {
  const lines = [renderSectionTitle('\u{1F4CA} WIN CONDITION REPORT (par style)')];
  const headers = ['Style', 'Victoires', 'KO %', 'TKO %', 'Sub %', 'Decision %', 'Arret Medical %'];
  const rows = Object.entries(result.styleWinMethods).map(([style, entry]) => {
    const m = entry.byMethod;
    const decisionCount = (m.UNANIMOUS_DECISION?.count ?? 0) + (m.SPLIT_DECISION?.count ?? 0) + (m.MAJORITY_DECISION?.count ?? 0);
    const decisionRate = entry.totalWins > 0 ? decisionCount / entry.totalWins : null;
    return [
      style,
      formatNumber(entry.totalWins),
      formatPercent(m.KO?.share ?? null, 0),
      formatPercent(m.TKO?.share ?? null, 0),
      formatPercent(m.SUBMISSION?.share ?? null, 0),
      formatPercent(decisionRate, 0),
      formatPercent(m.DOCTOR_STOPPAGE?.share ?? null, 0),
    ];
  });
  lines.push(renderTable(headers, rows));
  return lines.join('\n');
}

function renderActionEVSubsection(result) {
  const lines = [renderSectionTitle('⚖️ EXPECTED VALUE (EV) DES ACTIONS')];
  const headers = ['Action', 'Tentatives', 'Taux reussite', 'Degats moy.', 'EV (pts juge/round)', 'Controle gagne'];
  const rows = Object.entries(result.combat.actionMetrics).map(([key, m]) => [
    ACTION_LABELS[key] ?? key,
    formatNumber(m.attempts),
    formatPercent(m.successRate, 0),
    formatDecimal(m.avgDamage),
    formatDecimal(m.avgScorePoints),
    formatPercent(m.controlRate, 0),
  ]);
  lines.push(renderTable(headers, rows));
  lines.push('');
  lines.push("Agressivite (paiement reel par choix de tempo, meme action sinon) :");
  const tempoHeaders = ['Tempo', 'Rounds', 'Degats moy./round', 'Score juge moy./round'];
  const tempoRows = Object.entries(result.combat.tempoMetrics).map(([tempo, t]) => [
    tempo,
    formatNumber(t.rounds),
    formatDecimal(t.avgDamage),
    formatDecimal(t.avgScorePoints),
  ]);
  lines.push(renderTable(tempoHeaders, tempoRows));
  return lines.join('\n');
}

function renderMetaJudgeBiasSubsection(result) {
  const c = result.combat;
  const totalJudgePoints = c.judgePointsFromDamage + c.judgePointsFromGroundControl;
  const controlShare = totalJudgePoints > 0 ? c.judgePointsFromGroundControl / totalJudgePoints : null;
  const damageShare = totalJudgePoints > 0 ? c.judgePointsFromDamage / totalJudgePoints : null;

  const aggressive = c.tempoMetrics.AGGRESSIVE;
  const conservative = c.tempoMetrics.CONSERVATIVE;
  const aggressivePayoff =
    aggressive.avgScorePoints !== null && conservative.avgScorePoints
      ? aggressive.avgScorePoints / conservative.avgScorePoints - 1
      : null;

  const lines = [renderSectionTitle('\u{1F468}‍⚖️ JUDGE BIAS REPORT (poids reel)')];
  lines.push(`Poids reel — Controle (sol/clinch) : ${formatPercent(controlShare, 1)}`);
  lines.push(`Poids reel — Degats                : ${formatPercent(damageShare, 1)}`);
  lines.push(
    `Agressivite (score/round en tempo AGGRESSIVE vs CONSERVATIVE) : ` +
      (aggressivePayoff === null ? 'N/A' : `${aggressivePayoff >= 0 ? '+' : ''}${(aggressivePayoff * 100).toFixed(1)}%`)
  );
  lines.push('');
  lines.push(
    'Note : Controle et Degats sont les deux SEULS termes additifs de la formule de score des juges' +
      ' (CombatEngine#_computeScoreBreakdown) ; l\'Agressivite n\'est pas un troisieme critere additif — c\'est un' +
      ' multiplicateur sur les Degats (BALANCE.COMBAT.GAMEPLAN.TEMPO_MODIFIERS), mesure ici separement, pas dans' +
      ' le meme total a 100%.'
  );
  return lines.join('\n');
}

function renderStyleIdentitySubsection(result) {
  const lines = [renderSectionTitle('\u{1F94A} STYLE IDENTITY SCORE (fidelite / 100)')];
  const headers = ['Style', 'Score de fidelite'];
  const rows = Object.entries(result.styleIdentity).map(([style, score]) => [
    style,
    score === null ? 'N/A (pas d\'affinite de distance)' : formatDecimal(score, 0),
  ]);
  lines.push(renderTable(headers, rows));
  return lines.join('\n');
}

function renderDiversitySubsection(result) {
  const d = result.diversity;
  const lines = [renderSectionTitle('\u{1F310} DIVERSITY INDEX')];
  lines.push(`Indice de diversite (entropie normalisee, 0-100) : ${formatNumber(d.diversityIndex)}`);
  lines.push('');
  const headers = ['Style', 'Combattants generes', 'Part de la population'];
  const rows = Object.entries(d.byStyle).map(([style, entry]) => [
    style,
    formatNumber(entry.count),
    formatPercent(entry.share, 1),
  ]);
  lines.push(renderTable(headers, rows));
  return lines.join('\n');
}

function renderMetaHealthIndexSubsection(result) {
  const m = result.metaHealth;
  const lines = [renderSectionTitle('\u{1F4AF} META HEALTH INDEX')];
  lines.push(`Diversite (representation des styles) : ${formatNumber(m.diversityScore)} / 100`);
  lines.push(`Equilibre (winrate proche de 50%)      : ${formatNumber(m.balanceScore)} / 100`);
  lines.push(`Sante financiere (inverse du taux de faillite) : ${formatNumber(m.financialHealthScore)} / 100`);
  lines.push(`Fun (inverse du taux de semaines creuses)      : ${formatNumber(m.funScore)} / 100`);
  lines.push('');
  lines.push(`>>> META HEALTH INDEX : ${formatNumber(m.overallIndex)} / 100 <<<`);
  return lines.join('\n');
}

function renderMetaHealthDashboard(result) {
  return [
    renderMetaHealthHeader(),
    renderWinConditionSubsection(result),
    renderActionEVSubsection(result),
    renderMetaJudgeBiasSubsection(result),
    renderStyleIdentitySubsection(result),
    renderDiversitySubsection(result),
    renderMetaHealthIndexSubsection(result),
  ].join('\n');
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
  lines.push(
    "* CombatEngine ne modelise pas (encore) de veritable contestation de takedown : choisir la distance GROUND" +
      ' reussit toujours instantanement, sans jet de defense pour l\'adversaire — d\'ou un taux de reussite a 100%' +
      ' et un taux de defense a 0% ci-dessus. C\'est une donnee telemetrique fidele au jeu actuel, pas un bug de ce rapport.'
  );
  lines.push(
    "* De meme, \"contres declenches\" compte uniquement l'opportunite (une tentative de soumission ratee par" +
      " l'adversaire) : CombatEngine ne resout aucun effet de contre-attaque (pas de degats/bonus) sur cette" +
      ' opportunite a ce jour.'
  );
  lines.push(
    '* Les actions de l\'EV (Frappes Tete/Corps/Jambes, Clinch, Takedown, Tentative de Soumission) correspondent aux' +
      ' seules combinaisons cible x distance que CombatEngine resout reellement — il ne simule pas de coups' +
      ' individuels (pas de distinction Jab/Cross/Uppercut) ; "Tentative de Soumission" est un sous-ensemble des' +
      " rounds Takedown (un round GROUND declenche toujours les deux a la fois), donc sommer tous les buckets" +
      ' surcompte les rounds GROUND — chaque bucket se lit independamment.'
  );
  lines.push(
    '* Le Style Identity Score mesure la fidelite des COMPETENCES du combattant a son style (recouvrement entre' +
      ' sa repartition de skills et les poids ideaux de la distance de son style), pas si le simulateur "joue' +
      ' juste" — l\'IA de coach de cet outil choisit deja toujours le gameplan optimal pour le style, donc mesurer' +
      ' ca donnerait trivialement 100% partout.'
  );
  lines.push(
    '* Le Diversity Index et le Meta Health Index sont des formules simples et transparentes (entropie de Shannon' +
      ' normalisee ; moyenne non ponderee de 4 sous-scores affiches individuellement), pas des scores calibres' +
      ' sur un playtest reel — a interpreter comme un tableau de bord de diagnostic, pas une note certifiee.'
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
    renderCombatTelemetrySection(result),
    renderMetaHealthDashboard(result),
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
