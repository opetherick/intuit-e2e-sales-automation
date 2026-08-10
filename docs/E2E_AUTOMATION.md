# E2E Weekly Sales Deck — End-to-End Automation

Complete engineering + operations guide for the automated **FY26 CA Weekly
Accountant E2E** pipeline. This is the hand-off document: read it top to bottom
and you should be able to run, debug, and extend the whole system without any
tribal knowledge.

---

## 1. What this system does

Every Monday morning it turns raw sales-booking data in the Intuit data lake into
a finished, AI-summarized Google Slides deck for the weekly sales-leadership
review — with **no manual data entry**.

There are three moving parts, wired together through **one Google Spreadsheet**:

| # | Component | Tech | Where it runs | Job |
|---|-----------|------|---------------|-----|
| 1 | **Data pipeline** | Python (`fetch_data.py`) | Analyst laptop on Intuit VPN (today) | Query Athena → write `Raw_Data`, `Calendar_Cache`, `Pipeline_Meta` (timestamp + AI summary) |
| 2 | **Formula generator** | Apps Script (`Full_Formula_Generator.gs`) | Bound to the **dashboard** spreadsheet | Turn `Raw_Data` into live COUNTIFS on the dashboard tabs, flip forecast→actual colours, roll quarters over |
| 3 | **Deck generator** | Apps Script (`Code.js`) | Bound to the **deck/agenda** project | Build the Google Slides deck + agenda slides, pull the AI summary from `Pipeline_Meta!B1` |

### Data flow

```
Every Monday morning
        │
        ▼
fetch_data.py  (eiamcli login → Athena queries via the "longtail" workgroup)
        │        • uses GenOS (GCP-fronted LLM) to write the exec summary
        ▼
Google Sheet (SPREADSHEET_ID 1qp6eTw9nmblHi4_28zZe7gI3shbEFV_LOCl35inQL0Y)
   ├── Raw_Data          ← cleared + rewritten with the latest flat table
   ├── Calendar_Cache    ← one row per fiscal week (drives current-week + rollover)
   ├── Pipeline_Meta!A1  ← UTC completion timestamp ("data is fresh today")
   └── Pipeline_Meta!B1  ← pre-generated AI weekly summary (GenOS)
        │
        ▼
Full_Formula_Generator.gs  (Apps Script, "Canada Dashboard" menu / weekly run)
   • writes =COUNTIFS(Raw_Data...) into the dashboard tables
   • flips completed weeks blue(forecast) → black(actual)
   • caps writes so future weeks stay forecast
        │
        ▼
Code.js  →  generateWeeklyPresentation() + generateAgendaSlides_()
   • reads the dashboard tabs + "FY26Q4 Visuals" tab
   • reads Pipeline_Meta!B1 for the AI commentary  ← (no GenOS call needed)
   • copies the template deck and fills every slide
        │
        ▼
By 12pm — finished Google Slides deck + agenda, ready for the review.
```

> **Why the summary lives in a cell:** Apps Script runs on Google's network, which
> is *outside* Intuit's. It cannot obtain an Intuit IAM ticket, so a GenOS call
> straight from Apps Script always 403s. `fetch_data.py` runs on the Intuit
> network, so it generates the summary and parks it in `Pipeline_Meta!B1`; the
> deck just reads the cell. (The `src/relay_service/` FastAPI service is the
> long-term fix if the pipeline ever moves to a cloud scheduler — see §8.)

---

## 2. Repository layout

```
intuit-e2e-sales-automation/
├── README.md
├── docs/
│   └── E2E_AUTOMATION.md          ← this file
├── queries/
│   └── sales_pipeline_athena.sql  ← reference/exploration query (not run by the pipeline)
├── src/
│   ├── data_pipeline/
│   │   ├── fetch_data.py          ← the pipeline (COMPONENT 1)
│   │   └── requirements.txt       ← pinned Python deps
│   ├── appsscript/
│   │   ├── Code.js                ← deck generator (COMPONENT 3)
│   │   ├── Full_Formula_Generator.gs ← dashboard formula generator (COMPONENT 2)
│   │   ├── appsscript.json
│   │   └── .clasp.json            ← clasp target (scriptId of the deck project)
│   ├── ai_engine/summarizer.py    ← placeholder (logic currently lives in fetch_data.py)
│   └── relay_service/             ← FastAPI GenOS relay (future cloud deployment)
```

The local Python **`venv/`**, `__pycache__/`, `athena_test_output.csv`, and the
`test_*.py` scratch scripts are intentionally **git-ignored** (see `.gitignore`)
— the venv is ~278 MB and the CSV holds raw sales rows.

---

## 3. Prerequisites & one-time setup

### Access you need first
1. **SSO / EIAM access to the `longtail` Athena workgroup.** Your SSO access
   becomes available only *after your access ticket is approved*. Roger Hewett
   is the point of contact for longtail / Athena questions.
2. **GenOS app secret** for `Intuit.sbseganalyticsds.e2eautomationsales`
   (see §5 — never hard-code it).
3. **GenOS: enable the downstream service "Identity API (Private)"** for the
   app registration, or the IAM-ticket exchange in `call_genos()` fails.
4. **Google Sheets access** — the pipeline impersonates the service account
   `ca-cbr-gcp-gdrive-sa@intuit-5479772439762953825.iam.gserviceaccount.com`,
   which must have edit access to the spreadsheet.

### Local environment (first run only)
```bash
cd ~/cursor-workspace/intuit-e2e-sales-automation/src/data_pipeline
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

A corporate CA bundle is expected at `~/.ssl/combined-ca.pem` (Netskope). The
script points `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE`, and
`httplib2.CA_CERTS` at it — update `SSL_CERT_FILE` at the top of `fetch_data.py`
if your path differs.

---

## 4. The weekly runbook (Monday, target: done by 12pm)

```bash
# Step 1 — refresh AWS / SSO token (do this every run)
eiamcli login
eiamcli getAWSTempCredentials -a 052517444781 -r longtail -p default

# Step 2 — run the pipeline
cd ~/cursor-workspace/intuit-e2e-sales-automation/src/data_pipeline
source venv/bin/activate                          # activates pandas + deps
export GENOS_APP_SECRET="<secret from IDPS — see §5>"   # required each run for the AI step
python3 fetch_data.py
```

What a successful run does, in order (`main()`):
1. Authenticates to Google Sheets (impersonated SA).
2. Loads the **FSA Map roster** (agent → team mapping) from its own sheet.
3. Opens the Athena connection (`longtail` workgroup).
4. Runs every query in `QUERIES` (GNS, PAYROLL, ADV, ADV_GNS, ADV_UPGRADES,
   SIGNUP, PKG_GNS_ACCOUNTANT, 8× PKG types, ACTIVE_CANCELS), tags each with its
   `table_type`, and concatenates into one flat frame.
5. For ACTIVE_CANCELS: classifies each account to a team via the roster and
   applies the **weekly freeze** (closed weeks are locked to their snapshot;
   only the open week recomputes).
6. Runs `validate()` against known-good weeks (W45 cancels, per-week payroll,
   W48 for the rest) — mismatches are logged, not fatal.
7. `clear_and_write()` → overwrites the **`Raw_Data`** tab.
8. `write_calendar_cache()` → refreshes **`Calendar_Cache`** (non-fatal).
9. `write_pipeline_timestamp()` → stamps **`Pipeline_Meta!A1`** (non-fatal).
10. Builds the summary prompt, calls **GenOS**, writes **`Pipeline_Meta!B1`**
    (non-fatal — a missing secret or network error just logs a warning and the
    deck falls back to the template TLDR).

After the pipeline finishes, the two Apps Script components run (manually from
the sheet menu, or on the weekly trigger — see §7):
- **`Full_Formula_Generator.gs` → Generate All Formulas** updates the dashboard.
- **`Code.js` → `generateWeeklyPresentation()` / `runWeeklyAutomation()`** builds the deck.

---

## 5. Secrets & the GenOS auth flow

**The GenOS app secret must never be committed or pasted into docs/code.** It is
read from the `GENOS_APP_SECRET` environment variable at runtime and, if absent,
the AI step is skipped silently (non-fatal). Fetch the value from IDPS/DevPortal:

```
managed-items/api-security/private-auth/preProd/appsecret
AppId:  Intuit.sbseganalyticsds.e2eautomationsales
```

> **⚠️ Security note (action needed):** the secret was shared in plain text in the
> chat that produced this doc. Treat it as **potentially exposed** and rotate it
> in IDPS. Nothing in this repo stores it, and it is not in git history introduced
> by this change — keep it that way.

`call_genos()` tries two auth strategies:
1. **PrivateAuth Basic** — `app_id` + `app_secret` straight to GenOS.
2. **PrivateAuth+** — exchange credentials for an IAM ticket via the Intuit
   Identity service first (`_genos_iam_ticket()`), then send the full header.
   This is the same pattern the relay service and `agentfordashappv3` use.

GenOS config (in `fetch_data.py`): `GENOS_ENDPOINT` (Claude Sonnet via GenOS E2E),
`GENOS_EXPERIENCE_ID`, `GENOS_IDENTITY_URL`. This only works **on the Intuit VPN**.

---

## 6. Component 1 — `fetch_data.py` (the pipeline)

### Key config constants (top of file)
- `SPREADSHEET_ID` — the output workbook.
- `TAB_NAME = "Raw_Data"`, `PIPELINE_META_TAB`, `CALENDAR_CACHE_TAB`,
  `ACTIVE_CANCELS_FREEZE_TAB`.
- `AI_SUMMARY_CELL = "Pipeline_Meta!B1"` — **the cell `Code.js` reads.**
- `FY = 2027`, `QUARTER = 1` — bump these on quarter rollover (see §12).
- `AWS_REGION`, `S3_STAGING_DIR`, `ATHENA_WORKGROUP = "longtail"`.

### `Raw_Data` schema (the contract with Apps Script)
Flat table matching Stephen's LATAM_E2E structure. The columns the Apps Script
depends on (by **letter**, because COUNTIFS is positional):

| Col | Field | Used by |
|-----|-------|---------|
| C | `FWeek` (fiscal week number) | week column match |
| H | `L3_Division` (or dashboard team label for cancels) | row label match |
| Q | `table_type` | which table (GNS / PAYROLL / ADV_* / PKG_* / ACTIVE_CANCELS) |

> If you ever reorder `Raw_Data` columns, you **must** update `COL_WEEK`/`COL_L3`/
> `COL_TYPE` in `Full_Formula_Generator.gs` and `buildCountLookup()`'s `colIdx`.

### `table_type` values written
`GNS`, `PAYROLL`, `ADV`, `ADV_GNS`, `ADV_UPGRADES`, `SIGNUP`,
`PKG_GNS_ACCOUNTANT`, `PKG_DTM`, `PKG_DTM_ADV`, `PKG_DTM_ESS`, `PKG_PA`,
`PKG_PA_ADV`, `PKG_PA_ESS`, `PKG_LEDGER`, `PKG_NAM`, `ACTIVE_CANCELS`.

### L3 → dashboard-row mapping (note the deliberate inversion!)
| Athena `division_l3_name` | Dashboard row |
|---|---|
| `National Sales CA L3` | National |
| `Regional Firms Sales CA L3` | **Major** |
| `Large Firms Sales CA L3` | **Large** |
| `DTM Sales CA L3` | DTM |

"Regional Firms" maps to the **Major** row and "Large Firms" to the **Large** row
— confirmed with Stephen. This trips people up constantly.

### ACTIVE_CANCELS classification (the subtle part)
Cancels are **not** classified by `division_l3_name` (which is point-in-time as of
activation and goes stale when reps change teams). Instead the pipeline replicates
Stephen's manual VLOOKUP against the **FSA Map roster**
(`ROSTER_SPREADSHEET_ID`), driven by the roster's **L3** column (Segment is a
fallback only). Highlights:
- Matching is **exact-only** on a whitespace/case-normalized name key (no fuzzy
  matching — the roster is the single source of truth; add a name form if a real
  rep isn't matching).
- `OWNER_TEAM_OVERRIDES` win over the roster and bridge spelling drift; a value
  of `"DROP"` excludes an owner entirely.
- System/integration owners (`SYSTEM_OWNER_MARKERS`) → **Unmanaged**; real
  off-roster humans (managers, ops) are **dropped**.
- **Weekly freeze** (`apply_active_cancels_freeze`, `ActiveCancels_Freeze` tab):
  once a week closes, its cancel rows are frozen to that snapshot so late/backdated
  cancels and reactivations don't rewrite history. Only the open week recomputes.

### `Calendar_Cache` (drives the Apps Script's sense of "now")
One aggregated row per `(fiscal_year, fiscal_quarter, fiscal_week)` with
`week_start_date`, `week_end_date`, and `day_count_in_qtr`. Column aliases match
`CAL_FIELD` in `Full_Formula_Generator.gs` exactly — the generator uses this to
know the current fiscal week and to relabel weeks on quarter rollover.

### `Pipeline_Meta` (the two-cell hand-off tab)
| Cell | Written by | Read by | Meaning |
|------|-----------|---------|---------|
| `A1` | `write_pipeline_timestamp()` | `Code.js:isRawDataFresh_()` | UTC ISO timestamp — "Raw_Data refreshed today" |
| `B1` | `write_ai_summary()` | `Code.js:readPipelineAISummary_()` | The GenOS exec summary (TLDR / Bright Spots / Hot Spots) |

### Validation
The hard-coded FY26 Q4 expected-value dicts (`W46_EXPECTED`,
`PAYROLL_WEEKLY_EXPECTED`, `W45_ACTIVE_CANCELS_EXPECTED`) were **removed on the
FY27 Q1 rollover** — those weeks (40–53) no longer exist in an FY27 Q1 pull, so
every check reported a spurious `got 0, want N`. The run now just logs a per-
`table_type` row-count summary as a sanity check. The generic `validate()` helper
remains in place; if Stephen/Olivia confirm FY27 ground-truth totals for a week,
add a new dict and re-wire `validate()` in `main()`. (See §12 on the fiscal-week
reset for why expected values must be re-created each quarter.)

---

## 7. Component 2 — `Full_Formula_Generator.gs` (dashboard)

Bound to the **dashboard** spreadsheet. Adds a **"Canada Dashboard"** menu on
open (`onOpen`):
- **Generate All Formulas (+ current-week flip)** → `generateAllFormulas()`
- **What week is it? (diagnostic)** → `whatWeekIsIt()`
- **Roll over to next quarter** → `rolloverToNextQuarter()`

### What `generateAllFormulas()` does (4 passes)
1. **Pass 1 — full-write tables** (`FULL_WRITE_TABLES`: GNS r6, PKG_GNS_ACCOUNTANT
   r67, PAYROLL r247, ACTIVE_CANCELS r310, ADV_GNS r130, ADV_UPGRADES r169).
   Writes `=COUNTIFS('Raw_Data'!...)` for each week/row and flips the cell
   **blue→black** as a week becomes actual.
2. **Pass 2 — flip-only ranges** (`FLIP_ONLY_RANGES`: PKG rows 34–41). Recolours
   only; never overwrites values (they come from other formulas).
3. **Pass 3 — row-3 "x" markers** for completed weeks.
4. **Pass 4 — calendar-driven colour flip** for the current/completed weeks.

### The current-week cap (why future weeks stay forecast)
`getCurrentWeekCap_()` decides the highest week to treat as **actual**. Weeks
beyond it keep their forecast value and are forced back to **blue** (so a
partially-populated future week can't flip to a wrong low "actual"). Source of
the cap, in priority order:
1. **`CURRENT_WEEK_OVERRIDE`** (top of file) — set this to the current fiscal week
   number each week (e.g. `52`) to force it. `null` = use the calendar.
2. Otherwise `Calendar_Cache` via `getCurrentFiscalPosition()`.
3. If the calendar can't be read → cap = `Infinity` (write everything; degrade
   safely rather than blanking the sheet).

> **Colour convention:** forecast = blue `#0000ff`, actual = black `#000000`.
> **Manual rows** (`MANUAL_ROWS = [42]`, the "NAM BDO" line) are never written or
> recoloured.

### Quarter/year rollover (`rolloverToNextQuarter()`)
Clones the current dashboard tab into the next quarter, relabels week headers +
day-counts + the `Q` label from `Calendar_Cache`, resets managed cells to
forecast, does a naive `FY.. Q..` text swap (flagging comparison blocks for manual
review), and regenerates formulas. Afterwards, update the `DASHBOARD_TAB` constant
(and `CURRENT_WEEK*` in `Code.js`, and `FY`/`QUARTER` in `fetch_data.py`).

---

## 8. Component 3 — `Code.js` (deck generator)

Bound to the deck/agenda Apps Script project (`.clasp.json` scriptId
`1Xat3GqQdX6VikRTDbRPB67fbirOzr4qFoGe-56V5n_b3E6kBIZkCKca6`).

### Weekly knobs (top of file)
- `CURRENT_WEEK = 'W52'` / `CURRENT_WEEK_NUM = 52` — **change every week.**
- `SOURCE_PRESENTATION_ID` — the template deck that gets copied.
- `QUARTER_CONFIG` — per-quarter weeks, dashboard spreadsheet id, tab name.
- `RAW_DATA_SPREADSHEET_ID`, `PIPELINE_META_RANGE = 'Pipeline_Meta!A1'`,
  `AI_SUMMARY_RANGE = 'Pipeline_Meta!B1'`.

### `generateWeeklyPresentation()`
1. Opens the dashboard tab, mirrors its conditional-format colour rules.
2. Bumps the `FY26Q4 Visuals` week-driver cell (`F149`) and flushes so the
   visuals table recomputes for the current week.
3. Copies the template deck.
4. `extractAllData_()` reads all slide inputs.
5. **`generateAICommentary_(data)`** — see below.
6. `updateAllSlides_()` fills every slide.

### AI commentary — now reads `Pipeline_Meta!B1` first  ⭐ (this change)
`generateAICommentary_()` resolves the summary in this order:
1. **`readPipelineAISummary_()`** — reads the pre-generated summary from
   `Pipeline_Meta!B1` (what `fetch_data.py` wrote on-network). **Preferred** —
   no GenOS call from Apps Script.
2. **Live GenOS call** — kept as a fallback for manual on-network runs (usually
   403s off-network).
3. **`buildTemplateTLDR_(data)`** — deterministic template built from the numbers
   if both above fail.

```javascript
// src/appsscript/Code.js
const AI_SUMMARY_RANGE = 'Pipeline_Meta!B1';

function readPipelineAISummary_() { /* reads B1, returns trimmed string or '' */ }

function generateAICommentary_(data) {
  var pipelineSummary = readPipelineAISummary_();
  if (pipelineSummary) return pipelineSummary;   // ← preferred path
  // ... else fall back to live GenOS, then buildTemplateTLDR_(data)
}
```

### Weekly automation & freshness gate
`runWeeklyAutomation()` (time-driven trigger) checks `isRawDataFresh_()` — is
`Pipeline_Meta!A1` timestamped **today**? If not, it schedules an **hourly retry**
(`scheduleHourlyRetry_` / `retryWeeklyAutomation`) until the pipeline lands, then
runs `generateWeeklyPresentation()` + `generateAgendaSlides_()`. This is why the
pipeline must finish before the deck runs — the timestamp is the handshake.

### `generateAgendaSlides_()`
Copies the agenda template and fills it from the agenda spreadsheet
(`AGENDA_SPREADSHEET_ID`, range `B4:F15`).

---

## 9. The relay service (`src/relay_service/`) — future

FastAPI service intended to run inside IKS (Intuit network) so Apps Script (or a
cloud scheduler) can call GenOS through it instead of directly. Not required for
the current laptop-run flow, in which `fetch_data.py` already writes the summary
to `Pipeline_Meta!B1`. Full deployment checklist, env vars, and auth-flow detail
are in `src/relay_service/README.md`. Use it if the pipeline ever moves off a
VPN-connected laptop.

---

## 10. Common bugs & fixes

| Symptom | Cause | Fix |
|---|---|---|
| Athena / AWS auth errors, `ExpiredToken` | SSO/AWS token lapsed | Re-run `eiamcli login` **and** `eiamcli getAWSTempCredentials -a 052517444781 -r longtail -p default` |
| GenOS step logs a 401/403 warning, `B1` not updated | `GENOS_APP_SECRET` not exported, off-VPN, or downstream **Identity API (Private)** not enabled | Export the secret, connect VPN, enable the downstream service identity API |
| Deck TLDR is generic, not the AI summary | `Pipeline_Meta!B1` empty (GenOS step skipped/failed) | Fix the GenOS step; deck correctly falls back to the template until then |
| A week "shows nothing" on the dashboard | Missing week header label (e.g. blank `W52`) | v20 interpolates a single interior gap, but **restore the real header label** — totals/section headers reference that cell |
| **Whole tab won't update from `Raw_Data`** (all cells stay forecast/blue) | Week-header row uses a label the parser doesn't recognize, so `getSheetWeekNumbers` falls back to the contiguous `FIRST_WEEK=40` guess and builds `COUNTIFS` for weeks that aren't in `Raw_Data` | Ensure row 5 headers are `W40…`/`WK1…`. The parser now accepts an optional `K` (`/W\s*K?\s*(\d+)/i`); confirm the numbers with **What week is it?** and re-run **Generate All Formulas** |
| Future week flipped to a wrong low "actual" | Cap landed on an old week (stale `Calendar_Cache`) | Set `CURRENT_WEEK_OVERRIDE` to the current week, or re-run the pipeline to refresh the cache; check with **What week is it?** |
| ADV numbers stop updating past some week | Same stale-cap issue | Same fix — override or refresh `Calendar_Cache` |
| Google Sheets 403 in the pipeline | Impersonated SA lacks edit access | Grant `ca-cbr-gcp-gdrive-sa@...` edit on the workbook |
| A cancel account in the wrong team / dropped | Roster spelling drift | Add the exact name form to the FSA Map, or add an `OWNER_TEAM_OVERRIDES` line |

`whatWeekIsIt()` (Dashboard menu) is the first diagnostic to run for any
"wrong week / not updating" problem.

---

## 11. Handover checklist & open items

**Weekly (every Monday):**
- [ ] `eiamcli login` + AWS temp creds.
- [ ] `export GENOS_APP_SECRET=...`, run `fetch_data.py`, confirm `Pipeline_Meta!A1`
      + `B1` updated.
- [ ] Set `CURRENT_WEEK_OVERRIDE` in `Full_Formula_Generator.gs` to this week;
      run **Generate All Formulas**.
- [ ] Update `CURRENT_WEEK` / `CURRENT_WEEK_NUM` in `Code.js`; run the deck.

**On quarter rollover (Q1→Q2→Q3→Q4) or a new fiscal year — see §12 for the full walkthrough.**

**Still to do (from the project notes):**
- [ ] **Mapping document** — a single canonical doc of every `table_type` → dashboard
      row/section → SQL filters (partially captured in §6; finish and link it).
- [ ] Rotate the exposed `GENOS_APP_SECRET` (§5).
- [ ] Longer term: deploy `relay_service` and move the pipeline to a scheduler so
      Monday runs don't depend on a laptop + VPN.

---

## 12. Quarterly / yearly rollover — what to change

When moving to a new quarter (Q1→Q2→Q3→Q4) or a new fiscal year, update these in
order. Nothing rolls over fully automatically — the calendar drives *week
numbers*, but the config constants and the new tab are manual.

**1. `fetch_data.py` (the data pipeline)**
- `FY` — set to the new fiscal year (e.g. `2027`). Only changes on a year rollover (after Q4).
- `QUARTER` — set to the new quarter (`1`–`4`).
- These two scope the whole pull; everything downstream (`Raw_Data`, `Calendar_Cache`) follows automatically.

**2. Create the new dashboard tab**
- Use the Apps Script menu **Canada Dashboard → Roll over to next quarter** (`rolloverToNextQuarter()`).
  It clones the current tab, relabels the week headers + day-counts + the `Q` label
  from `Calendar_Cache`, resets cells to forecast (blue), and regenerates formulas.
- If you build the tab by hand, make sure the week-header row (row 5) is labeled for
  that quarter's weeks. **Both `W40`/`W41…` and `WK1`/`WK2…` formats are accepted** —
  the generator's parser matches an optional `K` (fixed after the FY27 Q1 `WK1`
  headers silently fell back to the wrong week numbers). The labels must be present
  and correct — the generator reads them to build the `COUNTIFS`.

**3. `Full_Formula_Generator.gs` (dashboard formula generator)**
- `DASHBOARD_TAB` — point at the new tab name (e.g. `"E2E FY27 Q2"`). Rollover reminds you but does not set it.
- `VISUALS_TAB` — hardcoded and does **not** follow the rollover; repoint it by hand to the new quarter's visuals tab.
- `CURRENT_WEEK_OVERRIDE` — normally leave `null` (calendar-driven). Only set a week number if `Calendar_Cache` is stale.

**4. `Code.js` (deck generator)**

_Every quarter:_
- `CURRENT_WEEK` / `CURRENT_WEEK_NUM` — the weekly knobs; set to the week you're **reporting** (the last completed week, e.g. `W2` while `W3` is in progress).
- `QUARTER_CONFIG` — add an entry for the new quarter (its `weeks`, `spreadsheetId`, `tabName`). The run auto-selects by matching `CURRENT_WEEK` against each entry's `weeks`.
- `VISUALS_TAB_NAME` — repoint at the new quarter's visuals tab (the one holding the `F149` week-driver cell). A wrong name just no-ops with a log line, but visuals-sourced rows (pipeline, team slides, EMM) go blank.

_Every fiscal year (Q1) — additionally:_
- `FY_LABEL` — the fiscal-year prefix on the tab's **section headers** (`"FY27 Q1 GNS"`, `"FY27 Q1 Payroll"`, …). One change re-points ~10 current-quarter section lookups. Requires the tab's section titles to actually read `FY_LABEL + " " + quarter`.
- `PREV_FY_LABEL` / `PREV_QUARTER` — the **previous-quarter comparison block** shown next to the current quarter (slides 8 / 9 / 13). For a Q1 deck set these to the **prior FY's Q4** (`'FY26'` / `'Q4'`). These drive the source-tab lookups (`pkgQ3Sec`, `q3CanSec`, `pkg9Sec`, `pkgQ3WkCols`), the slide-writer matchers, **and** the automatic header relabel. ⚠ The current tab must actually **contain** that comparison block with data; if it doesn't, those rows go blank.
- `FY_WEEK1_MONDAY` — Monday of fiscal W1 (FY27 = `2026-08-03`). Only used by the automation's auto-week fallback; verify against `Calendar_Cache` if the calendar's W1 differs from the first Monday of August.

_Week-header styles:_ FY27+ tabs label week columns `WK1`…`WK14`; older tabs used `W40`…`W53`. The sheet-reading helpers fold `WKn`↔`Wn` via `wkNorm_()`, so both resolve. Keep `QUARTER_CONFIG` `weeks` in plain-`W` form (`['W1',…]`); `wkNorm_` handles the match to `WK` headers.

_The Slides template is relabeled automatically — no hand-editing:_ The template (`SOURCE_PRESENTATION_ID`) is the FY26 Q4 deck, so its headers are baked in as `W40`…`W53` / `FY26 Q4 …` / `FY26 Q3 …` / `FY25 …`. Because slides 9–13 write data **positionally**, their header text never changes on its own — which is why a rolled-over deck used to still show `W41, W42, …`. `generateWeeklyPresentation` now calls `relabelDeckHeaders_` on the fresh copy **before writing data**, rewriting:
- week columns `W40`…`W53` → the tab's `WK1`…`WK14`,
- current-quarter titles `FY26 Q4 …` → `FY_LABEL + " " + quarter` (`FY27 Q1 …`),
- previous-quarter titles `FY26 Q3 …` → `PREV_FY_LABEL + " " + PREV_QUARTER` (`FY26 Q4 …`), incl. `FY25 Q4 Package GNS` → `FY26 Q4 Package GNS`,
- `FY26 Cancel Type`/`WSB`/`PKGs` and `FY25 PKGs` → the FY27/FY26 equivalents,
- quarter-total column cells `Q4` → `Q1` and `Q3` → `Q4` (exact single-cell match).

All FROM values come from the `TEMPLATE_*` constants; all TO values are derived from `FY_LABEL` / `PREV_*` / `QUARTER_CONFIG`. Only change the `TEMPLATE_*` constants if the template deck itself is rebuilt with different baseline headers. To fix an already-generated deck's visible labels without a full re-run, call `relabelDeckHeadersById(presentationId)` — but prefer re-running `generateWeeklyPresentation`, since slides 6/8 populate by matching header text at generation time.

_Does NOT roll automatically (manual, by design):_
- **Fixed row indices** (`ADV_HDR=128`, `PAY_HDR=245`, `getS9Row_(65)`, …) assume the tab was **cloned** from the previous quarter (same row layout). If the tab was rebuilt, re-verify these against the new tab.

**5. Sanity checks after the first run of the new quarter**
- Run the pipeline, then in Apps Script run **What week is it?** (`whatWeekIsIt()`) to confirm the calendar reports the expected FY/Q/week.
- Run **Generate All Formulas** and confirm completed weeks flip to actual (black) and future weeks stay forecast (blue).

> **Fiscal week numbers reset every fiscal year.** `week_for_year_fy` runs 1–53
> across the FY, so the quarters are roughly **Q1 = W1–13, Q2 = W14–26,
> Q3 = W27–39, Q4 = W40–53.** This is why a new quarter's `Raw_Data` weeks won't
> match the previous quarter's, and why any hardcoded expected-value checks (like
> the old FY26 validation dicts, now removed) must be re-created with the new
> quarter's weeks if you want validation back.

---

## 13. Contacts

| Area | Who |
|------|-----|
| Athena / `longtail` workgroup / data lake | **Roger Hewett** |
| `Raw_Data` structure (LATAM_E2E), ACTIVE_CANCELS manual process / FSA Map | **Stephen** |
| Payroll confirmed-correct numbers | **Olivia** |
| GenOS / Private Auth / IDPS | Intuit GenOS + DevPortal teams |

---

*Data-handling note:* this pipeline processes Canada sales-booking data for
internal sales management. If any output is ever shared with a non-tax product or
team, or combined with other data sources, confirm IRC §7216 consent coverage
first.
