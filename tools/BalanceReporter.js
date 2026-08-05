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

/** Signed integer delta, e.g. for score-out-of-100 comparisons ("+3", "-5", "0"). */
function formatSignedInt(delta) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return 'N/A';
  const rounded = Math.round(delta);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/** Signed percentage-point delta between two [0, 1] rates, e.g. for winrate/bias comparisons ("+4.2 pts", "-8.5 pts"). */
function formatSignedPercentPoints(current, previous, digits = 1) {
  if (current === null || current === undefined || previous === null || previous === undefined) return 'N/A';
  const deltaPoints = (current - previous) * 100;
  const sign = deltaPoints >= 0 ? '+' : '';
  return `${sign}${deltaPoints.toFixed(digits)} pts`;
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
      `(Combat: ${formatNumber(h.bySource.COMBAT ?? 0)}, Entrainement: ${formatNumber(h.bySource.TRAINING ?? 0)}, ` +
      `Sparring (evenement narratif): ${formatNumber(h.bySource.SPARRING ?? 0)}, ` +
      `Sparring (creneau hebdo, Phase 3.1 v1): ${formatNumber(h.bySource.SPARRING_SESSION ?? 0)})`
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

/**
 * "Average Round EV Ratio": weighted-average judge-score EV for standing
 * (HEAD/BODY/LEG strikes, weighted by each bucket's own attempt count) vs
 * ground (TAKEDOWN) rounds, and their ratio. Computed here from
 * already-finalized result.combat.actionMetrics rather than a new SimRunner
 * field — every input (attempts + avgScorePoints per bucket) is already
 * reported per-bucket, so this stays pure formatting/derivation, no new
 * aggregation logic added to SimRunner.
 * @returns {{ evStanding: number|null, evGround: number|null, ratio: number|null }}
 */
function computeRoundEVRatio(result) {
  const a = result.combat.actionMetrics;
  const standingBuckets = [a.HEAD_STRIKE, a.BODY_STRIKE, a.LEG_STRIKE];
  const standingAttempts = standingBuckets.reduce((sum, bucket) => sum + bucket.attempts, 0);
  const evStanding =
    standingAttempts > 0
      ? standingBuckets.reduce((sum, bucket) => sum + bucket.attempts * (bucket.avgScorePoints ?? 0), 0) / standingAttempts
      : null;
  const evGround = a.TAKEDOWN.avgScorePoints;
  const ratio = evStanding !== null && evStanding > 0 && evGround !== null ? evGround / evStanding : null;
  return { evStanding, evGround, ratio };
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

  const { evStanding, evGround, ratio } = computeRoundEVRatio(result);
  lines.push('Average Round EV Ratio (Debout vs Sol) :');
  lines.push(`  EV Debout (Tete/Corps/Jambes, pondere par tentatives) : ${formatDecimal(evStanding)}`);
  lines.push(`  EV Sol (Takedown/Controle)                            : ${formatDecimal(evGround)}`);
  lines.push(`  Ratio Sol / Debout                                    : ${ratio === null ? 'N/A' : `x${ratio.toFixed(2)}`}`);
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

/**
 * Test A3's "Risk / Reward Index" per action bucket:
 *   Risk   = avg penalty on FAILURE (damage taken + stamina lost + momentum
 *            lost, using the *OnFailure fields SimRunner derives from
 *            CombatEngine's per-attempt totals).
 *   Reward = avg gain on SUCCESS (damage + judge points + control, using the
 *            *OnSuccess fields).
 *   Ratio  = Reward / Risk.
 * Risk (and therefore Ratio) is only defined for buckets with a real
 * pass/fail roll: TAKEDOWN (Test A3's new contest) and SUBMISSION_ATTEMPT
 * (the pre-existing submission roll). HEAD_STRIKE/BODY_STRIKE/LEG_STRIKE/
 * CLINCH never fail outright (continuous hit-chance multiplier, no discrete
 * miss), so they show N/A rather than a fabricated risk figure.
 */
function computeRiskRewardIndex(result) {
  const rows = [];
  for (const [key, m] of Object.entries(result.combat.actionMetrics)) {
    const reward =
      m.avgDamageOnSuccess === null && m.avgScorePointsOnSuccess === null && m.controlRateOnSuccess === null
        ? null
        : (m.avgDamageOnSuccess ?? 0) + (m.avgScorePointsOnSuccess ?? 0) + (m.controlRateOnSuccess ?? 0);
    const risk =
      m.avgDamageTakenOnFailure === null && m.avgStaminaPenaltyOnFailure === null && m.avgMomentumPenaltyOnFailure === null
        ? null
        : (m.avgDamageTakenOnFailure ?? 0) + (m.avgStaminaPenaltyOnFailure ?? 0) + (m.avgMomentumPenaltyOnFailure ?? 0);
    const ratio = reward !== null && risk !== null && risk > 0 ? reward / risk : null;
    rows.push({ key, failures: m.failures, reward, risk, ratio });
  }
  return rows;
}

function renderRiskRewardSubsection(result) {
  const lines = [renderSectionTitle('⚖️ RISK / REWARD INDEX (par action)')];
  const rows = computeRiskRewardIndex(result);
  const headers = ['Action', 'Echecs (N)', 'Risk (penalite moy./echec)', 'Reward (gain moy./reussite)', 'Ratio Reward/Risk'];
  const tableRows = rows.map((r) => [
    ACTION_LABELS[r.key] ?? r.key,
    formatNumber(r.failures),
    r.risk === null ? 'N/A (pas d\'echec discret)' : formatDecimal(r.risk, 2),
    r.reward === null ? 'N/A' : formatDecimal(r.reward, 2),
    r.ratio === null ? 'N/A' : `x${r.ratio.toFixed(2)}`,
  ]);
  lines.push(renderTable(headers, tableRows));
  lines.push('');
  lines.push(
    'Note : seuls TAKEDOWN (contest A3) et SUBMISSION_ATTEMPT ont un jet de reussite/echec discret dans' +
      ' CombatEngine — HEAD_STRIKE/BODY_STRIKE/LEG_STRIKE/CLINCH se resolvent via un multiplicateur continu, sans' +
      ' echec binaire, d\'ou leur Risk "N/A" plutot qu\'un chiffre invente.'
  );
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
    renderRiskRewardSubsection(result),
    renderMetaJudgeBiasSubsection(result),
    renderStyleIdentitySubsection(result),
    renderDiversitySubsection(result),
    renderMetaHealthIndexSubsection(result),
  ].join('\n');
}

const WEEKLY_PLANNING_ACTIVITY_LABELS = Object.freeze({
  TECHNIQUE: 'Technique',
  SPARRING: 'Sparring',
  VIDEO_PREP: 'Preparation Video',
  MEDIA_SPONSORS: 'Medias & Sponsors',
  PHYSIO_REST: 'Physio & Repos',
});

/** Training Diversity Index target: no single activity should account for more than half of all resolved slots. */
const TRAINING_DIVERSITY_MAX_SHARE = 0.5;
/** Average Readiness on fight day target band (Phase 3.1 v1 spec). */
const AVERAGE_READINESS_TARGET = Object.freeze({ MIN: 75, MAX: 85 });

function renderWeeklyPlanningHeader() {
  return '\n=== PLANNING HEBDOMADAIRE & READINESS (Phase 3.1 v1) ===';
}

function renderTrainingDiversitySubsection(result) {
  const wp = result.weeklyPlanning;
  const lines = [renderSectionTitle('\u{1F4CA} TRAINING DIVERSITY INDEX')];
  const headers = ['Activite', 'Slots utilises', 'Part'];
  const rows = Object.entries(wp.activityUsage).map(([key, a]) => [
    WEEKLY_PLANNING_ACTIVITY_LABELS[key] ?? key,
    formatNumber(a.count),
    formatPercent(a.share, 1),
  ]);
  lines.push(renderTable(headers, rows));
  lines.push('');
  const maxSharePass = wp.maxActivityShare !== null && wp.maxActivityShare <= TRAINING_DIVERSITY_MAX_SHARE;
  lines.push(
    `Part maximale d'une activite : ${formatPercent(wp.maxActivityShare, 1)} ` +
      `(cible : <= ${formatPercent(TRAINING_DIVERSITY_MAX_SHARE, 0)}) : ${maxSharePass ? 'DANS LA CIBLE' : 'HORS CIBLE'}`
  );
  return lines.join('\n');
}

function renderAverageReadinessSubsection(result) {
  const wp = result.weeklyPlanning;
  const lines = [renderSectionTitle('\u{1F4AA} AVERAGE READINESS (le jour du combat)')];
  const readiness = wp.averageReadinessOnFightDay;
  const inTarget = readiness !== null && readiness >= AVERAGE_READINESS_TARGET.MIN && readiness <= AVERAGE_READINESS_TARGET.MAX;
  lines.push(
    `Readiness moyenne des combattants le jour du combat : ${formatDecimal(readiness, 1)} ` +
      `(cible : ${AVERAGE_READINESS_TARGET.MIN}-${AVERAGE_READINESS_TARGET.MAX}) : ${readiness === null ? 'N/A' : inTarget ? 'DANS LA CIBLE' : 'HORS CIBLE'}`
  );
  return lines.join('\n');
}

function renderDecisionQualitySubsection(result) {
  const wp = result.weeklyPlanning;
  const lines = [renderSectionTitle('\u{1F3AF} DECISION QUALITY INDEX (viabilite des strategies de planning)')];
  const headers = ['Strategie de planning', 'Semaines-combattant', 'Semaines en surmenage massif', 'Taux de surmenage'];
  const rows = Object.entries(wp.byStyle).map(([style, s]) => [
    style,
    formatNumber(s.fighterWeeks),
    formatNumber(s.overheatWeeks),
    formatPercent(s.overheatRate, 1),
  ]);
  lines.push(renderTable(headers, rows));
  lines.push('');
  lines.push(`Taux de surmenage massif global : ${formatPercent(wp.overallOverheatRate, 1)}`);
  lines.push(`Taux d'insolvabilite du gymnase : ${formatPercent(result.economy.insolvencyRate, 2)}`);
  lines.push('');
  lines.push(`>>> DECISION QUALITY INDEX : ${wp.decisionQualityIndex === null ? 'N/A' : `${formatNumber(wp.decisionQualityIndex)} / 100`} <<<`);
  lines.push(
    '(Index = moyenne de deux sous-scores non officiels definis par cette implementation : sante financiere du' +
      ' gymnase (inverse du taux d\'insolvabilite) et absence de surmenage massif (inverse du taux de semaines-' +
      ' combattant a >= 90% de Fatigue) — le spec ne donnait qu\'un objectif qualitatif ("plusieurs strategies' +
      ' restent viables sans faillite ni surmenage massif"), pas de formule ; voir tools/SimRunner.js\'s' +
      ' finalizeWeeklyPlanning pour le detail.)'
  );
  return lines.join('\n');
}

function renderWeeklyPlanningSection(result) {
  return [
    renderWeeklyPlanningHeader(),
    renderTrainingDiversitySubsection(result),
    renderAverageReadinessSubsection(result),
    renderDecisionQualitySubsection(result),
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

/**
 * Manually-recorded history of past A/B test runs (Phase 3.0's
 * "atomique" methodology: one balance.js variable changed per test).
 * Each entry is a point-in-time snapshot as it was reported to the user
 * when that test concluded — metrics that weren't tracked yet at the
 * time are left null rather than back-filled/guessed. Append a new entry
 * once a future test's results are confirmed, exactly like a changelog;
 * never edit a past entry's recorded numbers.
 */
const VERSION_HISTORY = Object.freeze([
  Object.freeze({
    version: 'v0.30',
    label: 'Baseline',
    change: 'Reference (fin de la Phase 3.0.3, avant tout Test A/B)',
    grapplingWinRate: null,
    freestyleWinRate: null,
    groundDominantDecisionWinRate: null,
    evRatio: null,
    balanceScore: 74,
    funScore: 68,
    metaHealthIndex: 86,
  }),
  Object.freeze({
    version: 'v0.31',
    label: 'Test A1',
    change: 'COMBAT.SCORING.NON_STRIKE_METRIC_SCALE : 10 -> 7.5 (poids du controle sol/soumission/takedown dans le score des juges)',
    grapplingWinRate: 0.655,
    freestyleWinRate: null,
    groundDominantDecisionWinRate: 0.712,
    evRatio: null,
    balanceScore: 74,
    funScore: 69,
    metaHealthIndex: 87,
  }),
  Object.freeze({
    version: 'v0.32',
    label: 'Test A2',
    change: 'COMBAT.SCORING.WEIGHT_CONTROL_TIME : 0.2 -> 0.14 (valeur des gains de position/controle au sol, a poids des juges v0.31 inchange)',
    grapplingWinRate: 0.664,
    freestyleWinRate: null,
    groundDominantDecisionWinRate: 0.696,
    evRatio: 1.87,
    balanceScore: 77,
    funScore: 69,
    metaHealthIndex: 87,
  }),
  Object.freeze({
    version: 'v0.33',
    label: 'Test A3',
    change:
      'Boucle de Risque Decisionnel sur les takedowns : contest reel (ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE=0.4' +
      ' desormais branche via CombatEngine#_computeTakedownChance, au lieu d\'atterrir a 100%) + COMBAT.TAKEDOWN_RISK' +
      ' (A3.1 cout Stamina/Momentum sur echec, A3.2 fenetre de contre pour le defenseur, A3.3 bonus de Sprawl' +
      ' cumulatif anti-spam). Juges v0.31 et controle sol v0.32 inchanges.',
    grapplingWinRate: 0.416,
    freestyleWinRate: 0.527,
    groundDominantDecisionWinRate: 0.388,
    evRatio: 0.71,
    balanceScore: 90,
    funScore: 69,
    metaHealthIndex: 90,
    submissionAttemptRatio: 8.61,
  }),
  Object.freeze({
    version: 'v0.34a',
    label: 'Test A3.4a',
    change:
      'ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE : 0.4 -> 0.5 (seule variable modifiee vs Test A3 — A3.1/A3.2/A3.3' +
      ' de COMBAT.TAKEDOWN_RISK restent intacts, methodologie A/B atomique).',
    grapplingWinRate: 0.455,
    freestyleWinRate: 0.503,
    groundDominantDecisionWinRate: 0.435,
    evRatio: 0.85,
    balanceScore: 95,
    funScore: 69,
    metaHealthIndex: 91,
    submissionAttemptRatio: 8.97,
  }),
  Object.freeze({
    version: 'v0.34b',
    label: 'Test A3.4b',
    change:
      'ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE : 0.5 -> 0.55 (seule variable modifiee vs Test A3.4a — A3.1/A3.2/A3.3' +
      ' de COMBAT.TAKEDOWN_RISK restent intacts, methodologie A/B atomique). Validee par Mistral.',
    grapplingWinRate: 0.479,
    freestyleWinRate: 0.477,
    groundDominantDecisionWinRate: 0.455,
    evRatio: 0.96,
    balanceScore: 96,
    funScore: 69,
    metaHealthIndex: 91,
    submissionAttemptRatio: 9.22,
  }),
]);

/** Builds this run's own row from the live `result`, to append after VERSION_HISTORY's recorded past entries. */
function buildCurrentVersionEntry(result) {
  const { ratio } = computeRoundEVRatio(result);
  return {
    version: 'v0.34c',
    label: 'Test A3.4c',
    change:
      'ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE : 0.55 -> 0.59 (seule variable modifiee vs Test A3.4b — A3.1/A3.2/A3.3' +
      ' de COMBAT.TAKEDOWN_RISK restent intacts, methodologie A/B atomique). Reglage final valide par Mistral.',
    grapplingWinRate: result.grappling.winRate,
    freestyleWinRate: result.styles.Freestyle?.winRate ?? null,
    groundDominantDecisionWinRate: result.combat.groundDominantWinRate,
    evRatio: ratio,
    balanceScore: result.metaHealth.balanceScore,
    funScore: result.metaHealth.funScore,
    metaHealthIndex: result.metaHealth.overallIndex,
    submissionAttemptRatio: computeRiskRewardIndex(result).find((r) => r.key === 'SUBMISSION_ATTEMPT')?.ratio ?? null,
  };
}

function renderVersionHistorySection(result) {
  const current = buildCurrentVersionEntry(result);
  const baseline = VERSION_HISTORY[0];
  const previous = VERSION_HISTORY[VERSION_HISTORY.length - 1];
  const rows = [...VERSION_HISTORY, current];

  const lines = ['\n=== VERSION HISTORY TRACKER ==='];
  const headers = [
    'Version',
    'Label',
    'Winrate Grappling',
    'Winrate Freestyle',
    'Biais Juges (sol dominant)',
    'Ratio EV Sol/Debout',
    'Equilibre',
    'Fun',
    'Meta Health',
  ];
  const tableRows = rows.map((entry) => [
    entry.version,
    entry.label,
    entry.grapplingWinRate === null ? 'N/A' : formatPercent(entry.grapplingWinRate, 1),
    entry.freestyleWinRate === null || entry.freestyleWinRate === undefined ? 'N/A' : formatPercent(entry.freestyleWinRate, 1),
    entry.groundDominantDecisionWinRate === null ? 'N/A' : formatPercent(entry.groundDominantDecisionWinRate, 1),
    entry.evRatio === null ? 'N/A' : `x${entry.evRatio.toFixed(2)}`,
    entry.balanceScore === null ? 'N/A' : `${formatNumber(entry.balanceScore)}/100`,
    entry.funScore === null ? 'N/A' : `${formatNumber(entry.funScore)}/100`,
    entry.metaHealthIndex === null ? 'N/A' : `${formatNumber(entry.metaHealthIndex)}/100`,
  ]);
  lines.push(renderTable(headers, tableRows));
  lines.push('');
  lines.push(`Changement teste (${current.version} ${current.label}) : ${current.change}`);
  lines.push('');
  lines.push(`Comparatif ${current.version} vs ${previous.version} (${previous.label}) :`);
  lines.push(
    `  Winrate Grappling (${result.grappling.styles.join(' + ')}) : ${formatPercent(current.grapplingWinRate, 1)} ` +
      `(${formatSignedPercentPoints(current.grapplingWinRate, previous.grapplingWinRate)} vs ${previous.version})`
  );
  lines.push(
    `  Winrate Freestyle : ${formatPercent(current.freestyleWinRate, 1)} ` +
      `(${formatSignedPercentPoints(current.freestyleWinRate, previous.freestyleWinRate)} vs ${previous.version})`
  );
  lines.push(
    `  Biais des juges (winrate a la decision quand le controle sol est dominant) : ${formatPercent(current.groundDominantDecisionWinRate, 1)} ` +
      `(${formatSignedPercentPoints(current.groundDominantDecisionWinRate, previous.groundDominantDecisionWinRate)} vs ${previous.version})`
  );
  lines.push(
    `  Fun Detector      : ${formatNumber(current.funScore)}/100 (${formatSignedInt(current.funScore - previous.funScore)} vs ${previous.version})`
  );
  lines.push(
    `  Meta Health Index : ${formatNumber(current.metaHealthIndex)}/100 (${formatSignedInt(current.metaHealthIndex - baseline.metaHealthIndex)} vs baseline ${baseline.version})`
  );
  lines.push(
    `  Submission Attempt Ratio (Reward/Risk) : ` +
      `${current.submissionAttemptRatio === null ? 'N/A' : `x${current.submissionAttemptRatio.toFixed(2)}`} ` +
      `(vs x${previous.submissionAttemptRatio?.toFixed(2) ?? 'N/A'} en ${previous.version})`
  );
  lines.push('');
  lines.push(renderTestA34cPredictionSubsection(result));
  return lines.join('\n');
}

/**
 * Test A3.4c's 4 predictions (Mistral, "reglage final") — same shape as
 * A3.4b's: Grappling is a closed range, Freestyle/Meta Health are lower
 * bounds, the ratio is an upper bound ("< x10"). All 4 scored DANS LA
 * CIBLE/HORS CIBLE.
 */
const TEST_A3_4C_PREDICTIONS = Object.freeze({
  GRAPPLING_WINRATE_MIN: 0.5,
  GRAPPLING_WINRATE_MAX: 0.52,
  FREESTYLE_WINRATE_MIN: 0.47,
  SUBMISSION_RATIO_MAX: 10,
  META_HEALTH_MIN: 90,
});

function evaluateTestA34cPredictions(result) {
  const p = TEST_A3_4C_PREDICTIONS;

  const grapplingWinRate = result.grappling.winRate;
  const grapplingPass = grapplingWinRate !== null && grapplingWinRate >= p.GRAPPLING_WINRATE_MIN && grapplingWinRate <= p.GRAPPLING_WINRATE_MAX;

  const freestyleWinRate = result.styles.Freestyle?.winRate ?? null;
  const freestylePass = freestyleWinRate !== null && freestyleWinRate >= p.FREESTYLE_WINRATE_MIN;

  const submissionRatio = computeRiskRewardIndex(result).find((r) => r.key === 'SUBMISSION_ATTEMPT')?.ratio ?? null;
  const submissionRatioPass = submissionRatio !== null && submissionRatio < p.SUBMISSION_RATIO_MAX;

  const metaHealthIndex = result.metaHealth.overallIndex;
  const metaHealthPass = metaHealthIndex !== null && metaHealthIndex >= p.META_HEALTH_MIN;

  return [
    {
      label: '1. Winrate Grappling',
      actual: grapplingWinRate === null ? 'N/A' : formatPercent(grapplingWinRate, 1),
      target: `${formatPercent(p.GRAPPLING_WINRATE_MIN, 0)} - ${formatPercent(p.GRAPPLING_WINRATE_MAX, 0)}`,
      pass: grapplingPass,
    },
    {
      label: '2. Winrate Freestyle',
      actual: freestyleWinRate === null ? 'N/A' : formatPercent(freestyleWinRate, 1),
      target: `>= ${formatPercent(p.FREESTYLE_WINRATE_MIN, 0)}`,
      pass: freestylePass,
    },
    {
      label: '3. Submission Attempt Ratio',
      actual: submissionRatio === null ? 'N/A' : `x${submissionRatio.toFixed(2)}`,
      target: `< x${p.SUBMISSION_RATIO_MAX}`,
      pass: submissionRatioPass,
    },
    {
      label: '4. Meta Health Index',
      actual: metaHealthIndex === null ? 'N/A' : `${formatNumber(metaHealthIndex)}/100`,
      target: `>= ${p.META_HEALTH_MIN}/100`,
      pass: metaHealthPass,
    },
  ];
}

function renderTestA34cPredictionSubsection(result) {
  const conditions = evaluateTestA34cPredictions(result);
  const lines = [renderSectionTitle('🎯 TEST A3.4c — COMPARATIF DES PREDICTIONS (Mistral, reglage final)')];
  const headers = ['Prediction', 'Mesure', 'Cible', 'Statut'];
  const rows = conditions.map((c) => [c.label, c.actual, c.target, c.pass ? 'DANS LA CIBLE' : 'HORS CIBLE']);
  lines.push(renderTable(headers, rows));
  lines.push('');
  const passed = conditions.filter((c) => c.pass).length;
  lines.push(`Bilan : ${passed} / ${conditions.length} predictions confirmees.`);
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
    '* Depuis Test A3, CombatEngine modelise une veritable contestation de takedown (ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE' +
      ' desormais branchee via #_computeTakedownChance) : le taux de reussite/defense ci-dessus reflete un jet reel,' +
      ' pas 100%/0% garanti comme avant ce test. Un echec coute Stamina + Momentum au lutteur (A3.1), ouvre une' +
      ' fenetre de contre pour le defenseur (A3.2) et augmente cumulativement sa Defense de Takedown (A3.3, Sprawl).'
  );
  lines.push(
    "* \"Contres declenches\" compte uniquement l'opportunite issue d'une tentative de soumission ratee (aucun effet" +
      ' de contre-attaque resolu dessus) — a ne pas confondre avec la fenetre de contre A3.2 (counterWindowsGranted/' +
      'counterWindowsUsed), qui elle applique un vrai bonus de precision/degats sur le round suivant du defenseur.'
  );
  lines.push(
    '* Les actions de l\'EV (Frappes Tete/Corps/Jambes, Clinch, Takedown, Tentative de Soumission) correspondent aux' +
      ' seules combinaisons cible x distance que CombatEngine resout reellement — il ne simule pas de coups' +
      ' individuels (pas de distinction Jab/Cross/Uppercut) ; depuis Test A3, "Tentative de Soumission" est un' +
      ' sous-ensemble STRICT des rounds Takedown reussis (un round GROUND ne declenche la soumission que si le' +
      ' takedown a lui-meme atterri — voir le contest A3), donc sommer tous les buckets surcompte encore les' +
      ' rounds GROUND — chaque bucket se lit independamment.'
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
  lines.push(
    '* Le Version History Tracker suit la methodologie A/B "atomique" de la Phase 3.0 : une seule variable de' +
      ' data/balance.js changee par test. La ligne v0.30 (Baseline) est un enregistrement fige rapporte a la fin' +
      ' de la Phase 3.0.3 — Winrate Grappling et Biais des Juges n\'y etaient pas encore suivis individuellement,' +
      ' d\'ou leur "N/A" plutot qu\'un delta invente. La ligne v0.31 (Test A1) est de meme figee aux chiffres' +
      ' rapportes a la fin de ce test-la.'
  );
  lines.push(
    '* Test A2 : WEIGHT_CONTROL_TIME a ete choisi empiriquement (simulations multi-graines a l\'echelle reelle),' +
      ' pas derive de la seule formule — la relation entre ce coefficient et l\'EV/winrate mesures n\'est pas' +
      ' parfaitement lineaire (les combattants qui gagnent enchainent plus de combats, ce qui retroagit sur la' +
      ' distribution de competences observee). Ce seul levier ramene l\'EV Sol pres de la cible mais ne suffit' +
      ' pas, a lui seul, a satisfaire les 4 conditions de validation de l\'epoque.'
  );
  lines.push(
    '* Test A3 : contrairement a A1/A2, les coefficients de TAKEDOWN_RISK sont imposes par la specification du' +
      ' test (pas de latitude de tuning empirique) — le seul veritable levier est le branchement de' +
      ' ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE=0.4, une donnee reservee depuis une phase anterieure mais jamais lue' +
      ' avant ce test. Verifie sur 5 graines a 3000 saisons (pas un artefact d\'une seule graine) : le contest a' +
      ' 40% de chance de base fait chuter le Winrate Grappling et l\'EV Sol nettement plus bas que les predictions —' +
      ' voir le comparatif des predictions ci-dessus pour le detail chiffre. C\'est le resultat honnete de la' +
      ' specification telle que demandee, pas un bug de cette implementation.'
  );
  lines.push(
    '* Test A3.4a : une seule variable modifiee vs Test A3 (methodologie A/B atomique) —' +
      ' ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE 0.4 -> 0.5, A3.1/A3.2/A3.3 (COMBAT.TAKEDOWN_RISK) intacts. Le' +
      ' Submission Attempt Ratio etait reporte en comparaison avec v0.33 (x8.61) mais volontairement non evalue' +
      ' PASS/FAIL — la tache demandait de le "monitorer", pas de fixer une cible chiffree a l\'epoque.'
  );
  lines.push(
    '* Test A3.4b : une seule variable modifiee vs Test A3.4a (methodologie A/B atomique) —' +
      ' ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE 0.5 -> 0.55, A3.1/A3.2/A3.3 intacts. Contrairement a A3.4a, le' +
      ' Submission Attempt Ratio recoit ici une vraie cible ("< x10") et est donc evalue PASS/FAIL comme les 3' +
      ' autres predictions ; Freestyle (> 49%) et Meta Health (>= 90/100) sont des bornes inferieures seules' +
      ' (pas de plafond fourni), Grappling reste le seul intervalle ferme.'
  );
  lines.push(
    '* Test A3.4c : une seule variable modifiee vs Test A3.4b (methodologie A/B atomique) —' +
      ' ACCURACY.TAKEDOWN_BASE_SUCCESS_CHANCE 0.55 -> 0.59, A3.1/A3.2/A3.3 intacts. Presente par la tache comme le' +
      ' "reglage final" de cette serie de tunings sur le taux de base du takedown (Test A3 : 0.4, A3.4a : 0.5,' +
      ' A3.4b : 0.55, A3.4c : 0.59) — voir le tableau recapitulatif complet (v0.30 a v0.34c) ci-dessus pour la' +
      ' trajectoire entiere.'
  );
  lines.push(
    '* Phase 3.1 v1 (Planning, Charge & Readiness) : CombatEngine ne lit plus jamais la Fatigue directement, ' +
      'seulement la Readiness derivee (Fighter#getReadiness = 100 - Fatigue + ModificateurMoral + BonusTactique -' +
      ' RisqueBlessure). Le spec donnait la forme de cette formule et les 5 points de calibration de la courbe' +
      ' continue Readiness -> Stamina Max/Momentum, mais pas les coefficients des 3 sous-termes (Moral/Tactique/' +
      ' Blessure) ni les gains reputation/argent/risque de blessure des activites — ce sont les valeurs par' +
      ' defaut choisies par cette implementation (voir data/balance.js#READINESS et #WEEKLY_PLANNING pour le' +
      ' detail et la justification de chacune). Le Decision Quality Index et les 4 "strategies de planning"' +
      ' (AGGRESSIVE/CONSERVATIVE/BALANCED/MEDIA_FOCUSED) sont egalement une operationnalisation de cette' +
      ' implementation, pas une formule officielle du jeu (voir tools/SimRunner.js).'
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
    renderWeeklyPlanningSection(result),
    renderVersionHistorySection(result),
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
