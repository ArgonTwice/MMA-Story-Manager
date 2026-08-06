/**
 * web/StoryExporter.js — Phase Beta ("Players First — Analytics, Frustration
 * Detector & Story Export")
 * ---------------------------------------------------------------------------
 * Builds a shareable "Carte de Succes / Chronique" summarizing a save's
 * whole career (not just the current season, unlike engine/StoryAnalyzer.js's
 * per-year Gala trophies) — meant to be exported from the Week-52 ceremony
 * or from a retired legend's Hall of Fame profile (see web/app.js).
 *
 * Split the same way ui/SeasonSummary.js splits build()/toText(): buildStoryCard()
 * is pure data assembly (no DOM/Canvas, fully Node-testable), while
 * renderStoryCardToCanvas() is the browser-only drawing step and toShareText()
 * is a plain-text fallback for the Web Share API / clipboard.
 *
 * Data sourcing, and why each field is honest rather than fabricated:
 *   - "Bilan Global": summed from the CURRENT roster's Fighter#career
 *     (wins/losses/draws) plus every Hall of Fame entry's own stored
 *     `record` string (see engine/HistoryEngine.js#induct). Non-legendary
 *     retirees are not archived anywhere once they leave the roster — same
 *     documented limitation as tools/BalanceReporter.js's Roster Attachment
 *     Index — so this is a lower bound ("at least this many fights"), not a
 *     perfect all-time total. Disclosed via the `note` field rather than
 *     hidden.
 *   - "Nombre de Legendes formees": worldState.getHallOfFame().length,
 *     already the exact metric tools/BalanceReporter.js's own Hall of Fame
 *     section reports.
 *   - "Meilleure Rivalite": the single highest-tension pair across the
 *     WHOLE career, scanning worldState.relationships directly — the same
 *     direct-field-access precedent engine/HistoryEngine.js#findBiggestRival
 *     already uses, generalized from "this fighter's rival" to "the
 *     biggest rivalry in the save's history" (StoryAnalyzer's own Rivalry
 *     of the Year is scoped to a single season's fights only, which can't
 *     answer "best ever").
 *   - "Plus Grand Upset": worldState.getRecord('biggestUpset') — a
 *     persistent, career-wide record engine/WorldMemory.js now tracks
 *     (added this phase specifically because StoryAnalyzer's own Upset of
 *     the Year only sees the current season's transient fight window).
 * ---------------------------------------------------------------------------
 */

const THEME = Object.freeze({
  bgVoid: '#0b0d10',
  bgPanel: '#14171c',
  gold: '#d4af37',
  goldBright: '#f0c75e',
  textPrimary: '#e8e6e1',
  textSecondary: '#a8aeb8',
  textMuted: '#666d78',
  border: '#3a4150',
});

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;

function parseRecordString(recordString) {
  const [wins, losses, draws] = String(recordString ?? '0-0-0').split('-').map(Number);
  return { wins: Number.isFinite(wins) ? wins : 0, losses: Number.isFinite(losses) ? losses : 0, draws: Number.isFinite(draws) ? draws : 0 };
}

function computeCareerRecord({ playerState, worldState }) {
  const totals = { wins: 0, losses: 0, draws: 0 };
  for (const fighter of playerState.roster) {
    totals.wins += fighter.career.wins;
    totals.losses += fighter.career.losses;
    totals.draws += fighter.career.draws;
  }
  for (const entry of worldState.getHallOfFame()) {
    const parsed = parseRecordString(entry.record);
    totals.wins += parsed.wins;
    totals.losses += parsed.losses;
    totals.draws += parsed.draws;
  }
  return totals;
}

/**
 * The single highest-tension relationship pair across the save's ENTIRE
 * history — see this file's header for why this generalizes
 * engine/HistoryEngine.js#findBiggestRival's per-fighter scan rather than
 * reusing it directly (that function needs a starting fighterId; this one
 * wants the single best pair in the whole graph).
 */
function findBestRivalryEver(worldState, playerState) {
  let best = null;
  for (const record of Object.values(worldState.relationships)) {
    if (!best || record.gauges.tension > best.gauges.tension) best = record;
  }
  if (!best || best.gauges.tension <= 0) return null;

  const nameFor = (id) => playerState?.getFighter?.(id)?.identity?.name ?? id;
  return {
    fighterAId: best.entityA,
    fighterBId: best.entityB,
    fighterAName: nameFor(best.entityA),
    fighterBName: nameFor(best.entityB),
    tension: Math.round(best.gauges.tension),
  };
}

/**
 * @param {Object} options
 * @param {Object} options.playerState - A PlayerState instance.
 * @param {Object} options.worldState - A WorldState instance.
 * @returns {Object} A structured, JSON-serializable story card view model.
 */
export function buildStoryCard({ playerState, worldState }) {
  const record = computeCareerRecord({ playerState, worldState });
  const upsetRecord = worldState.getRecord('biggestUpset');

  return {
    gymName: playerState.gymName,
    country: playerState.country || null,
    day: worldState.currentDay,
    year: worldState.year,
    record,
    recordString: `${record.wins}-${record.losses}-${record.draws}`,
    legendCount: worldState.getHallOfFame().length,
    bestRivalry: findBestRivalryEver(worldState, playerState),
    biggestUpset: upsetRecord.value === null ? null : { detail: upsetRecord.detail, gap: upsetRecord.value },
    note:
      "Bilan calcule sur l'effectif actuel + le Hall of Fame ; les retraites non legendaires ne sont pas " +
      'archivees (meme limitation que le Roster Attachment Index) — ce chiffre est donc un minimum garanti, pas ' +
      'un total absolu.',
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Plain-text rendering of a story card, for the Web Share API's `text`
 * field or a clipboard fallback when Canvas export isn't available/wanted —
 * same role as ui/SeasonSummary.js#toText().
 * @param {Object} card - The result of buildStoryCard().
 * @returns {string}
 */
export function toShareText(card) {
  const lines = [
    `\u{1F94A} ${card.gymName}${card.country ? ` (${card.country})` : ''} — Chronique d'une dynastie`,
    `Jour ${card.day}, An ${card.year}`,
    '',
    `Bilan Global : ${card.recordString}`,
    `Legendes formees : ${card.legendCount}`,
  ];
  if (card.bestRivalry) {
    lines.push(`Meilleure Rivalite : ${card.bestRivalry.fighterAName} vs ${card.bestRivalry.fighterBName} (tension ${card.bestRivalry.tension})`);
  }
  if (card.biggestUpset) {
    lines.push(`Plus Grand Upset : ${card.biggestUpset.detail}`);
  }
  lines.push('', 'MMA Gym Manager');
  return lines.join('\n');
}

function drawStatRow(ctx, x, y, width, icon, label, value) {
  ctx.fillStyle = THEME.textSecondary;
  ctx.font = '32px sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${icon}  ${label}`, x, y);

  ctx.fillStyle = THEME.goldBright;
  ctx.font = 'bold 40px sans-serif';
  ctx.fillText(String(value), x, y + 50);
}

/**
 * Draws a story card onto a caller-supplied canvas (browser-only — relies
 * on CanvasRenderingContext2D, never called from Node). The caller owns
 * sizing/export (canvas.toDataURL(), navigator.share with a Blob, etc.) —
 * see web/app.js's own export button wiring.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} card - The result of buildStoryCard().
 */
export function renderStoryCardToCanvas(canvas, card) {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');

  // Background.
  const bgGradient = ctx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
  bgGradient.addColorStop(0, THEME.bgPanel);
  bgGradient.addColorStop(1, THEME.bgVoid);
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // Header band.
  const headerGradient = ctx.createLinearGradient(0, 0, CARD_WIDTH, 0);
  headerGradient.addColorStop(0, THEME.gold);
  headerGradient.addColorStop(1, THEME.goldBright);
  ctx.fillStyle = headerGradient;
  ctx.fillRect(0, 0, CARD_WIDTH, 12);

  let cursorY = 130;
  ctx.textAlign = 'center';
  ctx.fillStyle = THEME.textMuted;
  ctx.font = '28px sans-serif';
  ctx.fillText('\u{1F94A} MMA GYM MANAGER — CHRONIQUE', CARD_WIDTH / 2, cursorY);

  cursorY += 90;
  ctx.fillStyle = THEME.textPrimary;
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText(card.gymName, CARD_WIDTH / 2, cursorY);

  if (card.country) {
    cursorY += 46;
    ctx.fillStyle = THEME.textSecondary;
    ctx.font = '30px sans-serif';
    ctx.fillText(card.country, CARD_WIDTH / 2, cursorY);
  }

  cursorY += 40;
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(120, cursorY);
  ctx.lineTo(CARD_WIDTH - 120, cursorY);
  ctx.stroke();

  ctx.textAlign = 'left';
  const rowX = 120;
  const rowWidth = CARD_WIDTH - 240;
  cursorY += 100;
  drawStatRow(ctx, rowX, cursorY, rowWidth, '\u{1F3C6}', 'Bilan Global', card.recordString);

  cursorY += 130;
  drawStatRow(ctx, rowX, cursorY, rowWidth, '\u{2728}', 'Legendes formees', card.legendCount);

  cursorY += 130;
  ctx.fillStyle = THEME.textSecondary;
  ctx.font = '32px sans-serif';
  ctx.fillText('\u{1F525}  Meilleure Rivalite', rowX, cursorY);
  ctx.fillStyle = THEME.goldBright;
  ctx.font = 'bold 34px sans-serif';
  const rivalryText = card.bestRivalry
    ? `${card.bestRivalry.fighterAName} vs ${card.bestRivalry.fighterBName} (${card.bestRivalry.tension})`
    : 'Aucune rivalite marquante — pas encore';
  ctx.fillText(rivalryText, rowX, cursorY + 50);

  cursorY += 140;
  ctx.fillStyle = THEME.textSecondary;
  ctx.font = '32px sans-serif';
  ctx.fillText('\u{1F4A5}  Plus Grand Upset', rowX, cursorY);
  ctx.fillStyle = THEME.goldBright;
  ctx.font = 'bold 30px sans-serif';
  const upsetText = card.biggestUpset ? card.biggestUpset.detail : 'Aucun upset marquant — pas encore';
  wrapText(ctx, upsetText, rowX, cursorY + 46, rowWidth, 38);

  ctx.textAlign = 'center';
  ctx.fillStyle = THEME.textMuted;
  ctx.font = '26px sans-serif';
  ctx.fillText(`Jour ${card.day} — An ${card.year}`, CARD_WIDTH / 2, CARD_HEIGHT - 60);
}

/** Naive word-wrap for a single Canvas fillText call spanning multiple lines. */
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let cursorY = y;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY);
      line = word;
      cursorY += lineHeight;
    } else {
      line = candidate;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
}
