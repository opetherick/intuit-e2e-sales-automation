/**
 * Full_Formula_Generator_v20.gs
 *
 * Changes from v19:
 *  - RESILIENT TO A MISSING WEEK-HEADER LABEL. getSheetWeekNumbers reads the
 *    week numbers from the primary header row (row 5). If a label was blank
 *    (e.g. the missing "W52"), that whole column was treated as unused and the
 *    week got NO number/formula ("W52 shows nothing"). v20 fills a single
 *    interior gap between two consecutive-by-2 weeks (W51 _ W53 -> 52) and logs
 *    a warning. NOTE: still restore the actual "W52" label in the header — your
 *    section headers and Q4 totals may reference that cell; the interpolation
 *    only fixes what THIS generator sees.
 *
 * Changes from v19 (retained):
 *  - Single source of truth for the current week across Pass 1 and Pass 4;
 *    future weeks forced back to forecast blue and never zeroed.
 *
 * Changes from v18 (retained):
 *  - CURRENT_WEEK_OVERRIDE + whatWeekIsIt() diagnostic.
 *
 * Changes from v16/v17 (retained):
 *  - ADV_GNS (130-133) + ADV_UPGRADES (169-172) generator-owned with writeZeros.
 *
 * Changes from v15 (retained in v20):
 *  - CURRENT-WEEK WRITE CAP (Pass 1). v15's Pass 1 wrote a COUNTIFS for EVERY
 *    week column, including weeks after the one we're currently on. A not-yet-
 *    complete week (e.g. W51 while we're on W50) whose Raw_Data already has a
 *    few partial rows would therefore get a real COUNTIFS written and flip to
 *    actual — showing a wrong, low number and knocking Payroll (and any other
 *    FULL_WRITE table) out of agreement with the forecast. v16 computes the
 *    current fiscal week from the SAME calendar Pass 4 already uses, and in
 *    Pass 1 leaves any week beyond it exactly as-is (forecast/blue, untouched).
 *    Falls back to "write everything" (old behaviour) if the calendar can't be
 *    read, so a calendar outage never blanks the sheet.
 *
 *    SCOPE NOTE: this cap only affects tables the generator actually WRITES,
 *    i.e. FULL_WRITE_TABLES (GNS, PKG_GNS_ACCOUNTANT, PAYROLL, ACTIVE_CANCELS).
 *    The FLIP_ONLY_RANGES (PKG 34-41, ADV_GNS 130-133, ADV_UPGRADES 169-172)
 *    are recolor-only — the generator never writes their values — so the cap
 *    cannot change an ADV number. If ADV_GNS/ADV_UPGRADES future-week VALUES
 *    are wrong, that is either a stale manual/forecast value in the cell or the
 *    in-cell COUNTIFS pulling future-week Raw_Data; see ADV_OWNERSHIP note near
 *    FLIP_ONLY_RANGES for the two ways to fix that. Pass 4 already caps the
 *    COLOR/"x" flip for these by calendar week, so their forecast cells stay
 *    blue regardless.
 *
 *  - MANUAL_ROWS guard. The hand-entered "NAM BDO" line (row 42) must never be
 *    written or recoloured by the generator. It already sits outside every
 *    FULL_WRITE_TABLES block and the {34,41} FLIP_ONLY range, so it was already
 *    safe; MANUAL_ROWS makes that explicit and guards against a future range
 *    edit accidentally sweeping it in.
 *
 * Changes from v14 (unchanged in v16):
 *  - QUARTER-AGNOSTIC WEEK NUMBERS read from the header row.
 *  - STEP 1 calendar-driven current-week color flip (Pass 4).
 *  - STEP 2 quarter/year rollover.
 *  - generateAllFormulas() takes an optional sheet argument.
 *
 * COLOR CONVENTION (unchanged): forecast = blue (#0000ff),
 * actual = black (#000000). As a week completes, its cells flip blue -> black.
 */

// ── QUARTERLY / YEARLY ROLLOVER — what to change (full walkthrough:
//    docs/E2E_AUTOMATION.md §12). Use the "Roll over to next quarter" menu item
//    to clone + relabel the tab, then:
//      • DASHBOARD_TAB  → the new tab name (e.g. "E2E FY27 Q2").
//      • VISUALS_TAB    → the new quarter's visuals tab (hardcoded; does NOT
//                         follow the rollover — repoint by hand).
//      • CURRENT_WEEK_OVERRIDE → keep null (calendar-driven) unless the cache is stale.
//    Also: fetch_data.py FY/QUARTER, and Code.js CURRENT_WEEK*/QUARTER_CONFIG.
//    Week numbers reset each fiscal year (Q1≈W1–13 … Q4≈W40–53). Header labels
//    may be "W40…" or "WK1…"; getSheetWeekNumbers parses both.
const DASHBOARD_TAB = "E2E FY27 Q1";
const RAW_DATA_TAB  = "Raw_Data";

const COL_WEEK = "C";
const COL_L3   = "H";
const COL_TYPE = "Q";

const WEEK_START_COL = 3;   // column C = first week
const FIRST_WEEK     = 40;  // fallback only; real numbers are read from the sheet
const NUM_WEEKS      = 14;  // max week columns (C..P). A quarter uses 13 or 14.

const FORECAST_COLOR = "#0000ff";
const ACTUAL_COLOR   = "#000000";

// ── v18: manual current-week override ───────────────────────────────────────
// The week cap (which weeks count as actual vs. future) normally comes from the
// calendar. If Calendar_Cache is stale/missing the cap can land on an old week
// and ADV formulas stop being written past it. Set this to the current fiscal
// week number (e.g. 50, then 51 next week) to FORCE the cap — same weekly habit
// as CURRENT_WEEK_NUM in the deck generator. Leave null to use the calendar.
//   null  -> use the calendar (Calendar_Cache)
//   50    -> force "actuals through W50"; W51+ stay forecast
const CURRENT_WEEK_OVERRIDE = 52;

// Layout rows on the dashboard (confirmed against the live sheet):
const ROW3_MARKER_ROW   = 3;  // "Completed Week" x-markers
const DAYCOUNT_ROW      = 4;  // "2 days" / "6 days" partial-week annotations
const PRIMARY_HEADER_ROW = 5; // the header carrying "W40 May 1-2" + the dates
const QUARTER_LABEL_COL = 17; // column Q — holds "Q4" (the quarter-total header)
const DAYS_IN_FULL_WEEK = 7;  // a week with fewer days than this is "partial"

// ── Manual rows the generator must NEVER write or recolour (v16) ────────────
// Row 42 = "NAM BDO", a hand-entered bulk-deal line. It is already outside
// every FULL_WRITE_TABLES block and the {34,41} FLIP_ONLY range, so it was
// already protected; this makes it explicit. Sheet row numbers (1-based).
// VERIFY 42 is the NAM BDO row on your tab before trusting the guard.
const MANUAL_ROWS = [42];

// ── L3 / table row definitions (unchanged from v14) ─────────────────────────
const L3_ROWS = [
  { label: "National",  l3: "National Sales CA L3"       },
  { label: "Major",     l3: "Regional Firms Sales CA L3" },
  { label: "Large",     l3: "Large Firms Sales CA L3"    },
  { label: "DTM",       l3: "DTM Sales CA L3"            },
];

const ACTIVE_CANCELS_TABLE_TYPE = "ACTIVE_CANCELS";

const ACTIVE_CANCELS_ROWS = [
  { label: "National",  match: ["National"]  },
  { label: "Major",     match: ["Major"]     },
  { label: "Large",     match: ["Large"]     },
  { label: "DTM",       match: ["DTM"]       },
  { label: "Growth",    match: ["Growth"]    },
  { label: "NBAM",      match: ["NBAM"]      },
  { label: "Unmanaged", match: ["Unmanaged"] },
];

const FULL_WRITE_TABLES = [
  { startRow: 6,   tableType: "GNS",                 mode: "L3"      },
  { startRow: 67,  tableType: "PKG_GNS_ACCOUNTANT",  mode: "L3"      },
  { startRow: 247, tableType: "PAYROLL",             mode: "L3"      },
  { startRow: 310, tableType: ACTIVE_CANCELS_TABLE_TYPE, mode: "CANCELS" },
  // v17: ADV rows are now generator-owned so their numbers update every week
  // (previously flip-only → stopped at the last hand-typed week, W48).
  // writeZeros:true → a completed/current week (<= cap) writes the actual and
  // goes black even when the count is 0, so every "x" week's ADV cells refresh.
  // These use the standard National/Major/Large/DTM L3 mapping (L3_ROWS), same
  // as GNS — confirmed against fetch_data's ADV_GNS / ADV_UPGRADES table_types.
  { startRow: 130, tableType: "ADV_GNS",      mode: "L3", writeZeros: true },
  { startRow: 169, tableType: "ADV_UPGRADES", mode: "L3", writeZeros: true },
];

// FLIP_ONLY_RANGES: recolor-only (Pass 2 never writes values here). As of v17
// ADV_GNS (130-133) and ADV_UPGRADES (169-172) were MOVED OUT of here into
// FULL_WRITE_TABLES so the generator writes their numbers each week. What's
// left is the PKG block (34-41), whose values come from other formulas and
// only need recolouring. NAM BDO (row 42) is deliberately NOT in this range
// and is further protected by MANUAL_ROWS.
const FLIP_ONLY_RANGES = [
  { startRow: 34,  endRow: 41  },  // PKG rows (values from other formulas; recolor only)
];

/* ════════════════════════════════════════════════════════════════════════
 *  CALENDAR ACCESS LAYER  (sbseg_dm.dim_Calendar)
 *  ──────────────────────────────────────────────────────────────────────
 *  This is the ONLY part that talks to the calendar. Two source modes:
 *
 *    "CACHE"    (default) — read a snapshot tab that your existing pipeline
 *               (the same one that fills Raw_Data) lands into the workbook.
 *               No extra auth, behaves like Raw_Data. Recommended.
 *
 *    "BIGQUERY" — query sbseg_dm.dim_Calendar directly. Only works if that
 *               mart is a BigQuery dataset your Google account can read.
 *               Enable Resources > Advanced Services > BigQuery, set the
 *               project id below, and see queryCalendarFromBigQuery().
 *
 *  ▶▶ CONFIRM THESE FIELD NAMES against the real dim_Calendar schema. In
 *     CACHE mode they are the header labels in row 1 of the cache tab; in
 *     BIGQUERY mode they are the column names in the SELECT. Everything else
 *     in this file is written in terms of the six logical fields below, so
 *     this block is the only thing you should have to touch.
 * ════════════════════════════════════════════════════════════════════════ */
const CAL_SOURCE_MODE   = "CACHE";           // "CACHE" | "BIGQUERY"
const CALENDAR_CACHE_TAB = "Calendar_Cache";
const BQ_PROJECT_ID      = "YOUR-GCP-PROJECT";      // BIGQUERY mode only
const BQ_CALENDAR_TABLE  = "sbseg_dm.dim_Calendar"; // BIGQUERY mode only

const CAL_FIELD = {
  fiscalYear:    "fiscal_year",       // e.g. 26 (FY26) or 2026 — see normalizeFy()
  fiscalQuarter: "fiscal_quarter",    // e.g. 4
  fiscalWeek:    "fiscal_week",       // e.g. 47  (the "W" number)
  weekStart:     "week_start_date",   // date this fiscal week starts
  weekEnd:       "week_end_date",     // date this fiscal week ends
  dayCount:      "day_count_in_qtr",  // days of this week inside the quarter (2, 5, 6, 7)
};

// ── MAIN ────────────────────────────────────────────────────────────────────

function generateAllFormulas(targetSheet) {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const dashSheet    = targetSheet || ss.getSheetByName(DASHBOARD_TAB);
  const rawDataSheet = ss.getSheetByName(RAW_DATA_TAB);

  if (!dashSheet || !rawDataSheet) {
    SpreadsheetApp.getUi().alert(`Missing tab: ${!dashSheet ? DASHBOARD_TAB : RAW_DATA_TAB}`);
    return;
  }

  const countLookup  = buildCountLookup(rawDataSheet);
  const weekNumbers  = getSheetWeekNumbers(dashSheet);   // e.g. [40,41,...,53] or [1,..,13,null]

  // ── v16: current-week cap. Highest week number to treat as ACTUAL on this
  // tab, from the SAME calendar Pass 4 uses. Weeks beyond it are left forecast.
  const weekCap = getCurrentWeekCap_(dashSheet);
  Logger.log(`Current-week cap: ${weekCap.note}`);

  let written = 0, skipped = 0, flipped = 0;
  const skippedDetails = [];
  const writtenDetails = [];
  const columnResolved = new Array(NUM_WEEKS).fill(true);

  // ── Pass 1: full-write tables (data-driven) ───────────────────────────────
  FULL_WRITE_TABLES.forEach(table => {
    const rowDefs     = table.mode === "CANCELS" ? ACTIVE_CANCELS_ROWS : L3_ROWS;
    const range       = dashSheet.getRange(table.startRow, WEEK_START_COL, rowDefs.length, NUM_WEEKS);
    const fontColors  = range.getFontColors();
    const newFormulas = [];
    const newColors   = [];
    // v17: only ADV uses writeZeros, and only when the calendar cap is reliable.
    // When on, a completed/current week (<= cap) writes the actual even if 0.
    const tableWriteZeros = !!table.writeZeros && weekCap.reliable;

    rowDefs.forEach((rowDef, r) => {
      const formulaRow = [];
      const colorRow   = [];
      const sheetRowAbs = table.startRow + r;                 // v16: absolute sheet row
      const isManualRow = MANUAL_ROWS.indexOf(sheetRowAbs) !== -1;  // v16

      for (let weekOffset = 0; weekOffset < NUM_WEEKS; weekOffset++) {
        const weekNum      = weekNumbers[weekOffset];   // may be null on an unused column
        const sheetRow     = table.startRow + r;
        const sheetCol     = WEEK_START_COL + weekOffset;
        const cellA1       = dashSheet.getRange(sheetRow, sheetCol).getA1Notation();
        const currentColor = normalizeColor(fontColors[r][weekOffset]);
        const isForecast   = currentColor === FORECAST_COLOR;
        const cell         = range.getCell(r + 1, weekOffset + 1);

        // Unused week column (e.g. a 13-week quarter's 14th slot): leave as-is.
        if (weekNum == null) {
          formulaRow.push(cell.getFormula() || cell.getValue());
          colorRow.push(currentColor);
          continue;
        }

        // v16: manual row (NAM BDO) — never write or recolour it.
        if (isManualRow) {
          formulaRow.push(cell.getFormula() || cell.getValue());
          colorRow.push(currentColor);
          continue;
        }

        // v16/v19: future week (beyond the cap) — never write a value. Keep the
        // existing value but FORCE forecast blue, so a cell that was wrongly
        // blackened is restored and can't be zeroed next run.
        if (weekNum > weekCap.cap) {
          formulaRow.push(cell.getFormula() || cell.getValue());
          colorRow.push(FORECAST_COLOR);
          skipped++;
          columnResolved[weekOffset] = false;
          skippedDetails.push({ table: table.tableType, label: rowDef.label, week: `W${weekNum}`, cell: cellA1 });
          continue;
        }

        let actualCount, formula;
        if (table.mode === "CANCELS") {
          actualCount = rowDef.match.reduce(
            (sum, m) => sum + (countLookup[`${weekNum}|${m}|${ACTIVE_CANCELS_TABLE_TYPE}`] || 0), 0);
          formula = buildActiveCancelsFormula(weekNum, rowDef.match);
        } else {
          actualCount = countLookup[lookupKey(weekNum, table.tableType, rowDef.l3)] || 0;
          formula = buildCountifsFormula(weekNum, table.tableType, rowDef.l3);
        }

        // v17: with writeZeros (ADV), a completed/current week always writes the
        // actual and flips black — even a 0 — so every "x" week's cells refresh.
        // Without it (GNS/PAYROLL), a forecast cell with 0 actual stays forecast.
        if (isForecast && actualCount === 0 && !tableWriteZeros) {
          formulaRow.push(cell.getFormula() || cell.getValue());
          colorRow.push(currentColor || FORECAST_COLOR);
          skipped++;
          columnResolved[weekOffset] = false;
          skippedDetails.push({ table: table.tableType, label: rowDef.label, week: `W${weekNum}`, cell: cellA1 });
        } else {
          formulaRow.push(formula);
          colorRow.push(ACTUAL_COLOR);
          written++;
          if (isForecast) {
            flipped++;
            writtenDetails.push({ table: table.tableType, label: rowDef.label, week: `W${weekNum}`, cell: cellA1, newCount: actualCount });
          }
        }
      }
      newFormulas.push(formulaRow);
      newColors.push(colorRow);
    });

    range.setFormulas(newFormulas);
    range.setFontColors(newColors);
  });

  // ── Pass 2: flip-only ranges (data-driven recolor, never touch values) ────
  FLIP_ONLY_RANGES.forEach(rangeDef => {
    const numRows    = rangeDef.endRow - rangeDef.startRow + 1;
    const range      = dashSheet.getRange(rangeDef.startRow, WEEK_START_COL, numRows, NUM_WEEKS);
    const fontColors = range.getFontColors();
    const values     = range.getValues();
    const newColors  = [];

    for (let r = 0; r < numRows; r++) {
      const colorRow = [];
      const sheetRowAbs = rangeDef.startRow + r;                    // v16
      const isManualRow = MANUAL_ROWS.indexOf(sheetRowAbs) !== -1;  // v16
      for (let weekOffset = 0; weekOffset < NUM_WEEKS; weekOffset++) {
        const sheetRow     = rangeDef.startRow + r;
        const sheetCol     = WEEK_START_COL + weekOffset;
        const cellA1       = dashSheet.getRange(sheetRow, sheetCol).getA1Notation();
        const currentColor = normalizeColor(fontColors[r][weekOffset]);
        const isForecast   = currentColor === FORECAST_COLOR;
        const value        = values[r][weekOffset];
        const isResolved   = value !== "" && value !== null && value !== 0;
        const weekNum      = weekNumbers[weekOffset];

        // v16: manual row (NAM BDO) — leave colour exactly as-is.
        if (isManualRow) {
          colorRow.push(currentColor);
          continue;
        }

        // v16/v19: future week — force forecast blue (restore if blackened).
        if (weekNum != null && weekNum > weekCap.cap) {
          colorRow.push(FORECAST_COLOR);
          columnResolved[weekOffset] = false;
          continue;
        }

        if (isForecast && isResolved) {
          colorRow.push(ACTUAL_COLOR);
          flipped++;
          writtenDetails.push({ table: `range:${rangeDef.startRow}-${rangeDef.endRow}`, label: `row ${sheetRow}`, week: `W${weekNumbers[weekOffset] || "?"}`, cell: cellA1, newCount: value });
        } else if (isForecast) {
          colorRow.push(currentColor);
          columnResolved[weekOffset] = false;
          skippedDetails.push({ table: `range:${rangeDef.startRow}-${rangeDef.endRow}`, label: `row ${sheetRow}`, week: `W${weekNumbers[weekOffset] || "?"}`, cell: cellA1 });
        } else {
          colorRow.push(currentColor);
        }
      }
      newColors.push(colorRow);
    }
    range.setFontColors(newColors);
  });

  // ── Pass 3: row-3 "x" markers ─────────────────────────────────────────────
  writeRow3Markers(dashSheet, columnResolved);

  // ── Pass 4: STEP 1 — calendar-driven current-week flip (override) ─────────
  // v19: uses the SAME cap as Pass 1 so CURRENT_WEEK_OVERRIDE governs the colour
  // flip too, and it's skipped when the cap is unreliable.
  const calFlip = flipCompletedWeeksFromCalendar(dashSheet, weekNumbers, weekCap);

  writeAuditLog(ss, skippedDetails, writtenDetails, calFlip);

  Logger.log(`✅ Done — wrote ${written}, flipped ${flipped}, preserved ${skipped}. Calendar flip: ${calFlip.note}`);
  SpreadsheetApp.getUi().alert(
    `Done on "${dashSheet.getName()}".\n` +
    `Formulas written: ${written}. Data-driven flips: ${flipped}. Still forecast: ${skipped}.\n` +
    `Week cap: ${weekCap.note}\n` +
    `Calendar: ${calFlip.note}\nSee "Forecast Audit Log" tab.`
  );
}

/* ════════════════════════════════════════════════════════════════════════
 *  v16 — CURRENT-WEEK CAP
 *  Highest week number that should be treated as ACTUAL on this tab, using the
 *  SAME calendar readers Pass 4 uses. Mirrors Pass 4's fy/quarter comparison:
 *    same quarter as "now" -> current fiscal week (inclusive)
 *    quarter in the past    -> Infinity (all weeks actual)
 *    quarter in the future  -> -Infinity (nothing actual yet)
 *  Falls back to Infinity if the calendar can't be read, so a calendar outage
 *  degrades to v15's "write everything" behaviour rather than writing nothing.
 * ════════════════════════════════════════════════════════════════════════ */
// `reliable` = we actually know the calendar position. writeZeros only forces
// actual-writes when reliable is true, so a calendar outage (reliable:false)
// can never wipe forecasts by writing 0s.
function getCurrentWeekCap_(dashSheet) {
  // v18: manual override wins and needs no calendar. reliable:true so ADV
  // writeZeros is active (completed weeks get formulas + black even at 0).
  if (CURRENT_WEEK_OVERRIDE != null && CURRENT_WEEK_OVERRIDE !== "") {
    const wk = parseInt(CURRENT_WEEK_OVERRIDE, 10);
    if (!isNaN(wk)) {
      return { cap: wk, reliable: true, note: `manual override CURRENT_WEEK_OVERRIDE=${wk} — actuals through W${wk}` };
    }
    Logger.log(`⚠ CURRENT_WEEK_OVERRIDE="${CURRENT_WEEK_OVERRIDE}" is not a number — ignoring, using calendar.`);
  }

  let pos;
  try {
    pos = getCurrentFiscalPosition(readCalendarRows());   // { fy, quarter, week }
  } catch (e) {
    return { cap: Infinity, reliable: false, note: `calendar unavailable (${e.message}) — writing all weeks, skip-on-zero kept` };
  }
  if (!pos) return { cap: Infinity, reliable: false, note: "today not found in calendar — writing all weeks, skip-on-zero kept" };

  const tabFq = parseTabFyQuarter(dashSheet.getName());
  if (!tabFq) return { cap: Infinity, reliable: false, note: `couldn't parse fy/quarter from "${dashSheet.getName()}" — writing all weeks, skip-on-zero kept` };

  const cmp = fqRank(pos) - fqRank(tabFq);
  if (cmp > 0)  return { cap: Infinity,  reliable: true, note: `tab quarter is in the past — all weeks actual` };
  if (cmp < 0)  return { cap: -Infinity, reliable: true, note: `tab quarter is in the future (now = FY${pos.fy} Q${pos.quarter}) — no weeks actual yet` };
  return { cap: pos.week, reliable: true, note: `now = FY${pos.fy} Q${pos.quarter} W${pos.week} — actuals through W${pos.week}` };
}

/* ════════════════════════════════════════════════════════════════════════
 *  STEP 1 — CURRENT-WEEK COLOUR FLIP  (v19: driven by the shared cap)
 *  Flips every week column at/before the cap from blue to black, full column
 *  height (only blue cells change). Uses the SAME weekCap as Pass 1 so
 *  CURRENT_WEEK_OVERRIDE governs it too. Skipped entirely when the cap is not
 *  reliable, so a stale/missing Calendar_Cache can never blacken future weeks.
 * ════════════════════════════════════════════════════════════════════════ */
function flipCompletedWeeksFromCalendar(dashSheet, weekNumbers, weekCap) {
  if (!weekCap || !weekCap.reliable) {
    return { flippedCells: 0, note: `SKIPPED colour flip (${weekCap ? weekCap.note : "no cap"})` };
  }
  const maxWeekToFlip = weekCap.cap;                 // Infinity / -Infinity / N
  if (maxWeekToFlip === -Infinity) {
    return { flippedCells: 0, note: `no weeks flipped (${weekCap.note})` };
  }

  const lastRow  = dashSheet.getLastRow();
  const firstRow = PRIMARY_HEADER_ROW + 1;           // start just below the header
  let flippedCells = 0;

  for (let weekOffset = 0; weekOffset < NUM_WEEKS; weekOffset++) {
    const wk = weekNumbers[weekOffset];
    if (wk == null || wk > maxWeekToFlip) continue;  // leave future weeks blue

    const col    = WEEK_START_COL + weekOffset;
    const range  = dashSheet.getRange(firstRow, col, lastRow - firstRow + 1, 1);
    const colors = range.getFontColors();
    let changed = false;
    for (let i = 0; i < colors.length; i++) {
      const absRow = firstRow + i;
      if (MANUAL_ROWS.indexOf(absRow) !== -1) continue;   // never touch NAM BDO
      if (normalizeColor(colors[i][0]) === FORECAST_COLOR) {
        colors[i][0] = ACTUAL_COLOR;
        flippedCells++;
        changed = true;
      }
    }
    if (changed) range.setFontColors(colors);
  }

  const scope = maxWeekToFlip === Infinity ? "all weeks (quarter complete)" : `through W${maxWeekToFlip}`;
  return { flippedCells, note: `${weekCap.note}; flipped ${flippedCells} blue cells ${scope}` };
}

/* ════════════════════════════════════════════════════════════════════════
 *  STEP 2 — QUARTER / YEAR ROLLOVER
 *  Duplicates the current tab into the next fiscal quarter, relabels the
 *  weeks from dim_Calendar, resets to forecast, and regenerates formulas.
 * ════════════════════════════════════════════════════════════════════════ */
function rolloverToNextQuarter() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const src = ss.getSheetByName(DASHBOARD_TAB);
  if (!src) { SpreadsheetApp.getUi().alert(`Missing tab: ${DASHBOARD_TAB}`); return; }

  const srcFq = parseTabFyQuarter(src.getName());
  if (!srcFq) { SpreadsheetApp.getUi().alert(`Couldn't parse fy/quarter from "${src.getName()}".`); return; }

  const nextFq   = nextQuarter(srcFq);                       // {fy, quarter}
  const nextName = `E2E FY${nextFq.fy} Q${nextFq.quarter}`;

  if (ss.getSheetByName(nextName)) {
    SpreadsheetApp.getUi().alert(`Tab "${nextName}" already exists — nothing to do.`);
    return;
  }

  // Pull the new quarter's weeks from the calendar BEFORE cloning, so we fail
  // early if the calendar doesn't have them yet.
  let weeks;
  try {
    weeks = getWeeksForQuarter(readCalendarRows(), nextFq.fy, nextFq.quarter);
  } catch (e) {
    SpreadsheetApp.getUi().alert(`Calendar read failed: ${e.message}`);
    return;
  }
  if (!weeks.length) {
    SpreadsheetApp.getUi().alert(`dim_Calendar has no weeks for FY${nextFq.fy} Q${nextFq.quarter} yet.`);
    return;
  }
  if (weeks.length > NUM_WEEKS) {
    SpreadsheetApp.getUi().alert(`FY${nextFq.fy} Q${nextFq.quarter} has ${weeks.length} weeks but the template only holds ${NUM_WEEKS}. Aborting.`);
    return;
  }

  // 1) Clone the tab (keeps all formatting + formulas).
  const dest = src.copyTo(ss).setName(nextName);
  ss.setActiveSheet(dest);
  ss.moveActiveSheet(ss.getNumSheets());

  // 2) Rewrite week labels in EVERY header row + the quarter label in col Q.
  relabelWeekHeaders(dest, weeks, nextFq.quarter);

  // 3) Reset the managed cells back to forecast (blue) and clear row-3 markers.
  resetManagedCellsToForecast(dest);
  dest.getRange(ROW3_MARKER_ROW, WEEK_START_COL, 1, NUM_WEEKS).clearContent();

  // 4) Naive FY/Q text swap on labels (e.g. "FY26 Q4 GNS" -> "FY27 Q1 GNS").
  //    Comparison blocks (prior-quarter, FY25/FY26 YoY) are NOT auto-shifted
  //    and are reported for manual review — their correct values are a
  //    business decision, not a safe guess.
  const relabelNotes = swapFyQuarterText(dest, srcFq, nextFq);

  // 5) Regenerate the COUNTIFS for the new week numbers on the new tab.
  generateAllFormulas(dest);

  SpreadsheetApp.getUi().alert(
    `Created "${nextName}" (${weeks.length} weeks: ` +
    `W${weeks[0].week}–W${weeks[weeks.length - 1].week}).\n\n` +
    `⚠ Manual review needed:\n${relabelNotes.join("\n") || "(none flagged)"}\n\n` +
    `The DASHBOARD_TAB constant still points at "${DASHBOARD_TAB}". ` +
    `Update it to "${nextName}" when you're ready to run the weekly generator against the new quarter.`
  );
}

// Rewrite the W-labels across every header row, the day-counts in row 4, and
// the quarter label in column Q. Only columns C..P and col Q are touched.
function relabelWeekHeaders(sheet, weeks, quarterNum) {
  const lastRow    = sheet.getLastRow();
  const quarterLbl = `Q${quarterNum}`;

  // Day-count annotation row (row 4): "N days" over any partial week, blank else.
  const dayRow = new Array(NUM_WEEKS).fill("");
  weeks.forEach((w, i) => {
    if (w.dayCount && w.dayCount < DAYS_IN_FULL_WEEK) dayRow[i] = `${w.dayCount} days`;
  });
  sheet.getRange(DAYCOUNT_ROW, WEEK_START_COL, 1, NUM_WEEKS).setValues([dayRow]);

  // Find every header row: a row whose column C looks like "W<number>...".
  for (let row = 1; row <= lastRow; row++) {
    const c = String(sheet.getRange(row, WEEK_START_COL).getValue()).trim();
    if (!/^W\s*K?\s*\d+/i.test(c)) continue;

    const isPrimary = row === PRIMARY_HEADER_ROW;
    const labels = new Array(NUM_WEEKS).fill("");
    weeks.forEach((w, i) => {
      // Primary header shows the date range on partial weeks (matches "W40 May 1-2").
      if (isPrimary && w.dateLabel && w.dayCount && w.dayCount < DAYS_IN_FULL_WEEK) {
        labels[i] = `W${w.week} ${w.dateLabel}`;
      } else {
        labels[i] = `W${w.week}`;
      }
    });
    sheet.getRange(row, WEEK_START_COL, 1, NUM_WEEKS).setValues([labels]);
    sheet.getRange(row, QUARTER_LABEL_COL).setValue(quarterLbl);
  }
}

// Reset every generator-managed week cell (C..P) back to blue forecast.
function resetManagedCellsToForecast(sheet) {
  const setBlue = (startRow, numRows) => {
    const range  = sheet.getRange(startRow, WEEK_START_COL, numRows, NUM_WEEKS);
    const colors = range.getFontColors().map((rowColors, i) =>
      // v16: never repaint a manual row (NAM BDO).
      (MANUAL_ROWS.indexOf(startRow + i) !== -1) ? rowColors : rowColors.map(() => FORECAST_COLOR)
    );
    range.setFontColors(colors);
  };
  FULL_WRITE_TABLES.forEach(t => {
    const rows = (t.mode === "CANCELS" ? ACTIVE_CANCELS_ROWS : L3_ROWS).length;
    setBlue(t.startRow, rows);
  });
  FLIP_ONLY_RANGES.forEach(r => setBlue(r.startRow, r.endRow - r.startRow + 1));
}

// Swap the current-quarter label text in column B / title. Returns a list of
// comparison-block labels that were left untouched for manual review.
function swapFyQuarterText(sheet, srcFq, nextFq) {
  const oldTag = `FY${srcFq.fy} Q${srcFq.quarter}`;
  const newTag = `FY${nextFq.fy} Q${nextFq.quarter}`;
  const notes  = [];
  const lastRow = sheet.getLastRow();

  // Column B labels + column B title cell (B1). Also scan B for stray old tags.
  const bRange  = sheet.getRange(1, 2, lastRow, 1);
  const bValues = bRange.getValues();
  for (let i = 0; i < bValues.length; i++) {
    const v = String(bValues[i][0]);
    if (!v) continue;
    if (v.indexOf(oldTag) !== -1) {
      bValues[i][0] = v.split(oldTag).join(newTag);
    } else if (/FY\d+\s*Q\d+/i.test(v) || /FY\d+\s*(PKGs|WSB)/i.test(v)) {
      // A different-period label (prior quarter, YoY). Flag, don't touch.
      notes.push(`  Row ${i + 1}, col B: "${v}" — verify / shift by hand.`);
    }
  }
  bRange.setValues(bValues);
  return notes;
}

// ── FORMULA BUILDERS (unchanged from v14) ───────────────────────────────────
function buildCountifsFormula(weekNum, tableType, l3Name) {
  const weekCol = `'${RAW_DATA_TAB}'!${COL_WEEK}:${COL_WEEK}`;
  const typeCol = `'${RAW_DATA_TAB}'!${COL_TYPE}:${COL_TYPE}`;
  if (!l3Name) {
    return `=COUNTIFS(${weekCol},"${weekNum}",${typeCol},"${tableType}")`;
  }
  const l3Col = `'${RAW_DATA_TAB}'!${COL_L3}:${COL_L3}`;
  return `=COUNTIFS(${weekCol},"${weekNum}",${l3Col},"${l3Name}",${typeCol},"${tableType}")`;
}

function buildActiveCancelsFormula(weekNum, matchList) {
  const weekCol = `'${RAW_DATA_TAB}'!${COL_WEEK}:${COL_WEEK}`;
  const typeCol = `'${RAW_DATA_TAB}'!${COL_TYPE}:${COL_TYPE}`;
  const l3Col   = `'${RAW_DATA_TAB}'!${COL_L3}:${COL_L3}`;
  const parts = matchList.map(m => {
    const criteria = m === "" ? `""` : `"${m}"`;
    return `COUNTIFS(${weekCol},"${weekNum}",${l3Col},${criteria},${typeCol},"${ACTIVE_CANCELS_TABLE_TYPE}")`;
  });
  return `=${parts.join("+")}`;
}

// ── WEEK-NUMBER + FISCAL HELPERS ────────────────────────────────────────────

// Read the actual week numbers from the tab's primary header row.
// "W40 May 1-2" -> 40, "W41" -> 41, "WK1" -> 1, blank -> null.
// The regex accepts an optional "K" (and surrounding spaces) so both the Q4-style
// "W40" labels and the FY27 Q1-style "WK1"…"WK14" labels parse to a plain number.
// Without this, a "WK1" header failed to match, getSheetWeekNumbers returned all
// null, and the generator fell back to the contiguous FIRST_WEEK (40) guess —
// building COUNTIFS for weeks 40-53 that no longer exist in Raw_Data (which now
// holds weeks 1-13), so every cell stayed forecast and nothing updated.
// v20: if a single column is blank but sits between two known weeks that differ
// by exactly 2 (e.g. W51 _ W53), fill the gap (52). This makes a missing header
// label (the "W52 shows nothing" bug) not silently drop the whole week. Only a
// single unambiguous interior gap is filled; leading/trailing/multi blanks are
// left null. A warning is logged so the header itself still gets fixed.
function getSheetWeekNumbers(dashSheet) {
  const row = dashSheet.getRange(PRIMARY_HEADER_ROW, WEEK_START_COL, 1, NUM_WEEKS).getValues()[0];
  const nums = row.map(v => {
    const m = String(v).match(/W\s*K?\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  });
  if (nums.every(n => n == null)) {
    // Header not found — fall back to the old contiguous assumption.
    return Array.from({ length: NUM_WEEKS }, (_, i) => FIRST_WEEK + i);
  }
  // v20: fill single interior gaps between two consecutive-by-2 weeks.
  for (let i = 1; i < nums.length - 1; i++) {
    if (nums[i] == null && nums[i - 1] != null && nums[i + 1] != null
        && nums[i + 1] - nums[i - 1] === 2) {
      const inferred = nums[i - 1] + 1;
      Logger.log(`⚠ Header cell for W${inferred} is BLANK (column ${i + WEEK_START_COL}); ` +
                 `inferred from W${nums[i - 1]}/W${nums[i + 1]}. Restore the "W${inferred}" ` +
                 `label in row ${PRIMARY_HEADER_ROW} so section headers/totals stay correct.`);
      nums[i] = inferred;
    }
  }
  return nums;
}

function parseTabFyQuarter(name) {
  const m = String(name).match(/FY\s*(\d+)\s*Q\s*(\d+)/i);
  if (!m) return null;
  return { fy: parseInt(m[1], 10), quarter: parseInt(m[2], 10) };
}

function nextQuarter(fq) {
  return fq.quarter < 4 ? { fy: fq.fy, quarter: fq.quarter + 1 }
                        : { fy: fq.fy + 1, quarter: 1 };
}

function fqRank(fq) { return fq.fy * 10 + fq.quarter; }

// dim_Calendar may store fiscal_year as 26 or 2026 — collapse to 2-digit.
function normalizeFy(y) { const n = parseInt(y, 10); return n >= 2000 ? n - 2000 : n; }

// ── CALENDAR READERS ────────────────────────────────────────────────────────

// Returns [{ fy, quarter, week, start:Date, end:Date, dayCount, dateLabel }, ...]
function readCalendarRows() {
  return CAL_SOURCE_MODE === "BIGQUERY" ? queryCalendarFromBigQuery()
                                        : readCalendarFromCacheTab();
}

function readCalendarFromCacheTab() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CALENDAR_CACHE_TAB);
  if (!sheet) throw new Error(`tab "${CALENDAR_CACHE_TAB}" not found`);

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) throw new Error(`tab "${CALENDAR_CACHE_TAB}" is empty`);

  const header = values[0].map(h => String(h).trim());
  const idx = {};
  Object.keys(CAL_FIELD).forEach(k => { idx[k] = header.indexOf(CAL_FIELD[k]); });
  const missing = Object.keys(idx).filter(k => idx[k] === -1)
                        .map(k => CAL_FIELD[k]);
  if (missing.length) throw new Error(`missing columns in ${CALENDAR_CACHE_TAB}: ${missing.join(", ")}`);

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const week = parseInt(r[idx.fiscalWeek], 10);
    if (isNaN(week)) continue;
    const start = r[idx.weekStart] ? new Date(r[idx.weekStart]) : null;
    const end   = r[idx.weekEnd]   ? new Date(r[idx.weekEnd])   : null;
    rows.push({
      fy:       normalizeFy(r[idx.fiscalYear]),
      quarter:  parseInt(r[idx.fiscalQuarter], 10),
      week:     week,
      start:    start,
      end:      end,
      dayCount: r[idx.dayCount] !== "" ? parseInt(r[idx.dayCount], 10) : null,
      dateLabel: buildDateLabel(start, end),
    });
  }
  return rows;
}

// Direct BigQuery variant. Requires: Advanced Services > BigQuery enabled,
// BQ_PROJECT_ID set, and read access to sbseg_dm.dim_Calendar. Adjust the
// SELECT column names to match the real schema (same six logical fields).
function queryCalendarFromBigQuery() {
  const sql =
    `SELECT ${CAL_FIELD.fiscalYear}    AS fiscal_year,
            ${CAL_FIELD.fiscalQuarter} AS fiscal_quarter,
            ${CAL_FIELD.fiscalWeek}    AS fiscal_week,
            ${CAL_FIELD.weekStart}     AS week_start,
            ${CAL_FIELD.weekEnd}       AS week_end,
            ${CAL_FIELD.dayCount}      AS day_count
       FROM \`${BQ_CALENDAR_TABLE}\``;

  const request  = { query: sql, useLegacySql: false };
  let queryResults = BigQuery.Jobs.query(request, BQ_PROJECT_ID);
  const jobId = queryResults.jobReference.jobId;
  while (!queryResults.jobComplete) {
    Utilities.sleep(500);
    queryResults = BigQuery.Jobs.getQueryResults(BQ_PROJECT_ID, jobId);
  }
  const rows = (queryResults.rows || []).map(r => {
    const f = r.f;
    const start = f[3].v ? new Date(f[3].v) : null;
    const end   = f[4].v ? new Date(f[4].v) : null;
    return {
      fy:       normalizeFy(f[0].v),
      quarter:  parseInt(f[1].v, 10),
      week:     parseInt(f[2].v, 10),
      start:    start,
      end:      end,
      dayCount: f[5].v !== null && f[5].v !== "" ? parseInt(f[5].v, 10) : null,
      dateLabel: buildDateLabel(start, end),
    };
  });
  return rows;
}

// Which fiscal week is "today"?  Prefer the row whose [start,end] contains
// today; fall back to the latest week that has already started.
function getCurrentFiscalPosition(rows) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let contains = null, latestStarted = null;
  rows.forEach(r => {
    if (r.start && r.end && today >= r.start && today <= r.end) contains = r;
    if (r.start && r.start <= today) {
      if (!latestStarted || r.start > latestStarted.start) latestStarted = r;
    }
  });
  const hit = contains || latestStarted;
  return hit ? { fy: hit.fy, quarter: hit.quarter, week: hit.week } : null;
}

// All weeks in a fiscal year+quarter, ordered by start date (or week number).
function getWeeksForQuarter(rows, fy, quarter) {
  return rows
    .filter(r => r.fy === fy && r.quarter === quarter)
    .sort((a, b) => (a.start && b.start) ? a.start - b.start : a.week - b.week);
}

function buildDateLabel(start, end) {
  if (!start) return "";
  const tz  = Session.getScriptTimeZone();
  const mon = Utilities.formatDate(start, tz, "MMM");
  const d1  = Utilities.formatDate(start, tz, "d");
  if (!end) return `${mon} ${d1}`;
  const endMon = Utilities.formatDate(end, tz, "MMM");
  const d2  = Utilities.formatDate(end, tz, "d");
  return endMon === mon ? `${mon} ${d1}-${d2}` : `${mon} ${d1}-${endMon} ${d2}`;
}

// ── ROW 3 MARKERS ───────────────────────────────────────────────────────────
function writeRow3Markers(dashSheet, columnResolved) {
  const rowRange = dashSheet.getRange(ROW3_MARKER_ROW, WEEK_START_COL, 1, NUM_WEEKS);
  rowRange.setValues([columnResolved.map(resolved => resolved ? "x" : "")]);
}

// ── COUNT LOOKUP (unchanged from v14) ───────────────────────────────────────
function buildCountLookup(rawDataSheet) {
  const data = rawDataSheet.getDataRange().getValues();
  const colIdx = { week: 2, l3: 7, type: 16 };
  const lookup = {};
  for (let i = 1; i < data.length; i++) {
    const week = String(data[i][colIdx.week]).trim();
    if (!week) continue;
    const l3   = String(data[i][colIdx.l3]).trim();
    const type = String(data[i][colIdx.type]).trim();
    const keyWithL3 = `${week}|${l3}|${type}`;
    const keyNoL3   = `${week}|*|${type}`;
    lookup[keyWithL3] = (lookup[keyWithL3] || 0) + 1;
    lookup[keyNoL3]   = (lookup[keyNoL3]   || 0) + 1;
  }
  return lookup;
}

function lookupKey(weekNum, tableType, l3Name) {
  return l3Name ? `${weekNum}|${l3Name}|${tableType}` : `${weekNum}|*|${tableType}`;
}

function normalizeColor(color) { return color ? color.toLowerCase() : color; }

// ── AUDIT LOG ─────────────────────────────────────────────────────────────
function writeAuditLog(ss, skippedDetails, writtenDetails, calFlip) {
  const AUDIT_TAB = "Forecast Audit Log";
  let logSheet = ss.getSheetByName(AUDIT_TAB);
  if (!logSheet) logSheet = ss.insertSheet(AUDIT_TAB);
  else logSheet.clear();

  logSheet.getRange(1, 1).setValue(`Run: ${new Date().toISOString()}`);
  if (calFlip) logSheet.getRange(1, 3).setValue(`Calendar: ${calFlip.note}`);

  logSheet.getRange(3, 1, 1, 5).setValues([
    ["STILL FORECAST (blue, unresolved)", "Table/Range", "Row Label", "Week", "Cell"]
  ]).setFontWeight("bold");

  if (skippedDetails.length) {
    logSheet.getRange(4, 1, skippedDetails.length, 5)
      .setValues(skippedDetails.map(d => ["", d.table, d.label, d.week, d.cell]));
  } else {
    logSheet.getRange(4, 1).setValue("(none this run)");
  }

  const flipStartRow = 6 + skippedDetails.length;
  logSheet.getRange(flipStartRow, 1, 1, 5).setValues([
    ["FLIPPED TO ACTUAL THIS RUN", "Table/Range", "Row Label", "Week", "Cell"]
  ]).setFontWeight("bold");

  if (writtenDetails.length) {
    logSheet.getRange(flipStartRow + 1, 1, writtenDetails.length, 5)
      .setValues(writtenDetails.map(d => ["", d.table, d.label, d.week, d.cell]));
  } else {
    logSheet.getRange(flipStartRow + 1, 1).setValue("(none this run)");
  }
  logSheet.autoResizeColumns(1, 5);
}

// ── OPTIONAL MANUAL UTILITY (unchanged from v14) ────────────────────────────
function setupActiveCancelsFormulas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dashSheet = ss.getSheetByName(DASHBOARD_TAB);
  if (!dashSheet) throw new Error(`Missing tab: ${DASHBOARD_TAB}`);
  const weekNumbers = getSheetWeekNumbers(dashSheet);
  ACTIVE_CANCELS_ROWS.forEach((rowDef, r) => {
    const formulas = [];
    for (let weekOffset = 0; weekOffset < NUM_WEEKS; weekOffset++) {
      const wk = weekNumbers[weekOffset];
      formulas.push(wk == null ? "" : buildActiveCancelsFormula(wk, rowDef.match));
    }
    dashSheet.getRange(310 + r, WEEK_START_COL, 1, NUM_WEEKS).setFormulas([formulas]);
  });
  SpreadsheetApp.getUi().alert("Active Cancels formulas written to rows 310-316 (colors unchanged).");
}

// ── v18 DIAGNOSTIC: what week does the generator think it is? ────────────────
// Run this if ADV (or any table) isn't writing the weeks you expect. It shows
// the calendar's current fiscal position AND the resulting cap for the active
// dashboard tab — so you can tell whether Calendar_Cache is stale (the usual
// cause of "no formula past W48"). If the week shown is wrong, either refresh
// Calendar_Cache by re-running the pipeline, or set CURRENT_WEEK_OVERRIDE.
function whatWeekIsIt() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dashSheet = ss.getSheetByName(DASHBOARD_TAB) || ss.getActiveSheet();

  let calMsg;
  try {
    const pos = getCurrentFiscalPosition(readCalendarRows());
    calMsg = pos ? `Calendar says: FY${pos.fy} Q${pos.quarter} W${pos.week}`
                 : "Calendar: today not found in Calendar_Cache (cache stale or missing rows).";
  } catch (e) {
    calMsg = `Calendar: UNAVAILABLE (${e.message}). Calendar_Cache tab missing or unreadable.`;
  }

  const cap = getCurrentWeekCap_(dashSheet);
  const overrideMsg = (CURRENT_WEEK_OVERRIDE != null && CURRENT_WEEK_OVERRIDE !== "")
    ? `CURRENT_WEEK_OVERRIDE is SET to ${CURRENT_WEEK_OVERRIDE} (this wins over the calendar).`
    : "CURRENT_WEEK_OVERRIDE is null (using the calendar).";

  SpreadsheetApp.getUi().alert(
    `Tab: "${dashSheet.getName()}"\n\n` +
    `${overrideMsg}\n${calMsg}\n\n` +
    `Resulting cap: ${cap.note}\n\n` +
    `Weeks at or before the cap get actual formulas (black); weeks after it stay ` +
    `forecast (blue, no formula). If the cap week looks wrong, refresh Calendar_Cache ` +
    `(re-run the pipeline) or set CURRENT_WEEK_OVERRIDE at the top of this script.`
  );
}

// ── MENU ─────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Canada Dashboard")
    .addItem("Generate All Formulas (+ current-week flip)", "generateAllFormulas")
    .addSeparator()
    .addItem("What week is it? (diagnostic)", "whatWeekIsIt")
    .addItem("Roll over to next quarter", "rolloverToNextQuarter")
    .addToUi();
}
