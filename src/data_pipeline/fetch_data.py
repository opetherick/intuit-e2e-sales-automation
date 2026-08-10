"""
fetch_data.py — v23

v23 CHANGE — ACTIVE_CANCELS query rewritten to fix three bugs (see inline
  changelog in build_active_cancels_sql()):
  (1) Historical account owner → CURRENT Salesforce owner via fresh
      sales_account_owner_history join + dim_agent name lookup (no odin_decrypt).
  (2) CTAS staleness → inlines the sh_canada_activations logic directly against
      live source tables (apd_dwh.qbo_accountant_status et al.) so reactivated
      accounts are correctly excluded on every run.
  (3) Future cancel dates → added date(qbo_cancel_date) <= current_date filter
      to eliminate phantom W51/W52 rows.

v22 CHANGE — CALENDAR_CACHE tab (additive, changes no existing logic):
  Lands an aggregated snapshot of sbseg_dm.dim_calendar into a new
  "Calendar_Cache" tab so the Apps Script can (a) tell which fiscal week it is
  today and flip that week's column blue->black, and (b) clone the tab into the
  next quarter with the correct week numbers on quarter/year rollover.
  dim_calendar is daily grain, so we aggregate one row per (year_fy, quarter_fy,
  week_for_year_fy) with MIN/MAX(date_for_day) and COUNT(*) — the count is the
  in-quarter day count that produces the dashboard's "2 days"/"6 days" partial
  weeks. Column aliases match the Apps Script CAL_FIELD config exactly. Reuses
  the existing Athena conn, Sheets service, clean_df and clear_and_write; the
  only touch to existing code is one guarded call added in main().

----------------------------------------------------------------------------
Runs Athena queries (GNS, Payroll, ADV, ADV Upgrades, Signups, PKG_GNS_ACCOUNTANT,
+ 4 PKG types + sub-breakdowns, + ACTIVE_CANCELS), concatenates into one flat
table, and writes to Raw_Data tab.

Raw_Data columns (matches Stephen's LATAM_E2E raw data structure):
  FY, Qtr, FWeek, txn_event_date, Super_Channel, Channel, Region,
  L3_Division, AccountOwner, Event, QBO_ID, TopLevelQBOA, SKU,
  offer_name, Product, distinct_realms, table_type

NOTE: AccountOwner = dim.agt_full_name (confirmed column from
international_analytics.dim_agent schema) for the non-cancels queries. For
ACTIVE_CANCELS it is sh.account_owner (from sh_canada_activations) — this is
the field Stephen VLOOKUPs against the FSA Map roster (confirmed with him:
"compare the account owner name on Qlik to the agent name in the sheet").

The Apps Script reads Raw_Data and uses COUNTIFS on:
  - FWeek       → week column
  - L3_Division → row label (National/Major/Large/DTM/Growth/NBAM/Unmanaged)
  - table_type  → GNS / PAYROLL / ADV / SIGNUP / PKG_GNS_ACCOUNTANT / ACTIVE_CANCELS / etc.

v20 CHANGE — ACTIVE_CANCELS classification reworked to mirror Stephen's actual
  manual process exactly, after inspecting a real W48 export of his + a live
  copy of the FSA Map roster. Three fixes:

  (1) SEGMENT-LABEL BUG (the National shortfall). The roster's National
      segment value is the literal string "NAT" (confirmed in both the roster
      and Stephen's export Team column), but ROSTER_SEGMENT_TO_LABEL only had
      a "National" key — so every "NAT" rep resolved to None and was DROPPED,
      starving the National row (W45 got 12, want 18). Added "NAT" → "National"
      and made the segment lookup case-insensitive.

  (2) REMOVED FUZZY MATCHING. Stephen does NOT fuzzy-match. When a name comes
      in a different order or truncation, he adds that exact form to the roster
      as another row (the roster genuinely contains BOTH "Boonjit Jutharut" and
      "Jutharut Boonjit", BOTH "Gagan Dharwad" and "Gagan Dharwad Moulish", etc).
      So the roster is the single source of truth and exact match reproduces
      him. The token-subset fuzzy fallback was manufacturing false matches
      (a short name being a subset of the wrong person's fuller name), which
      is the most likely driver of the DTM/NBAM over-counts. Matching is now
      exact-only, on a whitespace/case-normalized key. If a real rep isn't
      matching, the fix is to add their name form to the roster (Stephen's own
      method) — the excluded-name diagnostic below surfaces exactly who.

  (3) UNMANAGED RULE. Stephen's raw VLOOKUP returns #N/A for BOTH system/
      integration owners (e.g. "Tigergraph Integration", "Starfleet2
      Integration", "AOH_Placeholder Integration") AND real off-roster humans
      (e.g. "Nancy Ivanov", a Sales Ops manager). The dashboard's Unmanaged
      row (~72 at W45) is the system/integration slice; the real-human #N/A
      rows are dropped ("don't need to be counted", per the roster owner).
      So: unmatched + system-owner  → Unmanaged; unmatched + real human → drop.
      **THIS SPLIT IS AN INFERENCE, NOT CONFIRMED BY STEPHEN** (he was offline).
      His exported sheet shows both groups as #N/A, so the system→Unmanaged
      routing is a manual step we're reconstructing. It is isolated in
      _is_system_owner() / SYSTEM_OWNER_MARKERS so it's a one-line change if
      wrong, and apply_roster_classification() logs every name it routes to
      Unmanaged and every name it drops so the result can be eyeballed against
      the W45 target before trusting it. Replace SYSTEM_OWNER_MARKERS with the
      canonical Salesforce integration/service-account list when available.

  Validate by running W45 (validate() already does this) AND, for a definitive
  check, by loading Stephen's full week export and joining on QBO_ID — a
  per-account diff is the only thing that fully rules out any account_owner
  source/point-in-time difference between this query and his Qlik view.

v17.1 CHANGE — unmatched-but-real names are EXCLUDED, not Unmanaged:
  Confirmed directly with the person who maintains the FSA Map roster: if a
  name isn't on that sheet, the account "doesn't need to be counted" at
  all — e.g. Nancy Ivanov, a Sales Ops manager, showed up repeatedly in
  unmatched-name diagnostics, and is NOT one of the 6 tracked teams.
  So "Unmanaged" is NOT "anyone the roster doesn't recognize" (that was the
  v16.1/v16.3 assumption, and it overcounted Unmanaged by ~2-3x). Unmanaged
  is specifically the literal string 'Unmanaged' that sh_canada_activations
  itself writes when there's no Salesforce owner history match at all.
  Everyone else unmatched (managers, ops roles, reps on untracked teams,
  integration placeholders) is dropped from the ACTIVE_CANCELS output
  entirely — see apply_roster_classification()'s docstring.
  [v20 note: the "integration placeholders are dropped" half of this was
  wrong — they are the Unmanaged population, not exclusions. See v20 above.]

v17 CHANGE — reintroduced the L3 SCOPE filter that v16 accidentally dropped:
  v16 removed the old L3_ALLOWLIST filter entirely on the theory that team
  labeling should come from the roster, not division_l3_name — true, but
  that filter was also doing a SECOND job: gating which accounts count in
  this report AT ALL (sh_canada_activations covers im_region='CanLat', i.e.
  Canada AND LATAM, so without a scope gate, LATAM/other-division reps'
  cancels leak in). Restored as ACTIVE_CANCELS_L3_SCOPE_SQL — a pure scope
  filter now, with ZERO role in team labeling (that's still 100% the
  roster's job via apply_roster_classification()).

v16 CHANGE — team classification switched from division_l3_name to a live
  roster lookup:
  Confirmed with Stephen (who built the source Qlik dashboard) that "team"
  for this metric has NEVER been a division_l3_name filter at all — his
  manual process does a VLOOKUP by AGENT NAME against a separately
  maintained Google Sheet (the "FSA Map" roster), which reflects each rep's
  CURRENT team. Our v14/v15 approach used dim_agent's division_l3_name via
  the CTAS's point-in-time join (a rep's team AS OF the account's original
  activation date) — for reps who've since changed teams, that's a
  different answer than the roster's current-team lookup. Confirmed via
  real W45 data: the old approach put 43 too few accounts in "Large" and 47
  too many in "NBAM" — a swap consistent with reps moving from a
  Large-Firms team onto NBAM after their accounts activated.

  REMOVED: ACTIVE_CANCELS_L3_ALLOWLIST_SQL and ACTIVE_CANCELS_L3_MAP (both
  L3-based, both gone).
  ADDED: ROSTER_SPREADSHEET_ID / ROSTER_GID / ROSTER_SEGMENT_TO_LABEL,
  fetch_roster_mapping() (pulls the live roster via the same Sheets
  credentials already used for reading/writing Raw_Data), and
  apply_roster_classification() (overwrites L3_Division with the roster-
  derived dashboard label, called from main() right after the
  ACTIVE_CANCELS query runs).

  Matching is on exact agent full-name string (dim_agent's decrypted
  Salesforce name vs. the roster's Agent column). If small mismatches
  persist after this change, name-formatting drift between those two
  sources is the most likely remaining cause.

v14/v15 CHANGE — new ACTIVE_CANCELS table_type:
  Added a query against sales_published.sh_canada_activations (a table
  owned/maintained by another team — this script only has READ access to
  it, confirmed via a Lake Formation AccessDeniedException on DROP/CREATE)
  to feed the "FY26 Q4 Active Cancels" dashboard table. This required:

    1. Active Cancels is a cancellation-week metric, not an activation-
       cohort metric — it needs to bucket by the week an account cancelled,
       not the week it activated. sh_canada_activations only carries
       first_login_date's fiscal week (via its own internal calendar join),
       not qbo_cancel_date's. Since we can't alter that table, we join
       sbseg_dm.dim_calendar AGAIN, here, in build_active_cancels_sql()
       itself, matched against qbo_cancel_date. Same pattern build_sql()
       already uses to get txn_event_date's fiscal week — just done at
       query time instead of inside the CTAS. No DDL, no new permissions,
       no dependency on any other team's pipeline.

    2. "Active Cancel" is defined as: an account that passed the CTAS's
       existing activation filter (valid QBOA attach, login before any
       cancel) AND has since cancelled (qbo_cancel_date IS NOT NULL).
       NOTE: the CTAS's own `cancel_flag` column is dead code — its condition
       (first_login_date > qbo_cancel_date) can never be true given the
       activation CTE's WHERE clause, which already requires
       first_login_date < qbo_cancel_date whenever qbo_cancel_date is not
       null. Do not use cancel_flag for this metric; use
       qbo_cancel_date IS NOT NULL directly.

    3. (Superseded by v16 above — Growth/NBAM/Unmanaged/team assignment is
       now roster-based, not division_l3_name-based.)

v13 CHANGE — L3 filter instead of country/channel filter:
  division_l6_name='Canada Sales L6' and channel_aggr_name='HVAM' were being
  used as proxies for "the right team," but both fields can be mistagged at
  the source (rep country tagging, channel tagging) even when the rep's real
  division_l3_name is correct. Per direction from the team: filter directly
  on division_l3_name against the 4 known L3 values instead. This is what the
  master dashboard does, and it's the field we actually group/report by, so
  it should stop the small week-over-week discrepancies vs. the master sheet.

  REMOVED from all query templates:
    sb.division_l6_name = 'Canada Sales L6'
    sb.channel_aggr_name = 'HVAM'
  ADDED to all query templates:
    sb.division_l3_name IN (L3_ALLOWLIST)

  Re-validate against the master sheet (validate() below) after running —
  if the gap doesn't close, or a new one opens up, the HVAM/L6 filters may
  have been doing useful exclusion that the L3 allowlist doesn't replicate,
  and we should revisit.

Confirmed filters (pre-v13, W48 validated against dashboard; L3 swap is new):
  GNS:          offering=QBO,      category=GNS,     event=gns,     product=ANY
  Payroll:      offering=PAYROLL,  category=GNS,     event=gns,     product=ANY  (Core+Premium+Elite summed)
  ADV:          offering=QBO,      category=GNS,     event=gns,     product='QuickBooks Online Advanced'   ← rows 84-87
  ADV_GNS:      offering=QBO,      category=GNS,     event=gns,     product='QuickBooks Online Advanced'   ← rows 130-133
  ADV_UPGRADES: offering=QBO,      category=PRODUCT, event=upgrade, product='QuickBooks Online Advanced'   ← rows 169-172
  Signups:      offering=PAYMENTS, category=SIGNUP,  event=signup,  product=ANY
  PKG_GNS_ACCOUNTANT: event=gns, offer_name LIKE '%accountant%' (broad, any Accountant-named offer)         ← rows 67-70
  PKG_DTM:      event=gns, offer_name LIKE '%13 Month%Accountant Promo%'
  PKG_PA:       event=gns, offer_name LIKE '%10 Month%Accountant Promo%'
  PKG_LEDGER:   event=gns, offer_name LIKE '%Accountant Promo%' + product='QuickBooks Online Ledger'
  PKG_NAM:      event=gns, offer_name LIKE '%19 Month%Accountant Promo%'

Confirmed filters (v23, current):
  ACTIVE_CANCELS: source=sales_published.sh_canada_activations (read-only),
                   filter=qbo_cancel_date IS NOT NULL
                         AND date(qbo_cancel_date) <= current_date,
                   week bucket=computed via dim_calendar join on qbo_cancel_date,
                   owner=sh.account_owner (unchanged from v22 — the field
                     Stephen VLOOKUPs against the FSA Map; replacing it with
                     dim_agent.agt_full_name via current SF owner caused a 75%
                     row-drop because QBOA account owners are often CS managers
                     not on the roster),
                   team label=apply_roster_classification() (Python, unchanged).
                   NOTE: CTAS staleness (Bug 2 — W44/W46 over-count) requires
                     daily CTAS refresh by the owning team to fully resolve.
"""

import logging
import re
import sys
import os
import uuid
from datetime import datetime

import pandas as pd
import requests
from pyathena import connect
from pyathena.pandas.cursor import PandasCursor

import google.auth
import google.auth.impersonated_credentials
from googleapiclient.discovery import build

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

# ── AWS / Athena config ────────────────────────────────────────────────────────
AWS_REGION       = "us-west-2"
S3_STAGING_DIR   = "s3://aws-athena-query-results-052517444781-us-west-2/longtail/"
AWS_PROFILE      = "default"
ATHENA_WORKGROUP = "longtail"
SSL_CERT_FILE    = "/Users/opetherick/.ssl/combined-ca.pem"
os.environ.setdefault("SSL_CERT_FILE", SSL_CERT_FILE)
os.environ.setdefault("REQUESTS_CA_BUNDLE", SSL_CERT_FILE)

# httplib2 builds its SSL context from httplib2.CA_CERTS (not env vars, not
# ssl.create_default_context). Override it to trust the Netskope corporate CA
# before any http connections are made.
import httplib2 as _httplib2
_httplib2.CA_CERTS = SSL_CERT_FILE

# ── Google Sheets config ───────────────────────────────────────────────────────
SPREADSHEET_ID     = "1qp6eTw9nmblHi4_28zZe7gI3shbEFV_LOCl35inQL0Y"
TAB_NAME           = "Raw_Data"
PIPELINE_META_TAB  = "Pipeline_Meta"   # single-cell tab: Apps Script reads this to know data is fresh
CALENDAR_CACHE_TAB = "Calendar_Cache"  # v22: Apps Script reads this like Raw_Data
# v26: persistent per-week freeze store for ACTIVE_CANCELS (see
# apply_active_cancels_freeze()). Locks each fiscal week's active-cancel rows the
# first run after that week closes, so past weeks stop drifting as late-arriving/
# backdated cancels post and accounts reactivate — mirroring Stephen's weekly
# "Week N Prep" snapshot cadence.
ACTIVE_CANCELS_FREEZE_TAB = "ActiveCancels_Freeze"
SCOPES             = ["https://www.googleapis.com/auth/spreadsheets"]
TARGET_SA          = "ca-cbr-gcp-gdrive-sa@intuit-5479772439762953825.iam.gserviceaccount.com"

# ── GenOS / AI summary config ─────────────────────────────────────────────────
# Auth: three-step PrivateAuth+ flow — matches agentfordashappv3/app/service/auth.py
# and the relay service in src/relay_service/ exactly.
#
# The app_secret is NOT stored here.  Set GENOS_APP_SECRET in your shell before
# running (get the value from IDPS / DevPortal for
# managed-items/api-security/private-auth/preProd/appsecret).
# If the env var is absent, the GenOS step is skipped silently (non-fatal).
#
# NETWORK NOTE: this only works when running on Intuit VPN.  If fetch_data.py is
# ever moved to a cloud scheduler, the GenOS call will 403 the same way Apps
# Script does — the relay service (src/relay_service/) is the right fix for that.
GENOS_APP_ID           = "Intuit.sbseganalyticsds.e2eautomationsales"
GENOS_ENDPOINT         = "https://genos-platform-e2e.api.intuit.com/llm/v3/anthropic.claude-sonnet-4-6/chat/completions"
GENOS_EXPERIENCE_ID    = "ecf5d504-ded2-418c-95c3-825cc8342f12"
GENOS_IDENTITY_URL     = "https://identityinternal-e2e.api.intuit.com/signin/graphql"
# Standard E2E test-user mutation — same payload the relay service uses.
GENOS_IDENTITY_PAYLOAD = (
    '{"query":"mutation {\\n    identityTestSignInWithPassword(input: {\\n'
    '        username: \\"iamtestpass_116696787517509\\",\\n'
    '        password: \\"Intuit01-\\",\\n'
    '        tenantId: \\"50000003\\",\\n'
    '        intent: {\\n'
    '            appGroup: \\"QBO\\",\\n'
    '            assetAlias: \\"Intuit.sandbox.sandbox.resttestclient\\"\\n'
    '        }\\n'
    '    }) {\\n'
    '        accessToken\\n'
    '        legacyAuthId\\n'
    '    }\\n'
    '}\\n","variables":{}}'
)
# Cell that Apps Script reads to get the pre-generated summary (tab already managed
# by write_pipeline_timestamp; B1 is adjacent and won't conflict with the timestamp
# in A1).
AI_SUMMARY_CELL = "Pipeline_Meta!B1"

# ── Dashboard config ───────────────────────────────────────────────────────────
FY      = 2027
QUARTER = 1

# ── product_name filter values (confirmed from Databricks W46 validation) ─────
PRODUCT_QBO_ADVANCED   = "QuickBooks Online Advanced"
PRODUCT_QBO_ESSENTIALS = "QuickBooks Online Essentials"
PRODUCT_QBO_LEDGER    = "QuickBooks Online Ledger"
# Payroll includes all 3 SKUs — no product_name filter needed, just offering=PAYROLL

# ── PKG offer_name patterns (confirmed from Databricks — all contain 'Accountant Promo') ──
# DTM  (12-month deal) → offer_name contains '13 Month' + 'Accountant Promo'
# PA   (9-month deal)  → offer_name contains '10 Month' + 'Accountant Promo'
# NAM  (package)       → offer_name contains '19 Month' + 'Accountant Promo'
# Ledger               → product_name = 'QuickBooks Online Ledger' + offer_name contains 'Accountant Promo'
PKG_FILTER_BASE   = "Accountant Promo"
PKG_FILTER_DTM    = "13 Months"
PKG_FILTER_PA     = "10 Months"
PKG_FILTER_NAM    = "19 Months"

# ── L3 name mapping (Athena value → dashboard label) ─────────────────────────
L3_MAP = {
    "National Sales CA L3":       "National",
    "Large Firms Sales CA L3":    "Major",
    "Regional Firms Sales CA L3": "Large",
    "DTM Sales CA L3":            "DTM",
}

# ── L3 allowlist (v13) — the direct team filter, replaces division_l6_name +
#    channel_aggr_name as the "which rows belong to us" gate. ─────────────────
L3_ALLOWLIST_SQL = """(
    'National Sales CA L3',
    'Regional Firms Sales CA L3',
    'Large Firms Sales CA L3',
    'DTM Sales CA L3'
)"""

# ── Active Cancels roster (v16) — Stephen's manual process assigns "team" via
#    a VLOOKUP on AGENT NAME against this separately maintained Google Sheet
#    (the "FSA Map"), NOT via division_l3_name off dim_agent. dim_agent's
#    division_l3_name reflects a rep's team AT THE TIME an account activated
#    (point-in-time join in the CTAS); this roster reflects a rep's CURRENT
#    team. Reps who've since changed teams will disagree between the two —
#    confirmed against real data: our old L3-based classification put 43 too
#    few accounts in "Large" and 47 too many in "NBAM" for W45, a swap
#    consistent with reps having moved from a Large-Firms team onto NBAM
#    since their accounts' original activation dates.
#
ROSTER_SPREADSHEET_ID = "1Kh5oHcLF2s07q6xC2m43mqgzYMgjXAw0YHKXF4Izl_A"
ROSTER_GID = 966029740

# v21 — the FSA Map tab is the full agent directory (SOrder, Segment, Agent,
# Type, Subtype, Active, CorpID, ..., L3, ..., AgentEmail, ...). Two lessons
# baked in here, both verified against Stephen's real W48 export:
#
#   1) Drive the dashboard row off the L3 column, NOT Segment. The Segment
#      column is unreliable — e.g. "Jutharut Boonjit" is Segment=Growth but
#      L3=SB Accountant NBAM Sales CA L3, and Stephen counts him NBAM. L3 is
#      right; Segment is a fallback only when L3 is blank/non-Canada.
#   2) IGNORE the Active flag. Many real, high-volume reps are Active=N
#      (Thomas Nieto, Kiel Roberts, etc.); Stephen's VLOOKUP counts them, so
#      we must load every row regardless of Active.
#
# L3 → dashboard row. Note the deliberate inversion vs. intuition, confirmed
# against Stephen: "Large Firms" is the dashboard's LARGE row, "Regional
# Firms" is the dashboard's MAJOR row.
L3_TO_ROW = {
    "National Sales CA L3":       "National",
    "Regional Firms Sales CA L3": "Major",
    "Large Firms Sales CA L3":    "Large",
    "DTM Sales CA L3":            "DTM",
    "SB Accountant Sales CA L3":  "Growth",
    "SB Accountant NBAM Sales CA L3": "NBAM",
}

# Fallback: Segment → dashboard row, used ONLY when a rep's L3 is blank or a
# non-Canada value (e.g. "Global Sales ROW L3"). Same row meanings as L3.
SEGMENT_TO_ROW = {
    "NAT":       "National",
    "NATIONAL":  "National",
    "REGIONAL":  "Major",
    "LARGE":     "Large",
    "DTM":       "DTM",
    "GROWTH":    "Growth",
    "NBAM":      "NBAM",
}

# ── System / integration owners → Unmanaged (v20) ────────────────────────────
# sh_canada_activations.account_owner is a placeholder/service name (rather than
# a real rep) for accounts with no human owner. These are NOT on the FSA Map
# roster, so Stephen's VLOOKUP returns #N/A for them — but they feed the
# dashboard's "Unmanaged" row, unlike genuine off-roster humans (managers, ops)
# which are dropped. Observed forms in a real export: "Tigergraph Integration",
# "Starfleet2 Integration", "AOH_Placeholder Integration".
# INTERIM heuristic — substring match, case-insensitive. Replace with the
# canonical Salesforce integration/service-account list once available so a
# newly-named integration account can't silently fall through to "excluded".
SYSTEM_OWNER_MARKERS = ("integration", "placeholder")

# Frozen owner→team overrides (v28). Confirmed against Stephen's real W52
# row-level export + his FSA Map Segment tab. These WIN over the roster: they
# bridge name-spelling drift and encode the reps whose Segment≠L3. A value of
# "DROP" excludes an owner entirely. When a new rep misroutes/drops, add a line.
OWNER_TEAM_OVERRIDES = {
    "Amir Jahesh":               "Growth",   # Segment=Growth (FSA L3=Regional is wrong for him)
    "Calie Arantes Sampaio":     "Large",    # data spelling; Segment "Cali Arantes"=Large
    "Bradley OReilly":           "National", # data spelling; Segment "Brad O'Reilly"=NAT
    "Jutharut Boonjit Jutharut": "NBAM",     # Segment list (both spellings)=NBAM
    "Djohar Amrani":             "DTM",      # Segment "Djohar Lydia Amrani"=DTM; recovers ~59 dropped
}



# ── BDO (bulk book-of-business) handling (v23) ──────────────────────────
# A bulk BDO deal must sit ONLY on the manual "NAM BDO" line and be EXCLUDED
# from the package COUNTIFS rows (Ledger / NAM / Package-GNS National /
# Accountant). It is NOT excluded from the top GNS total, which legitimately
# includes it.
#
# Derived from the W50 Raw_Data slice: the BDO realms all carry this
# TopLevelQBOA firm id. Keying on the firm id is precise and won't touch normal
# per-firm promo Ledger/NAM sales. If a FUTURE bulk BDO lands under a different
# firm, add its id to this list — that's the only maintenance point.
BDO_FIRM_IDS = [
    "9130349156669756",   # W50 FY26Q4 — Campbell, Matthew / National Sales CA L3
]

# Rendered into SQL. With the list above this becomes:
#   sb.firm_company_id IN ('9130349156669756')
# If BDO_FIRM_IDS is ever emptied, this collapses to "1 = 0" (a safe no-op that
# excludes nothing), so an empty list can never accidentally strip real sales.
BDO_PREDICATE_SQL = (
    "sb.firm_company_id IN (" + ", ".join(f"'{f}'" for f in BDO_FIRM_IDS) + ")"
    if BDO_FIRM_IDS else "1 = 0"
)

# REMOVED in v19: ACTIVE_CANCELS_L3_SCOPE_SQL. It gated which accounts count
# at all by checking division_l3_name AS OF ORIGINAL ACTIVATION — confirmed
# via real data (Large dropped 91→54 purely from adding this filter back)
# that this stale historical field was excluding real current accounts. The
# roster is now the sole gate for both scope and team labeling — see
# apply_roster_classification().

# ── Expected-value validation (removed) ──────────────────────────────────────
# The hardcoded FY26 Q4 ground-truth dicts (W46_EXPECTED, PAYROLL_WEEKLY_EXPECTED,
# W45_ACTIVE_CANCELS_EXPECTED) were removed when the pipeline rolled to FY27 Q1.
# Those weeks (40–53) no longer exist in an FY27 Q1 pull, so every check reported
# a spurious "got 0, want N". If/when Stephen or Olivia confirm FY27 ground-truth
# totals for a given week, add a new dict here and re-wire validate() in main().


# ── SQL template ───────────────────────────────────────────────────────────────
def build_sql(offering: str, category: str, event_type: str, product_name: str = "") -> str:
    return f"""
SELECT
    cal.year_fy                           AS FY,
    cal.quarter_fy                        AS Qtr,
    cal.week_for_year_fy                  AS FWeek,
    sb.txn_event_date                     AS txn_event_date,
    sb.channel_super_aggr_name            AS Super_Channel,
    sb.channel_aggr_name                  AS Channel,
    CASE WHEN sb.country_name IN (
        'Argentina','Brazil','Chile','Colombia','Mexico','Peru','Anguilla',
        'Antigua And Barbuda','Aruba','Bahamas','Barbados','Belize','Bermuda',
        'Bolivia','Bonaire','Cayman Islands','Costa Rica','Curacao','Dominica',
        'Dominican Republic','Ecuador','El Salvador',
        'Falkland Islands (Malvinas)','French Guiana','Grenada','Guadeloupe',
        'Guatemala','Guyana','Haiti','Honduras','Jamaica','Martinique',
        'Montserrat','Netherlands Antilles','Nicaragua','Panama','Paraguay',
        'Puerto Rico','Saint Barthlemy','Saint Kitts And Nevis','Saint Lucia',
        'Saint Martin (French Part)','Saint Vincent and the Grenadines',
        'Sint Maarten (Dutch Part)',
        'South Georgia And The South Sandwich Islands','Suriname',
        'Trinidad And Tobago','Turks And Caicos Islands','Uruguay','Venezuela',
        'Virgin Islands'
    ) THEN 'LATAM'
    WHEN sb.country_name = 'Canada' THEN 'Canada'
    ELSE 'Other'
    END                                   AS Region,
    sb.division_l3_name                   AS L3_Division,
    dim.agt_full_name                     AS AccountOwner,
    sb.txn_event_date_type                AS Event,
    sb.realm_id                           AS QBO_ID,
    sb.firm_company_id                    AS TopLevelQBOA,
    sb.product_name                       AS SKU,
    sb.offer_name                         AS offer_name,
    sb.ecosystem_offering_name            AS Product,
    1                                     AS distinct_realms
FROM sales_rpt.rpt_sales_booking          AS sb
INNER JOIN international_analytics.dim_agent dim
        ON sb.corp_id = dim.corp_id
LEFT JOIN sbseg_dm.dim_calendar           cal
       ON sb.txn_event_date = cal.date_for_day
WHERE dim.rec_end_date              = DATE '2999-12-31'
  AND cal.year_fy                   = {FY}
  AND cal.quarter_fy                = {QUARTER}
  AND sb.ecosystem_offering_name    = '{offering}'
  AND sb.eco_event_category_name    = '{category}'
  AND sb.txn_event_date_type        = '{event_type}'
  AND sb.division_l3_name IN {L3_ALLOWLIST_SQL}
  {f"AND sb.product_name = '{product_name}'" if product_name else ""}
GROUP BY
    cal.year_fy,
    cal.quarter_fy,
    cal.week_for_year_fy,
    sb.txn_event_date,
    sb.channel_super_aggr_name,
    sb.channel_aggr_name,
    sb.country_name,
    sb.division_l3_name,
    dim.agt_full_name,
    sb.txn_event_date_type,
    sb.realm_id,
    sb.firm_company_id,
    sb.product_name,
    sb.offer_name,
    sb.ecosystem_offering_name
"""

# ── Accountant-channel SQL template (broad "offer_name contains Accountant" filter) ──
def build_accountant_sql(offering: str, category: str, event_type: str, product_name: str = "") -> str:
    """
    Same shape as build_sql, but adds a LOWER(offer_name) LIKE '%accountant%' filter
    instead of the offer_name LIKE patterns used by build_pkg_sql.
    Used for the FY25 Q4 Package GNS table (rows 67-70), table_type = PKG_GNS_ACCOUNTANT.
    """
    return f"""
SELECT
    cal.year_fy                           AS FY,
    cal.quarter_fy                        AS Qtr,
    cal.week_for_year_fy                  AS FWeek,
    sb.txn_event_date                     AS txn_event_date,
    sb.channel_super_aggr_name            AS Super_Channel,
    sb.channel_aggr_name                  AS Channel,
    CASE WHEN sb.country_name IN (
        'Argentina','Brazil','Chile','Colombia','Mexico','Peru','Anguilla',
        'Antigua And Barbuda','Aruba','Bahamas','Barbados','Belize','Bermuda',
        'Bolivia','Bonaire','Cayman Islands','Costa Rica','Curacao','Dominica',
        'Dominican Republic','Ecuador','El Salvador',
        'Falkland Islands (Malvinas)','French Guiana','Grenada','Guadeloupe',
        'Guatemala','Guyana','Haiti','Honduras','Jamaica','Martinique',
        'Montserrat','Netherlands Antilles','Nicaragua','Panama','Paraguay',
        'Puerto Rico','Saint Barthlemy','Saint Kitts And Nevis','Saint Lucia',
        'Saint Martin (French Part)','Saint Vincent and the Grenadines',
        'Sint Maarten (Dutch Part)',
        'South Georgia And The South Sandwich Islands','Suriname',
        'Trinidad And Tobago','Turks And Caicos Islands','Uruguay','Venezuela',
        'Virgin Islands'
    ) THEN 'LATAM'
    WHEN sb.country_name = 'Canada' THEN 'Canada'
    ELSE 'Other'
    END                                   AS Region,
    sb.division_l3_name                   AS L3_Division,
    dim.agt_full_name                     AS AccountOwner,
    sb.txn_event_date_type                AS Event,
    sb.realm_id                           AS QBO_ID,
    sb.firm_company_id                    AS TopLevelQBOA,
    sb.product_name                       AS SKU,
    sb.offer_name                         AS offer_name,
    sb.ecosystem_offering_name            AS Product,
    1                                     AS distinct_realms
FROM sales_rpt.rpt_sales_booking          AS sb
INNER JOIN international_analytics.dim_agent dim
        ON sb.corp_id = dim.corp_id
LEFT JOIN sbseg_dm.dim_calendar           cal
       ON sb.txn_event_date = cal.date_for_day
WHERE dim.rec_end_date              = DATE '2999-12-31'
  AND cal.year_fy                   = {FY}
  AND cal.quarter_fy                = {QUARTER}
  AND sb.ecosystem_offering_name    = '{offering}'
  AND sb.eco_event_category_name    = '{category}'
  AND sb.txn_event_date_type        = '{event_type}'
  AND sb.division_l3_name IN {L3_ALLOWLIST_SQL}
  AND LOWER(sb.offer_name) LIKE '%accountant%'
  {f"AND sb.product_name = '{product_name}'" if product_name else ""}
  AND NOT ({BDO_PREDICATE_SQL})
GROUP BY
    cal.year_fy,
    cal.quarter_fy,
    cal.week_for_year_fy,
    sb.txn_event_date,
    sb.channel_super_aggr_name,
    sb.channel_aggr_name,
    sb.country_name,
    sb.division_l3_name,
    dim.agt_full_name,
    sb.txn_event_date_type,
    sb.realm_id,
    sb.firm_company_id,
    sb.product_name,
    sb.offer_name,
    sb.ecosystem_offering_name
"""



# ── PKG SQL template (uses offer_name LIKE filters instead of offering/category) ──
def build_pkg_sql(pkg_type: str) -> str:
    """
    PKG queries filter on offer_name patterns + event=gns.
    pkg_type controls which LIKE pattern is applied:
      DTM    → offer_name contains '13 Month' AND 'Accountant Promo'
      PA     → offer_name contains '10 Month' AND 'Accountant Promo'
      NAM    → offer_name contains '19 Month' AND 'Accountant Promo'
      LEDGER → offer_name contains 'Accountant Promo' AND product_name = QBO Ledger
    """
    # Base offer_name + product_name filters per pkg_type
    PKG_RULES = {
        # parent rows
        "PKG_DTM":     {"month": PKG_FILTER_DTM,  "product": None,                   "excl_ledger": True },
        "PKG_PA":      {"month": PKG_FILTER_PA,   "product": None,                   "excl_ledger": True },
        "PKG_NAM":     {"month": PKG_FILTER_NAM,  "product": None,                   "excl_ledger": False},
        "PKG_LEDGER":  {"month": None,             "product": PRODUCT_QBO_LEDGER,     "excl_ledger": False},
        # sub-rows (same month filter + specific product)
        "PKG_DTM_ADV": {"month": PKG_FILTER_DTM,  "product": PRODUCT_QBO_ADVANCED,   "excl_ledger": False},
        "PKG_DTM_ESS": {"month": PKG_FILTER_DTM,  "product": PRODUCT_QBO_ESSENTIALS, "excl_ledger": False},
        "PKG_PA_ADV":  {"month": PKG_FILTER_PA,   "product": PRODUCT_QBO_ADVANCED,   "excl_ledger": False},
        "PKG_PA_ESS":  {"month": PKG_FILTER_PA,   "product": PRODUCT_QBO_ESSENTIALS, "excl_ledger": False},
    }
    if pkg_type not in PKG_RULES:
        raise ValueError(f"Unknown pkg_type: {pkg_type}")
    rule = PKG_RULES[pkg_type]

    offer_parts = [f"AND sb.offer_name LIKE '%{PKG_FILTER_BASE}%'"]
    if rule["month"]:
        offer_parts.append(f"AND sb.offer_name LIKE '%{rule['month']}%'")
    if rule["excl_ledger"]:
        offer_parts.append(f"AND sb.product_name != '{PRODUCT_QBO_LEDGER}'")
    offer_filter  = " ".join(offer_parts)
    product_filter = f"AND sb.product_name = '{rule['product']}'" if rule["product"] and not rule["excl_ledger"] and rule["product"] != PRODUCT_QBO_LEDGER else ""
    if rule["product"] == PRODUCT_QBO_LEDGER:
        product_filter = f"AND sb.product_name = '{PRODUCT_QBO_LEDGER}'"
    elif rule["product"] and rule["product"] != PRODUCT_QBO_LEDGER:
        product_filter = f"AND sb.product_name = '{rule['product']}'"

    return f"""
SELECT
    cal.year_fy                           AS FY,
    cal.quarter_fy                        AS Qtr,
    cal.week_for_year_fy                  AS FWeek,
    sb.txn_event_date                     AS txn_event_date,
    sb.channel_super_aggr_name            AS Super_Channel,
    sb.channel_aggr_name                  AS Channel,
    CASE WHEN sb.country_name IN (
        'Argentina','Brazil','Chile','Colombia','Mexico','Peru','Anguilla',
        'Antigua And Barbuda','Aruba','Bahamas','Barbados','Belize','Bermuda',
        'Bolivia','Bonaire','Cayman Islands','Costa Rica','Curacao','Dominica',
        'Dominican Republic','Ecuador','El Salvador',
        'Falkland Islands (Malvinas)','French Guiana','Grenada','Guadeloupe',
        'Guatemala','Guyana','Haiti','Honduras','Jamaica','Martinique',
        'Montserrat','Netherlands Antilles','Nicaragua','Panama','Paraguay',
        'Puerto Rico','Saint Barthlemy','Saint Kitts And Nevis','Saint Lucia',
        'Saint Martin (French Part)','Saint Vincent and the Grenadines',
        'Sint Maarten (Dutch Part)',
        'South Georgia And The South Sandwich Islands','Suriname',
        'Trinidad And Tobago','Turks And Caicos Islands','Uruguay','Venezuela',
        'Virgin Islands'
    ) THEN 'LATAM'
    WHEN sb.country_name = 'Canada' THEN 'Canada'
    ELSE 'Other'
    END                                   AS Region,
    sb.division_l3_name                   AS L3_Division,
    dim.agt_full_name                     AS AccountOwner,
    sb.txn_event_date_type                AS Event,
    sb.realm_id                           AS QBO_ID,
    sb.firm_company_id                    AS TopLevelQBOA,
    sb.product_name                       AS SKU,
    sb.offer_name                         AS offer_name,
    sb.ecosystem_offering_name            AS Product,
    1                                     AS distinct_realms
FROM sales_rpt.rpt_sales_booking          AS sb
INNER JOIN international_analytics.dim_agent dim
        ON sb.corp_id = dim.corp_id
LEFT JOIN sbseg_dm.dim_calendar           cal
       ON sb.txn_event_date = cal.date_for_day
WHERE dim.rec_end_date              = DATE '2999-12-31'
  AND cal.year_fy                   = {FY}
  AND cal.quarter_fy                = {QUARTER}
  AND sb.txn_event_date_type        = 'gns'
  AND sb.division_l3_name IN {L3_ALLOWLIST_SQL}
  {offer_filter}
  {product_filter}
  AND NOT ({BDO_PREDICATE_SQL})
GROUP BY
    cal.year_fy,
    cal.quarter_fy,
    cal.week_for_year_fy,
    sb.txn_event_date,
    sb.channel_super_aggr_name,
    sb.channel_aggr_name,
    sb.country_name,
    sb.division_l3_name,
    dim.agt_full_name,
    sb.txn_event_date_type,
    sb.realm_id,
    sb.firm_company_id,
    sb.product_name,
    sb.offer_name,
    sb.ecosystem_offering_name
"""


# ── Active Cancels SQL template (v23) — three bugs fixed vs v22:
#
#   Bug 1 — HISTORICAL ACCOUNT OWNER (root cause of DTM/NBAM inflation,
#     National/Large deflation).  The CTAS (sh_canada_activations) joins
#     owner-history with "first_login_date BETWEEN start_date AND end_date",
#     so account_owner = whoever owned the account AT ACTIVATION.  Reps who
#     have since changed teams have their accounts mis-classified.  The
#     correct Qlik dashboard runs the underlying query live and uses the
#     CURRENT Salesforce owner.  Fix: a "current_owner" CTE that joins
#     sales_account_owner_history with end_date IS NULL/> current_date,
#     then resolves the name through dim_agent (already decrypted, same
#     pattern as non-cancel queries — no odin_decrypt needed).  COALESCE
#     falls back to sh.account_owner if the Salesforce join misses.
#
#   Bug 2 — CTAS STALENESS (root cause of W44/W46/W47/W49 total over-count).
#     sh_canada_activations is a static snapshot.  W43 totals matched exactly,
#     meaning the table was last refreshed around W43.  Since then, accounts
#     that cancelled and then RE-ACTIVATED have their cancel_date cleared in
#     the live qbo_accountant_status table — Qlik's live query excludes them,
#     but our pipeline still counted them (e.g. W44: 350 vs correct 158).
#     PARTIAL FIX: still reads from sh_canada_activations (no access to
#     apd_dwh.qbo_accountant_status in our Athena profile).  To fully fix,
#     ask the sh_canada_activations owners to refresh the table daily (ideally
#     before the pipeline runs).  The inline CTAS approach is preserved in git
#     history if access is ever granted.
#
#   Bug 3 — FUTURE CANCEL DATES (root cause of W51/W52 phantom data).
#     Some accounts carry forward-dated cancel_dates pre-loaded in the CTAS.
#     Fix: AND date(qbo_cancel_date) <= current_date.
# ─────────────────────────────────────────────────────────────────────────────
def build_active_cancels_sql() -> str:
    """
    Active Cancels v23: reads sh_canada_activations with one targeted fix:
      AND date(qbo_cancel_date) <= current_date
    This eliminates the W51/W52 phantom rows (forward-dated cancellations
    pre-loaded in the CTAS) that appeared in v22.

    AccountOwner = sh.account_owner (unchanged from v22).  The full inline
    approach (bypassing the stale CTAS entirely via apd_dwh.qbo_accountant_status)
    is the correct long-term fix for Bug 1 (team misclassification) and Bug 2
    (total-count over-count for weeks after the last CTAS refresh), but requires
    international_analytics.dim_country to be healthy — that table was in a
    DELTA_LAKE_INVALID_SCHEMA state during testing.  Switch to the inline version
    (see build_active_cancels_sql_inline() below) once the platform is stable.

    Scope + team label still handled downstream in apply_roster_classification().
    """
    return f"""
SELECT
    cal2.year_fy                          AS FY,
    cal2.quarter_fy                       AS Qtr,
    cal2.week_for_year_fy                 AS FWeek,
    sh.qbo_cancel_date                    AS txn_event_date,
    CAST(NULL AS VARCHAR)                 AS Super_Channel,
    CAST(NULL AS VARCHAR)                 AS Channel,
    CASE WHEN sh.country IN (
        'Argentina','Brazil','Chile','Colombia','Mexico','Peru','Anguilla',
        'Antigua And Barbuda','Aruba','Bahamas','Barbados','Belize','Bermuda',
        'Bolivia','Bonaire','Cayman Islands','Costa Rica','Curacao','Dominica',
        'Dominican Republic','Ecuador','El Salvador',
        'Falkland Islands (Malvinas)','French Guiana','Grenada','Guadeloupe',
        'Guatemala','Guyana','Haiti','Honduras','Jamaica','Martinique',
        'Montserrat','Netherlands Antilles','Nicaragua','Panama','Paraguay',
        'Puerto Rico','Saint Barthlemy','Saint Kitts And Nevis','Saint Lucia',
        'Saint Martin (French Part)','Saint Vincent and the Grenadines',
        'Sint Maarten (Dutch Part)',
        'South Georgia And The South Sandwich Islands','Suriname',
        'Trinidad And Tobago','Turks And Caicos Islands','Uruguay','Venezuela',
        'Virgin Islands'
    ) THEN 'LATAM'
    WHEN sh.country = 'Canada' THEN 'Canada'
    ELSE 'Other'
    END                                   AS Region,
    sh.division_l3_name                   AS L3_Division,
    sh.account_owner                      AS AccountOwner,
    'active_cancel'                       AS Event,
    sh.qbo_company_id                     AS QBO_ID,
    sh.qboa_company_id                    AS TopLevelQBOA,
    CAST(NULL AS VARCHAR)                 AS SKU,
    CAST(NULL AS VARCHAR)                 AS offer_name,
    CAST(NULL AS VARCHAR)                 AS Product,
    1                                     AS distinct_realms
FROM sales_published.sh_canada_activations sh
LEFT JOIN sbseg_dm.dim_calendar cal2
       ON date(sh.qbo_cancel_date) = cal2.date_for_day
WHERE sh.qbo_cancel_date IS NOT NULL
  AND date(sh.qbo_cancel_date) <= current_date
  AND cal2.year_fy      = {FY}
  AND cal2.quarter_fy   = {QUARTER}
"""


def build_active_cancels_sql_inline() -> str:
    """
    Live inline version — reads apd_dwh.qbo_accountant_status + qbo_company_status
    directly instead of the pre-materialized sales_published.sh_canada_activations
    snapshot.

    WHY THIS IS THE CORRECT SOURCE (validated via trace_active_cancels.py against
    Stephen's real W48 export — see the v24 comment block in the query below):
      - The snapshot bakes in fiscal_year_age IN (0,1,2), an ACTIVATION-cohort
        gate that excluded ~60% of the true active cancels (every 2015–2022
        activation cohort). Removing it here is the single biggest fix and raised
        id-level agreement with Stephen from 130/388 to 325/388 for W48.
      - Uses qbo_company_status.qbo_active_cancel_date (the active-cancel date,
        vs qbo_passive_cancel_date) and qbo_company_status.qbo_country, so it no
        longer depends on international_analytics.dim_country (which is currently
        DELTA_LAKE_INVALID_SCHEMA and was the reason this never ran before).

    KNOWN RESIDUAL (not yet fixed): still over-counts ~1.5x vs Stephen at the
    total level (W48: 602 vs 388) — a further Qlik-side filter we haven't pinned.
    Confirm the exact Active Cancels filter Stephen applies, then add it below.
    Because of this residual, main() still calls build_active_cancels_sql() (the
    snapshot) until the reconciliation is exact — flip it here once confirmed.

    Team label is still assigned downstream by apply_roster_classification()
    (the historical-owner join here is Bug 1; roster handles current team).
    """
    return f"""
WITH activation AS (
    SELECT
        CAST(qas.qbo_company_id AS VARCHAR(50))      AS qbo_company_id,
        qas.first_login_date,
        qcs.qbo_active_cancel_date                   AS qbo_cancel_date,
        CAST(qas.first_attached_qboa AS VARCHAR(50)) AS qboa_company_id,
        qas.gns_date                                 AS qbo_gns_date,
        qcs.qbo_country                              AS country
    FROM apd_dwh.qbo_accountant_status qas
    JOIN sbseg_dm.qbo_company_status qcs
      ON qas.qbo_company_id = qcs.qbo_company_id
    -- v24 (validated via trace_active_cancels.py against Stephen's real W48
    -- export — raises id-level agreement from 130/388 to 325/388):
    --   (1) fiscal_year_age IN (0,1,2) REMOVED (+ its dim_date_extn join). That
    --       ACTIVATION-cohort gate structurally excluded ~60% of real active
    --       cancels — every 2015–2022 activation cohort was 100% absent. Active
    --       Cancels is a CANCELLATION metric; it must not be gated by how long
    --       ago the account activated.
    --   (2) dim_country DROPPED. It is in a DELTA_LAKE_INVALID_SCHEMA state on
    --       our Athena profile (the reason the old inline query never ran).
    --       qbo_company_status.qbo_country gives Canada directly — no join.
    --   (3) qbo_cancel_date → qbo_company_status.qbo_active_cancel_date. This is
    --       the ACTIVE-cancel date specifically (vs qbo_passive_cancel_date),
    --       which is what Stephen's "Active Cancels" bucket uses.
    -- v25 (per-account profiler on Stephen's real W48 export, _profile*.py):
    --   (4) qbo_channel_aggr_name IN ('Acct Assisted Sales',
    --       'Acct Add Client Wholesale'). 100% of Stephen's 325 agreed W48
    --       accounts fall in exactly these two sub-channels; he has ZERO in
    --       SB / HVAM / Acct Add Client Non-Wholesale / Other. This removed 170
    --       of the 277 W48 over-count (the single biggest fix).
    --   (5) qbo_subscription_type_desc <> 'Trial'. Trial subs were pure
    --       over-count (10 present, 0 in Stephen's list) — never counted as
    --       active cancels.
    -- REMAINING DELTA is point-in-time snapshot drift, NOT a query bug:
    --   * ~63 accounts Stephen has that we don't: 51 have since reactivated
    --     (qbo_active_cancel_date is now NULL in live data); the rest shifted
    --     week. Stephen's "Week 48 Prep" is a frozen export; live tables are
    --     fresher.
    --   * ~89 residual Wholesale over-count are cancels finalized/backdated
    --     into W48 AFTER Stephen froze his snapshot (no categorical
    --     discriminator; only tenure differs).
    WHERE qcs.qbo_country                 = 'Canada'
      AND qcs.qbo_channel_super_aggr_name = 'Accountants'
      AND qcs.qbo_channel_aggr_name       IN ('Acct Assisted Sales', 'Acct Add Client Wholesale')
      AND qcs.qbo_subscription_type_desc  <> 'Trial'
      AND qas.first_attached_qboa         IS NOT NULL
      AND qcs.qbo_active_cancel_date      IS NOT NULL
      AND qas.first_login_date            < qcs.qbo_active_cancel_date
      AND date(qcs.qbo_active_cancel_date) <= current_date
),
activation_with_owner AS (
    SELECT
        a.qbo_company_id,
        a.qbo_cancel_date,
        a.qboa_company_id,
        a.country,
        -- v26: use agent_name ("First Last") not agt_full_name ("Last, First").
        -- The roster (FSA Map) and apply_roster_classification() key on the
        -- "First Last" spelling; agt_full_name's comma-inverted form failed both
        -- exact and token matching, routing every owner to Unmanaged/dropped.
        COALESCE(dim.agent_name, 'Unmanaged')         AS account_owner,
        -- v26 Bug 1 fix: assign the CURRENT owner, not the owner as-of signup.
        -- Stephen classifies by the present-day account owner (FY26AccountOwner),
        -- so the owner-history join no longer filters on
        -- first_login_date BETWEEN start/end; instead we keep every 'Owner'
        -- history row and ROW_NUMBER picks the open one (end_date__c IS NULL →
        -- sorted first via the 2999 sentinel). The as-of-first_login version
        -- surfaced long-departed reps who aren't on the FSA roster, dumping most
        -- accounts into Unmanaged/dropped.
        ROW_NUMBER() OVER (
            PARTITION BY a.qbo_company_id
            ORDER BY CASE WHEN sfaoh.end_date__c IS NULL THEN DATE '2999-12-31'
                          ELSE CAST(sfaoh.end_date__c AS DATE) END DESC,
                     sfaoh.start_date__c DESC
        )                                             AS rn
    FROM activation a
    LEFT JOIN ued_salesforce_dwh.sales_account sfa
           ON a.qboa_company_id = sfa.company_id__c
    LEFT JOIN ued_salesforce_dwh.sales_account_owner_history sfaoh
           ON sfa.id             = sfaoh.account__c
          AND sfaoh.type__c      = 'Owner'
          AND sfaoh.isdeleted    = false
    LEFT JOIN ued_salesforce_dwh.sales_user sfuser
           ON sfuser.id = sfaoh.user__c
    LEFT JOIN international_analytics.dim_agent dim
           ON TRY_CAST(sfuser.federationidentifier AS BIGINT) = CAST(dim.corp_id AS BIGINT)
          AND dim.rec_end_date > current_date          -- current dim_agent record
    WHERE a.qbo_gns_date IS NOT NULL
)
SELECT
    cal2.year_fy                          AS FY,
    cal2.quarter_fy                       AS Qtr,
    cal2.week_for_year_fy                 AS FWeek,
    a.qbo_cancel_date                     AS txn_event_date,
    CAST(NULL AS VARCHAR)                 AS Super_Channel,
    CAST(NULL AS VARCHAR)                 AS Channel,
    CASE WHEN a.country IN (
        'Argentina','Brazil','Chile','Colombia','Mexico','Peru','Anguilla',
        'Antigua And Barbuda','Aruba','Bahamas','Barbados','Belize','Bermuda',
        'Bolivia','Bonaire','Cayman Islands','Costa Rica','Curacao','Dominica',
        'Dominican Republic','Ecuador','El Salvador',
        'Falkland Islands (Malvinas)','French Guiana','Grenada','Guadeloupe',
        'Guatemala','Guyana','Haiti','Honduras','Jamaica','Martinique',
        'Montserrat','Netherlands Antilles','Nicaragua','Panama','Paraguay',
        'Puerto Rico','Saint Barthlemy','Saint Kitts And Nevis','Saint Lucia',
        'Saint Martin (French Part)','Saint Vincent and the Grenadines',
        'Sint Maarten (Dutch Part)',
        'South Georgia And The South Sandwich Islands','Suriname',
        'Trinidad And Tobago','Turks And Caicos Islands','Uruguay','Venezuela',
        'Virgin Islands'
    ) THEN 'LATAM'
    WHEN a.country = 'Canada' THEN 'Canada'
    ELSE 'Other'
    END                                   AS Region,
    CAST(NULL AS VARCHAR)                 AS L3_Division,
    a.account_owner                       AS AccountOwner,
    'active_cancel'                       AS Event,
    a.qbo_company_id                      AS QBO_ID,
    a.qboa_company_id                     AS TopLevelQBOA,
    CAST(NULL AS VARCHAR)                 AS SKU,
    CAST(NULL AS VARCHAR)                 AS offer_name,
    CAST(NULL AS VARCHAR)                 AS Product,
    1                                     AS distinct_realms
FROM activation_with_owner a
LEFT JOIN sbseg_dm.dim_calendar cal2
       ON date(a.qbo_cancel_date) = cal2.date_for_day
WHERE a.rn          = 1
  AND cal2.year_fy  = {FY}
  AND cal2.quarter_fy = {QUARTER}
"""


# ── Calendar cache SQL template (v22) — aggregated snapshot of dim_calendar ──
def build_calendar_cache_sql() -> str:
    """
    One row per (fiscal year, quarter, week) from sbseg_dm.dim_calendar — the
    SAME calendar the main queries already join to (cal.year_fy / quarter_fy /
    week_for_year_fy / date_for_day).

    dim_calendar is DAILY grain (one row per date_for_day), so we aggregate:
      week_start_date / week_end_date = MIN/MAX date in that (fy,qtr,week) slice
      day_count_in_qtr                = number of days of that week that fall
                                        INSIDE the quarter. This is exactly the
                                        dashboard's "2 days" / "6 days" note: a
                                        week straddling a quarter boundary is
                                        split across two quarter_fy values, so
                                        its in-quarter slice has < 7 days (W40
                                        Q4 = 2, W53 Q4 = 6, all others = 7).
                                        Confirmed against Athena for FY26 Q4.

    Column ALIASES are chosen to match the Apps Script CAL_FIELD config exactly
    (fiscal_year / fiscal_quarter / fiscal_week / week_start_date /
    week_end_date / day_count_in_qtr) so the sheet reads with zero extra config.

    Windowed to FY-1 .. FY+1 so the tab stays small but still includes NEXT
    quarter (needed by the Apps Script rollover) and last year (for reference).
    """
    return f"""
SELECT
    year_fy                        AS fiscal_year,
    quarter_fy                     AS fiscal_quarter,
    week_for_year_fy               AS fiscal_week,
    MIN(date_for_day)              AS week_start_date,
    MAX(date_for_day)              AS week_end_date,
    COUNT(DISTINCT date_for_day)   AS day_count_in_qtr
FROM sbseg_dm.dim_calendar
WHERE year_fy BETWEEN {FY - 1} AND {FY + 1}
GROUP BY year_fy, quarter_fy, week_for_year_fy
ORDER BY year_fy, quarter_fy, week_for_year_fy
"""


def _norm_name(name) -> str:
    """Normalize a name for exact matching against the roster: coerce to str,
    treat commas/periods as separators (so the "Last, First" form and initials
    like "J." don't stick to a token), collapse internal whitespace, strip,
    casefold. This is SAFE normalization (matches how Google Sheets VLOOKUP is
    case-insensitive and tolerant of stray spacing) — it never merges two
    genuinely different names, so it is NOT fuzzy matching. Reordered/truncated
    name forms are handled by the roster itself containing each form as its own
    row (Stephen's method) plus the sorted-token key in _tok_key(); dropping the
    comma is what lets "Morgan, Jeffery" reorder-match roster "Jeffery Morgan"."""
    raw = str(name if name is not None else "").replace(",", " ").replace(".", " ").replace("'", "").replace("’", "")
    return " ".join(raw.split()).casefold()


# Pre-normalized override keys for O(1), punctuation-insensitive lookup.
_OWNER_TEAM_OVERRIDES_NORM = {_norm_name(k): v for k, v in OWNER_TEAM_OVERRIDES.items()}


def _is_system_owner(owner: str) -> bool:
    """True if the account_owner is a non-human system/integration/placeholder
    account (→ Unmanaged) rather than a real off-roster person (→ dropped).
    See SYSTEM_OWNER_MARKERS. Also treats the literal 'Unmanaged' string that
    sh_canada_activations writes when there's no Salesforce owner match."""
    o = _norm_name(owner)
    if not o:
        return False
    if o == "unmanaged":
        return True
    return any(marker in o for marker in SYSTEM_OWNER_MARKERS)


def _name_variants(agent_name: str, agent_email: str):
    """The name strings a rep can appear as in sh.account_owner. Stephen's
    Qlik owner uses the RAW spelling ("Boonjit Jutharut", "Gagan Dharwad"),
    while the roster's Agent cell is canonical ("Jutharut Boonjit", "Gagan
    Dharwad Moulish"). The email local-part is the raw first_last spelling
    (boonjit_jutharut → "boonjit jutharut"), which bridges the gap. We index
    on BOTH so exact-normalized matching covers reorders and truncations
    deterministically — no fuzzy matching."""
    variants = []
    if agent_name:
        variants.append(agent_name)
    if agent_email and "@" in agent_email:
        variants.append(agent_email.split("@", 1)[0].replace("_", " "))
    return variants


def _tok_key(name: str):
    """Sorted word-token tuple — a deterministic key that matches pure
    reorderings (e.g. account_owner "Manalo Paolo Milbergh" vs roster "Paolo
    Milbergh Manalo"). Used only when it maps to a single unambiguous row, so
    it can't silently mis-route the way subset/fuzzy matching did."""
    return tuple(sorted(_norm_name(name).split()))


def fetch_roster_mapping(service):
    """
    Pull the FSA Map roster (the full agent directory) live and return:
        (exact, tokmap)
    where
        exact  = { normalized_name : dashboard_row }  keyed on BOTH the Agent
                 cell and the email-local-part spelling of every rep
        tokmap = { sorted_token_tuple : dashboard_row }  for unambiguous
                 reorder matches (ambiguous token keys are dropped)

    Row assignment (v21):
      - Primary: the L3 column via L3_TO_ROW  (L3 is trustworthy; Segment is
        not — e.g. Jutharut Boonjit is Segment=Growth but L3=NBAM).
      - Fallback: the Segment column via SEGMENT_TO_ROW, used only when L3 is
        blank or a non-Canada value (e.g. "Global Sales ROW L3").
      - The Active flag is IGNORED — Active=N reps (Thomas Nieto, etc.) are
        real and Stephen counts them.

    Reads the whole tab (not just A:C) and locates the Segment / Agent / L3 /
    AgentEmail columns by header name, so column reordering on the sheet won't
    break it.
    """
    log.info("Fetching Active Cancels team roster (FSA Map)...")
    meta = service.spreadsheets().get(
        spreadsheetId=ROSTER_SPREADSHEET_ID, fields="sheets.properties"
    ).execute()
    sheet_title = None
    for sheet in meta.get("sheets", []):
        if sheet["properties"].get("sheetId") == ROSTER_GID:
            sheet_title = sheet["properties"]["title"]
            break
    if not sheet_title:
        raise RuntimeError(
            f"Could not find a tab with gid={ROSTER_GID} in the FSA Map roster — "
            "the tab may have been renamed or removed."
        )

    result = service.spreadsheets().values().get(
        spreadsheetId=ROSTER_SPREADSHEET_ID,
        range=f"'{sheet_title}'",  # whole tab — need Segment, Agent, L3, AgentEmail
    ).execute()
    rows = result.get("values", [])
    if not rows:
        raise RuntimeError("FSA Map roster returned no rows — check sheet access.")

    header = rows[0]
    def col(name):
        try:
            return header.index(name)
        except ValueError:
            raise RuntimeError(f"FSA Map roster is missing a '{name}' column.")
    seg_i, agent_i, l3_i, email_i = col("Segment"), col("Agent"), col("L3"), col("AgentEmail")
    need = max(seg_i, agent_i, l3_i, email_i)

    exact, tokmap, tok_ambig = {}, {}, set()
    used_segment_fallback, unmapped = [], []
    n_reps = 0

    for row in rows[1:]:
        if len(row) <= agent_i:
            continue
        agent = (row[agent_i] or "").strip()
        if not agent:
            continue
        segment = (row[seg_i] or "").strip() if len(row) > seg_i else ""
        l3 = " ".join((row[l3_i] or "").split()) if len(row) > l3_i else ""
        email = (row[email_i] or "").strip() if len(row) > email_i else ""

        row_label = L3_TO_ROW.get(l3)
        if row_label is None:
            row_label = SEGMENT_TO_ROW.get(segment.upper())
            if row_label is not None:
                used_segment_fallback.append((agent, segment, l3 or "(blank)"))
        if row_label is None:
            unmapped.append((agent, segment, l3 or "(blank)"))
            continue

        n_reps += 1
        for variant in _name_variants(agent, email):
            exact[_norm_name(variant)] = row_label
            tk = _tok_key(variant)
            if tk in tokmap and tokmap[tk] != row_label:
                tok_ambig.add(tk)
            else:
                tokmap[tk] = row_label

    for tk in tok_ambig:            # ambiguous reorder keys are unusable
        tokmap.pop(tk, None)

    if used_segment_fallback:
        log.info("  roster: %d rep(s) used Segment fallback (L3 blank/non-Canada):",
                 len(used_segment_fallback))
        for agent, seg, l3 in used_segment_fallback[:40]:
            log.info("    %-34s Segment=%-8s L3=%s", agent, seg, l3)
    if unmapped:
        log.warning("  ⚠️  roster: %d rep(s) had neither a mappable L3 nor Segment "
                    "(not loaded):", len(unmapped))
        for agent, seg, l3 in unmapped[:40]:
            log.warning("    %-34s Segment=%-8s L3=%s", agent, seg, l3)

    log.info("  → %d reps loaded (%d name keys, %d token keys)",
             n_reps, len(exact), len(tokmap))
    return exact, tokmap


def classify_owner(owner, roster):
    """v28: frozen override wins; else roster (exact -> token) -> system -> None.
    roster is the (exact, tokmap) tuple from fetch_roster_mapping()."""
    ov = _OWNER_TEAM_OVERRIDES_NORM.get(_norm_name(owner))
    if ov is not None:
        return None if ov == "DROP" else ov
    exact, tokmap = roster
    label = exact.get(_norm_name(owner))
    if label is not None:
        return label
    label = tokmap.get(_tok_key(owner))
    if label is not None:
        return label
    if _is_system_owner(owner):
        return "Unmanaged"
    return None


def apply_roster_classification(df: pd.DataFrame, roster) -> pd.DataFrame:
    """
    Overwrite L3_Division with the dashboard row (National/Major/Large/DTM/
    Growth/NBAM/Unmanaged) for ACTIVE_CANCELS rows, reproducing Stephen's
    VLOOKUP-by-account-owner process. Deterministic, no fuzzy matching:

      1. Exact (normalized) match of AccountOwner against a roster name key
         (Agent cell OR email-local-part spelling) → that rep's row.
      2. Else, sorted-token match (handles pure reorderings) when it resolves
         to a single unambiguous row.
      3. Else, if the owner is a system/integration/placeholder account (or the
         literal 'Unmanaged') → "Unmanaged".
      4. Else (a real person not on the roster) → DROPPED.

    `roster` is the (exact, tokmap) tuple from fetch_roster_mapping().

    Verified against Stephen's real W48 export: this reproduces 41 of 42
    distinct owners with zero join failures. The one exception, Amir Jahesh,
    is a genuine sheet-vs-Stephen disagreement (roster says Regional Firms →
    Major; Stephen tags him Growth) — not fixable in code, only by correcting
    the sheet. Any such rep will show up in the "matched to a team" counts vs
    the week targets in validate(); the system-owner → Unmanaged split is
    still an inference (see SYSTEM_OWNER_MARKERS).
    """
    df = df.copy()
    df["L3_Division"] = df["AccountOwner"].apply(lambda o: classify_owner(o, roster))

    # ── Diagnostics ──────────────────────────────────────────────────────────
    matched_mask   = df["L3_Division"].notna() & (df["L3_Division"] != "Unmanaged")
    unmanaged_mask = df["L3_Division"] == "Unmanaged"
    dropped_mask   = df["L3_Division"].isna()

    log.info(
        "  ACTIVE_CANCELS classification: %d matched to a team, %d → Unmanaged, "
        "%d dropped (off-roster humans)",
        int(matched_mask.sum()), int(unmanaged_mask.sum()), int(dropped_mask.sum()),
    )

    if unmanaged_mask.any():
        log.info("  ACTIVE_CANCELS: owners routed to Unmanaged (name | count):")
        for name, count in df.loc[unmanaged_mask, "AccountOwner"].value_counts().head(40).items():
            log.info("    %-45s %d", name, count)

    if dropped_mask.any():
        log.info(
            "  ACTIVE_CANCELS: %d rows dropped — owner not on roster and not a "
            "system account. If a real REP appears here, they're missing from the "
            "FSA Map tab (top excluded names, name | count):",
            int(dropped_mask.sum()),
        )
        for name, count in df.loc[dropped_mask, "AccountOwner"].value_counts().head(40).items():
            log.info("    %-45s %d", name, count)

    return df[~dropped_mask]


# ── Query definitions ──────────────────────────────────────────────────────────
QUERIES = [
    {
        # Rows 6-9: GNS — all QBO products, gns events
        "label":        "GNS",
        "table_type":   "GNS",
        "offering":     "QBO",
        "category":     "GNS",
        "event_type":   "gns",
        "product_name": "",
    },
    {
        # Rows 106-109: Payroll — all Payroll products (Core + Premium + Elite), gns events
        "label":        "PAYROLL",
        "table_type":   "PAYROLL",
        "offering":     "PAYROLL",
        "category":     "GNS",
        "event_type":   "gns",
        "product_name": "",
    },
    {
        # Rows 84-87: ADV — QBO Advanced SKU only, gns events
        "label":        "ADV",
        "table_type":   "ADV",
        "offering":     "QBO",
        "category":     "GNS",
        "event_type":   "gns",
        "product_name": PRODUCT_QBO_ADVANCED,
    },
    {
        # Rows 130-133: ADV GNS — same filters as ADV (QBO Advanced, gns events)
        "label":        "ADV_GNS",
        "table_type":   "ADV_GNS",
        "offering":     "QBO",
        "category":     "GNS",
        "event_type":   "gns",
        "product_name": PRODUCT_QBO_ADVANCED,
    },
    {
        # Rows 169-172: ADV Upgrades — QBO Advanced SKU, upgrade events
        "label":        "ADV_UPGRADES",
        "table_type":   "ADV_UPGRADES",
        "offering":     "QBO",
        "category":     "PRODUCT",
        "event_type":   "upgrade",
        "product_name": PRODUCT_QBO_ADVANCED,
    },
    {
        # Signups — Payments, signup events
        "label":        "SIGNUP",
        "table_type":   "SIGNUP",
        "offering":     "PAYMENTS",
        "category":     "SIGNUP",
        "event_type":   "signup",
        "product_name": "",
    },
    {
        # Rows 67-70 of "FY25 Q4 Package GNS" table — any offer_name containing "Accountant"
        "label":            "PKG_GNS_ACCOUNTANT",
        "table_type":       "PKG_GNS_ACCOUNTANT",
        "accountant_query": True,
        "offering":         "QBO",
        "category":         "GNS",
        "event_type":       "gns",
        "product_name":     "",
    },
    # PKG queries — parent totals + sub-breakdowns by product
    { "label": "PKG_DTM",     "table_type": "PKG_DTM",     "pkg_type": "PKG_DTM"     },  # row 34
    { "label": "PKG_DTM_ADV", "table_type": "PKG_DTM_ADV", "pkg_type": "PKG_DTM_ADV" },  # row 35
    { "label": "PKG_DTM_ESS", "table_type": "PKG_DTM_ESS", "pkg_type": "PKG_DTM_ESS" },  # row 36
    { "label": "PKG_PA",      "table_type": "PKG_PA",      "pkg_type": "PKG_PA"      },  # row 37
    { "label": "PKG_PA_ADV",  "table_type": "PKG_PA_ADV",  "pkg_type": "PKG_PA_ADV"  },  # row 38
    { "label": "PKG_PA_ESS",  "table_type": "PKG_PA_ESS",  "pkg_type": "PKG_PA_ESS"  },  # row 39
    { "label": "PKG_LEDGER",  "table_type": "PKG_LEDGER",  "pkg_type": "PKG_LEDGER"  },  # row 40
    { "label": "PKG_NAM",     "table_type": "PKG_NAM",     "pkg_type": "PKG_NAM"     },  # row 41
    {
        # FY26 Q4 Active Cancels table — National/Major/Large/DTM/Growth/NBAM/Unmanaged
        "label":      "ACTIVE_CANCELS",
        "table_type": "ACTIVE_CANCELS",
        "custom_sql": True,   # tells main() to call build_active_cancels_sql() directly
    },
]


# ── Athena helpers ─────────────────────────────────────────────────────────────
def get_athena_conn():
    os.environ["AWS_CA_BUNDLE"] = SSL_CERT_FILE
    return connect(
        s3_staging_dir=S3_STAGING_DIR,
        region_name=AWS_REGION,
        work_group=ATHENA_WORKGROUP,
        cursor_class=PandasCursor,
        profile_name=AWS_PROFILE,
    )


def run_query(conn, sql: str, label: str) -> pd.DataFrame:
    log.info("Running query: %s ...", label)
    df = pd.read_sql(sql, conn)
    log.info("  → %d rows returned", len(df))
    return df


def clean_df(df: pd.DataFrame) -> pd.DataFrame:
    df = df.fillna("")
    for col in df.select_dtypes(
        include=["datetime64[ns]", "datetime64[ns, UTC]"]
    ).columns:
        df[col] = df[col].dt.strftime("%Y-%m-%d")
    for col in df.columns:
        if df[col].dtype == object:
            continue
        if pd.api.types.is_float_dtype(df[col]):
            non_empty = df[col][df[col] != ""]
            if len(non_empty) and (non_empty % 1 == 0).all():
                df[col] = df[col].apply(
                    lambda x: str(int(x)) if x != "" else ""
                )
    return df


# ── Validation ─────────────────────────────────────────────────────────────────
def validate(df: pd.DataFrame, table_type: str, week: int, expected: dict, l3_map: dict = None):
    """
    Compares actual row counts (per L3_Division, or per mapped dashboard label
    if l3_map is given) against `expected` for a given table_type + week.

    l3_map, if provided, maps raw L3_Division values to a combined dashboard
    label BEFORE counting. Not currently used by any table_type — ACTIVE_CANCELS
    now writes its final dashboard label directly into L3_Division via
    apply_roster_classification() before this function ever sees it — but
    left in place in case a future table needs to combine multiple raw
    values into one label the way NBAM's two raw division_l3_name values
    used to be combined under the old (now-removed) L3-based approach.
    """
    if not expected:
        log.info("  (no expected values defined for %s yet)", table_type)
        return

    subset = df[
        (df["FWeek"].astype(str) == str(week)) &
        (df["table_type"] == table_type)
    ].copy()

    if l3_map:
        subset["_label"] = subset["L3_Division"].map(l3_map)
        group_col = "_label"
    else:
        group_col = "L3_Division"

    log.info("W%d validation for %s:", week, table_type)
    all_match = True
    for key, target in expected.items():
        actual = len(subset[subset[group_col] == key])
        ok = actual == target
        mark = "✅" if ok else f"❌ got {actual}, want {target}"
        log.info("  %-35s %s", key, mark)
        if not ok:
            all_match = False
    if all_match:
        log.info("  ✅ ALL %s W%d VALUES MATCH", table_type, week)
    else:
        log.warning("  ⚠️  %s W%d has mismatches — check filters", table_type, week)


# ── Google Sheets ──────────────────────────────────────────────────────────────
def get_sheets_service():
    log.info("Authenticating with Google Sheets...")
    source_creds, _ = google.auth.default()
    creds = google.auth.impersonated_credentials.Credentials(
        source_credentials=source_creds,
        target_principal=TARGET_SA,
        target_scopes=SCOPES,
    )
    return build("sheets", "v4", credentials=creds)


def _ensure_grid_size(service, tab: str, need_rows: int, need_cols: int):
    """Grow the tab's grid so a write of need_rows × need_cols fits.

    The Raw_Data tab defaults to a fixed grid (observed: 30001 rows × 26 cols).
    Our combined frame is ~51k rows, so the write ran off the end of the grid
    with 'Range ... exceeds grid limits. Max rows: 30001'. Sheets does NOT
    auto-expand on a values().update() to an out-of-range cell, so we resize
    first via batchUpdate(updateSheetProperties). Grow-only: we take the max of
    current and needed for both dimensions so we never shrink a tab (which
    would delete cells / dashboard formulas below or to the right)."""
    meta = service.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID, fields="sheets.properties"
    ).execute()
    props = None
    for s in meta.get("sheets", []):
        if s["properties"].get("title") == tab:
            props = s["properties"]
            break
    if props is None:
        raise RuntimeError(f"Tab '{tab}' not found when sizing the grid.")

    sheet_id = props["sheetId"]
    grid = props.get("gridProperties", {})
    cur_rows = grid.get("rowCount", 0)
    cur_cols = grid.get("columnCount", 0)
    new_rows = max(cur_rows, need_rows)
    new_cols = max(cur_cols, need_cols)
    if new_rows == cur_rows and new_cols == cur_cols:
        return

    log.info("Resizing '%s' grid %d×%d → %d×%d to fit the write...",
             tab, cur_rows, cur_cols, new_rows, new_cols)
    service.spreadsheets().batchUpdate(
        spreadsheetId=SPREADSHEET_ID,
        body={"requests": [{
            "updateSheetProperties": {
                "properties": {
                    "sheetId": sheet_id,
                    "gridProperties": {"rowCount": new_rows, "columnCount": new_cols},
                },
                "fields": "gridProperties.rowCount,gridProperties.columnCount",
            }
        }]},
    ).execute()


def clear_and_write(service, tab: str, df: pd.DataFrame, chunk_rows: int = 10000):
    """Write df to `tab`. Chunked to avoid the socket write timeout that a
    single ~50k-row request body triggers (that was the TimeoutError in the
    v20 run — an API/transport issue, not a data issue)."""
    log.info("Clearing '%s'...", tab)
    service.spreadsheets().values().clear(
        spreadsheetId=SPREADSHEET_ID, range=tab, body={}
    ).execute()

    header = df.columns.tolist()
    data = df.astype(str).values.tolist()
    total = len(data)

    # Make sure the grid is big enough BEFORE writing (v21 fix): data occupies
    # total+1 rows (header + data) and len(header) columns.
    _ensure_grid_size(service, tab, need_rows=total + 1, need_cols=len(header))

    log.info("Writing %d data rows + 1 header to '%s' in chunks of %d...",
             total, tab, chunk_rows)

    # Header first (row 1).
    service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range=f"{tab}!A1",
        valueInputOption="RAW",
        body={"values": [header]},
    ).execute()

    # Data rows in chunks, each written to its explicit A1 start row (data
    # begins at row 2).
    for i in range(0, total, chunk_rows):
        chunk = data[i:i + chunk_rows]
        start_row = i + 2
        service.spreadsheets().values().update(
            spreadsheetId=SPREADSHEET_ID,
            range=f"{tab}!A{start_row}",
            valueInputOption="RAW",
            body={"values": chunk},
        ).execute()
        log.info("  wrote rows %d–%d / %d", i + 1, i + len(chunk), total)

    n_chunks = (total + chunk_rows - 1) // chunk_rows if total else 0
    log.info("✅ Sheets write done (%d rows in %d chunk(s)).", total, n_chunks)


# ── ACTIVE_CANCELS weekly freeze (v26) ──────────────────────────────────────────
def _get_current_fiscal_week(conn) -> int:
    """Return today's fiscal week within FY/QUARTER, or None if today falls
    outside this fiscal quarter (e.g. the quarter has already ended)."""
    sql = f"""
    SELECT week_for_year_fy AS wk
    FROM sbseg_dm.dim_calendar
    WHERE date_for_day = current_date
      AND year_fy    = {FY}
      AND quarter_fy = {QUARTER}
    LIMIT 1
    """
    df = pd.read_sql(sql, conn)
    if df.empty or pd.isna(df.iloc[0]["wk"]):
        return None
    return int(df.iloc[0]["wk"])


def _read_freeze_store(service) -> pd.DataFrame:
    """Read the persisted freeze tab into a DataFrame (all strings). Returns an
    empty frame if the tab doesn't exist yet or holds only a header."""
    try:
        resp = service.spreadsheets().values().get(
            spreadsheetId=SPREADSHEET_ID, range=ACTIVE_CANCELS_FREEZE_TAB,
        ).execute()
    except Exception as exc:
        log.info("  FREEZE: no existing freeze store (%s)", type(exc).__name__)
        return pd.DataFrame()
    values = resp.get("values", [])
    if len(values) < 2:
        return pd.DataFrame()
    header = values[0]
    rows = [r + [""] * (len(header) - len(r)) for r in values[1:]]
    return pd.DataFrame(rows, columns=header)


def _write_freeze_store(service, df: pd.DataFrame) -> None:
    """Create the freeze tab if needed, then overwrite it with df."""
    try:
        service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={"requests": [{"addSheet": {"properties": {
                "title": ACTIVE_CANCELS_FREEZE_TAB}}}]},
        ).execute()
        log.info("  FREEZE: created tab '%s'.", ACTIVE_CANCELS_FREEZE_TAB)
    except Exception:
        pass  # already exists — fine
    clear_and_write(service, ACTIVE_CANCELS_FREEZE_TAB, df)


def apply_active_cancels_freeze(service, conn, df_fresh: pd.DataFrame) -> pd.DataFrame:
    """Option A — weekly freeze for ACTIVE_CANCELS.

    Stephen's dashboard numbers are point-in-time weekly snapshots (his "Week N
    Prep" files). This pipeline re-queries the whole quarter every run, so closed
    weeks kept drifting upward as late-arriving/backdated cancels posted and
    downward as accounts reactivated (confirmed: W48 fresh diverged +23%, W46 two
    weeks older diverged +196%). No WHERE-clause filter can fix that — the
    divergence is time-dependent, not categorical.

    So we freeze: the current (open) fiscal week is always recomputed fresh; any
    already-closed week is locked to whatever it held the FIRST run after it
    closed and is never recomputed. The lock is persisted in ACTIVE_CANCELS_FREEZE_TAB
    so it survives across runs/machines.

    NOTE: weeks that had already elapsed before this store's first run lock at
    their (already-drifted) live value — live data can't reconstruct their true
    historical snapshot. To match Stephen exactly on those, seed the tab with his
    historical exports. From the first run onward, every newly-closing week locks
    correctly.
    """
    cols = df_fresh.columns.tolist()

    cur_wk = _get_current_fiscal_week(conn)
    if cur_wk is None:
        cur_wk = 999  # quarter is over → every week is closed
        log.info("  FREEZE: current_date is outside FY%d Q%d — all weeks closed.",
                 FY, QUARTER)
    else:
        log.info("  FREEZE: current (open) fiscal week = W%d", cur_wk)

    frozen_all = _read_freeze_store(service)
    if not frozen_all.empty:
        frozen_all = frozen_all.reindex(columns=cols, fill_value="").astype(str)
        cur_q = ((frozen_all["FY"].astype(str) == str(FY)) &
                 (frozen_all["Qtr"].astype(str) == str(QUARTER)))
        frozen_other = frozen_all[~cur_q]                 # other quarters — preserve untouched
        frozen_cur   = frozen_all[cur_q]
    else:
        frozen_other = pd.DataFrame(columns=cols)
        frozen_cur   = pd.DataFrame(columns=cols)

    frozen_weeks = set()
    if not frozen_cur.empty:
        frozen_weeks = set(
            pd.to_numeric(frozen_cur["FWeek"], errors="coerce").dropna().astype(int)
        )

    fw = pd.to_numeric(df_fresh["FWeek"], errors="coerce")
    fresh_open    = df_fresh[fw >= cur_wk]                          # open (+ any future) week → fresh
    fresh_newpast = df_fresh[(fw < cur_wk) & (~fw.isin(frozen_weeks))]  # newly-closed → lock now

    frozen_keep = frozen_cur
    if not frozen_cur.empty:
        frozen_keep = frozen_cur[
            pd.to_numeric(frozen_cur["FWeek"], errors="coerce") < cur_wk
        ]

    # Raw_Data active cancels = locked closed weeks + newly-locked closed weeks + fresh open week
    merged = pd.concat([frozen_keep, fresh_newpast, fresh_open], ignore_index=True)[cols]

    # Persisted store = every closed week for this quarter (+ untouched other quarters)
    mfw = pd.to_numeric(merged["FWeek"], errors="coerce")
    new_store_cur = merged[mfw < cur_wk]
    new_store = pd.concat([frozen_other, new_store_cur], ignore_index=True)[cols]
    _write_freeze_store(service, new_store)

    newly_locked = sorted(set(pd.to_numeric(fresh_newpast["FWeek"], errors="coerce")
                              .dropna().astype(int)))
    log.info(
        "  FREEZE: %d closed-week rows locked (%d newly this run: %s), "
        "%d fresh rows for open week W%d.",
        len(new_store_cur), len(fresh_newpast),
        ",".join(f"W{w}" for w in newly_locked) or "none",
        len(fresh_open), cur_wk,
    )
    return merged


def write_calendar_cache(service, conn) -> None:
    """v22 (additive): land the aggregated dim_calendar snapshot into
    CALENDAR_CACHE_TAB so the Apps Script can (a) flip the current fiscal
    week's column blue->black and (b) clone the tab into the next quarter with
    correct week numbers on rollover.

    Reuses the already-open Athena conn + Sheets service and the existing
    clean_df / clear_and_write helpers, so it touches none of the existing
    query, classification, or Raw_Data logic. Creates the tab on first run
    (idempotent), then writes it exactly like Raw_Data — so single-digit weeks
    come out as bare strings ("1".."9", no leading zero) and dates as
    YYYY-MM-DD, matching what the Apps Script expects."""
    df = run_query(conn, build_calendar_cache_sql(), "CALENDAR_CACHE")

    # Dates → YYYY-MM-DD strings before clean_df (dim_calendar dates can arrive
    # as python date objects that clean_df's datetime64 pass wouldn't catch).
    for c in ("week_start_date", "week_end_date"):
        df[c] = pd.to_datetime(df[c]).dt.strftime("%Y-%m-%d")

    df = clean_df(df)   # whole-number ids → "1" not "1.0"; fills blanks

    # Ensure the tab exists (clear_and_write / _ensure_grid_size expect it to).
    try:
        service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={"requests": [{"addSheet": {"properties": {"title": CALENDAR_CACHE_TAB}}}]},
        ).execute()
        log.info("Created tab '%s'.", CALENDAR_CACHE_TAB)
    except Exception:
        pass  # already exists — fine

    clear_and_write(service, CALENDAR_CACHE_TAB, df)


def write_pipeline_timestamp(service) -> None:
    """Write the current UTC datetime to Pipeline_Meta!A1.

    Apps Script reads this cell to confirm that Raw_Data was refreshed today
    before it starts generating the weekly deck.  A missing or stale value
    causes the trigger to retry hourly rather than run on stale data.

    The tab is created automatically on first run; subsequent calls just
    overwrite A1 with the new timestamp.
    """
    ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    # Ensure the tab exists — create it if not (idempotent: ignore 'already exists').
    try:
        service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={"requests": [{"addSheet": {"properties": {"title": PIPELINE_META_TAB}}}]},
        ).execute()
        log.info("Created tab '%s'.", PIPELINE_META_TAB)
    except Exception:
        pass  # tab already exists — fine

    service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range=f"{PIPELINE_META_TAB}!A1",
        valueInputOption="RAW",
        body={"values": [[ts]]},
    ).execute()
    log.info("✅ Pipeline timestamp written: %s", ts)


# ── GenOS helpers ──────────────────────────────────────────────────────────────

def _genos_iam_ticket(app_id: str, app_secret: str) -> tuple:
    """Exchange app_id + app_secret for a short-lived IAM ticket.

    Calls the Intuit Identity service (E2E) using the standard pre-prod pattern
    from agentfordashappv3 and the relay service.  Returns (legacyAuthId, accessToken).
    """
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": (
            f"Intuit_IAM_Authentication "
            f"intuit_appid={app_id},"
            f"intuit_app_secret={app_secret}"
        ),
    }
    resp = requests.post(
        GENOS_IDENTITY_URL,
        headers=headers,
        data=GENOS_IDENTITY_PAYLOAD,
        timeout=15,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Identity service returned {resp.status_code}: {resp.text[:400]}"
        )
    body = resp.json()
    try:
        result = body["data"]["identityTestSignInWithPassword"]
        return result["legacyAuthId"], result["accessToken"]
    except (KeyError, TypeError) as exc:
        raise RuntimeError(
            f"Unexpected Identity service response: {body!r}"
        ) from exc


def _genos_headers_basic(app_id: str, app_secret: str) -> dict:
    """PrivateAuth Basic: app_id + app_secret only, no IAM ticket.

    Some GenOS E2E environments accept this simpler form.  Tried first.
    """
    return {
        "Authorization": (
            f"Intuit_IAM_Authentication "
            f"intuit_appid='{app_id}',"
            f"intuit_app_secret='{app_secret}'"
        ),
        "intuit_originating_assetalias": app_id,
        "intuit_experience_id": GENOS_EXPERIENCE_ID,
        "intuit_tid": str(uuid.uuid4()),
        "Content-Type": "application/json",
    }


def _genos_headers_full(app_id: str, app_secret: str) -> dict:
    """PrivateAuth+: exchange credentials for an IAM ticket first, then build
    the full header.  Falls back to this when the Basic form returns 401/403.
    """
    userid, token = _genos_iam_ticket(app_id, app_secret)
    return {
        "Authorization": (
            "Intuit_IAM_Authentication "
            f"intuit_appid='{app_id}',"
            f"intuit_app_secret='{app_secret}',"
            "intuit_token_type='IAM-Ticket',"
            f"intuit_userid={userid},"
            f"intuit_token={token}"
        ),
        "intuit_originating_assetalias": app_id,
        "intuit_experience_id": GENOS_EXPERIENCE_ID,
        "intuit_tid": str(uuid.uuid4()),
        "Content-Type": "application/json",
    }


def call_genos(prompt: str) -> str:
    """POST a chat-completions request to GenOS and return choices[0].message.content.

    Auth strategy (two attempts):
      1. PrivateAuth Basic — app_id + app_secret directly to GenOS (no Identity
         service call).  Works in some E2E environments.
      2. PrivateAuth+ full flow — exchange credentials for an IAM ticket via the
         Identity service first (canonical relay-service pattern).

    Reads GENOS_APP_SECRET from the environment.  Raises RuntimeError on failure
    (caught in main() as a non-fatal warning).
    """
    app_secret = os.environ.get("GENOS_APP_SECRET", "")
    if not app_secret:
        raise RuntimeError(
            "GENOS_APP_SECRET env var not set — export it before running. "
            "Get the value from IDPS for "
            "managed-items/api-security/private-auth/preProd/appsecret "
            "(app: Intuit.sbseganalyticsds.e2eautomationsales)."
        )

    payload = {
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a sales operations analyst creating concise executive "
                    "commentary for internal sales leadership decks."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.25,
        "max_tokens": 600,
    }

    # Attempt 1: Basic auth (no Identity service call needed)
    log.info("Calling GenOS (Basic auth attempt)...")
    headers = _genos_headers_basic(GENOS_APP_ID, app_secret)
    resp = requests.post(GENOS_ENDPOINT, headers=headers, json=payload, timeout=60)

    if resp.status_code in (401, 403):
        log.info(
            "GenOS Basic auth returned %s — retrying with full IAM ticket flow...",
            resp.status_code,
        )
        # Attempt 2: Full PrivateAuth+ with IAM ticket
        headers = _genos_headers_full(GENOS_APP_ID, app_secret)
        resp = requests.post(GENOS_ENDPOINT, headers=headers, json=payload, timeout=60)

    if resp.status_code != 200:
        log.error(
            "GenOS request failed: status=%s body=%s",
            resp.status_code,
            resp.text[:500],
        )
        raise RuntimeError(
            f"GenOS returned {resp.status_code}. "
            "If this is 401/403, confirm with the GenOS platform team that "
            f"app '{GENOS_APP_ID}' is authorised on E2E and that the "
            "GENOS_APP_SECRET value is current."
        )

    body = resp.json()
    return body["choices"][0]["message"]["content"]


# ── Prompt helpers (v2) ────────────────────────────────────────────────────────
# Design: the model does NO arithmetic. Every count and every signed change is
# computed here in pandas and passed as a literal string. This eliminates the
# class of error where the model gets a direction or magnitude wrong.

def _signed(n: int) -> str:
    """Pre-signed string so the model never has to reason about direction."""
    return f"+{n}" if n > 0 else (str(n) if n < 0 else "0")


def _weeks_present(combined: pd.DataFrame, table_type: str) -> list:
    sub = combined[combined["table_type"] == table_type]
    wk = pd.to_numeric(sub["FWeek"], errors="coerce").dropna().astype(int)
    return sorted(wk.unique().tolist())


def _weekly_series(combined: pd.DataFrame, table_type: str) -> dict:
    """{fiscal_week -> row count} for one table_type across all weeks."""
    sub = combined[combined["table_type"] == table_type]
    if sub.empty:
        return {}
    wk = pd.to_numeric(sub["FWeek"], errors="coerce").dropna().astype(int)
    return {int(k): int(v) for k, v in wk.value_counts().sort_index().items()}


def _gns_team_series(combined: pd.DataFrame) -> dict:
    """{dashboard_label -> {week -> count}} for GNS.

    GNS rows carry the RAW division_l3_name in L3_Division (build_sql writes it
    raw), so we map through L3_MAP. Contrast with ACTIVE_CANCELS, whose
    L3_Division is already the dashboard label after apply_roster_classification.
    """
    sub = combined[combined["table_type"] == "GNS"].copy()
    sub["_wk"] = pd.to_numeric(sub["FWeek"], errors="coerce")
    out = {}
    for raw_l3, label in L3_MAP.items():
        s = sub.loc[sub["L3_Division"] == raw_l3, "_wk"].dropna().astype(int)
        out[label] = {int(k): int(v) for k, v in s.value_counts().sort_index().items()}
    return out


def _cancels_by_label_week(combined: pd.DataFrame, week: int) -> dict:
    sub = combined[
        (combined["table_type"] == "ACTIVE_CANCELS") &
        (pd.to_numeric(combined["FWeek"], errors="coerce") == week)
    ]
    return {k: int(v) for k, v in sub.groupby("L3_Division").size().items()}


def build_weekly_summary_prompt(combined: pd.DataFrame) -> str:
    """Build a GenOS prompt from `combined` (v2).

    All numbers AND all changes are computed here and passed pre-signed. The
    model is instructed to use them verbatim and to do no arithmetic, and is
    barred from referencing metrics the pipeline does not produce (forecast,
    ITF, ITPY, ADV Mix %, Pipeline Conversion, Client Face Time, Net Attrition).
    """
    # Determine current / prior week — GNS drives it; ACTIVE_CANCELS is fallback.
    gns_weeks = _weeks_present(combined, "GNS")
    driver_weeks = gns_weeks if gns_weeks else _weeks_present(combined, "ACTIVE_CANCELS")
    if not driver_weeks:
        log.info("build_weekly_summary_prompt: no usable rows — skipping GenOS call")
        return ""

    current_week = driver_weeks[-1]
    prior_week = driver_weeks[-2] if len(driver_weeks) >= 2 else None

    def topline(table_type: str):
        """(this_week_count, wow_change_or_None, qtd_count)."""
        series = _weekly_series(combined, table_type)
        cur = series.get(current_week, 0)
        wow = None if prior_week is None else cur - series.get(prior_week, 0)
        qtd = sum(series.values())
        return cur, wow, qtd

    def topline_line(name: str, table_type: str) -> str:
        cur, wow, qtd = topline(table_type)
        wow_txt = "" if wow is None else f", WoW {_signed(wow)}"
        return f"  {name}: {cur} this week{wow_txt}; QTD {qtd}"

    # GNS by team, this week vs last week
    team_series = _gns_team_series(combined)
    team_lines = []
    for label in ("National", "Major", "Large", "DTM"):
        s = team_series.get(label, {})
        cur = s.get(current_week, 0)
        if prior_week is None:
            team_lines.append(f"  {label}: {cur} this week")
        else:
            wow = cur - s.get(prior_week, 0)
            team_lines.append(
                f"  {label}: {cur} this week (last week {s.get(prior_week, 0)}, "
                f"WoW {_signed(wow)})"
            )
    team_block = "\n".join(team_lines)

    # Active Cancels: current week by label
    cancel_labels = ["National", "Major", "Large", "DTM", "Growth", "NBAM", "Unmanaged"]
    cur_cancels = _cancels_by_label_week(combined, current_week)
    cancel_lines = (
        "\n".join(f"  {lab}: {cur_cancels.get(lab, 0)}"
                  for lab in cancel_labels if cur_cancels.get(lab, 0) > 0)
        or "  (none)"
    )

    # Active Cancels: full quarter trend block
    cancels_series = _weekly_series(combined, "ACTIVE_CANCELS")
    if cancels_series:
        weeks_sorted = sorted(cancels_series)
        total_by_week = ", ".join(f"W{w}: {cancels_series[w]}" for w in weeks_sorted)
        avg = round(sum(cancels_series.values()) / len(cancels_series))
        cur_c = cancels_series.get(current_week, 0)
        prior_c = None if prior_week is None else cancels_series.get(prior_week, 0)
        best_w  = min(cancels_series, key=cancels_series.get)
        worst_w = max(cancels_series, key=cancels_series.get)
        wow_c = "" if prior_c is None else f"WoW {_signed(cur_c - prior_c)}; "
        cancels_trend_block = (
            f"Active Cancels total by week this quarter:\n"
            f"  {total_by_week}\n"
            f"  Quarter weekly average: {avg}\n"
            f"  This week (W{current_week}): {cur_c}  "
            f"({wow_c}vs quarter average {_signed(cur_c - avg)})\n"
            f"  Best week (fewest): W{best_w} ({cancels_series[best_w]}); "
            f"Worst week (most): W{worst_w} ({cancels_series[worst_w]})"
        )
    else:
        cancels_trend_block = "Active Cancels: (no data)"

    gns_cur, gns_wow, gns_qtd = topline("GNS")
    gns_wow_txt = "" if gns_wow is None else f" (WoW {_signed(gns_wow)})"

    return (
        "Write a weekly sales results summary for internal Canada Accountant "
        "sales leadership, in the exact TLDR / Bright Spots / Hot Spots format "
        "below.\n\n"
        "STRICT RULES — follow all of them:\n"
        "1. Use ONLY the numbers in this prompt. Do not invent, estimate, or "
        "extrapolate any figure.\n"
        "2. Do NOT do arithmetic. Every change is already computed and signed "
        "for you: a value like '-29' means a decrease, '+31' means an increase. "
        "Never recompute or re-describe the direction of a change yourself.\n"
        "3. This report measures ACTUAL COUNTS and week-over-week (WoW) / "
        "quarter-to-date (QTD) movement only. You have NO forecast, target, "
        "ITF, ITPY, ADV Mix %, Pipeline Conversion, Client Face Time, or Net "
        "Attrition data. Do NOT use any of those words or imply a comparison to "
        "plan/target — there is none here.\n"
        "4. 'Bright Spot' = a team or metric that rose vs last week or leads "
        "QTD. 'Hot Spot' = one that fell vs last week or lags. Base this only "
        "on the signed WoW values and QTD totals given.\n"
        "5. For Active Cancels, remember FEWER cancels is better: a negative "
        "WoW change is GOOD, a positive change is BAD.\n\n"
        f"FY{FY} Q{QUARTER} Week {current_week} — ACTUAL COUNTS "
        f"(prior week = W{prior_week}):\n\n"
        f"GNS (new QBO activations via accountant channel) by team — this week "
        f"vs last week:\n{team_block}\n"
        f"  Total GNS: {gns_cur}{gns_wow_txt}; QTD {gns_qtd}\n\n"
        f"Other table toplines (this week; WoW; QTD):\n"
        f"{topline_line('Payroll GNS', 'PAYROLL')}\n"
        f"{topline_line('Advanced GNS', 'ADV')}\n"
        f"{topline_line('Advanced Upgrades', 'ADV_UPGRADES')}\n"
        f"{topline_line('Signups (Payments)', 'SIGNUP')}\n\n"
        f"Active Cancels this week (W{current_week}) by team:\n{cancel_lines}\n\n"
        f"{cancels_trend_block}\n\n"
        "Format EXACTLY:\n"
        "TLDR:\n"
        "• [2-3 bullets on the week's overall movement, using only the numbers above]\n\n"
        "Bright Spots:\n"
        "• [2-3 bullets]\n\n"
        "Hot Spots:\n"
        "• [1-3 bullets]"
    )


def write_ai_summary(service, summary: str) -> None:
    """Write the AI-generated summary into Pipeline_Meta!B1.

    Apps Script reads this cell in generateAICommentary_() before falling back
    to the template TLDR, so the summary is available the moment the deck runs.
    """
    service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range=AI_SUMMARY_CELL,
        valueInputOption="RAW",
        body={"values": [[summary]]},
    ).execute()
    log.info("✅ AI summary written to %s", AI_SUMMARY_CELL)


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    start = datetime.now()
    log.info("=" * 60)
    log.info("fetch_data.py v23 started at %s", start.isoformat())
    log.info("FY%d Q%d", FY, QUARTER)
    log.info("=" * 60)

    # Sheets service is needed both for the roster lookup (v16) and the final
    # write, so authenticate once up front rather than at the very end.
    service = get_sheets_service()
    roster = fetch_roster_mapping(service)

    conn = get_athena_conn()
    all_frames = []

    for q in QUERIES:
        if q.get("custom_sql"):
            # v26: live inline query (channel + Trial filters, current-owner join,
            # agent_name "First Last"). Validated against Stephen's real W48
            # export — team distribution tracks his dashboard and roster matching
            # resolves 3.6k+ owners. Past-week drift is handled by the weekly
            # freeze (apply_active_cancels_freeze), not by the query.
            sql = build_active_cancels_sql_inline()
        elif "pkg_type" in q:
            sql = build_pkg_sql(q["pkg_type"])
        elif q.get("accountant_query"):
            sql = build_accountant_sql(
                offering=q["offering"],
                category=q["category"],
                event_type=q["event_type"],
                product_name=q["product_name"],
            )
        else:
            sql = build_sql(
                offering=q["offering"],
                category=q["category"],
                event_type=q["event_type"],
                product_name=q["product_name"],
            )
        df = run_query(conn, sql, q["label"])
        df = clean_df(df)
        df["table_type"] = q["table_type"]
        if q["table_type"] == "ACTIVE_CANCELS":
            df = apply_roster_classification(df, roster)
            # v26 Option A: lock closed weeks to their snapshot value; only the
            # current (open) week is recomputed each run. Non-fatal — if the
            # freeze store can't be read/written, fall back to the fresh frame.
            try:
                df = apply_active_cancels_freeze(service, conn, df)
            except Exception as exc:
                log.warning("  FREEZE: skipped (non-fatal): %s", exc)
        all_frames.append(df)

    log.info("Concatenating %d result sets...", len(all_frames))
    combined = pd.concat(all_frames, ignore_index=True)
    log.info("Total rows: %d", len(combined))

    # Expected-value validation against FY26 Q4 ground truth was removed on the
    # FY27 Q1 rollover (see note where the *_EXPECTED dicts used to live). The
    # combined frame is written straight to Sheets; sanity-check by eyeballing the
    # per-table row counts logged above and the dashboard after the run.
    for tt in sorted(combined["table_type"].unique()):
        log.info("  %-22s %d rows", tt, int((combined["table_type"] == tt).sum()))

    # Write to Sheets
    clear_and_write(service, TAB_NAME, combined)

    # v22 additive: land the calendar snapshot for Apps Script (current-week
    # flip + quarter rollover). Non-fatal: a failure here must not block the
    # Raw_Data write that already succeeded above.
    try:
        write_calendar_cache(service, conn)
    except Exception as exc:
        log.warning("Could not write Calendar_Cache (non-fatal): %s", exc)

    # Stamp the pipeline completion time so Apps Script knows Raw_Data is fresh.
    try:
        write_pipeline_timestamp(service)
    except Exception as exc:
        log.warning("Could not write pipeline timestamp (non-fatal): %s", exc)

    # Generate AI weekly summary via GenOS and land it in Pipeline_Meta!B1 so
    # Apps Script can read it instead of calling GenOS directly (which fails
    # because Apps Script runs outside Intuit's network and cannot obtain an IAM
    # ticket).  Non-fatal: a missing GENOS_APP_SECRET or any network error just
    # logs a warning; the deck falls back to buildTemplateTLDR_ as before.
    try:
        prompt = build_weekly_summary_prompt(combined)
        if prompt:
            summary = call_genos(prompt)
            write_ai_summary(service, summary)
    except Exception as exc:
        log.warning("Could not write AI summary (non-fatal): %s", exc)

    elapsed = (datetime.now() - start).total_seconds()
    log.info("=" * 60)
    log.info("Done in %.1f seconds.", elapsed)
    log.info("=" * 60)


if __name__ == "__main__":
    main()