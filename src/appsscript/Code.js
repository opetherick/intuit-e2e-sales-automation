// ============================================================
//  FY26 CA Weekly Accountant E2E — Automated Deck Generator
//  VERSION 5
//
//  CHANGES FROM v4 (FIXED):
//   A. F149 DRIVER (NEW). Before reading the "FY26Q4 Visuals" tab we now
//      write the current week number into its driver cell (F149) and flush,
//      so the visuals lookup table recomputes for the current week before we
//      pull its values. Cell + value are configurable below (VISUALS_WEEK_CELL
//      / whether it wants "W50" vs 50).
//
//   B. COLOURING NOW MIRRORS THE SHEET'S CONDITIONAL-FORMAT RULES EXACTLY.
//      The sheet uses three CF rules on the ITF/ITPY ranges:
//         >= 100            -> green  (#B6D7A8)
//         >= 95 and < 100   -> amber  (#FFE599)
//         < 95              -> red    (#EA9999)
//      v4 re-invented this with an extra "n<=0 || n>300 -> white" guard that
//      the sheet does NOT have, which is why the deck disagreed with the sheet.
//      All three colour helpers now call one shared cfColorForValue_() that
//      matches the CF rule and only whites-out genuinely blank / non-numeric
//      cells (same as the sheet showing nothing).
//
//  (v4 fixes retained: WSB fixed offsets, Non-NAM table, QTD label-matching,
//   de-duped populateGrid_, Q3 QTD col map.)
// ============================================================

// ────────────────────────────────────────────────────────────────────────────
//  QUARTERLY / YEARLY ROLLOVER — what to change here (full walkthrough:
//  docs/E2E_AUTOMATION.md §12). Nothing below follows a rollover automatically.
//
//  EVERY QUARTER:
//   • CURRENT_WEEK / CURRENT_WEEK_NUM — set to the week you're REPORTING (the
//     last completed week, e.g. W2 while W3 is in progress).
//   • QUARTER_CONFIG — add an entry for the new quarter (weeks / spreadsheetId /
//     tabName) if it doesn't exist yet.
//   • VISUALS_TAB_NAME — point at the new quarter's visuals tab.
//
//  EVERY FISCAL YEAR (Q1) — additionally:
//   • FY_LABEL — the fiscal-year prefix on the tab's SECTION headers
//     ("FY27 Q1 GNS", "FY27 Q1 Payroll", …). One change here re-points ~10
//     current-quarter section lookups instead of editing them individually.
//   • FY_WEEK1_MONDAY — the Monday of fiscal W1 (used only by the automation's
//     auto-week fallback; the deck itself uses CURRENT_WEEK).
//   • PREV_FY_LABEL / PREV_QUARTER — the "previous quarter" comparison block
//     shown next to the current quarter (slides 8/9/13). For a Q1 deck this is
//     the PRIOR FY's Q4 (FY26 Q4). These drive BOTH the source-tab lookups AND
//     the Slides template title matchers, so they stay in sync only if you also
//     relabel the template's comparison headers to match. IMPORTANT: the current
//     tab must actually CONTAIN that comparison block with data. See docs §12.
//
//  Also update, in the other files:
//   • fetch_data.py             → FY / QUARTER
//   • Full_Formula_Generator.gs → DASHBOARD_TAB, VISUALS_TAB
//
//  NOTE: fiscal week numbers reset every fiscal year (Q1≈W1–13/14, Q2≈W14–26,
//  Q3≈W27–39, Q4≈W40–53), so a new quarter's weeks differ from last quarter's.
//  FY27+ dashboards label week columns "WK1".."WK14"; the sheet-reading helpers
//  normalize "WKn"/"Wn" so bxoth styles resolve (see wkNorm_).
// ────────────────────────────────────────────────────────────────────────────
const CURRENT_WEEK     = 'W2';  // ← Change each week (week being reported)
const CURRENT_WEEK_NUM = 2;     // ← Change each week (numeric)

// Fiscal-year prefix on the E2E tab's section headers. Change on a Q1 rollover.
const FY_LABEL = 'FY27';

// Prior-period (comparison) block labels shown NEXT TO the current quarter. For
// a Q1 deck the "previous quarter" is the PRIOR fiscal year's Q4. These must
// match BOTH (a) the comparison-section titles on the source E2E tab and (b) the
// matching section titles on the Slides template. Change on every rollover:
//   Q1 → PREV = prior-FY Q4 | Q2 → Q1 | Q3 → Q2 | Q4 → Q3 (same FY).
const PREV_FY_LABEL = 'FY26';
const PREV_QUARTER  = 'Q4';

const SOURCE_PRESENTATION_ID = '1AJdrGTUsYB--hrdapqalqLxgB3YU8Z7-27hI537oN7A';
const DESTINATION_FOLDER_ID  = null;

const QUARTER_CONFIG = {
  Q1: {
    weeks: ['W1','W2','W3','W4','W5','W6','W7','W8','W9','W10','W11','W12','W13','W14'],
    spreadsheetId: '1qp6eTw9nmblHi4_28zZe7gI3shbEFV_LOCl35inQL0Y',
    tabName: 'E2E FY27 Q1',
  },
  Q3: {
    weeks: ['W27','W28','W29','W30','W31','W32','W33','W34','W35','W36','W37','W38','W39','W40'],
    spreadsheetId: '1BSs8I9NXBH8r-NqAaoDP08B_AnrgYU0XG5jm5ZN0K6U',
    tabName: 'E2E FY26 Q3',
  },
  Q4: {
    weeks: ['W40','W41','W42','W43','W44','W45','W46','W47','W48','W49','W50','W51','W52','W53'],
    spreadsheetId: '1BSs8I9NXBH8r-NqAaoDP08B_AnrgYU0XG5jm5ZN0K6U',
    tabName: 'E2E FY26 Q4',
  },
};

// ============================================================
//  PIPELINE / AUTOMATION CONFIG
// ============================================================

const RAW_DATA_SPREADSHEET_ID = '1qp6eTw9nmblHi4_28zZe7gI3shbEFV_LOCl35inQL0Y';
const PIPELINE_META_RANGE     = 'Pipeline_Meta!A1';
// B1 on the same tab holds the pre-generated AI weekly summary that
// fetch_data.py writes via write_ai_summary() (AI_SUMMARY_CELL). Apps Script
// reads it here so the deck never has to call GenOS itself — Apps Script runs
// outside Intuit's network and cannot obtain an IAM ticket, so a direct GenOS
// call always 403s. The pipeline already generated the summary on-network.
const AI_SUMMARY_RANGE        = 'Pipeline_Meta!B1';

// Monday of fiscal W1 — used ONLY by the automation's auto-week fallback
// (getCurrentWeekNumber_); the deck content uses CURRENT_WEEK. Update on a Q1
// rollover. FY26 W1 = 4 Aug 2025; FY27 W1 = 3 Aug 2026. VERIFY against
// Calendar_Cache if the calendar's W1 differs from the first Monday of August.
const FY_WEEK1_MONDAY = new Date('2026-08-03T00:00:00');

// ── Visuals week-driver cell (CHANGE A) ─────────────────────
// The visuals lookup table keys off this cell. We bump it to the current week
// and flush before reading the tab so the pulled values are for this week.
// ⚠ VERIFY this tab name exactly matches the FY27 Q1 visuals tab (incl. any
// trailing space). A mismatch just no-ops with a log line — the deck still
// runs but visuals-sourced rows (pipeline, team slides, EMM) stay blank.
const VISUALS_TAB_NAME    = 'FY27Q1 Visuals';
const VISUALS_WEEK_CELL   = 'F149';
// Set to true if the visuals table matches on the "W50" string; false if it
// matches on the bare number 50.
const VISUALS_WEEK_AS_TEXT = false;

// ============================================================
//  AGENDA SLIDE CONFIG
// ============================================================

const AGENDA_TEMPLATE_ID    = '1UdXQjazwl8s_hi93AhnWU8JhwkHEj5XiUE_65ARDCUc';
const AGENDA_SPREADSHEET_ID = '18ALFz2LQz8pUf2Z0hiyjxw-1sBdAlSrf1dkqFUHbZSQ';
const AGENDA_DATA_RANGE     = 'B4:F15';
const AGENDA_OUTPUT_FOLDER  = '1_tEoKp0mKL0GaLba1TBHkxMyKM7WsJSq';
const AGENDA_SHEET_GID      = 915584597;   // fallback tab id (…#gid=915584597)

// ============================================================
//  GENOS CONFIG
// ============================================================

var GENOS_ENABLED = true;

var GENOS_E2E_ENDPOINT =
  'https://genos-platform-e2e.api.intuit.com/llm/v3/anthropic.claude-sonnet-4-6/chat/completions';

var GENOS_ASSET_ALIAS =
  'Intuit.sbseganalyticsds.e2eautomationsales';

var GENOS_EXPERIENCE_ID =
  'ecf5d504-ded2-418c-95c3-825cc8342f12';

// ============================================================
//  CF COLOUR RULE (CHANGE B) — mirrors the sheet exactly
//    >= 100            -> green
//    >= 95 and < 100   -> amber
//    < 95              -> red
//    blank/non-numeric -> white (sheet shows nothing)
//  NOTE: deliberately NO "n<=0 || n>300 -> white" guard. That was a v4
//  invention the sheet's conditional formatting does not have.
// ============================================================
var CF_GREEN = '#B6D7A8', CF_AMBER = '#FFE599', CF_RED = '#EA9999', CF_WHITE = '#FFFFFF';

// Dynamic resolver built once per run from the sheet's live CF rules.
// Set in generateWeeklyPresentation; null means "use the static fallback".
var CF_RESOLVER = null;

// Public entry point — unchanged name, called by every apply*Colours_ helper.
// If a live resolver was built this run, use it; otherwise use the static rule.
function cfColorForValue_(txt) {
  return CF_RESOLVER ? CF_RESOLVER(txt) : cfColorStatic_(txt);
}

// Original hardcoded logic, renamed. Used as the fallback when no CF rules load.
//    >= 100            -> green
//    >= 95 and < 100   -> amber
//    < 95              -> red
//    blank/non-numeric -> white
function cfColorStatic_(txt) {
  if (txt === null || txt === undefined) return CF_WHITE;
  var s = String(txt).trim();
  if (s === '' || s === '-' || s.toLowerCase() === 'n/a' || s === '#DIV/0!') return CF_WHITE;
  var n = parseFloat(s.replace(/,/g, '').replace('%', ''));
  if (isNaN(n)) return CF_WHITE;
  return n >= 100 ? CF_GREEN : n >= 95 ? CF_AMBER : CF_RED;
}

// Builds a resolver from a sheet's conditional-format rules, read in the
// sheet's own priority order (first match wins — exactly how Sheets renders).
// getBackground() can't read CF colours, so evaluating rules by value is the
// only faithful mirror. Returns cfColorStatic_ if no boolean rules are found.
function buildCfResolverFromSheet_(sheet) {
  var parsed = [];
  try {
    var rules = sheet.getConditionalFormatRules();
    rules.forEach(function (rule) {
      var bc = rule.getBooleanCondition();
      if (!bc) return;                                // skip gradient rules
      var colorObj = bc.getBackgroundObject();
      if (!colorObj) return;
      var hex;
      try { hex = colorObj.asRgbColor().asHexString(); } catch (e) { return; }
      parsed.push({
        type:   bc.getCriteriaType(),
        values: (bc.getCriteriaValues() || []).map(function (val) {
          var n = parseFloat(String(val).replace(/[,%]/g, ''));
          return isNaN(n) ? val : n;
        }),
        hex: hex
      });
    });
  } catch (e) {
    Logger.log('[cfResolver] rule read failed: ' + e);
  }

  Logger.log('[cfResolver] loaded %s boolean rules: %s', parsed.length, JSON.stringify(parsed));
  if (!parsed.length) {
    Logger.log('[cfResolver] no boolean rules — using static fallback');
    return cfColorStatic_;
  }

  return function (txt) {
    if (txt === null || txt === undefined) return CF_WHITE;
    var s = String(txt).trim();
    if (s === '' || s === '-' || s.toLowerCase() === 'n/a' || s === '#DIV/0!') return CF_WHITE;
    var n = parseFloat(s.replace(/,/g, '').replace('%', ''));
    if (isNaN(n)) return CF_WHITE;
    for (var i = 0; i < parsed.length; i++) {
      if (matchesNumberCriteria_(n, parsed[i].type, parsed[i].values)) return parsed[i].hex;
    }
    return CF_WHITE;
  };
}

function matchesNumberCriteria_(n, type, vals) {
  var C = SpreadsheetApp.BooleanCriteria;
  var a = vals[0], b = vals[1];
  switch (type) {
    case C.NUMBER_GREATER_THAN:             return n >  a;
    case C.NUMBER_GREATER_THAN_OR_EQUAL_TO: return n >= a;
    case C.NUMBER_LESS_THAN:                return n <  a;
    case C.NUMBER_LESS_THAN_OR_EQUAL_TO:    return n <= a;
    case C.NUMBER_EQUAL_TO:                 return n === a;
    case C.NUMBER_NOT_EQUAL_TO:             return n !== a;
    case C.NUMBER_BETWEEN:                  return n >= a && n <= b;   // inclusive, like Sheets
    case C.NUMBER_NOT_BETWEEN:              return n <  a || n >  b;
    default:
      Logger.log('[cfResolver] unhandled criteria type: ' + type);
      return false;
  }
}

// ============================================================
//  MAIN
// ============================================================

function generateWeeklyPresentation() {
  Logger.log('=== E2E Deck Generator v5 — ' + CURRENT_WEEK + ' ===');
  var qi     = getQuarterInfo_(CURRENT_WEEK);
  var spreadsheet = SpreadsheetApp.openById(qi.spreadsheetId);
  var sheet       = spreadsheet.getSheetByName(qi.tabName);
  CF_RESOLVER = buildCfResolverFromSheet_(sheet);   // mirror the sheet's live CF rules
  var allData = sheet.getDataRange().getDisplayValues();

  var visSheet = spreadsheet.getSheetByName(VISUALS_TAB_NAME);
  updateVisualsWeekCell_(visSheet);   // CHANGE A: bump the week driver first
  SpreadsheetApp.flush();             // force the visuals table to recompute
  var visData  = visSheet.getDataRange().getValues();
  Logger.log('[visLoad] %s rows=%s cols=%s', VISUALS_TAB_NAME, visData.length, visData[0] ? visData[0].length : 0);

  debugLogSections_(allData);

  var newName   = 'FY26 CA Weekly Accountant E2E Review: Week ' + CURRENT_WEEK_NUM + ' (' + qi.quarter + ')';
  var newFileId = copyPresentation_(newName);
  Logger.log('Created: ' + newName);

  var data    = extractAllData_(allData, visData, qi, spreadsheet);
  var aiText  = generateAICommentary_(data);
  updateAllSlides_(newFileId, data, aiText);
  Logger.log('=== DONE: https://docs.google.com/presentation/d/' + newFileId + '/edit ===');
}

// CHANGE A: write the week driver into the visuals tab.
function updateVisualsWeekCell_(visSheet) {
  if (!visSheet) { Logger.log('[visualsWeek] %s missing — skipped', VISUALS_TAB_NAME); return; }
  try {
    var val = VISUALS_WEEK_AS_TEXT ? CURRENT_WEEK : CURRENT_WEEK_NUM;
    visSheet.getRange(VISUALS_WEEK_CELL).setValue(val);
    Logger.log('[visualsWeek] set %s = %s', VISUALS_WEEK_CELL, val);
  } catch (e) {
    Logger.log('[visualsWeek] failed to set %s: %s', VISUALS_WEEK_CELL, e.message);
  }
}

function debugLogSections_(allData) {
  var qi = getQuarterInfo_(CURRENT_WEEK);
  if (!allData) {
    allData = SpreadsheetApp.openById(qi.spreadsheetId)
              .getSheetByName(qi.tabName).getDataRange().getDisplayValues();
  }
  var _cur  = FY_LABEL + ' ' + ((qi && qi.quarter) || 'Q1');
  var _prev = PREV_FY_LABEL + ' ' + PREV_QUARTER;
  [
    _cur + ' GNS', _prev + ' GNS','National','Major','Large','DTM','Act/Fcst',
    'ITF','Account Based ITPY',
    _cur + ' Finance Forecast', _cur + ' ADV','ADV GNS Mix (non-BDO)',
    'ADV GNS A','ADV ITF','Account Based ADV ITPY',
    'ADV Upgrade Events','ADV Upgrades ITF','ADV Upgrades ITPY','EMM ADV Upgrades',
    _cur + ' Payroll','Payroll Attach','Payroll GNS A','Payroll ITF','Payroll ITPY',
    FY_LABEL + ' Cancel', _cur + ' Active Cancels',
    _cur + ' PKG Actuals', _prev + ' PKG Actuals', FY_LABEL + ' WSB','Package % of GNS',
    'EMM Account Management',
  ].forEach(function(lbl) {
    Logger.log('ROW "' + lbl + '" → ' + (findRowLoose_(allData, lbl, 1, allData.length) || 'NOT FOUND'));
  });
  Logger.log('COL "' + CURRENT_WEEK + '" → ' + (findColumnLoose_(allData, CURRENT_WEEK) || 'NOT FOUND'));
  Logger.log('COL "QTD"             → ' + (findColumnLoose_(allData, 'QTD')          || 'NOT FOUND'));
  Logger.log('COL "QTG"             → ' + (findColumnLoose_(allData, 'QTG')          || 'NOT FOUND'));
}

function getQuarterInfo_(week) {
  for (var q in QUARTER_CONFIG)
    if (QUARTER_CONFIG[q].weeks.indexOf(week) >= 0)
      return { quarter: q, spreadsheetId: QUARTER_CONFIG[q].spreadsheetId, tabName: QUARTER_CONFIG[q].tabName };
  throw new Error('Week not found: ' + week);
}

function copyPresentation_(name) {
  var src = DriveApp.getFileById(SOURCE_PRESENTATION_ID);
  return (DESTINATION_FOLDER_ID
    ? src.makeCopy(name, DriveApp.getFolderById(DESTINATION_FOLDER_ID))
    : src.makeCopy(name)).getId();
}

// ============================================================
//  DATA EXTRACTION
// ============================================================

function extractAllData_(allData, visData, qi, spreadsheet) {
  var W = findColumnLoose_(allData, CURRENT_WEEK);
  var Q = findColumnInRows_(allData, 'QTD', 1, 15);
  var G = findColumnInRows_(allData, 'QTG', 1, 15);
  if (!W) throw new Error('Week column not found: ' + CURRENT_WEEK);
  if (!Q) { Q = findColumnLoose_(allData, 'QTD'); }

  var ql = qi.quarter;

  // ── Section anchor rows ──────────────────────────────────
  var gnsSec     = findRowLoose_(allData, FY_LABEL + ' ' + ql + ' GNS',              1, allData.length) || 3;
  var finSec     = findRowLoose_(allData, FY_LABEL + ' ' + ql + ' Finance Forecast',  1, allData.length);
  var itfSec     = findRowLoose_(allData, 'ITF',                  gnsSec + 3,  gnsSec + 120);
  var itpySec    = findRowLoose_(allData, 'Account Based ITPY',   1,           allData.length);
  var advSec     = findRowLoose_(allData, FY_LABEL + ' ' + ql + ' ADV', 1,           allData.length);
  var advMixSec  = findRowLoose_(allData, 'ADV GNS Mix (non-BDO)',1,           allData.length);
  var advGnsA    = findRowLoose_(allData, 'ADV GNS A',            1,           allData.length);
  var advItfSec  = advGnsA
    ? findRowLoose_(allData, 'ADV ITF',    advGnsA,     advGnsA + 60)
    : findRowLoose_(allData, 'ADV ITF',    advSec || 1, allData.length);
  var advItpySec = findRowLoose_(allData, 'Account Based ADV ITPY', 1,         allData.length);
  var upgrSec    = findRowLoose_(allData, 'ADV Upgrade Events',   1,           allData.length);
  var upgrItfSec = findRowLoose_(allData, 'ADV Upgrades ITF',     1,           allData.length);
  var upgrItpySec= findRowLoose_(allData, 'ADV Upgrades ITPY',    1,           allData.length);
  var emmSec     = findRowLoose_(allData, 'EMM ADV Upgrades',     1,           allData.length);
  var paySec     = findRowLoose_(allData, FY_LABEL + ' ' + ql + ' Payroll', 1,        allData.length);
  var payAttSec  = findRowLoose_(allData, 'Payroll Attach',       1,           allData.length);
  var payGnsA    = findRowLoose_(allData, 'Payroll GNS A',        1,           allData.length);
  var payItfSec  = findRowLoose_(allData, 'Payroll ITF',          1,           allData.length);
  var payItpySec = findRowLoose_(allData, 'Payroll ITPY',         1,           allData.length);
  // Current-quarter / current-FY sections: driven by FY_LABEL + ql so a rollover
  // is a one-line change. (Variable names keep the historical "q4" for minimal
  // downstream churn — they hold the CURRENT quarter's rows, not literally Q4.)
  var canSec     = findRowLoose_(allData, FY_LABEL + ' Cancel',              1, allData.length);
  var q4CanSec   = findRowLoose_(allData, FY_LABEL + ' ' + ql + ' Active Cancels', 1, allData.length);
  var pkgQ4Sec   = findRowLoose_(allData, FY_LABEL + ' ' + ql + ' PKG Actuals',    1, allData.length);
  var wsbSec     = findRowLoose_(allData, FY_LABEL + ' WSB',                 1, allData.length);
  // PRIOR-PERIOD comparison anchors, driven by PREV_FY_LABEL / PREV_QUARTER.
  // For a Q1 deck these resolve to "FY26 Q4 ..." (the prior FY's Q4). NOTE: they
  // search the CURRENT tab, so the FY27 Q1 tab must actually CONTAIN a FY26 Q4
  // comparison block with data. Legacy FY25 fallbacks are kept last.
  var q3CanSec   = findRowLoose_(allData, PREV_FY_LABEL + ' ' + PREV_QUARTER + ' Active Cancels', 1, allData.length)
                 || findRowLoose_(allData, 'FY25 Cancel Type',    1,           allData.length);
  var pkgQ3Sec   = findRowLoose_(allData, PREV_FY_LABEL + ' ' + PREV_QUARTER + ' PKG Actuals',    1, allData.length);
  var pkgPctSec  = findRowLoose_(allData, 'Package % of GNS',     1,           allData.length)
                 || findRowLoose_(allData, 'Package %',           1,           allData.length);
  var pkg9Sec    = findRowLoose_(allData, PREV_FY_LABEL + ' ' + PREV_QUARTER + ' Package GNS',    1, allData.length)
                 || pkgQ4Sec || pkgQ3Sec;

  var visSec = findRowLoose_(visData, 'Pipeline (TOTAL', 1, allData.length);

  // ── Helper ───────────────────────────────────────────────
  var v = function(row, col) {
    if (!row || !col) return '';
    try { return allData[row-1][col-1]; } catch(e) { return ''; }
  };

  var vv = function(row, col) {
    if (!row || !col) return '';
    try { return visData[row-1][col-1]; } catch(e) { return ''; }
  };

  // ── GNS section: team rows ───────────────────────────────
  var gnsEnd = Math.min(gnsSec + 60,
    (itfSec  || gnsSec + 60) - 1,
    (finSec  || gnsSec + 60) - 1);

  var natGns = findRowLoose_(allData, 'National', gnsSec, gnsEnd);
  var majGns = findRowLoose_(allData, 'Major',    gnsSec, gnsEnd);
  var lrgGns = findRowLoose_(allData, 'Large',    gnsSec, gnsEnd);
  var dtmGns = findRowLoose_(allData, 'DTM',      gnsSec, gnsEnd);
  var actRow = findRowLoose_(allData, 'Act/Fcst', gnsSec, gnsEnd)
             || findRowLoose_(allData, 'Actual/Sales', gnsSec, gnsEnd);

  var finEnd = finSec ? finSec + 10 : gnsEnd;
  var finNat = finSec ? findRowLoose_(allData, 'National', finSec, finEnd) : null;
  var finMaj = finSec ? findRowLoose_(allData, 'Major',    finSec, finEnd) : null;
  var finLrg = finSec ? findRowLoose_(allData, 'Large',    finSec, finEnd) : null;
  var finDtm = finSec ? findRowLoose_(allData, 'DTM',      finSec, finEnd) : null;
  var finTot = finSec ? findRowLoose_(allData, 'Forecast', finSec, finEnd) : null;

  var itfEnd  = itfSec ? itfSec + 10 : 0;
  var natItf  = itfSec ? findRowLoose_(allData, 'National', itfSec + 1, itfEnd) : null;
  var majItf  = itfSec ? findRowLoose_(allData, 'Major',    itfSec + 1, itfEnd) : null;
  var lrgItf  = itfSec ? findRowLoose_(allData, 'Large',    itfSec + 1, itfEnd) : null;
  var dtmItf  = itfSec ? findRowLoose_(allData, 'DTM',      itfSec + 1, itfEnd) : null;
  var totItf  = (itfSec && natItf)
    ? findRowLoose_(allData, 'ITF', natItf + 1, itfEnd)
    : null;

  var itpyEnd = itpySec ? itpySec + 10 : 0;
  var natItpy = itpySec ? findRowLoose_(allData, 'National', itpySec, itpyEnd) : null;
  var majItpy = itpySec ? findRowLoose_(allData, 'Major',    itpySec, itpyEnd) : null;
  var lrgItpy = itpySec ? findRowLoose_(allData, 'Large',    itpySec, itpyEnd) : null;
  var dtmItpy = itpySec ? findRowLoose_(allData, 'DTM',      itpySec, itpyEnd) : null;
  var totItpy = itpySec ? findRowLoose_(allData, 'ITPY',     itpySec, itpyEnd) : null;

  var advEnd  = advSec ? advSec + 20 : 0;
  var natAdv  = advSec ? findRowLoose_(allData, 'National',      advSec, advEnd) : null;
  var majAdv  = advSec ? findRowLoose_(allData, 'Major',         advSec, advEnd) : null;
  var lrgAdv  = advSec ? findRowLoose_(allData, 'Large',         advSec, advEnd) : null;
  var dtmAdv  = advSec ? findRowLoose_(allData, 'DTM',           advSec, advEnd) : null;
  var totAdv  = advSec ? findRowLoose_(allData, 'Total ADV GNS', advSec, advEnd + 10) : null;

  var advFcstSec = findRowLoose_(allData, FY_LABEL + ' ' + ql + ' ADV Forecast', 1, allData.length);
  var advFcstRow = advFcstSec
    ? findRowLoose_(allData, 'Advanced GNS', advFcstSec, advFcstSec + 10)
    : null;
  var advItfEnd  = advItfSec ? advItfSec + 10 : 0;
  var advItfRow  = advItfSec
    ? findRowLoose_(allData, 'ADV ITF', advItfSec + 1, advItfEnd)
    : null;
  var advItpyEnd = advItpySec ? advItpySec + 10 : 0;
  var advItpyRow = advItpySec
    ? findRowLoose_(allData, 'ITPY', advItpySec + 1, advItpyEnd)
    : null;

  var advMixRow     = findRowLoose_(allData, 'ADV GNS Mix (non-BDO)', 1, allData.length);
  var advMixFcstRow = advMixRow ? advMixRow + 1 : null;
  var advMixItfRow  = advMixRow ? advMixRow + 2 : null;
  var advMixItpyRow = advMixRow ? advMixRow + 3 : null;

  var upgrEnd     = upgrSec ? upgrSec + 50 : 0;
  var hvamRow     = upgrSec
    ? findRowLoose_(allData, 'Total Upgrades', upgrSec, upgrEnd)
    : null;
  var upgrFcstSec = findRowLoose_(allData, FY_LABEL + ' ' + ql + ' ADV UPGRADES Forecast', 1, allData.length);
  var hvamFcstRow = upgrFcstSec
    ? findRowLoose_(allData, 'ADV Upgrades', upgrFcstSec, upgrFcstSec + 10)
    : null;
  var upgrItfEnd  = upgrItfSec ? upgrItfSec + 10 : 0;
  var hvamItfRow  = upgrItfSec
    ? findRowLoose_(allData, 'ADV ITF', upgrItfSec + 1, upgrItfEnd)
    : null;
  var upgrItpyEnd = upgrItpySec ? upgrItpySec + 10 : 0;
  var hvamItpyRow = upgrItpySec
    ? findRowLoose_(allData, 'ADV ITPY', upgrItpySec + 1, upgrItpyEnd)
    : null;

  var emmActRow  = emmSec ? emmSec + 1 : null;
  var emmItfRow  = emmSec ? emmSec + 2 : null;
  var emmItpyRow = null;

  var payEnd     = paySec ? paySec + 20 : 0;
  var totPay     = paySec
    ? findRowLoose_(allData, 'Actual/Sales Fcst', paySec, payEnd)
    || findRowLoose_(allData, 'Partner',           paySec, payEnd)
    : null;
  var payFcstSec = findRowLoose_(allData, FY_LABEL + ' ' + ql + ' Payroll Forecast', 1, allData.length);
  var payFcstRow = payFcstSec
    ? findRowLoose_(allData, 'Partner', payFcstSec, payFcstSec + 10)
    : null;
  var payItfRow  = payItfSec
    ? findRowLoose_(allData, 'Partner', payItfSec + 1, payItfSec + 10)
    : null;
  var payItpyRow = payItpySec
    ? findRowLoose_(allData, 'Partner', payItpySec + 1, payItpySec + 10)
    : null;

  var advPipeRow  = findRowLoose_(visData, 'ADV pipeline',        1, visData.length);
  var convActRow  = findRowLoose_(visData, 'Pipeline Conversion', 1, visData.length);
  var faceActRow  = findRowLoose_(visData, 'Average Client Face', 1, visData.length);
  var netActRow   = findRowLoose_(visData, 'Net Attrition',       1, visData.length);
  var advMixVisRow = findRowLoose_(visData, 'ADV Mix', 1, visData.length);
  var emmVisRow = findRowLoose_(visData, 'EMM ADV Upgrades', 1, visData.length);
  var netAttrRow  = null;

  Logger.log('=== Slide 4 row resolution ===');
  Logger.log('natGns='+natGns+' majGns='+majGns+' lrgGns='+lrgGns+' dtmGns='+dtmGns+' actRow='+actRow);
  Logger.log('finNat='+finNat+' finMaj='+finMaj+' finLrg='+finLrg+' finDtm='+finDtm+' finTot='+finTot);
  Logger.log('natItf='+natItf+' totItf='+totItf+' natItpy='+natItpy+' totItpy='+totItpy);
  Logger.log('totAdv='+totAdv+' advFcstRow='+advFcstRow+' advItfRow='+advItfRow+' advItpyRow='+advItpyRow);
  Logger.log('advMixRow='+advMixRow+' advMixFcstRow='+advMixFcstRow+' advMixItfRow='+advMixItfRow+' advMixItpyRow='+advMixItpyRow);
  Logger.log('hvamRow='+hvamRow+' hvamFcstRow='+hvamFcstRow+' hvamItfRow='+hvamItfRow+' hvamItpyRow='+hvamItpyRow);
  Logger.log('emmActRow='+emmActRow+' emmItfRow='+emmItfRow);
  Logger.log('totPay='+totPay+' payFcstRow='+payFcstRow+' payItfRow='+payItfRow+' payItpyRow='+payItpyRow);

  // ── Team object builder ──────────────────────────────────
  var teamObj = function(gnsRow, finRow, itfRow, itpyRow) {
    var act = v(gnsRow, W), fcst = v(finRow || gnsRow, W);
    var aq  = v(gnsRow, Q), fq   = v(finRow || gnsRow, Q);
    return {
      actual:     act,   forecast:   fcst,  variance:   numDiff_(act, fcst),
      itf_w:      v(itfRow, W),             itpy_w:     v(itpyRow, W),
      actual_q:   aq,    forecast_q: fq,    variance_q: numDiff_(aq, fq),
      itf_q:      v(itfRow, Q),             itpy_q:     v(itpyRow, Q),
    };
  };

  var subObj = function(actualRow, forecastRow, itfRow, itpyRow) {
    var act = v(actualRow, W),  fcst = v(forecastRow || actualRow, W);
    var aq  = v(actualRow, Q),  fq   = v(forecastRow || actualRow, Q);
    return {
      actual:     act,   forecast:   fcst,  variance:   numDiff_(act, fcst),
      itf_w:      v(itfRow,  W),            itpy_w:     v(itpyRow, W),
      actual_q:   aq,    forecast_q: fq,    variance_q: numDiff_(aq, fq),
      itf_q:      v(itfRow,  Q),            itpy_q:     v(itpyRow, Q),
    };
  };

  var visW = findColumnLoose_(visData, CURRENT_WEEK);
  var visQ = findColumnLoose_(visData, 'QTD');

  Logger.log('visData rows: ' + visData.length +
             ' visW=' + visW + ' visQ=' + visQ +
             ' visSec=' + visSec + ' netActRow=' + netActRow);

  function fmtPct_(val) {
    if (val === null || val === undefined || val === '') return '';
    if (typeof val === 'string' && val.indexOf('%') >= 0) return val;
    var n = parseFloat(val);
    if (isNaN(n)) return String(val);
    if (Math.abs(n) < 2 && n !== 0) return String(Math.round(n * 100)) + '%';
    return String(Math.round(n)) + '%';
  }

  function fmtNum_(val) {
    if (val === null || val === undefined || val === '') return '';
    if (val === '-' || val === 'n/a') return String(val);
    if (typeof val === 'string' && val.indexOf('%') >= 0) return val;
    if (typeof val === 'string' && val.indexOf(',') >= 0) return val;
    var n = parseFloat(val);
    if (isNaN(n)) return String(val);
    if (Math.abs(n) < 10 && n !== Math.round(n)) return String(Math.round(n * 10) / 10);
    return String(Math.round(n));
  }

  // ── SLIDE 4 ───────────────────────────────────────────────
  var slide4 = {
    national: teamObj(natGns, finNat, natItf, natItpy),
    major:    teamObj(majGns, finMaj, majItf, majItpy),
    large:    teamObj(lrgGns, finLrg, lrgItf, lrgItpy),
    dtm:      teamObj(dtmGns, finDtm, dtmItf, dtmItpy),
    total: {
      actual:     v(actRow, W),
      forecast:   v(finTot || actRow, W),
      variance:   numDiff_(v(actRow, W),  v(finTot || actRow, W)),
      itf_w:      v(totItf,  W),
      itpy_w:     v(totItpy, W),
      actual_q:   v(actRow, Q),
      forecast_q: v(finTot || actRow, Q),
      variance_q: numDiff_(v(actRow, Q),  v(finTot || actRow, Q)),
      itf_q:      v(totItf,  Q),
      itpy_q:     v(totItpy, Q),
    },
    advGNS:   subObj(totAdv,    advFcstRow,    advItfRow,    advItpyRow),
    advMix: {
      actual:     v(advMixRow,     W),    forecast:   v(advMixFcstRow, W),
      variance:   fmtPct_(vv(advMixVisRow, 6)),    itf_w:      v(advMixItfRow,  W),
      itpy_w:     v(advMixItpyRow, W),
      actual_q:   v(advMixRow,     Q),    forecast_q: v(advMixFcstRow, Q),
      variance_q: fmtPct_(vv(advMixVisRow, 12)),   itf_q:      v(advMixItfRow,  Q),
      itpy_q:     v(advMixItpyRow, Q),
    },
    hvamUpgr: subObj(hvamRow,   hvamFcstRow,   hvamItfRow,   hvamItpyRow),
    emmUpgr: {
      actual:     v(emmActRow,  W),    forecast:   vv(emmVisRow, 5),
      variance:   vv(emmVisRow, 6),    itf_w:      v(emmItfRow,  W),
      itpy_w:     vv(emmVisRow, 8),
      actual_q:   v(emmActRow,  Q),    forecast_q: vv(emmVisRow, 11),
      variance_q: vv(emmVisRow, 12),   itf_q:      v(emmItfRow,  Q),
      itpy_q:     vv(emmVisRow, 14),
    },
    payroll:  subObj(totPay,    payFcstRow,    payItfRow,    payItpyRow),
    pipeline: {
      actual:     vv(visSec, 4),   forecast:   vv(visSec, 5),   variance:   vv(visSec, 6),
      itf_w:      vv(visSec, 7),   itpy_w:     vv(visSec, 8),
      actual_q:   vv(visSec, 10),  forecast_q: vv(visSec, 11),  variance_q: vv(visSec, 12),
      itf_q:      vv(visSec, 13),  itpy_q:     vv(visSec, 14),
    },
    advPipeline: {
      actual:     vv(advPipeRow, 4),   forecast:   vv(advPipeRow, 5),   variance:   vv(advPipeRow, 6),
      itf_w:      vv(advPipeRow, 7),   itpy_w:     vv(advPipeRow, 8),
      actual_q:   vv(advPipeRow, 10),  forecast_q: vv(advPipeRow, 11),  variance_q: vv(advPipeRow, 12),
      itf_q:      vv(advPipeRow, 13),  itpy_q:     vv(advPipeRow, 14),
    },
    pipeConv: {
      actual:     fmtPct_(vv(convActRow, 4)),  forecast:   fmtPct_(vv(convActRow, 5)),
      variance:   fmtPct_(vv(convActRow, 6)),  itf_w:      fmtNum_(vv(convActRow, 7)),
      itpy_w:     null,
      actual_q:   fmtPct_(vv(convActRow, 10)), forecast_q: fmtPct_(vv(convActRow, 11)),
      variance_q: fmtPct_(vv(convActRow, 12)), itf_q:      fmtNum_(vv(convActRow, 13)),
      itpy_q:     null,
    },
    avgFace: {
      actual:     fmtNum_(vv(faceActRow, 4)),  forecast:   fmtNum_(vv(faceActRow, 5)),
      variance:   fmtNum_(vv(faceActRow, 6)),  itf_w:      fmtNum_(vv(faceActRow, 7)),
      itpy_w:     null,
      actual_q:   fmtNum_(vv(faceActRow, 10)), forecast_q: fmtNum_(vv(faceActRow, 11)),
      variance_q: fmtNum_(vv(faceActRow, 12)), itf_q:      fmtNum_(vv(faceActRow, 13)),
      itpy_q:     null,
    },
    netAttrition: {
      actual:     fmtNum_(vv(netActRow, 4)),   forecast:   fmtNum_(vv(netActRow, 5)),
      variance:   fmtNum_(vv(netActRow, 6)),   itf_w:      fmtNum_(vv(netActRow, 7)),
      itpy_w:     fmtNum_(vv(netActRow, 8)),
      actual_q:   fmtNum_(vv(netActRow, 10)),  forecast_q: fmtNum_(vv(netActRow, 11)),
      variance_q: fmtNum_(vv(netActRow, 12)),  itf_q:      fmtNum_(vv(netActRow, 13)),
      itpy_q:     fmtNum_(vv(netActRow, 14)),
    },
  };

  Logger.log('visData rows: ' + visData.length + ' visW=' + visW + ' visQ=' + visQ + ' visSec=' + visSec + ' netActRow=' + netActRow);
  if (visSec)     Logger.log('visSec row '   + visSec      + ': ' + JSON.stringify(visData[visSec-1]));
  if (advPipeRow) Logger.log('advPipe row '  + advPipeRow  + ': ' + JSON.stringify(visData[advPipeRow-1]));
  if (convActRow) Logger.log('convAct row '  + convActRow  + ': ' + JSON.stringify(visData[convActRow-1]));
  if (faceActRow) Logger.log('faceAct row '  + faceActRow  + ': ' + JSON.stringify(visData[faceActRow-1]));
  if (netActRow)  Logger.log('netAtt  row '  + netActRow   + ': ' + JSON.stringify(visData[netActRow-1]));

  // ── SLIDE 5 BMW ───────────────────────────────────────────
  var slide5 = (function() {
    var cB = findColumnLoose_(allData, 'Best Case')   || findColumnLoose_(allData, 'Best');
    var cM = findColumnLoose_(allData, 'Most Likely') || findColumnLoose_(allData, 'Most');
    var cW = findColumnLoose_(allData, 'Worst Case')  || findColumnLoose_(allData, 'Worst');
    var cT = findColumnLoose_(allData, 'Target');
    var r4 = function(r) { return r ? [v(r,cB),v(r,cM),v(r,cW),v(r,cT)] : ['','','','']; };
    var qtgNat=G?v(natGns,G):v(natGns,Q), qtgMaj=G?v(majGns,G):v(majGns,Q);
    var qtgLrg=G?v(lrgGns,G):v(lrgGns,Q), qtgDtm=G?v(dtmGns,G):v(dtmGns,Q);
    var qtgTot=G?v(actRow,G):v(actRow,Q);
    return {
      gns:[r4(natGns),r4(majGns),r4(lrgGns),r4(dtmGns),r4(actRow)],
      adv:[r4(natAdv),r4(majAdv),r4(lrgAdv),r4(dtmAdv),r4(totAdv)],
      qtd:[v(natGns,Q),v(majGns,Q),v(lrgGns,Q),v(dtmGns,Q),v(actRow,Q)],
      qtg:[qtgNat,qtgMaj,qtgLrg,qtgDtm,qtgTot],
      deltas:[
        [v(natGns,Q), numDiff_(v(natGns,Q),qtgNat)],
        [v(majGns,Q), numDiff_(v(majGns,Q),qtgMaj)],
        [v(lrgGns,Q), numDiff_(v(lrgGns,Q),qtgLrg)],
        [v(dtmGns,Q), numDiff_(v(dtmGns,Q),qtgDtm)],
        [v(actRow,Q), numDiff_(v(actRow,Q),qtgTot)],
      ],
    };
  })();

  // ── Week columns for grid extraction ─────────────────────
  var wkCols = QUARTER_CONFIG[ql].weeks.concat([ql,'QTD','QTG','QTD Average']);
  var exRows = function(sec, labels, secEnd) {
    return extractLabeledRows_(allData, sec, secEnd || sec + 40, labels, wkCols);
  };

  // ── SLIDE 6 ───────────────────────────────────────────────
  var gnsVarSec = findRowLoose_(allData, 'GNS', gnsSec + 5, gnsSec + 80);
  var actVsSec  = gnsVarSec
    ? findRowLoose_(allData, 'Act vs Fcst', gnsVarSec, gnsVarSec + 10)
    : findRowLoose_(allData, 'Act vs Fcst', gnsSec,    gnsSec + 80);
  var actVsEnd = actVsSec ? actVsSec + 10 : gnsSec + 80;

  Logger.log('wkCols: ' + JSON.stringify(wkCols));
  Logger.log('gnsSec='+gnsSec+' actVsSec='+actVsSec+' itfSec='+itfSec+' itpySec='+itpySec);

  var slide6 = {
    gns:      exRows(gnsSec,    ['National','Major','Large','DTM','Act/Fcst'],    gnsSec + 30),
    variance: exRows(gnsVarSec, ['National','Major','Large','DTM','Act vs Fcst'], gnsVarSec + 10),
    itf:      exRows(itfSec + 1,['National','Major','Large','DTM','ITF'],         itfEnd),
    itpy:     exRows(itpySec,   ['National','Major','Large','DTM','ITPY'],        itpyEnd),
  };

  // ── SLIDE 8 PKG extraction ────────────────────────────────
  Logger.log('=== Slide 8 debug ===');
  Logger.log('pkgQ4Sec=' + pkgQ4Sec + ' wsbSec=' + wsbSec + ' pkgQ3Sec=' + pkgQ3Sec);

  // Current-quarter package cols: weeks + the quarter-total label (ql) + QTD.
  var pkgQ4WkCols = QUARTER_CONFIG[ql].weeks.concat([ql, 'QTD']);
  // Prior-quarter package cols, driven by PREV_QUARTER (FY26 Q4 for a Q1 deck).
  var pkgQ3WkCols = QUARTER_CONFIG[PREV_QUARTER]
    ? QUARTER_CONFIG[PREV_QUARTER].weeks.concat([PREV_QUARTER, 'QTD'])
    : ['W40','W41','W42','W43','W44','W45','W46','W47','W48','W49','W50','W51','W52','W53','Q4','QTD'];

  // WSB row column offsets, derived from the layout rather than hardcoded to
  // W40..W53 (which blanked WSB on any non-Q4 tab). Weeks sit in columns C..P
  // (0-based offsets 2..15), the quarter total follows the weeks, then a spacer,
  // then QTD — matching the Q4 layout (total=16, QTD=18 for 14 weeks).
  var WSB_COL_OFFSETS = {};
  QUARTER_CONFIG[ql].weeks.forEach(function(w, i) { WSB_COL_OFFSETS[w] = i + 2; });
  var _wsbTotalOff = 2 + QUARTER_CONFIG[ql].weeks.length;
  WSB_COL_OFFSETS[ql]    = _wsbTotalOff;       // quarter-total column (e.g. "Q1")
  WSB_COL_OFFSETS['QTD'] = _wsbTotalOff + 2;   // QTD (one spacer column skipped)
  var wsbCols = pkgQ4WkCols;
  var wsbDataRows = [FY_LABEL + ' WSB', PREV_FY_LABEL, 'ITPY'].map(function(label) {
    var rowNum = (label === FY_LABEL + ' WSB') ? wsbSec
               : (label === PREV_FY_LABEL)     ? wsbSec + 1
               :                                 wsbSec + 2;
    var row = allData[rowNum - 1];
    if (!row) return { values: wsbCols.map(function() { return ''; }) };
    return { values: wsbCols.map(function(wk) {
      var offset = WSB_COL_OFFSETS[wk];
      return (offset !== undefined) ? row[offset] : '';
    })};
  });

  Logger.log('WSB FY26 values (W40-W45): ' + JSON.stringify(wsbDataRows[0].values.slice(0,6)));

  var nonNamData = [];
  if (pkgQ4Sec) {
    for (var nr = pkgQ4Sec; nr <= pkgQ4Sec + 12; nr++) {
      var nrow = allData[nr - 1];
      if (!nrow) continue;
      var nlabel = String(nrow[22] || '').trim();
      if (!nlabel || nlabel === 'Non-NAM') continue;
      nonNamData.push({
        label:    nlabel,
        units:    nrow[23] !== undefined ? String(nrow[23]) : '',
        promoMix: nrow[24] !== undefined ? String(nrow[24]) : '',
        mixGns:   nrow[25] !== undefined ? String(nrow[25]) : ''
      });
    }
  }
  Logger.log('nonNamData: ' + JSON.stringify(nonNamData));

  var slide8 = {
    q4PkgActuals: extractPkgSection_(allData, pkgQ4Sec, pkgQ4WkCols, false),
    wsb: { labels: wsbCols, data: wsbDataRows },
    q3PkgActuals: extractPkgSection_(allData, pkgQ3Sec, pkgQ3WkCols, true),
    nonNam: nonNamData,
  };

  Logger.log('=== PKG extraction debug ===');
  Logger.log('Q4 labels count: ' + (slide8.q4PkgActuals.data || []).length);
  Logger.log('Q3 labels count: ' + (slide8.q3PkgActuals.data || []).length);
  Logger.log('Q4 wkCols: ' + JSON.stringify(slide8.q4PkgActuals.labels));
  Logger.log('Q3 wkCols: ' + JSON.stringify(slide8.q3PkgActuals.labels));
  (slide8.q4PkgActuals.data || []).forEach(function(row, i) {
    Logger.log('Q4 row ' + i + ': ' + JSON.stringify(row.values.slice(0,6)));
  });
  (slide8.q3PkgActuals.data || []).forEach(function(row, i) {
    Logger.log('Q3 row ' + i + ': ' + JSON.stringify(row.values.slice(0,6)));
  });

  // ── SLIDE 9 ───────────────────────────────────────────────
  function getS9Row_(rowIdx) {
    var r = allData[rowIdx];
    if (!r) return {};
    return {
      W40: r[2],  W41: r[3],  W42: r[4],  W43: r[5],
      W44: r[6],  W45: r[7],  W46: r[8],  W47: r[9],
      W48: r[10], W49: r[11], W50: r[12], W51: r[13],
      W52: r[14], W53: r[15], Q4:  r[16],
      QTD:    r[18] || '',
      qtdPkg: r[19] || '',
      qtdAvg: r[20] || ''
    };
  }

  var slide9 = {
    pkgGns: {
      namBdo:     getS9Row_(65),
      national:   getS9Row_(66),
      major:      getS9Row_(67),
      large:      getS9Row_(68),
      dtm:        getS9Row_(69),
      accountant: getS9Row_(70)
    },
    pkgPercent: {
      national:   getS9Row_(73),
      major:      getS9Row_(74),
      large:      getS9Row_(75),
      dtm:        getS9Row_(76),
      accountant: getS9Row_(77)
    }
  };

  Logger.log('[slide9] national   W41=%s W42=%s W43=%s Q4=%s QTD=%s qtdPkg=%s qtdAvg=%s',
    slide9.pkgGns.national.W41, slide9.pkgGns.national.W42, slide9.pkgGns.national.W43,
    slide9.pkgGns.national.Q4,  slide9.pkgGns.national.QTD,
    slide9.pkgGns.national.qtdPkg, slide9.pkgGns.national.qtdAvg);

  // ── SLIDE 10 ──────────────────────────────────────────────
  var ADV_HDR  = 128;
  var ADV_MIX  = 134;
  var ADV_VAR  = 144;
  var ADV_ITF  = 151;
  var ADV_ITPY = 158;

  function getS10Row_(rowIdx) {
    var r = allData[rowIdx];
    if (!r) return {};
    return {
      W40:r[2],  W41:r[3],  W42:r[4],  W43:r[5],
      W44:r[6],  W45:r[7],  W46:r[8],  W47:r[9],
      W48:r[10], W49:r[11], W50:r[12], W51:r[13],
      W52:r[14], W53:r[15], Q4: r[16],
      QTD:       r[18] || '',
      QTG:       r[19] || '',
      qtdContrib:r[20] || '',
      qtdAvg:    r[21] || ''
    };
  }

  var slide10 = {
    gnsActuals: {
      'National':      getS10Row_(ADV_HDR + 1),
      'Major':         getS10Row_(ADV_HDR + 2),
      'Large':         getS10Row_(ADV_HDR + 3),
      'DTM':           getS10Row_(ADV_HDR + 4),
      'Total ADV GNS': getS10Row_(ADV_HDR + 5)
    },
    advMix: {
      'National Mix':          getS10Row_(ADV_MIX),
      'Major Mix':             getS10Row_(ADV_MIX + 1),
      'Large Mix':             getS10Row_(ADV_MIX + 2),
      'DTM Mix':               getS10Row_(ADV_MIX + 3),
      'ADV GNS Mix (non-BDO)': getS10Row_(ADV_MIX + 4),
      'ADV Mix Target':        getS10Row_(ADV_MIX + 5),
      'Mix ITF':               getS10Row_(ADV_MIX + 6),
      'Mix ITPY':              getS10Row_(ADV_MIX + 7)
    },
    variance: {
      'National':    getS10Row_(ADV_VAR + 1),
      'Major':       getS10Row_(ADV_VAR + 2),
      'Large':       getS10Row_(ADV_VAR + 3),
      'DTM':         getS10Row_(ADV_VAR + 4),
      'Act vs Fcst': getS10Row_(ADV_VAR + 5)
    },
    advItf: {
      'National': getS10Row_(ADV_ITF + 1),
      'Major':    getS10Row_(ADV_ITF + 2),
      'Large':    getS10Row_(ADV_ITF + 3),
      'DTM':      getS10Row_(ADV_ITF + 4),
      'ADV ITF':  getS10Row_(ADV_ITF + 5)
    },
    advItpy: {
      'National': getS10Row_(ADV_ITPY + 1),
      'Major':    getS10Row_(ADV_ITPY + 2),
      'Large':    getS10Row_(ADV_ITPY + 3),
      'DTM':      getS10Row_(ADV_ITPY + 4),
      'ITPY':     getS10Row_(ADV_ITPY + 5)
    }
  };

  Logger.log('[slide10] NatMix W42=%s W43=%s QTD=%s',
    slide10.advMix['National Mix'].W42,
    slide10.advMix['National Mix'].W43,
    slide10.advMix['National Mix'].QTD);

  // ── SLIDE 11 ──────────────────────────────────────────────
  var UPGR_HDR     = 167;
  var UPGR_ITF_HDR = 179;
  var UPGR_ITP_HDR = 186;
  var EMM_HDR      = 194;

  function getS11Row_(rowIdx) {
    var r = allData[rowIdx];
    if (!r) { Logger.log('[slide11] getS11Row_(%s): MISSING', rowIdx); return {}; }
    return {
      W40:r[2], W41:r[3], W42:r[4], W43:r[5],
      W44:r[6], W45:r[7], W46:r[8], W47:r[9],
      W48:r[10],W49:r[11],W50:r[12],W51:r[13],
      W52:r[14],W53:r[15],Q4:r[16],
      QTD:    r[18] || '',
      QTG:    r[19] || '',
      'QTD ADV contrib':           r[20] || '',
      '4 wk avg':                  r[21] || '',
      'Q3 Avg':                    r[22] || '',
      'ITPQ (4 Wk avg vs Q3 avg)': r[23] || ''
    };
  }

  var slide11 = {
    advEvents: {
      'National':             getS11Row_(UPGR_HDR + 1),
      'Major':                getS11Row_(UPGR_HDR + 2),
      'Large':                getS11Row_(UPGR_HDR + 3),
      'DTM':                  getS11Row_(UPGR_HDR + 4),
      'Total Upgrades':       getS11Row_(UPGR_HDR + 5),
      'National GNS+Upgrade': getS11Row_(UPGR_HDR + 6),
      'Major GNS+Upgrade':    getS11Row_(UPGR_HDR + 7),
      'Large GNS+Upgrade':    getS11Row_(UPGR_HDR + 8),
      'DTM GNS+Upgrade':      getS11Row_(UPGR_HDR + 9),
      'Total GNS+Upgrades':   getS11Row_(UPGR_HDR + 10)
    },
    advItf: {
      'National': getS11Row_(UPGR_ITF_HDR + 1),
      'Major':    getS11Row_(UPGR_ITF_HDR + 2),
      'Large':    getS11Row_(UPGR_ITF_HDR + 3),
      'DTM':      getS11Row_(UPGR_ITF_HDR + 4),
      'ADV ITF':  getS11Row_(UPGR_ITF_HDR + 5)
    },
    advItpy: {
      'National':  getS11Row_(UPGR_ITP_HDR + 1),
      'Major':     getS11Row_(UPGR_ITP_HDR + 2),
      'Large':     getS11Row_(UPGR_ITP_HDR + 3),
      'DTM':       getS11Row_(UPGR_ITP_HDR + 4),
      'ADV ITPY':  getS11Row_(UPGR_ITP_HDR + 5)
    },
    emmUpgrades: {
      'ADV Upgrades': getS11Row_(EMM_HDR + 1),
      'EMM AM ITF':   getS11Row_(EMM_HDR + 2)
    }
  };

  Logger.log('[slide11] National QTD=%s QTG=%s QTDAdv=%s 4wk=%s Q3=%s ITPQ=%s',
    slide11.advEvents['National'].QTD,
    slide11.advEvents['National'].QTG,
    slide11.advEvents['National']['QTD ADV contrib'],
    slide11.advEvents['National']['4 wk avg'],
    slide11.advEvents['National']['Q3 Avg'],
    slide11.advEvents['National']['ITPQ (4 Wk avg vs Q3 avg)']);

  // ── SLIDE 12 ──────────────────────────────────────────────
  var PAY_HDR     = 245;
  var PAY_ATT_HDR = 252;
  var PAY_GNSA_HDR = -1;
  for (var _pg = PAY_HDR + 1; _pg < PAY_HDR + 25; _pg++) {
    var _pgl = String(allData[_pg] ? allData[_pg][1] : '').trim();
    if (_pgl.indexOf('Payroll GNS') >= 0 && _pgl !== 'Payroll GNS A') {
      PAY_GNSA_HDR = _pg;
      Logger.log('[slide12] Found Payroll GNS▲ at allData[%s]: "%s"', _pg, _pgl);
      break;
    }
  }
  var PAY_ITF_HDR  = 266;
  var PAY_ITPY_HDR = 273;

  function getS12Row_(rowIdx) {
    var r = allData[rowIdx];
    if (!r) { Logger.log('[slide12] getS12Row_(%s): MISSING', rowIdx); return {}; }
    return {
      W40:r[2], W41:r[3], W42:r[4], W43:r[5],
      W44:r[6], W45:r[7], W46:r[8], W47:r[9],
      W48:r[10],W49:r[11],W50:r[12],W51:r[13],
      W52:r[14],W53:r[15],Q4:r[16],
      QTD:              r[18] || '',
      QTG:              r[19] || '',
      'QTD Attach Rate':r[20] || '',
      'QTD Average':    r[21] || ''
    };
  }

  var slide12 = {
    payroll: {
      'National':          getS12Row_(PAY_HDR + 1),
      'Major':             getS12Row_(PAY_HDR + 2),
      'Large':             getS12Row_(PAY_HDR + 3),
      'DTM':               getS12Row_(PAY_HDR + 4),
      'Actual/Sales Fcst': getS12Row_(PAY_HDR + 5)
    },
    attach: {
      'National':          getS12Row_(PAY_ATT_HDR + 1),
      'Major':             getS12Row_(PAY_ATT_HDR + 2),
      'Large':             getS12Row_(PAY_ATT_HDR + 3),
      'DTM':               getS12Row_(PAY_ATT_HDR + 4),
      'Actual/Sales Fcst': getS12Row_(PAY_ATT_HDR + 5)
    },
    gnsA: PAY_GNSA_HDR >= 0 ? {
      'National':    getS12Row_(PAY_GNSA_HDR + 1),
      'Major':       getS12Row_(PAY_GNSA_HDR + 2),
      'Large':       getS12Row_(PAY_GNSA_HDR + 3),
      'DTM':         getS12Row_(PAY_GNSA_HDR + 4),
      'Act vs Fcst': getS12Row_(PAY_GNSA_HDR + 5)
    } : null,
    itf: {
      'National': getS12Row_(PAY_ITF_HDR + 1),
      'Major':    getS12Row_(PAY_ITF_HDR + 2),
      'Large':    getS12Row_(PAY_ITF_HDR + 3),
      'DTM':      getS12Row_(PAY_ITF_HDR + 4),
      'Partner':  getS12Row_(PAY_ITF_HDR + 5)
    },
    itpy: {
      'National': getS12Row_(PAY_ITPY_HDR + 1),
      'Major':    getS12Row_(PAY_ITPY_HDR + 2),
      'Large':    getS12Row_(PAY_ITPY_HDR + 3),
      'DTM':      getS12Row_(PAY_ITPY_HDR + 4),
      'Partner':  getS12Row_(PAY_ITPY_HDR + 5)
    }
  };

  Logger.log('[slide12] payroll.National QTD=%s QTG=%s AttachRate=%s Avg=%s',
    slide12.payroll['National'].QTD, slide12.payroll['National'].QTG,
    slide12.payroll['National']['QTD Attach Rate'], slide12.payroll['National']['QTD Average']);
  Logger.log('[slide12] payroll.Total QTD=%s QTG=%s',
    slide12.payroll['Actual/Sales Fcst'].QTD, slide12.payroll['Actual/Sales Fcst'].QTG);
  Logger.log('[slide12] gnsA.National=%s', JSON.stringify(slide12.gnsA ? slide12.gnsA['National'] : 'NULL'));

  // ── SLIDE 13 ──────────────────────────────────────────────
  var CANCEL_HDR    = 297;
  var Q4CANCEL_HDR  = 308;

  function getS13Row_(rowIdx) {
    var r = allData[rowIdx];
    if (!r) { Logger.log('[slide13] getS13Row_(%s): MISSING', rowIdx); return {}; }
    return {
      W40:r[2], W41:r[3], W42:r[4], W43:r[5],
      W44:r[6], W45:r[7], W46:r[8], W47:r[9],
      W48:r[10],W49:r[11],W50:r[12],W51:r[13],
      W52:r[14],W53:r[15],Q4:r[16],
      QTD:          r[18] || '',
      QTG:          r[19] || '',
      'Weekly Average': r[20] || ''
    };
  }

  var slide13 = {
    cancelType: {
      'Active Cancel':   getS13Row_(CANCEL_HDR + 1),
      'Passive Cancel':  getS13Row_(CANCEL_HDR + 2),
      'Reactivation':    getS13Row_(CANCEL_HDR + 3),
      'Total Cancels':   getS13Row_(CANCEL_HDR + 4),
      'Forecast':        getS13Row_(CANCEL_HDR + 5)
    },
    cancelItf:  null,
    cancelItpy: null,
    q4Cancels: {
      'National':                 getS13Row_(Q4CANCEL_HDR + 1),
      'Major':                    getS13Row_(Q4CANCEL_HDR + 2),
      'Large':                    getS13Row_(Q4CANCEL_HDR + 3),
      'DTM':                      getS13Row_(Q4CANCEL_HDR + 4),
      'Growth':                   getS13Row_(Q4CANCEL_HDR + 5),
      'NBAM':                     getS13Row_(Q4CANCEL_HDR + 6),
      'Unmanaged':                getS13Row_(Q4CANCEL_HDR + 7),
      'Total Active Cancels':     getS13Row_(Q4CANCEL_HDR + 8),
      'Firms with Active Cancels':getS13Row_(Q4CANCEL_HDR + 9),
      'Average/Firm':             getS13Row_(Q4CANCEL_HDR + 10),
      'Count of Active 10+':      getS13Row_(Q4CANCEL_HDR + 11),
      'Count of Active 1s':       getS13Row_(Q4CANCEL_HDR + 12)
    }
  };

  for (var _ci = CANCEL_HDR + 1; _ci < Q4CANCEL_HDR; _ci++) {
    var _cl = String(allData[_ci] ? allData[_ci][1] : '').trim();
    if (_cl === 'ITF')  { slide13.cancelItf  = getS13Row_(_ci); Logger.log('[slide13] ITF at allData[%s]', _ci); }
    if (_cl === 'ITPY') { slide13.cancelItpy = getS13Row_(_ci); Logger.log('[slide13] ITPY at allData[%s]', _ci); }
  }

  Logger.log('[slide13] cancelType.Active Cancel W40=%s W41=%s Q4=%s QTD=%s',
    slide13.cancelType['Active Cancel'].W40, slide13.cancelType['Active Cancel'].W41,
    slide13.cancelType['Active Cancel'].Q4,  slide13.cancelType['Active Cancel'].QTD);
  Logger.log('[slide13] cancelItf=%s cancelItpy=%s',
    JSON.stringify(slide13.cancelItf), JSON.stringify(slide13.cancelItpy));

  // ── SLIDES 17/19/21/23 Team Visual data ───────────────────
  var VIS_OFFSETS = {
    gnsAct:  1, gnsTgt:  2, gnsItf:  3, gnsItpy:  4,
    advAct:  8, advTgt:  9, advItf: 10, advItpy: 11,
    upgAct: 15, upgTgt: 16, upgItf: 17, upgItpy: 18,
    payAct: 22, payTgt: 23, payItf: 24, payItpy: 25
  };

  var VIS_BASES = {
    national:  1,
    major:    31,
    large:    61,
    dtm:      91
  };

  // The team/EMM "This Week" & "QTD" columns should mirror exactly what the
  // sheet shows (e.g. "25%", "-"), not the raw stored value (0.25), so read
  // display values for these. Falls back to visData if the read fails.
  var visDisp = visData;
  try {
    visDisp = spreadsheet.getSheetByName(VISUALS_TAB_NAME).getDisplayValues();
  } catch (e) {
    Logger.log('[visDisp] display-values read failed, using raw: ' + e);
  }

  function getVisByIdx_(arrayIdx) {
    var r = visDisp[arrayIdx];
    if (!r) {
      Logger.log('[visIdx] arrayIdx %s MISSING', arrayIdx);
      return { tw:'', qtd:'' };
    }
    var tw  = r[19];
    var qtd = r[20];
    return {
      tw:  (tw  !== '' && tw  !== null && tw  !== undefined && tw  !== 'This Week') ? tw  : '',
      qtd: (qtd !== '' && qtd !== null && qtd !== undefined && qtd !== 'QTD')       ? qtd : ''
    };
  }

  function buildTeamDataByIdx_(base) {
    return {
      gns: {
        actual: getVisByIdx_(base + VIS_OFFSETS.gnsAct),
        target: getVisByIdx_(base + VIS_OFFSETS.gnsTgt),
        itf:    getVisByIdx_(base + VIS_OFFSETS.gnsItf),
        itpy:   getVisByIdx_(base + VIS_OFFSETS.gnsItpy)
      },
      adv: {
        actual: getVisByIdx_(base + VIS_OFFSETS.advAct),
        target: getVisByIdx_(base + VIS_OFFSETS.advTgt),
        itf:    getVisByIdx_(base + VIS_OFFSETS.advItf),
        itpy:   getVisByIdx_(base + VIS_OFFSETS.advItpy)
      },
      upg: {
        actual: getVisByIdx_(base + VIS_OFFSETS.upgAct),
        target: getVisByIdx_(base + VIS_OFFSETS.upgTgt),
        itf:    getVisByIdx_(base + VIS_OFFSETS.upgItf),
        itpy:   getVisByIdx_(base + VIS_OFFSETS.upgItpy)
      },
      pay: {
        actual: getVisByIdx_(base + VIS_OFFSETS.payAct),
        target: getVisByIdx_(base + VIS_OFFSETS.payTgt),
        itf:    getVisByIdx_(base + VIS_OFFSETS.payItf),
        itpy:   getVisByIdx_(base + VIS_OFFSETS.payItpy)
      }
    };
  }

  // ── SLIDE 16 (EMM Account Management) ─────────────────────
  // Three metric blocks — ADV Upgrade / Core Upgrades / Payroll — each with
  // Actual / Target / ITF, read from the "FY26Q4 Visuals" tab EMM AM section
  // (col T = This Week, col U = QTD) via getVisByIdx_.
  //
  // Values below are 0-based visData row indices (= sheet row - 1), confirmed
  // against the sheet:
  //   ADV Upgrade  Actual/Target/ITF = sheet rows 129/130/131 -> idx 128/129/130
  //   Core Upgrade Actual/Target/ITF = sheet rows 135/136/137 -> idx 134/135/136
  //   Payroll      Actual/Target/ITF = sheet rows 141/142/143 -> idx 140/141/142
  var EMM_VIS = {
    advUpgrade:  { actual: 128, target: 129, itf: 130 },
    coreUpgrade: { actual: 134, target: 135, itf: 136 },
    payroll:     { actual: 140, target: 141, itf: 142 }
  };
  function emmGrp_(g) {
    return {
      actual: getVisByIdx_(g.actual),
      target: getVisByIdx_(g.target),
      itf:    getVisByIdx_(g.itf)
    };
  }
  function nonEmptyGrp_(grp) {
    return grp && (grp.actual.tw !== '' || grp.actual.qtd !== '' ||
                   grp.target.tw !== '' || grp.target.qtd !== '' ||
                   grp.itf.tw    !== '' || grp.itf.qtd    !== '');
  }
  function buildEmmData_() {
    var adv  = emmGrp_(EMM_VIS.advUpgrade);
    var core = emmGrp_(EMM_VIS.coreUpgrade);
    var pay  = emmGrp_(EMM_VIS.payroll);
    Logger.log('[slide16] ADV Upgrade  act tw=%s qtd=%s | tgt tw=%s qtd=%s | itf tw=%s qtd=%s',
      adv.actual.tw, adv.actual.qtd, adv.target.tw, adv.target.qtd, adv.itf.tw, adv.itf.qtd);
    Logger.log('[slide16] Core Upgrade act tw=%s qtd=%s | tgt tw=%s qtd=%s | itf tw=%s qtd=%s',
      core.actual.tw, core.actual.qtd, core.target.tw, core.target.qtd, core.itf.tw, core.itf.qtd);
    Logger.log('[slide16] Payroll      act tw=%s qtd=%s | tgt tw=%s qtd=%s | itf tw=%s qtd=%s',
      pay.actual.tw, pay.actual.qtd, pay.target.tw, pay.target.qtd, pay.itf.tw, pay.itf.qtd);
    // Leave a table untouched (don't clobber) if its rows read empty.
    return {
      advUpgrade:  nonEmptyGrp_(adv)  ? adv  : null,
      coreUpgrade: nonEmptyGrp_(core) ? core : null,
      payroll:     nonEmptyGrp_(pay)  ? pay  : null
    };
  }

  Logger.log('[teamIdx] national GNS act tw=%s qtd=%s | major GNS act tw=%s qtd=%s',
    buildTeamDataByIdx_(VIS_BASES.national).gns.actual.tw,
    buildTeamDataByIdx_(VIS_BASES.national).gns.actual.qtd,
    buildTeamDataByIdx_(VIS_BASES.major).gns.actual.tw,
    buildTeamDataByIdx_(VIS_BASES.major).gns.actual.qtd);

  Logger.log('[visCols] visData total rows: %s', visData.length);

  return {
    meta: { week: CURRENT_WEEK, weekNum: CURRENT_WEEK_NUM, quarter: qi.quarter },
    slide4,
    slide5,
    slide6,
    slide8,
    slide9,
    slide10,
    slide11,
    slide12,
    slide13,
    slide16: buildEmmData_(),
    slide17: buildTeamDataByIdx_(VIS_BASES.major),
    slide19: buildTeamDataByIdx_(VIS_BASES.national),
    slide21: buildTeamDataByIdx_(VIS_BASES.large),
    slide23: buildTeamDataByIdx_(VIS_BASES.dtm),
  };
}

// ============================================================
//  AI COMMENTARY
// ============================================================

// Read the pre-generated weekly summary that fetch_data.py landed in
// Pipeline_Meta!B1. Returns the trimmed string, or '' if the cell is empty /
// unreadable so the caller can fall back. This is the PREFERRED source: the
// pipeline runs on the Intuit network where it can authenticate to GenOS, so
// B1 already contains a real AI summary by the time the deck runs.
function readPipelineAISummary_() {
  try {
    var ss  = SpreadsheetApp.openById(RAW_DATA_SPREADSHEET_ID);
    var val = ss.getRange(AI_SUMMARY_RANGE).getValue();
    var txt = (val == null) ? '' : String(val).trim();
    if (txt) {
      Logger.log('[aiSummary] using pipeline summary from ' + AI_SUMMARY_RANGE +
                 ' (' + txt.length + ' chars)');
    } else {
      Logger.log('[aiSummary] ' + AI_SUMMARY_RANGE + ' empty — will try live GenOS / template');
    }
    return txt;
  } catch (e) {
    Logger.log('[aiSummary] could not read ' + AI_SUMMARY_RANGE + ': ' + e);
    return '';
  }
}

function generateAICommentary_(data) {
  // 1) PREFERRED: the summary the pipeline already generated on-network and
  //    wrote to Pipeline_Meta!B1. No GenOS call from Apps Script needed.
  var pipelineSummary = readPipelineAISummary_();
  if (pipelineSummary) {
    return pipelineSummary;
  }

  // 2) FALLBACK: try a live GenOS call from Apps Script (usually 403s off-network,
  //    kept for when the deck is run manually from inside the Intuit network).
  if (!GENOS_ENABLED || GENOS_EXPERIENCE_ID === 'PASTE_YOUR_EXPERIENCE_ID_HERE') {
    return buildTemplateTLDR_(data);
  }

  var s = data.slide4;

  var prompt =
    'Write a weekly business results summary for a sales leadership meeting. Professional, direct. ' +
    'Use only the numbers from the data below. Do not invent numbers. Identify bright spots and hot spots based on performance vs forecast, ITF, ITPY, QTD, and mix.\n\n' +

    'WEEK ' + CURRENT_WEEK + ':\n' +
    ['National', 'Major', 'Large', 'DTM'].map(function(t) {
      var k = t.toLowerCase();
      return '- ' + t +
        ': Actual=' + s[k].actual +
        ' Fcst=' + s[k].forecast +
        ' Var=' + s[k].variance +
        ' ITF=' + s[k].itf_w +
        ' ITPY=' + s[k].itpy_w;
    }).join('\n') + '\n' +

    '- Total: Actual=' + s.total.actual +
    ' Fcst=' + s.total.forecast +
    ' Var=' + s.total.variance +
    ' ITF=' + s.total.itf_w +
    ' ITPY=' + s.total.itpy_w + '\n' +

    '- ADV=' + s.advGNS.actual +
    ' Mix=' + s.advMix.actual +
    ' HVAM Upgr=' + s.hvamUpgr.actual +
    ' Payroll=' + s.payroll.actual + '\n\n' +

    'QTD:\n' +
    '- Total=' + s.total.actual_q +
    ' ITF=' + s.total.itf_q +
    ' ADV=' + s.advGNS.actual_q + '\n\n' +

    'Format exactly:\n' +
    'TLDR:\n' +
    '• [3 bullets]\n\n' +
    'Bright Spots:\n' +
    '• [2 bullets]\n\n' +
    'Hot Spots:\n' +
    '• [1-2 bullets]';

  try {
    var payload = {
      messages: [
        {
          role: 'system',
          content: 'You are a sales operations analyst creating concise executive commentary for internal sales leadership decks.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.25,
      max_tokens: 600
    };

    var resp = UrlFetchApp.fetch(GENOS_E2E_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: {
        'Authorization': 'Intuit_IAM_Authentication',
        'intuit_originating_assetalias': GENOS_ASSET_ALIAS,
        'intuit_experience_id': GENOS_EXPERIENCE_ID
      },
      payload: JSON.stringify(payload)
    });

    var code = resp.getResponseCode();
    var text = resp.getContentText();

    if (code !== 200) {
      Logger.log('GenOS request failed. Code: ' + code + ' Body: ' + text);
      return buildTemplateTLDR_(data);
    }

    var json = JSON.parse(text);

    if (json.choices && json.choices.length > 0) {
      if (json.choices[0].message && json.choices[0].message.content) {
        return json.choices[0].message.content;
      }
      if (json.choices[0].text) {
        return json.choices[0].text;
      }
    }

    Logger.log('Unexpected GenOS response: ' + text);
    return buildTemplateTLDR_(data);

  } catch (e) {
    Logger.log('GenOS exception: ' + e);
    return buildTemplateTLDR_(data);
  }
}

// ============================================================
//  SLIDE UPDATERS
// ============================================================

function safeUpdate_(name, fn) {
  try { fn(); Logger.log('✓ ' + name); }
  catch(e) { Logger.log('✗ ' + name + ': ' + e.message); }
}

function updateAllSlides_(presentationId, data, aiText) {
  var pres = SlidesApp.openById(presentationId);
  safeUpdate_('Title',    function(){ updateTitleSlide_(pres, data.meta); });
  safeUpdate_('Slide 2',  function(){ updateAgendaSlide_(pres, data.meta); });
  safeUpdate_('Slide 4',  function(){ updateSlide4_(pres, data.slide4, aiText, data.meta); });
  safeUpdate_('Slide 5',  function(){ updateSlide5_(pres, data.slide5); });
  safeUpdate_('Slide 6',  function(){ updateSlide6_(pres, data); });
  safeUpdate_('Slide 8',  function(){ updateSlide8_(pres, data); });
  safeUpdate_('Slide 9',  function(){ updateSlide9_(pres, data); });
  safeUpdate_('Slide 10', function(){ updateSlide10_(pres, data); });
  safeUpdate_('Slide 11', function(){ updateSlide11_(pres, data); });
  safeUpdate_('Slide 12', function(){ updateSlide12_(pres, data); });
  safeUpdate_('Slide 13', function(){ updateSlide13_(pres, data); });
  safeUpdate_('EMM Account Mgmt', function(){ updateSlide16_(pres, data); });
  safeUpdate_('Major Firms',    function(){ updateSlide17_(pres, data); });
  safeUpdate_('National Firms', function(){ updateSlide19_(pres, data); });
  safeUpdate_('Large Firms',    function(){ updateSlide21_(pres, data); });
  safeUpdate_('DTM Firms',      function(){ updateSlide23_(pres, data); });
}

function updateTitleSlide_(pres, meta) {
  var slide = pres.getSlides()[0];
  slide.getShapes().forEach(function(s) {
    try {
      var txt = s.getText().asString();
      if (/Week\s+\d+/i.test(txt))
        s.getText().setText(txt.replace(/Week\s+\d+/gi, 'Week ' + meta.weekNum));
    } catch(e) {}
  });
}

function updateAgendaSlide_(pres, meta) {
  var slide = pres.getSlides()[1];
  if (!slide) return;

  // 1) Refresh the "Week N" label (shapes + any week text inside tables).
  slide.getShapes().forEach(function(s) {
    try {
      var txt = s.getText().asString();
      if (/Week\s+\d+/i.test(txt))
        s.getText().setText(txt.replace(/Week\s+\d+/gi, 'Week ' + meta.weekNum));
    } catch(e) {}
  });
  slide.getTables().forEach(function(t) {
    for (var r = 0; r < t.getNumRows(); r++) {
      for (var c = 0; c < t.getNumColumns(); c++) {
        try {
          var cell = t.getCell(r, c);
          var ct = cell.getText().asString();
          if (/Week\s+\d+/i.test(ct))
            cell.getText().replaceAllText(ct.match(/Week\s+\d+/i)[0], 'Week ' + meta.weekNum);
        } catch(e) {}
      }
    }
  });

  // 2) Populate the agenda table from the agenda spreadsheet.
  var agendaData = readAgendaDataForMainDeck_(meta.weekNum);
  if (!agendaData) {
    Logger.log('[agenda] no data for week %s — table left unchanged', meta.weekNum);
    return;
  }
  var tables = slide.getTables();
  if (!tables.length) { Logger.log('[agenda] slide 2 has no table'); return; }
  updateAgendaTable_(tables[0], agendaData);
  Logger.log('[agenda] slide 2 populated with %s rows', agendaData.length);
}

// Reads agenda rows for the main deck: prefers a "week N" tab, then the
// gid tab, then the first sheet.
function readAgendaDataForMainDeck_(weekNumber) {
  try {
    var ss    = SpreadsheetApp.openById(AGENDA_SPREADSHEET_ID);
    var sheet = getAgendaSheetForWeek_(ss, weekNumber);
    if (!sheet) {
      sheet = ss.getSheets().filter(function (s) {
        return s.getSheetId() === AGENDA_SHEET_GID;
      })[0] || ss.getSheets()[0];
      Logger.log('[agenda] no "week %s" tab — using "%s"',
        weekNumber, sheet ? sheet.getName() : 'NONE');
    }
    return sheet ? sheet.getRange(AGENDA_DATA_RANGE).getValues() : null;
  } catch (e) {
    Logger.log('readAgendaDataForMainDeck_ error: ' + e);
    return null;
  }
}

// ============================================================
//  SLIDE 4
// ============================================================

function updateSlide4_(pres, s, aiText, meta) {
  var slide = getSlideByTitle_(pres, 'CAN HV/EMM AM Sales - Input Metrics');
  if (!slide) { Logger.log('Slide 4 not found'); return; }
  replaceWeekLabel_(slide, meta.weekNum);

  slide.getShapes().forEach(function(shape) {
    try {
      var txt = shape.getText().asString();
      if (txt.indexOf('High Value Accountant') >= 0 || txt.indexOf('TLDR') >= 0)
        shape.getText().setText('High Value Accountant\n' + aiText);
    } catch(e) {}
  });

  var tables = slide.getTables();
  if (!tables.length) { Logger.log('Slide 4: no tables'); return; }
  var t = tables[0];

  var TR = function(lbl) { return findTableRowByLabel_(t, lbl); };
  var rNat  = TR('National');
  var rMaj  = TR('Major');
  var rLrg  = TR('Large');
  var rDtm  = TR('DTM');
  var rTot  = TR('Total Account Mgt');
  var rAdv  = TR('Advanced GNS');
  var rMix  = TR('ADV Mix');
  var rHvam = TR('HVAM ADV Upgrades');
  var rEmm  = TR('EMM ADV Upgrades');
  var rPay  = TR('Payroll GNS');
  var rPipe = TR('Pipeline (TOTAL');
  var rAPip = TR('ADV pipeline');
  var rConv = TR('Pipeline Conversion');
  var rFace = TR('Average Client Face');
  var rNA   = TR('Net Attrition');

  Logger.log('Slide4 row indices — Nat:'+rNat+' Maj:'+rMaj+' Lrg:'+rLrg+' Dtm:'+rDtm+
             ' Tot:'+rTot+' Adv:'+rAdv+' Mix:'+rMix+' Hvam:'+rHvam+' Emm:'+rEmm+
             ' Pay:'+rPay+' Pipe:'+rPipe+' APip:'+rAPip+' Conv:'+rConv+
             ' Face:'+rFace+' NA:'+rNA);

  var WA = 1, WF = 2, WV = 3, WI = 4, WP = 5;
  var QA = 7, QF = 8, QV = 9, QI = 10, QP = 11;

  Logger.log('Slide4 cols — WA:'+WA+' WF:'+WF+' WV:'+WV+' WI:'+WI+' WP:'+WP+
             ' | QA:'+QA+' QF:'+QF+' QV:'+QV+' QI:'+QI+' QP:'+QP);

  function wr(r, obj) {
    if (r < 0 || !obj) return;
    setCell_(t,r,WA,obj.actual);    setCell_(t,r,WF,obj.forecast);
    setCell_(t,r,WV,obj.variance);  setCell_(t,r,WI,obj.itf_w);  setCell_(t,r,WP,obj.itpy_w);
    setCell_(t,r,QA,obj.actual_q);  setCell_(t,r,QF,obj.forecast_q);
    setCell_(t,r,QV,obj.variance_q);setCell_(t,r,QI,obj.itf_q);  setCell_(t,r,QP,obj.itpy_q);
  }

  wr(rNat,  s.national);
  wr(rMaj,  s.major);
  wr(rLrg,  s.large);
  wr(rDtm,  s.dtm);
  wr(rTot,  s.total);
  wr(rAdv,  s.advGNS);
  wr(rMix,  s.advMix);
  wr(rHvam, s.hvamUpgr);
  wr(rEmm,  s.emmUpgr);
  wr(rPay,  s.payroll);
  wr(rPipe, s.pipeline);
  wr(rAPip, s.advPipeline);
  wr(rConv, s.pipeConv);
  wr(rFace, s.avgFace);
  wr(rNA,   s.netAttrition);

  applySlide4Colours_(slide);
}

// ============================================================
//  SLIDE 5
// ============================================================

function updateSlide5_(pres, data) {
  // BMW slide is removed by restructureDeck(); if it's gone, do nothing rather
  // than fall through to an index that now points at Phased Forecast.
  var slide = getSlideByTitle_(pres, 'CAN HV/EMM AM Sales - BMW');
  if (!slide || !data) return;
  var tables = slide.getTables();
  if (!tables.length) return;
  var bmwTables = [], qtdQtgTables = [];
  tables.forEach(function(t) {
    try {
      var h00 = t.getCell(0,0).getText().asString().trim().toLowerCase();
      var h01 = t.getCell(0,1).getText().asString().trim().toLowerCase();
      var combined = h00 + ' ' + h01;
      if (combined.indexOf('team') >= 0 || combined.indexOf('total gns') >= 0 || h00 === 'team')
        bmwTables.push(t);
      else if (combined.indexOf('qtd') >= 0 || combined.indexOf('qtg') >= 0)
        qtdQtgTables.push(t);
    } catch(e) {}
  });
  if (bmwTables[0]) {
    data.gns.forEach(function(row, i) {
      setCell_(bmwTables[0],i+2,3,row[0]); setCell_(bmwTables[0],i+2,4,row[1]);
      setCell_(bmwTables[0],i+2,5,row[2]); setCell_(bmwTables[0],i+2,6,row[3]);
    });
  }
  if (bmwTables[1] && data.adv) {
    data.adv.forEach(function(row, i) {
      setCell_(bmwTables[1],i+2,3,row[0]); setCell_(bmwTables[1],i+2,4,row[1]);
      setCell_(bmwTables[1],i+2,5,row[2]); setCell_(bmwTables[1],i+2,6,row[3]);
    });
  }
  qtdQtgTables.forEach(function(t) {
    for (var i = 0; i < 5 && i < data.qtd.length; i++) {
      setCell_(t, i+1, 0, data.qtd[i]);
      setCell_(t, i+1, 1, data.qtg[i]);
    }
  });
  var remainingTables = tables.filter(function(t) {
    return bmwTables.indexOf(t) < 0 && qtdQtgTables.indexOf(t) < 0;
  });
  remainingTables.forEach(function(t) {
    data.deltas.forEach(function(row, i) {
      setCell_(t, i+1, 0, row[0]);
      setCell_(t, i+1, 1, row[1]);
    });
  });

  applySlide5Colours_(slide);
}

// ============================================================
//  SLIDE 6
// ============================================================

function updateSlide6_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'Phased Forecast') || pres.getSlides()[5];
  if (!slide || !rootData.slide6) return;
  var d = rootData.slide6;

  var tables = slide.getTables();
  if (!tables.length) { Logger.log('Slide 6: no tables found'); return; }

  var t = null;
  for (var i = 0; i < tables.length; i++) {
    try {
      var c0 = tables[i].getCell(0,0).getText().asString().trim();
      var c1 = tables[i].getCell(0,1).getText().asString().trim();
      if (c0.indexOf('FY26') >= 0 || c0.indexOf('GNS') >= 0 || c1.indexOf('W40') >= 0) {
        t = tables[i];
        Logger.log('Slide 6: matched GNS table at index ' + i);
        break;
      }
    } catch(e) {}
  }
  if (!t) {
    var sorted = tables.slice().sort(function(a,b){ return b.getNumColumns()-a.getNumColumns(); });
    t = sorted[0];
    Logger.log('Slide 6: fell back to widest table');
  }

  var colIndex = {};
  var numCols = t.getNumColumns();
  for (var c = 0; c < numCols; c++) {
    try {
      var cell = t.getCell(1, c).getText().asString().trim();
      if (cell) colIndex[wkNorm_(cell)] = c;
    } catch(e) {}
  }
  Logger.log('Slide 6 colIndex: ' + JSON.stringify(colIndex));

  var SECTION_ROW_LABELS = {
    gns:      ['National','Major','Large','DTM','Act/Fcst'],
    variance: ['National','Major','Large','DTM','Act vs Fcst'],
    itf:      ['National','Major','Large','DTM','ITF'],
    itpy:     ['National','Major','Large','DTM','ITPY'],
  };

  var SECTION_DATA_START = {
    gns:      2,
    variance: 9,
    itf:      16,
    itpy:     23,
  };

  function resolveCol(wkLabel) {
    var sl = wkNorm_(wkLabel);
    if (colIndex[sl] !== undefined) return colIndex[sl];
    var weekMatch = sl.match(/^w(\d+)/);
    if (weekMatch) {
      for (var key in colIndex) {
        if (key.indexOf('w' + weekMatch[1]) === 0) return colIndex[key];
      }
    }
    for (var key in colIndex) {
      if (key.indexOf(sl) >= 0 || sl.indexOf(key) >= 0) return colIndex[key];
    }
    return -1;
  }

  var sections = [
    { key:'gns',      data: d.gns      },
    { key:'variance', data: d.variance  },
    { key:'itf',      data: d.itf       },
    { key:'itpy',     data: d.itpy      },
  ];

  sections.forEach(function(sec) {
    if (!sec.data) { Logger.log('Slide 6: no extracted data for "' + sec.key + '"'); return; }
    var startRow  = SECTION_DATA_START[sec.key];
    var rowLabels = SECTION_ROW_LABELS[sec.key];
    rowLabels.forEach(function(label, gr) {
      var rowData = sec.data[label];
      if (!rowData) { Logger.log('Slide 6 [' + sec.key + ']: missing row "' + label + '"'); return; }
      Object.keys(rowData).forEach(function(wkLabel) {
        var colIdx = resolveCol(wkLabel);
        if (colIdx >= 0) setCell_(t, startRow + gr, colIdx, rowData[wkLabel]);
      });
    });
    Logger.log('Slide 6 [' + sec.key + ']: wrote ' + rowLabels.length + ' rows');
  });

  slide.getTables().forEach(function(tbl) { applyItfColours_(tbl); });
  moveHighlightBox_(slide);
}

// ============================================================
//  SLIDE 8
// ============================================================

function updateSlide8_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'Offer Tracking') || pres.getSlides()[7];
  if (!slide || !rootData.slide8) return;
  var d = rootData.slide8;
  var ql = (rootData.meta && rootData.meta.quarter) || 'Q1';

  var tables = slide.getTables();
  Logger.log('Slide 8: total tables = ' + tables.length);
  tables.forEach(function(tbl, i) {
    var c0r0 = '', c0r1 = '';
    try { c0r0 = tbl.getCell(0,0).getText().asString().trim(); } catch(e) {}
    try { c0r1 = tbl.getCell(1,0).getText().asString().trim(); } catch(e) {}
    Logger.log('Table[' + i + '] top=' + Math.round(tbl.getTop()) +
               ' left=' + Math.round(tbl.getLeft()) +
               ' rows=' + tbl.getNumRows() + ' cols=' + tbl.getNumColumns() +
               ' [0,0]=' + c0r0 + ' [1,0]=' + c0r1);
  });

  var mainTable   = null;
  var nonNamTable = null;

  tables.forEach(function(tbl) {
    for (var c = 0; c < Math.min(tbl.getNumColumns(), 4); c++) {
      try {
        var h = tbl.getCell(0, c).getText().asString().trim();
        if (h === 'Non-NAM') { nonNamTable = tbl; return; }
      } catch(e) {}
    }
    outer:
    for (var r = 0; r < Math.min(3, tbl.getNumRows()); r++) {
      for (var c = 0; c < Math.min(tbl.getNumColumns(), 6); c++) {
        try {
          var txt = tbl.getCell(r, c).getText().asString().trim();
          if (txt.indexOf(FY_LABEL + ' ' + ql + ' PKG') >= 0) { mainTable = tbl; break outer; }
        } catch(e) {}
      }
    }
  });

  Logger.log('Slide 8: mainTable=' + (mainTable ? 'found rows=' + mainTable.getNumRows() : 'NOT FOUND') +
             ' nonNamTable=' + (nonNamTable ? 'found' : 'not found'));

  if (!mainTable) {
    Logger.log('Slide 8: no main table found, cannot write data');
    return;
  }

  var slideColMap = {};
  var numCols = mainTable.getNumColumns();
  for (var r = 0; r < Math.min(3, mainTable.getNumRows()); r++) {
    for (var c = 0; c < numCols; c++) {
      try {
        var cell = wkNorm_(mainTable.getCell(r, c).getText().asString().trim());
        if (cell && !slideColMap[cell]) slideColMap[cell] = c;
      } catch(e) {}
    }
  }
  Logger.log('Slide 8 colMap keys: ' + JSON.stringify(Object.keys(slideColMap)));

  function resolveSlideCol_(lbl) {
    var sl = wkNorm_(lbl);
    if (slideColMap[sl] !== undefined) return slideColMap[sl];
    var wm = sl.match(/^w(\d+)/);
    if (wm) {
      for (var key in slideColMap) {
        if (key.indexOf('w' + wm[1]) === 0) return slideColMap[key];
      }
    }
    return -1;
  }

  function findSectionRow_(keyword) {
    var kl = keyword.replace(/\s+/g,'').toLowerCase();
    for (var r = 0; r < mainTable.getNumRows(); r++) {
      for (var c = 0; c < Math.min(numCols, 6); c++) {
        try {
          var txt = mainTable.getCell(r, c).getText().asString()
                      .replace(/\s+/g,'').toLowerCase();
          if (txt.indexOf(kl) >= 0) {
            Logger.log('Slide 8: found "' + keyword + '" at table row ' + r + ' col ' + c);
            return r;
          }
        } catch(e) {}
      }
    }
    Logger.log('Slide 8: "' + keyword + '" NOT FOUND in main table');
    return -1;
  }

  function writeSectionToMainTable_(sectionHeaderRow, extractObj) {
    if (sectionHeaderRow < 0 || !extractObj || !extractObj.labels || !extractObj.data) return;

    var dataLabels = extractObj.labels;
    var colIndices = dataLabels.map(function(lbl) { return resolveSlideCol_(lbl); });
    Logger.log('Slide 8 section@row' + sectionHeaderRow +
               ' colIndices: ' + JSON.stringify(colIndices) +
               ' for labels: ' + JSON.stringify(dataLabels));

    var writeRow = sectionHeaderRow + 1;
    extractObj.data.forEach(function(rowObj) {
      if (writeRow >= mainTable.getNumRows()) return;
      var vals = rowObj.values || rowObj;
      vals.forEach(function(val, gi) {
        var ci = colIndices[gi];
        if (ci >= 0) setCell_(mainTable, writeRow, ci, val);
      });
      writeRow++;
    });
    Logger.log('Slide 8: wrote ' + extractObj.data.length + ' rows starting at ' + (sectionHeaderRow + 1));
  }

  var q4HdrRow  = findSectionRow_(FY_LABEL + ' ' + ql + ' PKG Actuals');
  var q3HdrRow  = findSectionRow_(PREV_FY_LABEL + ' ' + PREV_QUARTER + ' PKG Actuals');

  var wsbDataRow = findSectionRow_(FY_LABEL + ' WSB');
  var wsbHdrRow  = wsbDataRow >= 1 ? wsbDataRow - 1 : wsbDataRow;

  Logger.log("Slide 8 section rows: q4=" + q4HdrRow + " wsb=" + wsbHdrRow + " q3=" + q3HdrRow);

  writeSectionToMainTable_(q4HdrRow,  d.q4PkgActuals);
  writeSectionToMainTable_(wsbHdrRow, d.wsb);
  writeSectionToMainTable_(q3HdrRow,  d.q3PkgActuals);

  if (nonNamTable && d.nonNam && d.nonNam.length > 0) {
    var nnCols = { label:-1, units:-1, promoMix:-1, mixGns:-1 };
    for (var c = 0; c < nonNamTable.getNumColumns(); c++) {
      try {
        var h = nonNamTable.getCell(0, c).getText().asString().trim().toLowerCase()
                  .replace(/\s+/g,'');
        if (h === 'non-nam' || h === 'non–nam')    nnCols.label    = c;
        else if (h === 'units')                     nnCols.units    = c;
        else if (h.indexOf('promo') >= 0)           nnCols.promoMix = c;
        else if (h.indexOf('mix') >= 0)             nnCols.mixGns   = c;
      } catch(e) {}
    }
    Logger.log('NonNAM table cols: ' + JSON.stringify(nnCols));

    d.nonNam.forEach(function(item, i) {
      var tableRow = i + 1;
      if (tableRow >= nonNamTable.getNumRows()) return;
      if (nnCols.label    >= 0) setCell_(nonNamTable, tableRow, nnCols.label,    item.label);
      if (nnCols.units    >= 0) setCell_(nonNamTable, tableRow, nnCols.units,    item.units);
      if (nnCols.promoMix >= 0) setCell_(nonNamTable, tableRow, nnCols.promoMix, item.promoMix);
      if (nnCols.mixGns   >= 0) setCell_(nonNamTable, tableRow, nnCols.mixGns,   item.mixGns);
    });
    Logger.log('NonNAM table: wrote ' + d.nonNam.length + ' rows');
  }

  slide.getTables().forEach(function(tbl) { applyItfColours_(tbl); });
  applyWeekTextColours_(slide);
  moveHighlightBox_(slide);
}

// ============================================================
//  SLIDE 9
// ============================================================

function updateSlide9_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'Team Offer Tracking') || pres.getSlides()[8];
  if (!slide || !rootData.slide9) return;

  var d = rootData.slide9;
  var tables = slide.getTables();
  var mainTable = null;
  for (var t = 0; t < tables.length; t++) {
    if (tables[t].getCell(0,0).getText().asString().trim() === PREV_FY_LABEL + ' ' + PREV_QUARTER + ' Package GNS') {
      mainTable = tables[t];
      break;
    }
  }
  if (!mainTable) { Logger.log('[slide9] ERROR: main table not found'); return; }

  var COL = {
    W40:1, W41:2, W42:3, W43:4, W44:5, W45:6,
    W46:7, W47:8, W48:9, W49:10, W50:11, W51:12,
    W52:13, W53:14, Q4:15, QTD:17, qtdPkg:18, qtdAvg:19
  };

  function writeRow_(tableRow, rowData) {
    if (!rowData) return;
    Object.keys(COL).forEach(function(key) {
      var colIdx = COL[key];
      var val = rowData[key];
      if (val === undefined || val === null) return;
      try { tableRow.getCell(colIdx).getText().setText(String(val)); } catch(e) {}
    });
  }

  writeRow_(mainTable.getRow(1), d.pkgGns.namBdo);
  writeRow_(mainTable.getRow(2), d.pkgGns.national);
  writeRow_(mainTable.getRow(3), d.pkgGns.major);
  writeRow_(mainTable.getRow(4), d.pkgGns.large);
  writeRow_(mainTable.getRow(5), d.pkgGns.dtm);
  writeRow_(mainTable.getRow(6), d.pkgGns.accountant);
  writeRow_(mainTable.getRow(9),  d.pkgPercent.national);
  writeRow_(mainTable.getRow(10), d.pkgPercent.major);
  writeRow_(mainTable.getRow(11), d.pkgPercent.large);
  writeRow_(mainTable.getRow(12), d.pkgPercent.dtm);
  writeRow_(mainTable.getRow(13), d.pkgPercent.accountant);

  Logger.log('[slide9] wrote GNS rows 1-6 and %% rows 9-13 directly');
  tables.forEach(function(tbl, i) {
    Logger.log('[slide9] table[%s] firstCell="%s" rows=%s cols=%s',
      i, tbl.getCell(0,0).getText().asString().trim(), tbl.getNumRows(), tbl.getNumColumns());
  });
  moveHighlightBox_(slide);
}

// ============================================================
//  SLIDE 10
// ============================================================

function updateSlide10_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'ADV Tracking - GNS') || pres.getSlides()[9];
  if (!slide || !rootData.slide10) return;

  var d = rootData.slide10;
  var ql = (rootData.meta && rootData.meta.quarter) || 'Q1';
  var tables = slide.getTables();

  var t0 = null, t1 = null, t2 = null, t3 = null;
  tables.forEach(function(t) {
    var fc = t.getCell(0,0).getText().asString().trim();
    if (fc === FY_LABEL + ' ' + ql + ' ADV')  t0 = t;
    else if (fc === 'ADV GNS \u25b2')         t1 = t;
    else if (fc === 'ADV ITF')                t2 = t;
    else if (fc === 'Account Based ADV ITPY') t3 = t;
  });

  var C = {
    W40:1,W41:2,W42:3,W43:4,W44:5,W45:6,W46:7,W47:8,
    W48:9,W49:10,W50:11,W51:12,W52:13,W53:14,
    Q4:15, QTD:17, QTG:18, qtdContrib:19, qtdAvg:20
  };

  function writeRow_(table, rowIdx, data) {
    if (!table || !data) return;
    var numCols = table.getNumColumns();
    Object.keys(C).forEach(function(key) {
      var colIdx = C[key];
      if (colIdx >= numCols) return;
      var val = data[key];
      if (val === undefined || val === null || val === '') return;
      try { table.getCell(rowIdx, colIdx).getText().setText(String(val)); } catch(e) {}
    });
  }

  if (t0) {
    writeRow_(t0, 1,  d.gnsActuals['National']);
    writeRow_(t0, 2,  d.gnsActuals['Major']);
    writeRow_(t0, 3,  d.gnsActuals['Large']);
    writeRow_(t0, 4,  d.gnsActuals['DTM']);
    writeRow_(t0, 5,  d.gnsActuals['Total ADV GNS']);
    writeRow_(t0, 6,  d.advMix['National Mix']);
    writeRow_(t0, 7,  d.advMix['Major Mix']);
    writeRow_(t0, 8,  d.advMix['Large Mix']);
    writeRow_(t0, 9,  d.advMix['DTM Mix']);
    writeRow_(t0, 10, d.advMix['ADV GNS Mix (non-BDO)']);
    writeRow_(t0, 11, d.advMix['ADV Mix Target']);
    writeRow_(t0, 12, d.advMix['Mix ITF']);
  }
  if (t1) {
    writeRow_(t1, 1, d.variance['National']);
    writeRow_(t1, 2, d.variance['Major']);
    writeRow_(t1, 3, d.variance['Large']);
    writeRow_(t1, 4, d.variance['DTM']);
    writeRow_(t1, 5, d.variance['Act vs Fcst']);
  }
  if (t2) {
    writeRow_(t2, 1, d.advItf['National']);
    writeRow_(t2, 2, d.advItf['Major']);
    writeRow_(t2, 3, d.advItf['Large']);
    writeRow_(t2, 4, d.advItf['DTM']);
    writeRow_(t2, 5, d.advItf['ADV ITF']);
  }
  if (t3) {
    writeRow_(t3, 1, d.advItpy['National']);
    writeRow_(t3, 2, d.advItpy['Major']);
    writeRow_(t3, 3, d.advItpy['Large']);
    writeRow_(t3, 4, d.advItpy['DTM']);
    writeRow_(t3, 5, d.advItpy['ITPY']);
  }

  Logger.log('[slide10] wrote all 4 tables directly by row index');
  slide.getTables().forEach(function(tbl) { applyItfColours_(tbl); });
  applyWeekTextColours_(slide);
  moveHighlightBox_(slide);
}

// ============================================================
//  SLIDE 11
// ============================================================

function updateSlide11_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'ADV Tracking - Upgrades') || pres.getSlides()[10];
  if (!slide || !rootData.slide11) return;

  var d = rootData.slide11;
  var tables = slide.getTables();

  var tEvents = null, tItf = null, tItpy = null, tEmm = null;
  tables.forEach(function(t) {
    var fc = t.getCell(0,0).getText().asString().trim();
    if (fc === 'ADV Upgrade Events') tEvents = t;
    else if (fc === 'ADV Upgrades ITF')  tItf   = t;
    else if (fc === 'ADV Upgrades ITPY') tItpy  = t;
    else if (fc === 'EMM ADV Upgrades')  tEmm   = t;
  });

  var C11 = {
    W40:1,W41:2,W42:3,W43:4,W44:5,W45:6,W46:7,W47:8,
    W48:9,W49:10,W50:11,W51:12,W52:13,W53:14,
    Q4:15, QTD:17, QTG:18,
    'QTD ADV contrib':19, '4 wk avg':20, 'Q3 Avg':21,
    'ITPQ (4 Wk avg vs Q3 avg)':22
  };

  function writeS11Row_(table, rowIdx, data) {
    if (!table || !data || Object.keys(data).length === 0) return;
    var numCols = table.getNumColumns();
    Object.keys(C11).forEach(function(key) {
      var colIdx = C11[key];
      if (colIdx >= numCols) return;
      var val = data[key];
      if (val === undefined || val === null || val === '') return;
      try { table.getCell(rowIdx, colIdx).getText().setText(String(val)); } catch(e) {}
    });
  }

  if (tEvents) {
    writeS11Row_(tEvents, 1,  d.advEvents['National']);
    writeS11Row_(tEvents, 2,  d.advEvents['Major']);
    writeS11Row_(tEvents, 3,  d.advEvents['Large']);
    writeS11Row_(tEvents, 4,  d.advEvents['DTM']);
    writeS11Row_(tEvents, 5,  d.advEvents['Total Upgrades']);
    writeS11Row_(tEvents, 6,  d.advEvents['National GNS+Upgrade']);
    writeS11Row_(tEvents, 7,  d.advEvents['Major GNS+Upgrade']);
    writeS11Row_(tEvents, 8,  d.advEvents['Large GNS+Upgrade']);
    writeS11Row_(tEvents, 9,  d.advEvents['DTM GNS+Upgrade']);
    writeS11Row_(tEvents, 10, d.advEvents['Total GNS+Upgrades']);
  }
  if (tItf) {
    writeS11Row_(tItf, 1, d.advItf['National']);
    writeS11Row_(tItf, 2, d.advItf['Major']);
    writeS11Row_(tItf, 3, d.advItf['Large']);
    writeS11Row_(tItf, 4, d.advItf['DTM']);
    writeS11Row_(tItf, 5, d.advItf['ADV ITF']);
  }
  if (tItpy) {
    writeS11Row_(tItpy, 1, d.advItpy['National']);
    writeS11Row_(tItpy, 2, d.advItpy['Major']);
    writeS11Row_(tItpy, 3, d.advItpy['Large']);
    writeS11Row_(tItpy, 4, d.advItpy['DTM']);
    writeS11Row_(tItpy, 5, d.advItpy['ADV ITPY']);
  }
  if (tEmm) {
    writeS11Row_(tEmm, 1, d.emmUpgrades['ADV Upgrades']);
    writeS11Row_(tEmm, 2, d.emmUpgrades['EMM AM ITF']);
  }

  Logger.log('[slide11] wrote all 4 tables directly');
  slide.getTables().forEach(function(tbl) { applyItfColours_(tbl); });
  applyWeekTextColours_(slide);
  moveHighlightBox_(slide);
}

// ============================================================
//  SLIDE 12
// ============================================================

function updateSlide12_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'Payroll Results') || pres.getSlides()[11];
  if (!slide || !rootData.slide12) return;

  var d = rootData.slide12;
  var tables = slide.getTables();

  var tPay = null, tQtd = null, tAttach = null, tGnsA = null, tItf = null, tItpy = null;
  tables.forEach(function(t) {
    var fc = t.getCell(0,0).getText().asString().trim();
    if (fc.indexOf('FY26') >= 0 && fc.indexOf('Payroll') >= 0) tPay    = t;
    else if (fc === 'QTD')                                      tQtd    = t;
    else if (fc === 'Payroll Attach')                           tAttach = t;
    else if (fc.indexOf('Payroll GNS') >= 0)                   tGnsA   = t;
    else if (fc === 'Payroll ITF')                              tItf    = t;
    else if (fc === 'Payroll ITPY')                             tItpy   = t;
  });

  var C_PAY = {
    W40:1,W41:2,W42:3,W43:4,W44:5,W45:6,W46:7,W47:8,
    W48:9,W49:10,W50:11,W51:12,W52:13,W53:14, Q4:15
  };
  var C_ATT = {
    W40:1,W41:2,W42:3,W43:4,W44:5,W45:6,W46:7,W47:8,
    W48:9,W49:10,W50:11,W51:12,W52:13,W53:14, Q4:15, QTD:17
  };
  var C_GNSA = {
    W40:1,W41:2,W42:3,W43:4,W44:5,W45:6,W46:7,W47:8,
    W48:9,W49:10,W50:11,W51:12,W52:13,W53:14, Q4:15, QTD:17, QTG:18
  };

  function writeWithMap_(table, rowIdx, data, colMap) {
    if (!table || !data || Object.keys(data).length === 0) return;
    var numCols = table.getNumColumns();
    Object.keys(colMap).forEach(function(key) {
      var colIdx = colMap[key];
      if (colIdx >= numCols) return;
      var val = data[key];
      if (val === undefined || val === null || val === '') return;
      try { table.getCell(rowIdx, colIdx).getText().setText(String(val)); } catch(e) {}
    });
  }

  if (tPay) {
    writeWithMap_(tPay, 1, d.payroll['National'],         C_PAY);
    writeWithMap_(tPay, 2, d.payroll['Major'],            C_PAY);
    writeWithMap_(tPay, 3, d.payroll['Large'],            C_PAY);
    writeWithMap_(tPay, 4, d.payroll['DTM'],              C_PAY);
    writeWithMap_(tPay, 5, d.payroll['Actual/Sales Fcst'],C_PAY);
  }
  if (tQtd) {
    var qtdRows = ['National','Major','Large','DTM','Actual/Sales Fcst'];
    qtdRows.forEach(function(lbl, i) {
      var row = d.payroll[lbl];
      if (!row) return;
      var ri = i + 1;
      try { if (row.QTD)               tQtd.getCell(ri,0).getText().setText(String(row.QTD)); } catch(e){}
      try { if (row.QTG)               tQtd.getCell(ri,1).getText().setText(String(row.QTG)); } catch(e){}
      try { if (row['QTD Attach Rate'])tQtd.getCell(ri,2).getText().setText(String(row['QTD Attach Rate'])); } catch(e){}
      try { if (row['QTD Average'])    tQtd.getCell(ri,3).getText().setText(String(row['QTD Average'])); } catch(e){}
    });
  }
  if (tAttach) {
    writeWithMap_(tAttach, 1, d.attach['National'],         C_ATT);
    writeWithMap_(tAttach, 2, d.attach['Major'],            C_ATT);
    writeWithMap_(tAttach, 3, d.attach['Large'],            C_ATT);
    writeWithMap_(tAttach, 4, d.attach['DTM'],              C_ATT);
    writeWithMap_(tAttach, 5, d.attach['Actual/Sales Fcst'],C_ATT);
  }
  if (tGnsA && d.gnsA) {
    writeWithMap_(tGnsA, 1, d.gnsA['National'],    C_GNSA);
    writeWithMap_(tGnsA, 2, d.gnsA['Major'],       C_GNSA);
    writeWithMap_(tGnsA, 3, d.gnsA['Large'],       C_GNSA);
    writeWithMap_(tGnsA, 4, d.gnsA['DTM'],         C_GNSA);
    writeWithMap_(tGnsA, 5, d.gnsA['Act vs Fcst'], C_GNSA);
  }
  if (tItf) {
    writeWithMap_(tItf, 1, d.itf['National'],C_ATT);
    writeWithMap_(tItf, 2, d.itf['Major'],   C_ATT);
    writeWithMap_(tItf, 3, d.itf['Large'],   C_ATT);
    writeWithMap_(tItf, 4, d.itf['DTM'],     C_ATT);
    writeWithMap_(tItf, 5, d.itf['Partner'], C_ATT);
  }
  if (tItpy) {
    writeWithMap_(tItpy, 1, d.itpy['National'],C_ATT);
    writeWithMap_(tItpy, 2, d.itpy['Major'],   C_ATT);
    writeWithMap_(tItpy, 3, d.itpy['Large'],   C_ATT);
    writeWithMap_(tItpy, 4, d.itpy['DTM'],     C_ATT);
    writeWithMap_(tItpy, 5, d.itpy['Partner'], C_ATT);
  }

  Logger.log('[slide12] wrote all 6 tables directly');
  slide.getTables().forEach(function(tbl) { applyItfColours_(tbl); });
  applyWeekTextColours_(slide);
  moveHighlightBox_(slide);
}

// ============================================================
//  SLIDE 13
// ============================================================

function updateSlide13_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'Cancels');
  if (!slide) {
    var slides = pres.getSlides();
    if (slides.length > 12) slide = slides[12];
  }
  if (!slide || !rootData.slide13) return;

  var d = rootData.slide13;
  var ql = (rootData.meta && rootData.meta.quarter) || 'Q1';
  var tables = slide.getTables();
  var _cancelType = FY_LABEL + ' Cancel Type';
  var _curActive  = FY_LABEL + ' ' + ql + ' Active';
  var _prevQ      = PREV_FY_LABEL + ' ' + PREV_QUARTER;

  var tCancel = null, tCancelItf = null, tQ4 = null, tQ3Avg = null;
  tables.forEach(function(t, i) {
    var fc = t.getCell(0,0).getText().asString().trim();
    Logger.log('[slide13] table[%s] firstCell="%s" rows=%s cols=%s', i, fc, t.getNumRows(), t.getNumColumns());
    if (fc === _cancelType && !tCancel)          tCancel    = t;
    else if (fc === _cancelType)                 tCancelItf = t;
    else if (fc.indexOf(_curActive) >= 0)        tQ4        = t;
    else if (fc.indexOf(_prevQ) >= 0)            tQ3Avg     = t;
  });

  var C13 = {
    W40:1,W41:2,W42:3,W43:4,W44:5,W45:6,W46:7,W47:8,
    W48:9,W49:10,W50:11,W51:12,W52:13,W53:14,
    Q4:15, QTD:17, QTG:18, 'Weekly Average':19
  };

  function writeS13Row_(table, rowIdx, data) {
    if (!table || !data || Object.keys(data).length === 0) return;
    var numCols = table.getNumColumns();
    Object.keys(C13).forEach(function(key) {
      var colIdx = C13[key];
      if (colIdx >= numCols) return;
      var val = data[key];
      if (val === undefined || val === null) return;
      try { table.getCell(rowIdx, colIdx).getText().setText(String(val)); } catch(e) {}
    });
  }

  if (tCancel) {
    writeS13Row_(tCancel, 1, d.cancelType['Active Cancel']);
    writeS13Row_(tCancel, 2, d.cancelType['Passive Cancel']);
    writeS13Row_(tCancel, 3, d.cancelType['Reactivation']);
    writeS13Row_(tCancel, 4, d.cancelType['Total Cancels']);
    writeS13Row_(tCancel, 5, d.cancelType['Forecast']);
  }
  if (tCancelItf) {
    writeS13Row_(tCancelItf, 1, d.cancelItf);
    writeS13Row_(tCancelItf, 2, d.cancelItpy);
    var numCols = tCancelItf.getNumColumns();
    [1, 2].forEach(function(r) {
      for (var c = 0; c < numCols; c++) {
        try {
          var txt = tCancelItf.getCell(r, c).getText().asString();
          if (txt.indexOf('#DIV') >= 0 || txt.indexOf('#REF') >= 0)
            tCancelItf.getCell(r, c).getText().setText('');
        } catch(e) {}
      }
    });
  }
  if (tQ3Avg) {
    for (var r = 0; r < tQ3Avg.getNumRows(); r++) {
      for (var c = 0; c < tQ3Avg.getNumColumns(); c++) {
        try {
          var txt = tQ3Avg.getCell(r, c).getText().asString();
          if (txt.indexOf('#') >= 0) tQ3Avg.getCell(r, c).getText().setText('');
        } catch(e) {}
      }
    }
  }

  var Q4_ROWS = [
    'National','Major','Large','DTM','Growth','NBAM','Unmanaged',
    'Total Active Cancels','Firms with Active Cancels','Average/Firm',
    'Count of Active 10+','Count of Active 1s'
  ];
  if (tQ4) {
    Q4_ROWS.forEach(function(lbl, i) {
      writeS13Row_(tQ4, i + 1, d.q4Cancels[lbl]);
    });
  }

  Logger.log('[slide13] wrote all tables directly');
  applySlide13Colours_(slide);
  moveHighlightBox_(slide);
}

// ============================================================
//  TEAM SLIDES (16/17/19/21/23)
// ============================================================

function refreshSlideCharts_(slide) {
  var charts = slide.getSheetsCharts();
  Logger.log('[charts] found %s SheetsCharts', charts.length);
  charts.forEach(function(chart, i) {
    try { chart.refresh(); Logger.log('[charts] refreshed chart[%s]', i); }
    catch(e) { Logger.log('[charts] chart[%s] refresh error: %s', i, e.toString()); }
  });
}

function writeMetricTable_(table, sectionData) {
  if (!table || !sectionData) return;
  var rows = [sectionData.actual, sectionData.target, sectionData.itf, sectionData.itpy];
  rows.forEach(function(d, i) {
    if (!d) return;
    var ri = i + 1;
    if (ri >= table.getNumRows()) return;

    function fmt(v) {
      if (v === null || v === undefined || v === '') return '';
      if (v === '-' || v === 'n/a') return String(v);
      if (typeof v === 'string' && v.indexOf('.') < 0) return v;
      var n = parseFloat(v);
      if (isNaN(n)) return String(v);
      return String(Math.round(n));
    }

    var tw  = fmt(d.tw);
    var qtd = fmt(d.qtd);
    try { table.getCell(ri, 1).getText().setText(tw  !== '' ? tw  : ''); } catch(e){}
    try { table.getCell(ri, 2).getText().setText(qtd !== '' ? qtd : ''); } catch(e){}
  });
}

function updateTeamSlide_(pres, slideIndex, slideTitle, teamData) {
  var slide = getSlideByTitle_(pres, slideTitle) || pres.getSlides()[slideIndex];
  if (!slide) { Logger.log('[teamSlide] not found: %s', slideTitle); return; }
  if (!teamData) { Logger.log('[teamSlide] no data for: %s', slideTitle); return; }

  var tables = slide.getTables();
  var metricTables = tables.filter(function(t) {
    return t.getNumRows() === 5 && t.getNumColumns() === 3;
  });

  if (metricTables.length >= 1) writeMetricTable_(metricTables[0], teamData.gns);
  if (metricTables.length >= 2) writeMetricTable_(metricTables[1], teamData.adv);
  if (metricTables.length >= 3) writeMetricTable_(metricTables[2], teamData.upg);
  if (metricTables.length >= 4) writeMetricTable_(metricTables[3], teamData.pay);

  metricTables.forEach(function(t) { applyItfColours_(t); });

  Logger.log('[teamSlide %s] found %s metric tables (rows=5,cols=3)', slideTitle, metricTables.length);
  Logger.log('[teamSlide %s] GNS actual tw=%s qtd=%s | ADV tw=%s qtd=%s',
    slideTitle,
    teamData.gns.actual.tw, teamData.gns.actual.qtd,
    teamData.adv.actual.tw, teamData.adv.actual.qtd);

  moveHighlightBox_(slide);
  Logger.log('✓ %s', slideTitle);
}

// EMM Account Management: three Actual/Target/ITF tables + charts, same pattern
// as the team slides. Tables are matched by their header label rather than by
// row/col count (they're 4×3, not the 5×3 the team slides use).
function updateSlide16_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'EMM Account Management');
  if (!slide) { Logger.log('[slide16] EMM slide not found'); return; }
  var d = rootData.slide16;
  if (!d) { Logger.log('[slide16] no data'); return; }

  slide.getTables().forEach(function(t) {
    var hdr = '';
    try { hdr = t.getCell(0,0).getText().asString().trim().toLowerCase(); } catch(e) {}
    if (hdr.indexOf('adv upgrade') >= 0)       { if (d.advUpgrade) writeMetricTable_(t, d.advUpgrade);
                                                 else Logger.log('[slide16] ADV Upgrade left as-is (no data at configured rows)'); }
    else if (hdr.indexOf('core upgrade') >= 0) { if (d.coreUpgrade) writeMetricTable_(t, d.coreUpgrade);
                                                 else Logger.log('[slide16] Core Upgrades left as-is (no data at configured rows)'); }
    else if (hdr.indexOf('payroll') >= 0)      { if (d.payroll) writeMetricTable_(t, d.payroll);
                                                 else Logger.log('[slide16] Payroll left as-is (no data at configured rows)'); }
  });

  refreshSlideCharts_(slide);
  Logger.log('✓ EMM Account Management');
}

// Diagnostic: dump the This Week (col T) / QTD (col U) values for a range of
// visuals-tab rows, so EMM Core Upgrades / Payroll rows can be pinpointed.
// Run this by itself from the editor, then read the Execution log.
function dumpVisualsBlock_(startRow, endRow) {
  startRow = startRow || 118;   // 0-based visData indices; DTM block ends ~120
  endRow   = endRow   || 140;
  var qi = getQuarterInfo_(CURRENT_WEEK);
  var visData = SpreadsheetApp.openById(qi.spreadsheetId)
                  .getSheetByName(VISUALS_TAB_NAME).getDataRange().getValues();
  Logger.log('=== dumpVisualsBlock_ rows %s..%s (label | This Week[T] | QTD[U]) ===', startRow, endRow);
  for (var i = startRow; i <= endRow && i < visData.length; i++) {
    var r = visData[i] || [];
    var label = '';
    for (var c = 0; c < 4; c++) { if (r[c]) { label = String(r[c]); break; } }
    Logger.log('idx %s: %s | T=%s | U=%s', i, label, r[19], r[20]);
  }
}

function updateSlide17_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'Major Firms') || pres.getSlides()[16];
  if (!slide) return;
  updateTeamSlide_(pres, 16, 'Major Firms', rootData.slide17);
  refreshSlideCharts_(slide);
}
function updateSlide19_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'National Firms') || pres.getSlides()[18];
  if (!slide) return;
  updateTeamSlide_(pres, 18, 'National Firms', rootData.slide19);
  refreshSlideCharts_(slide);
}
function updateSlide21_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'Large Firms') || pres.getSlides()[20];
  if (!slide) return;
  updateTeamSlide_(pres, 20, 'Large Firms', rootData.slide21);
  refreshSlideCharts_(slide);
}
function updateSlide23_(pres, rootData) {
  var slide = getSlideByTitle_(pres, 'DTM Firms') || pres.getSlides()[22];
  if (!slide) return;
  updateTeamSlide_(pres, 22, 'DTM Firms', rootData.slide23);
  refreshSlideCharts_(slide);
}

// ============================================================
//  GRID POPULATOR
// ============================================================

function populateGrid_(slide, headerKeyword, extractObj) {
  var labels, dataRows;
  if (extractObj && extractObj.labels && extractObj.data) {
    labels = extractObj.labels;
    dataRows = extractObj.data;
  } else if (extractObj && typeof extractObj === 'object') {
    labels = null;
    dataRows = null;
  } else {
    return null;
  }

  if (labels && (!dataRows || !dataRows.length)) return null;
  if (!labels && (!extractObj || !Object.keys(extractObj).length)) return null;

  var tables = slide.getTables();
  for (var ti = 0; ti < tables.length; ti++) {
    var t = tables[ti];
    var matchRow = -1;
    for (var r = 0; r < Math.min(6, t.getNumRows()) && matchRow < 0; r++) {
      for (var c = 0; c < Math.min(5, t.getNumColumns()) && matchRow < 0; c++) {
        try {
          var ct = t.getCell(r,c).getText().asString().replace(/\s+/g,'').toLowerCase();
          if (ct.indexOf(headerKeyword.replace(/\s+/g,'').toLowerCase()) >= 0) matchRow = r;
        } catch(e) {}
      }
    }
    if (matchRow < 0) continue;

    var colHeaderRow = matchRow;
    for (var hr = matchRow; hr < Math.min(matchRow + 3, t.getNumRows()); hr++) {
      for (var hc = 0; hc < t.getNumColumns(); hc++) {
        try {
          var htxt = t.getCell(hr, hc).getText().asString().trim();
          if (/^W\d+/.test(htxt)) { colHeaderRow = hr; break; }
        } catch(e) {}
      }
      if (colHeaderRow !== matchRow) break;
    }

    var colMap = (labels || Object.keys(extractObj[Object.keys(extractObj)[0]] || {}))
      .map(function(lbl) {
        var sl = wkNorm_(lbl);
        for (var hc = 0; hc < t.getNumColumns(); hc++) {
          try {
            var hTxt = wkNorm_(t.getCell(colHeaderRow, hc).getText().asString());
            if (hTxt === sl) return hc;
          } catch(e) {}
        }
        var wm = sl.match(/^w(\d+)/);
        if (wm) {
          for (var hc = 0; hc < t.getNumColumns(); hc++) {
            try {
              var hTxt = wkNorm_(t.getCell(colHeaderRow, hc).getText().asString());
              if (hTxt.indexOf('w' + wm[1]) === 0) return hc;
            } catch(e) {}
          }
        }
        return -1;
      });

    Logger.log('populateGrid_ [' + headerKeyword + '] colHeaderRow=' + colHeaderRow + ' colMap: ' + JSON.stringify(colMap));

    if (labels) {
      dataRows.forEach(function(rowObj, gr) {
        var vals = rowObj.values || rowObj;
        vals.forEach(function(val, gc) {
          if (colMap[gc] >= 0) setCell_(t, matchRow + 1 + gr, colMap[gc], val);
        });
      });
    } else {
      var rowKeys = Object.keys(extractObj);
      rowKeys.forEach(function(rowLabel, gr) {
        var rowData = extractObj[rowLabel];
        Object.keys(rowData).forEach(function(wk, gc) {
          if (colMap[gc] >= 0) setCell_(t, matchRow + 1 + gr, colMap[gc], rowData[wk]);
        });
      });
    }
    return t;
  }
  return null;
}

// ============================================================
//  HIGHLIGHT BOX
// ============================================================

function moveHighlightBox_(slide) {
  var tables = slide.getTables();
  if (!tables.length) return;
  var t = tables[0], targetCol = -1;
  outer:
  for (var r = 0; r < Math.min(4, t.getNumRows()); r++) {
    for (var c = 0; c < t.getNumColumns(); c++) {
      try {
        if (wkNorm_(t.getCell(r,c).getText().asString()) === wkNorm_(CURRENT_WEEK)) { targetCol = c; break outer; }
      } catch(e) {}
    }
  }
  if (targetCol < 0) return;
  var x = t.getLeft();
  for (var c = 0; c < targetCol; c++) x += t.getColumn(c).getWidth();
  var w = t.getColumn(targetCol).getWidth();
  slide.getShapes().forEach(function(s) {
    try {
      if (s.getShapeType() === SlidesApp.ShapeType.RECTANGLE &&
          s.getText().asString().trim() === '' && s.getHeight() > s.getWidth() * 2) {
        s.setLeft(x); s.setWidth(w);
      }
    } catch(e) {}
  });
}

// ============================================================
//  COLOUR HELPERS  (CHANGE B — all now use cfColorForValue_)
// ============================================================

// ITF/ITPY section colouring. Section-scoped exactly as before (only cells
// under an ITF/ITPY-type header get coloured, matching the sheet's CF ranges),
// but the colour decision now mirrors the sheet's CF rule via cfColorForValue_.
function applyItfColours_(table) {
  if (!table) return;
  try {
    var hdr0 = table.getCell(0,0).getText().asString().toLowerCase();
    if (hdr0.indexOf('cancel') >= 0) return;
  } catch(e) {}

  var numRows = table.getNumRows(), numCols = table.getNumColumns();
  var inSection = false;

  // A label that identifies an ITF / ITPY / ITPQ index row or section.
  function isIndexLabel_(lower) {
    if (!lower) return false;
    return lower.indexOf('itf')  >= 0 ||
           lower.indexOf('itpy') >= 0 ||
           lower.indexOf('itpq') >= 0 ||
           lower === 'ipty';               // sheet typo for ITPY
  }

  // Colour a row's data cells by the sheet's CF rule. Returns true if the row
  // actually held numeric data (i.e. it's a data row, not an empty header).
  function colourRow_(r) {
    var hadData = false;
    for (var c = 1; c < numCols; c++) {
      try {
        var cell = table.getCell(r,c);
        var txt  = cell.getText().asString().trim();
        if (txt !== '' && !isNaN(parseFloat(txt.replace(/[,%]/g,'')))) hadData = true;
        cell.getFill().setSolidFill(cfColorForValue_(txt));
      } catch(e) {}
    }
    return hadData;
  }

  for (var r = 0; r < numRows; r++) {
    var lbl = '';
    try { lbl = table.getCell(r,0).getText().asString().trim(); } catch(e) {}
    var lower = lbl.toLowerCase();

    if (isIndexLabel_(lower)) {
      var hadData = colourRow_(r);
      // Data-bearing index row (e.g. "EMM AM ITF", "ADV ITF" total): colour it
      // and stop. Empty index header (e.g. slide-6 "ITF" over team rows): keep
      // colouring the rows beneath until a blank label ends the section.
      inSection = !hadData;
      continue;
    }
    if (inSection) {
      if (lbl === '') { inSection = false; continue; }
      colourRow_(r);
    }
  }
}

// Blue/black week-column text, mirroring the sheet: weeks up to and including
// the current week are black (done); later weeks are blue (not yet actuals).
var WEEK_TEXT_DONE   = '#000000';
var WEEK_TEXT_FUTURE = '#1155CC';

function applyWeekTextColours_(slide) {
  if (!slide) return;
  slide.getTables().forEach(function(t) {
    var numRows = t.getNumRows(), numCols = t.getNumColumns();

    // Map each column that has a week header (W40, W41, …) to its week number.
    var colWeek = {};
    for (var c = 0; c < numCols; c++) {
      for (var hr = 0; hr < numRows; hr++) {
        var h = '';
        try { h = t.getCell(hr,c).getText().asString().trim(); } catch(e) {}
        var m = /^w\s*k?\s*0*(\d+)$/i.exec(h);
        if (m) { colWeek[c] = parseInt(m[1], 10); break; }
      }
    }

    Object.keys(colWeek).forEach(function(cStr) {
      var c = parseInt(cStr, 10);
      var color = colWeek[c] <= CURRENT_WEEK_NUM ? WEEK_TEXT_DONE : WEEK_TEXT_FUTURE;
      for (var r = 0; r < numRows; r++) {
        try {
          var tr = t.getCell(r,c).getText();
          if (tr.asString().trim() !== '') tr.getTextStyle().setForegroundColor(color);
        } catch(e) {}
      }
    });
  });
}

function applySlide13Colours_(slide) {
  var tables = slide.getTables();
  var tbl = tables[1];
  if (!tbl) return;
  [1, 2].forEach(function(r) {
    var numCols = tbl.getNumColumns();
    for (var c = 1; c < numCols; c++) {
      try {
        var cell = tbl.getCell(r,c);
        var txt = cell.getText().asString().trim();
        // Cancels ITF/ITPY: 0 shows as blank on the sheet, so treat "0" as white.
        var hex = (txt === '0') ? CF_WHITE : cfColorForValue_(txt);
        cell.getFill().setSolidFill(hex);
      } catch(e) {}
    }
  });
}

function applySlide4Colours_(slide) {
  var tables = slide.getTables();
  if (!tables || tables.length === 0) return;
  var tbl = null, maxRows = 0;
  tables.forEach(function(t){ if (t.getNumRows() > maxRows){ maxRows=t.getNumRows(); tbl=t; }});
  if (!tbl) return;

  var numRows = tbl.getNumRows(), numCols = tbl.getNumColumns();
  var itfCols = [];
  for (var c=0;c<numCols;c++){
    for (var hr=0;hr<3;hr++){
      var h=''; try{h=tbl.getCell(hr,c).getText().asString().trim().toLowerCase();}catch(e){}
      if (h==='itf'||h==='itpy'){ itfCols.push(c); break; }
    }
  }

  for (var r=2;r<numRows;r++){
    itfCols.forEach(function(c){
      var cell, txt;
      try { cell=tbl.getCell(r,c); txt=cell.getText().asString().trim(); } catch(e){ return; }
      try { cell.getFill().setSolidFill(cfColorForValue_(txt)); } catch(e){}
    });
  }
}

// Colours the variance column(s) on slide 5. Finds the column by header text;
// if your variance column has no header, pin varCols to a fixed index instead.
function applySlide5Colours_(slide) {
  if (!slide) return;
  var VAR_KEYS = ['variance', 'var', 'delta', '\u0394',
                  'vsqtg', 'vsfcst', 'vsforecast', 'actvsfcst'];

  slide.getTables().forEach(function (t) {
    var numRows = t.getNumRows(), numCols = t.getNumColumns();
    var varCols = [], headerRow = -1;

    for (var hr = 0; hr < Math.min(3, numRows) && headerRow < 0; hr++) {
      for (var c = 0; c < numCols; c++) {
        var h = '';
        try { h = t.getCell(hr, c).getText().asString().replace(/\s+/g, '').toLowerCase(); }
        catch (e) {}
        if (!h) continue;
        for (var k = 0; k < VAR_KEYS.length; k++) {
          if (h.indexOf(VAR_KEYS[k]) >= 0) { varCols.push(c); headerRow = hr; break; }
        }
      }
    }
    if (headerRow < 0 || !varCols.length) return;

    for (var r = headerRow + 1; r < numRows; r++) {
      varCols.forEach(function (c) {
        try {
          var cell = t.getCell(r, c);
          cell.getFill().setSolidFill(cfColorForValue_(cell.getText().asString().trim()));
        } catch (e) {}
      });
    }
    Logger.log('[slide5] coloured variance col(s) %s below header row %s',
      JSON.stringify(varCols), headerRow);
  });
}

// ============================================================
//  UTILITIES
// ============================================================

function numDiff_(a, b) {
  var na = parseFloat(String(a).replace(/[,%]/g, ''));
  var nb = parseFloat(String(b).replace(/[,%]/g, ''));
  if (isNaN(na) || isNaN(nb)) return '';
  var diff = parseFloat((na - nb).toFixed(10));
  return (diff >= 0 ? '+' : '') + diff;
}

function extractLabeledRows_(allData, secStart, secEnd, labels, colHeaders) {
  if (!secStart) return {};
  var result = {};
  for (var i = 0; i < labels.length; i++) {
    var r = findRowLoose_(allData, labels[i], secStart, secEnd);
    if (!r) continue;
    result[labels[i]] = {};
    for (var j = 0; j < colHeaders.length; j++) {
      var hdr = colHeaders[j];
      var col = findColumnLoose_(allData, hdr);
      if (col) result[labels[i]][hdr] = allData[r-1][col-1];
    }
  }
  return result;
}

function extractPkgSection_(allData, secStart, wkCols, isQ3) {
  if (!secStart) return { labels: [], data: [] };

  var headerRow = allData[secStart - 1];
  var pkgColMap = {};
  for (var c = 0; c < headerRow.length; c++) {
    var h = String(headerRow[c] || '').trim();
    if (h) pkgColMap[h] = c + 1;
  }
  Logger.log('PKG section col map (sec=' + secStart + '): ' + JSON.stringify(pkgColMap));

  var scanEnd = secStart + (isQ3 ? 25 : 20);
  for (var dbr = secStart; dbr <= scanEnd; dbr++) {
    var cv = String((allData[dbr-1] || [])[1] || '').trim();
    if (cv.indexOf('ITPQ') >= 0 || cv.indexOf('DTM All') >= 0 || cv.indexOf('PA All') >= 0) {
      Logger.log('PKG scan row ' + dbr + ' col1: [' + cv + ']');
      Logger.log('PKG scan row ' + dbr + ' full: ' + JSON.stringify(allData[dbr-1]));
    }
  }

  var labels = isQ3
    ? ['DTM (12m)', '   2 Adv', '   2 Ess',
       'DTM All ITPQ', 'DTM ADV ITPQ',
       'PA Value (9mnths)', '   2 Adv__2', '   5 Ess',
       'Ledger',
       'PA All ITPQ', 'PA ADV ITPQ']
    : ['DTM (12m)', '   2 Adv', '   2 Ess',
       'PA Value (9mnths)', '   2 Adv__2', '   5 Ess',
       'Ledger', 'NAM', 'NAM BDO',
       FY_LABEL + ' PKGs', PREV_FY_LABEL + ' PKGs', 'IPTY'];

  var searchEnd = secStart + (isQ3 ? 25 : 20);
  var lastFoundRow = {};

  var dataRows = labels.map(function(label) {
    var sheetLabel = label.replace(/__\d+$/, '').trim();
    var searchFrom = lastFoundRow[sheetLabel]
      ? lastFoundRow[sheetLabel] + 1
      : secStart + 1;

    var rowNum = findRowLoose_(allData, sheetLabel, searchFrom, searchEnd);
    if (!rowNum) {
      Logger.log('PKG [' + (isQ3 ? 'Q3' : 'Q4') + ']: row not found for "' + label + '" (searched from ' + searchFrom + ')');
      return { values: wkCols.map(function() { return ''; }) };
    }

    lastFoundRow[sheetLabel] = rowNum;
    var rowData = allData[rowNum - 1];
    var values = wkCols.map(function(wk) {
      var col = pkgColMap[wk];
      if (!col) return '';
      var val = rowData[col - 1];
      return (val !== undefined && val !== null) ? val : '';
    });

    Logger.log('PKG [' + (isQ3 ? 'Q3' : 'Q4') + '] "' + label + '" row=' + rowNum + ': ' + JSON.stringify(values.slice(0, 6)));
    return { values: values };
  });

  return { labels: wkCols, data: dataRows };
}

function replaceWeekLabel_(slide, newWeekNum) {
  var newLabel = 'Week ' + newWeekNum;
  slide.getShapes().forEach(function(s) {
    try {
      var txt = s.getText().asString();
      if (/Week\s+\d+/i.test(txt))
        s.getText().setText(txt.replace(/Week\s+\d+/gi, newLabel));
    } catch(e) {}
  });
  slide.getTables().forEach(function(t) {
    for (var r = 0; r < t.getNumRows(); r++) {
      for (var c = 0; c < t.getNumColumns(); c++) {
        try {
          var ct = t.getCell(r,c).getText().asString();
          if (/Week\s+\d+/i.test(ct))
            t.getCell(r,c).getText().replaceAllText(ct.match(/Week\s+\d+/i)[0], newLabel);
        } catch(e) {}
      }
    }
  });
}

function findTableRowByLabel_(table, fragment) {
  var cl = fragment.toLowerCase();
  for (var r = 0; r < table.getNumRows(); r++) {
    try {
      if (table.getCell(r,0).getText().asString().toLowerCase().indexOf(cl) >= 0) return r;
    } catch(e) {}
  }
  return -1;
}

function getSlideByTitle_(pres, fragment) {
  var slides = pres.getSlides();
  for (var i = 0; i < slides.length; i++) {
    var shapes = slides[i].getShapes();
    for (var j = 0; j < shapes.length; j++) {
      try {
        var type = shapes[j].getShapeType();
        if (type === SlidesApp.ShapeType.TEXT_BOX || type === SlidesApp.ShapeType.TITLE)
          if (shapes[j].getText().asString().indexOf(fragment) >= 0) return slides[i];
      } catch(e) {}
    }
  }
  return null;
}

function setCell_(table, row, col, value) {
  try {
    if (row < 0 || row >= table.getNumRows())    return;
    if (col < 0 || col >= table.getNumColumns()) return;

    if (value === null || value === undefined || value === '' || value === '.') {
      table.getCell(row, col).getText().setText('');
      return;
    }

    var d = String(value).trim();
    if (!d) { table.getCell(row, col).getText().setText(''); return; }

    var isPercent = d.indexOf('%') >= 0;
    if (!isPercent) {
      var n = parseFloat(d.replace(/[,$\s]/g,''));
      if (!isNaN(n)) d = n % 1 === 0 ? Math.round(n).toLocaleString('en-US') : d;
    }

    var tr = table.getCell(row, col).getText();
    tr.setText(d);
    tr.getTextStyle().setForegroundColor('#000000');
  } catch(e) {}
}

// FY27+ dashboards label week columns "WK1".."WK14"; older ones used "W40"..
// Collapse whitespace/case AND fold a leading "WKn" to "Wn" so both header
// styles compare equal. Non-week labels (QTD, Best Case, WSB…) are unaffected
// because the fold only fires on "wk" immediately followed by a digit.
function wkNorm_(s) {
  return String(s).replace(/\s+/g, '').toLowerCase().replace(/^wk(?=\d)/, 'w');
}

function findColumnInRows_(allData, label, startRow, endRow) {
  var cl = wkNorm_(label);
  var s = Math.max(0, startRow - 1);
  var e = Math.min(endRow - 1, allData.length - 1);
  for (var pass = 0; pass < 2; pass++) {
    for (var ri = s; ri <= e; ri++) {
      var row = allData[ri];
      for (var ci = 0; ci < Math.min(row.length, 120); ci++) {
        var cell = wkNorm_(row[ci]);
        if (pass === 0 ? cell === cl : cell.indexOf(cl) >= 0) return ci + 1;
      }
    }
  }
  return null;
}

function findColumnLoose_(allData, label) {
  var cl = wkNorm_(label);
  var rows = Math.min(25, allData.length);
  for (var pass = 0; pass < 2; pass++) {
    for (var ri = 0; ri < rows; ri++) {
      var row = allData[ri];
      for (var ci = 0; ci < Math.min(row.length, 120); ci++) {
        var cell = wkNorm_(row[ci]);
        if (pass === 0 ? cell === cl : cell.indexOf(cl) >= 0) return ci + 1;
      }
    }
  }
  return null;
}

function findRowLoose_(allData, label, start, end) {
  var s = Math.max(0, (start||1) - 1);
  var e = Math.min((end||allData.length) - 1, allData.length - 1);
  var cl = label.replace(/\s+/g,'').toLowerCase();
  for (var pass = 0; pass < 2; pass++) {
    for (var i = s; i <= e; i++) {
      for (var j = 0; j < Math.min(5, allData[i].length); j++) {
        var cell = String(allData[i][j]).replace(/\s+/g,'').toLowerCase();
        if (pass === 0 ? cell === cl : cell.indexOf(cl) >= 0) return i + 1;
      }
    }
  }
  return null;
}

function toNum_(v) {
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v).replace(/[,%$\s]/g,''));
  return isNaN(n) ? 0 : n;
}

function buildTemplateTLDR_(data) {
  var s = data.slide4;
  var tv = toNum_(s.total.variance);
  var ts = tv >= 0 ? '+' : '';

  var hit = ['national', 'major', 'large', 'dtm']
    .filter(function(k) {
      return toNum_(s[k].actual) >= toNum_(s[k].forecast);
    })
    .map(function(k) {
      return k.charAt(0).toUpperCase() + k.slice(1);
    })
    .join(', ') || 'none';

  var miss = ['national', 'major', 'large', 'dtm']
    .filter(function(k) {
      return toNum_(s[k].actual) < toNum_(s[k].forecast);
    })
    .map(function(k) {
      return k.charAt(0).toUpperCase() + k.slice(1);
    })
    .join(', ') || 'none';

  return 'TLDR:\n' +
    '• ' + CURRENT_WEEK + ': ' + s.total.actual + ' units vs forecast ' + s.total.forecast +
    ' (' + ts + tv + '). ITF: ' + s.total.itf_w + '. ITPY: ' + s.total.itpy_w + '.\n' +
    '• On target: ' + hit + '. Below target: ' + miss + '.\n' +
    '• ADV GNS: ' + s.advGNS.actual + ' (' + s.advMix.actual + ' mix). Upgrades: ' +
    s.hvamUpgr.actual + '. Payroll: ' + s.payroll.actual + '. QTD: ' + s.total.actual_q +
    ' (ITF: ' + s.total.itf_q + ').\n\n' +
    'Bright Spots:\n' +
    '• On-target teams: ' + hit + '.\n\n' +
    'Hot Spots:\n' +
    '• Below-target teams: ' + miss + '.';
}

// ============================================================
//  WEEKLY AUTOMATION ENTRY POINT
// ============================================================

function runWeeklyAutomation() {
  var weekNum = getCurrentWeekNumber_();
  Logger.log('=== runWeeklyAutomation — FY week ' + weekNum + ' ===');

  if (!isRawDataFresh_()) {
    Logger.log('Raw_Data not yet refreshed today — scheduling hourly retry.');
    scheduleHourlyRetry_();
    return;
  }

  clearRetryTrigger_();

  try {
    generateWeeklyPresentation();
  } catch (e) {
    Logger.log('generateWeeklyPresentation failed: ' + e);
  }

  try {
    generateAgendaSlides_(weekNum);
  } catch (e) {
    Logger.log('generateAgendaSlides_ failed: ' + e);
  }
}

function retryWeeklyAutomation() {
  var weekNum = getCurrentWeekNumber_();
  Logger.log('=== retryWeeklyAutomation — FY week ' + weekNum + ' ===');

  if (!isRawDataFresh_()) {
    Logger.log('Raw_Data still not fresh — will retry again next hour.');
    return;
  }

  clearRetryTrigger_();

  try { generateWeeklyPresentation(); } catch (e) { Logger.log('generateWeeklyPresentation: ' + e); }
  try { generateAgendaSlides_(weekNum); } catch (e) { Logger.log('generateAgendaSlides_: ' + e); }
}

function isRawDataFresh_() {
  try {
    var ss  = SpreadsheetApp.openById(RAW_DATA_SPREADSHEET_ID);
    var val = ss.getRange(PIPELINE_META_RANGE).getValue();
    if (!val) return false;
    var ts  = new Date(val);
    var today = new Date();
    return ts.getFullYear()  === today.getFullYear()  &&
           ts.getMonth()     === today.getMonth()      &&
           ts.getDate()      === today.getDate();
  } catch (e) {
    Logger.log('isRawDataFresh_ error: ' + e);
    return false;
  }
}

function getCurrentWeekNumber_() {
  var now     = new Date();
  var utcNow  = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  var utcStart = Date.UTC(FY_WEEK1_MONDAY.getFullYear(), FY_WEEK1_MONDAY.getMonth(), FY_WEEK1_MONDAY.getDate());
  return Math.floor((utcNow - utcStart) / (1000 * 60 * 60 * 24 * 7)) + 1;
}

function scheduleHourlyRetry_() {
  var already = ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'retryWeeklyAutomation'; });
  if (already.length === 0) {
    ScriptApp.newTrigger('retryWeeklyAutomation').timeBased().everyHours(1).create();
    Logger.log('Hourly retry trigger created.');
  }
}

function clearRetryTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'retryWeeklyAutomation'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
}

// ============================================================
//  AGENDA SLIDE GENERATOR
// ============================================================

function generateAgendaSlides_(weekNumber) {
  var templateFile = DriveApp.getFileById(AGENDA_TEMPLATE_ID);
  var today        = new Date();
  var copyName     = 'CA Weekly E2E Review - Week ' + weekNumber +
                     ' (' + Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyy-MM-dd') + ')';

  var copy;
  try {
    copy = templateFile.makeCopy(copyName, DriveApp.getFolderById(AGENDA_OUTPUT_FOLDER));
  } catch (e) {
    copy = templateFile.makeCopy(copyName);
  }

  var pres   = SlidesApp.openById(copy.getId());
  var slides = pres.getSlides();

  pres.replaceAllText('Week 40', 'Week ' + weekNumber);
  pres.replaceAllText('Week 41', 'Week ' + weekNumber);

  slides.forEach(function(slide) {
    updateAgendaSlideText_(slide, weekNumber, today);
  });

  for (var i = slides.length - 1; i >= 2; i--) {
    slides[i].remove();
  }

  var agendaData = readAgendaData_(weekNumber);
  if (agendaData) {
    var tables = pres.getSlides()[1].getTables();
    if (tables.length > 0) {
      updateAgendaTable_(tables[0], agendaData);
    }
  }

  pres.saveAndClose();
  Logger.log('✅ Agenda deck created: ' + copyName);
}

function updateAgendaSlideText_(slide, weekNumber, date) {
  var weekRegex    = /(Week|Wk|W|W-)\s*\d+/gi;
  var dateRegex    = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/gi;
  var formattedDate = Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMM d, yyyy');

  slide.getPageElements().forEach(function(el) {
    var type = el.getPageElementType();
    if (type === SlidesApp.PageElementType.SHAPE) {
      var tf = el.asShape().getText();
      tf.replaceAllText(weekRegex, 'Week ' + weekNumber);
      tf.replaceAllText(dateRegex, formattedDate);
    } else if (type === SlidesApp.PageElementType.GROUP) {
      el.asGroup().getChildren().forEach(function(child) {
        if (child.getPageElementType() === SlidesApp.PageElementType.SHAPE) {
          child.asShape().getText().replaceAllText(weekRegex, 'Week ' + weekNumber);
        }
      });
    } else if (type === SlidesApp.PageElementType.TABLE) {
      var table = el.asTable();
      for (var r = 0; r < table.getNumRows(); r++) {
        for (var c = 0; c < table.getNumColumns(); c++) {
          try { table.getCell(r, c).getText().replaceAllText(weekRegex, 'Week ' + weekNumber); } catch (_) {}
        }
      }
    }
  });
}

function getAgendaSheetForWeek_(spreadsheet, weekNumber) {
  var regex = new RegExp('(week|wk|w)\\s*' + weekNumber + '\\b', 'i');
  var sheets = spreadsheet.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (regex.test(sheets[i].getName())) return sheets[i];
  }
  return null;
}

function readAgendaData_(weekNumber) {
  try {
    var ss    = SpreadsheetApp.openById(AGENDA_SPREADSHEET_ID);
    var sheet = getAgendaSheetForWeek_(ss, weekNumber);
    return sheet ? sheet.getRange(AGENDA_DATA_RANGE).getValues() : null;
  } catch (e) {
    Logger.log('readAgendaData_ error: ' + e);
    return null;
  }
}

function updateAgendaTable_(table, agendaData) {
  for (var r = 0; r < Math.min(agendaData.length, table.getNumRows()); r++) {
    for (var c = 0; c < Math.min(agendaData[0].length, table.getNumColumns()); c++) {
      try { table.getCell(r, c).getText().setText(agendaData[r][c].toString()); } catch (_) {}
    }
  }
}

// ============================================================
//  TRIGGER INSTALLATION
// ============================================================

function installTriggers() {
  ['generateWeeklyPresentation', 'runWeeklyAutomation', 'retryWeeklyAutomation']
    .forEach(function(fn) {
      ScriptApp.getProjectTriggers()
        .filter(function(t) { return t.getHandlerFunction() === fn; })
        .forEach(function(t) { ScriptApp.deleteTrigger(t); });
    });

  ScriptApp.newTrigger('runWeeklyAutomation')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(11)
    .create();

  Logger.log('✅ Trigger installed: runWeeklyAutomation — Monday 11am');
}

function createTuesdayTrigger() {
  Logger.log('createTuesdayTrigger is deprecated — call installTriggers() instead.');
  installTriggers();
}

// ============================================================
//  CHART SLIDES  (run manually after the 6 PNGs land in Drive)
//
//  Idempotent: each chart image carries a hidden alt-text marker
//  ("HVAM_CHART:<filename>"). On every run the script reuses the slide that
//  already holds that chart and swaps the image in place (slide order and any
//  manual positioning preserved); only charts that don't exist yet get
//  appended. Safe to re-run every week — no duplicate pile-up.
// ============================================================
// Fixed slide positions (1-based, POST-restructure) for each screenshot.
var CHART_LAYOUT = {
  'q4-pipeline.png':       6,
  'q4-adv-pipeline.png':   7,
  'major-pipeline.png':    18,
  'large-pipeline.png':    20,
  'dtm-pipeline.png':      22,
  'national-pipeline.png': 24
};
var CHART_FOLDER_ID = '1zkqwK_HnOOYmk_xryUwfMkOyoE18e3TL';   // "HVAM Forecast Charts"

// Places the six pipeline screenshots at their fixed slide positions.
// Full-clear: every image already on a target slide is removed first, then the
// new screenshot is fit + centered. Idempotent — safe to re-run weekly.
// Run restructureDeck() ONCE before the first use so the positions line up.
function addChartSlides() {
  var deck   = SlidesApp.openById(SOURCE_PRESENTATION_ID);

  // Guard: bail if the deck hasn't been restructured (BMW still present),
  // otherwise the fixed positions would land on the wrong slides.
  if (findSlideIndexByTitle_(deck, 'CAN HV/EMM AM Sales - BMW') >= 0) {
    Logger.log('[charts] deck not restructured yet (BMW slide still present). Run restructureDeck() first — aborting.');
    return;
  }

  var folder = DriveApp.getFolderById(CHART_FOLDER_ID);
  var slides = deck.getSlides();
  var W = deck.getPageWidth(), H = deck.getPageHeight();

  Object.keys(CHART_LAYOUT).forEach(function (name) {
    var pos   = CHART_LAYOUT[name];
    var slide = slides[pos - 1];
    if (!slide) { Logger.log('[charts] no slide at position ' + pos + ' for ' + name); return; }

    var files = folder.getFilesByName(name);
    if (!files.hasNext()) { Logger.log('[charts] missing: ' + name); return; }
    var blob = files.next().getBlob();

    // Full-clear: remove all existing images on the target slide.
    slide.getImages().forEach(function (img) { try { img.remove(); } catch (e) {} });

    var pic = slide.insertImage(blob);
    var s = Math.min(W / pic.getWidth(), H / pic.getHeight());
    pic.setWidth(pic.getWidth() * s).setHeight(pic.getHeight() * s);
    pic.setLeft((W - pic.getWidth()) / 2).setTop((H - pic.getHeight()) / 2);
    try { pic.setDescription('HVAM_CHART:' + name); } catch (e) {}

    Logger.log('[charts] placed ' + name + ' on slide ' + pos);
  });
}

// ── ONE-TIME deck restructure ──────────────────────────────
// Deletes the BMW slide and the stray chart test slide, then inserts a blank
// slide at position 7 for the q4-adv screenshot. Guarded so re-running is a
// no-op once BMW is gone. Run this ONCE, then addChartSlides().
function restructureDeck() {
  var deck = SlidesApp.openById(SOURCE_PRESENTATION_ID);

  if (findSlideIndexByTitle_(deck, 'CAN HV/EMM AM Sales - BMW') < 0) {
    Logger.log('[restructure] BMW slide not found — deck already restructured. Aborting.');
    return;
  }

  // 1) Remove stray chart slides: blank (no text, no tables) with only
  //    HVAM_CHART-tagged images (e.g. the earlier q4 test slide).
  deck.getSlides().forEach(function (s) {
    var imgs = s.getImages();
    if (!imgs.length) return;
    if (slideHasAnyText_(s)) return;
    var hasTables = false; try { hasTables = s.getTables().length > 0; } catch (e) {}
    if (hasTables) return;
    var allTagged = imgs.every(function (img) {
      var d = ''; try { d = img.getDescription() || ''; } catch (e) {}
      return d.indexOf('HVAM_CHART:') === 0;
    });
    if (allTagged) { Logger.log('[restructure] removing stray chart slide'); s.remove(); }
  });

  // 2) Remove BMW.
  var slides = deck.getSlides();
  for (var i = 0; i < slides.length; i++) {
    if (slideHasTitle_(slides[i], 'CAN HV/EMM AM Sales - BMW')) {
      Logger.log('[restructure] removing BMW at position ' + (i + 1));
      slides[i].remove();
      break;
    }
  }

  // 3) Insert blank slide at position 7 (index 6) for q4-adv-pipeline.
  deck.insertSlide(6, SlidesApp.PredefinedLayout.BLANK);
  Logger.log('[restructure] inserted blank slide at position 7');
  Logger.log('[restructure] done — now run addChartSlides().');
}

function findSlideIndexByTitle_(deck, fragment) {
  var slides = deck.getSlides();
  for (var i = 0; i < slides.length; i++) {
    if (slideHasTitle_(slides[i], fragment)) return i;
  }
  return -1;
}

function slideHasTitle_(slide, fragment) {
  var shapes = slide.getShapes();
  for (var j = 0; j < shapes.length; j++) {
    try { if (shapes[j].getText().asString().indexOf(fragment) >= 0) return true; } catch (e) {}
  }
  return false;
}

function slideHasAnyText_(slide) {
  var shapes = slide.getShapes();
  for (var j = 0; j < shapes.length; j++) {
    try { if (shapes[j].getText().asString().trim() !== '') return true; } catch (e) {}
  }
  return false;
}