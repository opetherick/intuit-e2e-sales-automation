"""
pipeline_summary.py
-------------------
Standalone script — run it directly:

    python pipeline_summary.py

It will:
  1. Connect to Athena and pull GNS, Runrate ITF, and Opportunities
  2. Load the Finance Forecast from Google Sheets
  3. Build the Team Level View table (all 22 measures)
  4. Write the result to a new tab called "Pipeline" in your Google Sheet

TWO BEST-GUESS MEASURES — validate these against the Qlik dashboard first:
    1. QTD Runrate Forecast  — marked below
    2. Oppty Conv Rate       — marked below
    All other 20 measures are confirmed from the screenshot.

BEFORE FIRST RUN — check these 3 things at the top of the file:
    1. FORECAST_SHEET_ID  — confirm this is your Finance Forecast sheet
    2. FORECAST_TAB_NAME  — confirm the tab name inside that sheet
    3. OUTPUT_SHEET_ID    — where you want the Pipeline table written
                           (defaults to your existing sheet from fetch_data.py)
"""

import logging
import os
import sys
from datetime import date, timedelta

import pandas as pd
from pyathena import connect
from pyathena.pandas.cursor import PandasCursor

import google.auth
import google.auth.impersonated_credentials
from googleapiclient.discovery import build as goog_build
from googleapiclient.errors import HttpError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG  ← edit these before running
# ─────────────────────────────────────────────────────────────────────────────

# Athena — copied from fetch_data.py
AWS_REGION       = "us-west-2"
S3_STAGING_DIR   = "s3://aws-athena-query-results-052517444781-us-west-2/longtail/"
AWS_PROFILE      = "default"
ATHENA_WORKGROUP = "longtail"
SSL_CERT_FILE    = "/Users/opetherick/.ssl/combined-ca.pem"

# Google — service account (same as fetch_data.py)
TARGET_SA = "ca-cbr-gcp-gdrive-sa@intuit-5479772439762953825.iam.gserviceaccount.com"
SCOPES    = ["https://www.googleapis.com/auth/spreadsheets"]

# Finance Forecast input sheet (extracted from Qlik web-connector URL)
# !! CONFIRM this is the right sheet before running !!
FORECAST_SHEET_ID = "1AdS-RFjwLlat_XF3cdhpoa6nRKxDAln952sH8q02xS0"
FORECAST_TAB_NAME = "Sheet1"   # ← update if the tab is named differently

# Output — where the Pipeline table gets written
# Using your existing sheet from fetch_data.py; change if you want a different one
OUTPUT_SHEET_ID  = "1qp6eTw9nmblHi4_28zZe7gI3shbEFV_LOCl35inQL0Y"
OUTPUT_TAB_NAME  = "Pipeline"  # tab will be created if it doesn't exist

# Team column mapping: Google Sheet header → Athena division_l3_name
FORECAST_TEAM_MAP = {
    "Partner QB National-GNS":       "National Sales CA L3",
    "Partner QB Regional Firms-GNS": "Regional Firms Sales CA L3",
    "Partner QB Large Firms-GNS":    "Large Firms Sales CA L3",
    "Partner QB DTM-GNS":            "DTM Sales CA L3",
    "BPO Partner AMs - GNS":         "SB Accountant Sales CA L3",
    "BPO (NBAM) - GNS":              "SB Accountant NBAM Sales CA L3",
}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def get_goog_creds():
    source_creds, _ = google.auth.default(scopes=SCOPES)
    return google.auth.impersonated_credentials.Credentials(
        source_credentials=source_creds,
        target_principal=TARGET_SA,
        target_scopes=SCOPES,
    )

def get_sheets_service():
    return goog_build("sheets", "v4", credentials=get_goog_creds())

def create_athena_conn():
    os.environ["REQUESTS_CA_BUNDLE"] = SSL_CERT_FILE
    return connect(
        s3_staging_dir=S3_STAGING_DIR,
        region_name=AWS_REGION,
        profile_name=AWS_PROFILE,
        work_group=ATHENA_WORKGROUP,
        cursor_class=PandasCursor,
    )

def run_query(sql: str, conn) -> pd.DataFrame:
    return conn.cursor().execute(sql).as_pandas()

def safe_div(num: pd.Series, denom: pd.Series) -> pd.Series:
    return num.div(denom.replace(0, pd.NA)).fillna(0)


# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — Finance Forecast from Google Sheets
# ─────────────────────────────────────────────────────────────────────────────

def get_finance_forecast() -> pd.DataFrame:
    log.info("Loading Finance Forecast from Google Sheets …")
    svc    = get_sheets_service()
    result = svc.spreadsheets().values().get(
        spreadsheetId=FORECAST_SHEET_ID,
        range=FORECAST_TAB_NAME,
    ).execute()

    rows = result.get("values", [])
    if not rows:
        raise ValueError(
            f"Finance Forecast sheet '{FORECAST_TAB_NAME}' returned no data. "
            "Check FORECAST_SHEET_ID and FORECAST_TAB_NAME in the config."
        )

    raw = pd.DataFrame(rows[1:], columns=rows[0])
    raw = raw[raw["year_fy"].astype(str).str.strip().str.len() > 0].copy()
    for col in ("year_fy", "quarter_fy", "Week_FY"):
        raw[col] = pd.to_numeric(raw[col], errors="coerce")

    frames = []
    for sheet_col, team in FORECAST_TEAM_MAP.items():
        if sheet_col not in raw.columns:
            log.warning("Column '%s' not found in Forecast sheet — skipping.", sheet_col)
            continue
        tmp = raw[["year_fy", "quarter_fy", "Week_FY", sheet_col]].copy()
        tmp.columns = ["fcst_fiscal_year", "fcst_fiscal_qtr", "fcst_fiscal_week", "forecast_gns"]
        tmp["team"]        = team
        tmp["forecast_gns"] = pd.to_numeric(tmp["forecast_gns"], errors="coerce").fillna(0)
        frames.append(tmp)

    ff = pd.concat(frames, ignore_index=True)
    log.info("Forecast loaded — %d rows across %d teams.", len(ff), ff["team"].nunique())
    return ff


# ─────────────────────────────────────────────────────────────────────────────
# Step 2 — Fiscal Calendar from Athena
# ─────────────────────────────────────────────────────────────────────────────

def get_fiscal_dates(conn) -> dict:
    log.info("Getting fiscal dates …")
    df  = run_query("""
        select
            date(fiscal_qtr_start_dt)       as qtr_start,
            date(fiscal_qtr_end_dt)         as qtr_end,
            cast(clndr_544_week_nbr as int) as current_week,
            cast(fiscal_qtr_nbr     as int) as current_qtr,
            cast(fiscal_year_nbr    as int) as current_fy
        from dlprd.ent_dim_dwh.dim_date_extn
        where date(clndr_dt) = current_date
        limit 1
    """, conn)
    row       = df.iloc[0]
    today     = date.today()
    qtr_start = pd.to_datetime(row["qtr_start"]).date()
    qtr_end   = pd.to_datetime(row["qtr_end"]).date()
    return {
        "current_fy":      int(row["current_fy"]),
        "current_qtr":     int(row["current_qtr"]),
        "current_week":    int(row["current_week"]),
        "weeks_completed": max(1, (today - qtr_start).days / 7),
        "weeks_remaining": max(0, (qtr_end   - today).days / 7),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Step 3 — QTD GNS from Athena
# ─────────────────────────────────────────────────────────────────────────────

def get_gns(conn) -> pd.DataFrame:
    log.info("Querying QTD GNS …")
    return run_query("""
        with gns as (
          select
            realm_id,
            cast(rsb.corp_id as bigint)         as corp_id_gns,
            sfa2.company_id__c                  as top_level_parent_company_id,
            rsb.prod_fmly_dsc, rsb.product,
            rsb.division_name, rsb.division_l3_name, rsb.division_l4_name,
            rsb.offer_name, epo.src_offer_id,
            cast(rsb.clndr_544_week_nbr as int) as fiscal_week,
            cast(rsb.fiscal_year_nbr    as int) as fiscal_yr,
            cast(rsb.fiscal_qtr_nbr     as int) as fiscal_qtr,
            cast(rsb.fiscal_qtr_age     as int) as fiscal_qtr_age,
            date(rsb.fiscal_qtr_start_dt)       as fiscal_qtr_start_dt,
            case when date_diff('day', fiscal_qtr_start_dt, txn_event_date)
                      between 0 and 28 then 1 else 0 end      as flag_28days,
            case when cast(rsb.clndr_week_age as int) between 1 and  4
                 then 'Y' else 'N' end                        as last_4_week_flag,
            case when cast(rsb.clndr_week_age as int) between 1 and 13
                 then 'Y' else 'N' end                        as last_13_week_flag
          from dlprd.sales_rpt.rpt_sales_booking rsb
          join dlprd.ent_sfdc_b2b_dwh.sf_account sfa
            on rsb.qboa_company_id = sfa.company_id__c
          join dlprd.ent_sfdc_b2b_dwh.sf_account sfa2
            on sfa.top_level_account_text = sfa2.id
          join dlprd.sbseg_dm.dim_eco_product_offer epo
            on rsb.eco_product_offer_key = epo.eco_product_offer_key
          where cast(fiscal_year_age as int) = 0
            and eco_channel_category_name in ('Accountants','Accountant')
            and eco_event_category_name    = 'GNS'
            and rsb.division_l4_name in (
                  'National Sales CA L4',
                  'Accountant Partner Sales CA L4',
                  'SB Accountant Sales CA L4')
            and cast(rsb.fiscal_qtr_age  as int) = 0
            and cast(rsb.clndr_week_age  as int) > 0
        )
        select a.*, a.division_l3_name as team, b.signup_category, b.promotion_name, b.use,
          case
            when a.division_name = 'CA Accountants - Nationals'
                 and a.src_offer_id in ('20059375','20059374','20059373','20059372','20054016','20059718')
              then 'Agent Added'
            when a.division_name = 'CA Accountants - Nationals'
                 and a.src_offer_id not in ('20059375','20059374','20059373','20059372','20054016')
              then 'Runrate'
            when a.division_name <> 'CA Accountants - Nationals' and b.signup_category <> 'AGENT'
              then 'Runrate'
            else 'Agent Added'
          end as gns_type,
          case when a.product = 'Advanced' then 1 else 0 end  as advanced_flag,
          case when a.prod_fmly_dsc in ('QUICKBOOKS ONLINE PAYROLL','QUICKBOOKS ASSISTED OL PAYROLL')
               then 1 else 0 end                              as payroll_flag,
          case when a.prod_fmly_dsc = 'QUICKBOOKS ONLINE EDITION'
               then 1 else 0 end                              as qbo_flag
        from gns a
        left join dlprd.sales_published.cfd_insights_ca_offer b
          on cast(a.src_offer_id as varchar) = cast(b.offer_id as varchar)
    """, conn)


# ─────────────────────────────────────────────────────────────────────────────
# Step 4 — Runrate ITF (L13 weeks) from Athena
# ─────────────────────────────────────────────────────────────────────────────

def get_runrate_itf(conn) -> pd.DataFrame:
    log.info("Querying Runrate ITF (L13 weeks) …")
    return run_query("""
        with gns as (
          select realm_id, cast(rsb.corp_id as bigint) as corp_id_gns,
            sfa2.company_id__c as top_level_parent_company_id,
            rsb.prod_fmly_dsc, rsb.product, rsb.division_name,
            rsb.division_l3_name, rsb.division_l4_name,
            rsb.offer_name, epo.src_offer_id,
            cast(rsb.clndr_544_week_nbr as int) as fiscal_week,
            cast(rsb.fiscal_year_nbr    as int) as fiscal_yr,
            cast(rsb.fiscal_qtr_nbr     as int) as fiscal_qtr,
            cast(rsb.fiscal_qtr_age     as int) as fiscal_qtr_age,
            date(rsb.fiscal_qtr_start_dt)       as fiscal_qtr_start_dt,
            case when date_diff('day', fiscal_qtr_start_dt, txn_event_date)
                      between 0 and 28 then 1 else 0 end     as flag_28days,
            case when cast(rsb.clndr_week_age as int) between 1 and  4
                 then 'Y' else 'N' end                       as last_4_week_flag,
            case when cast(rsb.clndr_week_age as int) between 1 and 13
                 then 'Y' else 'N' end                       as last_13_week_flag
          from dlprd.sales_rpt.rpt_sales_booking rsb
          join dlprd.ent_sfdc_b2b_dwh.sf_account sfa
            on rsb.qboa_company_id = sfa.company_id__c
          join dlprd.ent_sfdc_b2b_dwh.sf_account sfa2
            on sfa.top_level_account_text = sfa2.id
          join dlprd.sbseg_dm.dim_eco_product_offer epo
            on rsb.eco_product_offer_key = epo.eco_product_offer_key
          where cast(fiscal_year_age as int) = 0
            and eco_channel_category_name in ('Accountants','Accountant')
            and eco_event_category_name    = 'GNS'
            and rsb.division_l4_name in (
                  'National Sales CA L4',
                  'Accountant Partner Sales CA L4',
                  'SB Accountant Sales CA L4')
            and cast(rsb.clndr_week_age as int) between 1 and 13
        ),
        final as (
          select a.*,
            case when product       = 'Advanced'                   then 1 else 0 end as adv_flag,
            case when prod_fmly_dsc = 'QUICKBOOKS ONLINE EDITION'  then 1 else 0 end as qbo_flag,
            case when prod_fmly_dsc = 'QUICKBOOKS ONLINE PAYROLL'  then 1 else 0 end as payroll_flag,
            a.division_l3_name as team,
            b.signup_category, b.promotion_name, b.use,
            case
              when a.division_name = 'CA Accountants - Nationals'
                   and a.src_offer_id in ('20059375','20059374','20059373','20059372','20054016','20059718')
                then 'Agent Added'
              when a.division_name = 'CA Accountants - Nationals'
                   and a.src_offer_id not in ('20059375','20059374','20059373','20059372','20054016')
                then 'Runrate'
              when a.division_name <> 'CA Accountants - Nationals' and b.signup_category <> 'AGENT'
                then 'Runrate'
              else 'Agent Added'
            end as gns_type
          from gns a
          left join dlprd.sales_published.cfd_insights_ca_offer b
            on cast(a.src_offer_id as varchar) = cast(b.offer_id as varchar)
        )
        select team, 'QBO' as rr_type,
               count(distinct case when gns_type = 'Runrate' then realm_id end) as rr_gns,
               count(distinct realm_id) as total_gns
        from final where qbo_flag = 1 group by 1, 2
        union all
        select team, 'Advanced' as rr_type,
               count(distinct case when gns_type = 'Runrate' then realm_id end) as rr_gns,
               count(distinct realm_id) as total_gns
        from final where adv_flag = 1 group by 1, 2
        union all
        select team, 'Payroll' as rr_type,
               count(distinct case when gns_type = 'Runrate' then realm_id end) as rr_gns,
               count(distinct realm_id) as total_gns
        from final where payroll_flag = 1 group by 1, 2
    """, conn)


# ─────────────────────────────────────────────────────────────────────────────
# Step 5 — Opportunities from Athena
# ─────────────────────────────────────────────────────────────────────────────

def get_opportunities(conn) -> pd.DataFrame:
    log.info("Querying Opportunities …")
    return run_query("""
        with q as (
          USING EXTERNAL FUNCTION decrypt(ciphertext VARCHAR, keyName VARCHAR)
            RETURNS VARCHAR LAMBDA 'odin-athena-udf'
          select sfo.id, sfo.accountid,
            decrypt(sfa.name, 'IACI/SALESFORCE/KEY_IDPS_SALESFORCE') as company_name,
            sfa2.company_id__c as top_parent_company_id,
            sfo.stagename, sfo.amount, sfo.probability, sfo.closedate,
            sfo.isclosed, sfo.iswon,
            cast(sfo.createddate as date) as createddate,
            decrypt(sfu.name, 'IACI/SALESFORCE/KEY_IDPS_SALESFORCE') as user_name,
            cast(sfu.federationidentifier as bigint) as corp_id,
            sfu.division,
            da.division_l3_name as team,
            case when sfo.stagename in ('Closed Won','Closed Lost')
                 then 'Closed' else 'Open' end as oppty_status,
            case when date_diff('day', date(sfo.createddate), current_date) between 0 and 60
                 then 'Y' else 'N' end as oppty_0_60day_flag,
            sfol.quantity, sfol.totalprice,
            cal.fiscal_year_nbr, cal.fiscal_qtr_nbr, cal.fiscal_year_age,
            case
              when regexp_like(lower(sfp.name), 'advanced') then 'Advanced'
              when regexp_like(lower(sfp.name), 'payroll')  then 'Payroll'
              when sfp.name is null                          then 'No Product Line'
              when regexp_like(lower(sfp.name), 'tsheets')  then 'Tsheets'
              else 'QBO'
            end as oppty_product_group,
            case when sfo.stagename in ('Commit','Value') then 1 else 0 end as latestage_flag
          from dlprd.ued_salesforce_dwh.sales_opportunity sfo
          join dlprd.ued_salesforce_dwh.sales_user sfu on sfo.ownerid = sfu.id
          join dlprd.ued_salesforce_dwh.sales_account sfa on sfo.accountid = sfa.id
          join dlprd.ent_dim_dwh.dim_date_extn cal on date(sfo.closedate) = date(cal.clndr_dt)
          join dlprd.ent_dim_dwh.dim_date_extn dde on date(sfo.createddate) = date(dde.clndr_dt)
          join dlprd.ued_salesforce_dwh.sales_account sfa2 on sfa.TOP_LEVEL_ACCOUNT__C = sfa2.id
          left join dlprd.ued_salesforce_dwh.sales_opportunitylineitem sfol
            on sfo.id = sfol.opportunityid
          left join dlprd.ued_salesforce_dwh.sales_pricebookentry sfp
            on sfol.pricebookentryid = sfp.id
          join dlprd.international_analytics.dim_agent da
            on cast(sfu.federationidentifier as bigint) = cast(da.corp_id as bigint)
            and date(sfo.closedate) between da.rec_start_date and da.rec_end_date
          where cast(dde.fiscal_year_age as int) in (0, 1)
            and sfu.federationidentifier <> '5000sdm'
            and da.division_l4_name in (
                  'National Sales CA L4',
                  'Accountant Partner Sales CA L4',
                  'SB Accountant Sales CA L4')
            and (sfol.ISDELETED = false or sfol.isdeleted is null)
            and lower(sfp.name) not like '%upgrade%'
        )
        select distinct * from q
    """, conn)


# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — Build the summary table (all 22 measures)
# ─────────────────────────────────────────────────────────────────────────────

def build_team_summary(conn) -> pd.DataFrame:
    fdates = get_fiscal_dates(conn)
    gns    = get_gns(conn)
    rr_itf = get_runrate_itf(conn)
    oppty  = get_opportunities(conn)
    ff     = get_finance_forecast()

    current_fy  = fdates["current_fy"]
    current_qtr = fdates["current_qtr"]
    current_wk  = fdates["current_week"]
    weeks_rem   = fdates["weeks_remaining"]

    # QTD GNS
    qtd_gns = gns.groupby("team")["realm_id"].nunique().rename("QTD GNS")
    qtd_runrate_gns = (
        gns[gns["gns_type"] == "Runrate"]
           .groupby("team")["realm_id"].nunique()
           .rename("QTD Runrate GNS")
    )

    # Finance Forecast
    ff_qtr = (
        ff[(ff["fcst_fiscal_year"] == current_fy) & (ff["fcst_fiscal_qtr"] == current_qtr)]
          .groupby("team")["forecast_gns"].sum().rename("Total Finance Fcst")
    )
    ff_qtd = (
        ff[(ff["fcst_fiscal_year"] == current_fy) &
           (ff["fcst_fiscal_qtr"]  == current_qtr) &
           (ff["fcst_fiscal_week"] <= current_wk)]
          .groupby("team")["forecast_gns"].sum().rename("QTD Forecast")
    )

    # Avg weekly RR from Runrate ITF (QBO, L13 weeks)
    rr_qbo = rr_itf[rr_itf["rr_type"] == "QBO"].set_index("team")[["rr_gns", "total_gns"]]
    avg_weekly_rr = (rr_qbo["rr_gns"] / 13).rename("Avg weekly RR (L13 weeks)")

    # Oppty Conv Rate — *** BEST GUESS: 60-day closed-won rate ***
    # Validate this column against the Qlik dashboard before relying on it
    sixty_days_ago = date.today() - timedelta(days=60)
    oppty["closedate"] = pd.to_datetime(oppty["closedate"]).dt.date
    oppty_60 = oppty[oppty["closedate"] >= sixty_days_ago]
    conv_rate = (
        oppty_60.groupby("team")
                .apply(lambda x: x["iswon"].sum() / max(x["isclosed"].sum(), 1))
                .rename("Oppty Conv Rate")
    )

    # QTG Open Opptys
    qtg_open_opptys = (
        oppty[oppty["oppty_status"] == "Open"]
             .groupby("team")["id"].nunique()
             .rename("QTG Open Opptys")
    )

    # Assemble
    s = pd.concat([qtd_gns, qtd_runrate_gns, ff_qtd, ff_qtr,
                   avg_weekly_rr, conv_rate, qtg_open_opptys], axis=1).fillna(0)

    # QTD Runrate Forecast — *** BEST GUESS: QTD Forecast × L13 runrate rate ***
    # Validate this column against the Qlik dashboard before relying on it
    rr_rate = safe_div(rr_qbo["rr_gns"], rr_qbo["total_gns"])
    s["QTD Runrate Forecast"] = (s["QTD Forecast"] * rr_rate).fillna(0).round(0)

    # All confirmed derived measures
    s["QTD Pipeline GNS"]      = s["QTD GNS"]      - s["QTD Runrate GNS"]
    s["QTD Pipeline Forecast"] = s["QTD Forecast"]  - s["QTD Runrate Forecast"]
    s["QTD RR%"]               = safe_div(s["QTD Runrate GNS"],      s["QTD GNS"])
    s["QTD Forecast RR%"]      = safe_div(s["QTD Runrate Forecast"], s["QTD Forecast"])
    s["QTD ITF"]               = safe_div(s["QTD GNS"],              s["QTD Forecast"])
    s["QTD Runrate ITF"]       = safe_div(s["QTD Runrate GNS"],      s["QTD Runrate Forecast"])
    s["QTD Pipeline ITF"]      = safe_div(s["QTD Pipeline GNS"],     s["QTD Pipeline Forecast"])
    s["QTG GNS"]               = s["Total Finance Fcst"]             - s["QTD GNS"]
    s["QTG Fcst Runrate"]      = (s["Avg weekly RR (L13 weeks)"]     * weeks_rem).round(0)
    s["QTG Fcst Opptys"]       = (s["QTG Open Opptys"] * s["Oppty Conv Rate"]).round(0)
    s["QTG Fcst GNS"]          = s["QTG Fcst Runrate"]               + s["QTG Fcst Opptys"]
    s["Total Fcst GNS"]        = s["QTD GNS"]                        + s["QTG Fcst GNS"]
    s["Fcst Gap"]               = s["Total Fcst GNS"]                 - s["Total Finance Fcst"]
    s["Fcst ITF"]               = safe_div(s["Total Fcst GNS"],       s["Total Finance Fcst"])

    s = s.reset_index().rename(columns={"team": "Team"})

    col_order = [
        "Team",
        "QTD GNS", "QTD Forecast", "QTD ITF",
        "QTD Runrate GNS", "QTD Pipeline GNS",
        "QTD RR%", "QTD Forecast RR%",
        "QTD Runrate Forecast", "QTD Runrate ITF",
        "QTD Pipeline Forecast", "QTD Pipeline ITF",
        "QTG GNS", "QTG Open Opptys", "Oppty Conv Rate",
        "Avg weekly RR (L13 weeks)",
        "QTG Fcst Runrate", "QTG Fcst Opptys", "QTG Fcst GNS",
        "Total Finance Fcst", "Total Fcst GNS",
        "Fcst Gap", "Fcst ITF",
    ]
    return s[[c for c in col_order if c in s.columns]]


# ─────────────────────────────────────────────────────────────────────────────
# Step 7 — Write result to Google Sheets
# ─────────────────────────────────────────────────────────────────────────────

def ensure_tab_exists(svc, spreadsheet_id: str, tab_name: str) -> None:
    """Create the output tab if it doesn't already exist."""
    meta = svc.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    existing = [s["properties"]["title"] for s in meta["sheets"]]
    if tab_name not in existing:
        log.info("Creating new tab '%s' …", tab_name)
        svc.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": [{"addSheet": {"properties": {"title": tab_name}}}]},
        ).execute()

def export_to_sheets(df: pd.DataFrame) -> None:
    log.info("Writing %d rows to '%s' → '%s' …", len(df), OUTPUT_SHEET_ID, OUTPUT_TAB_NAME)
    svc = get_sheets_service()
    ensure_tab_exists(svc, OUTPUT_SHEET_ID, OUTPUT_TAB_NAME)

    # Round percentages to 1 decimal, everything else to whole numbers
    pct_cols = [c for c in df.columns if "%" in c or c in ("QTD ITF", "Oppty Conv Rate",
                                                             "QTD Runrate ITF", "QTD Pipeline ITF",
                                                             "Fcst ITF")]
    out = df.copy()
    for col in out.columns:
        if col == "Team":
            continue
        if col in pct_cols:
            out[col] = out[col].round(3)   # keep as decimal (0.46) — format in Sheets
        else:
            out[col] = out[col].round(0).astype(int)

    values = [out.columns.tolist()] + out.values.tolist()

    # Clear existing content then write fresh
    svc.spreadsheets().values().clear(
        spreadsheetId=OUTPUT_SHEET_ID,
        range=OUTPUT_TAB_NAME,
    ).execute()
    svc.spreadsheets().values().update(
        spreadsheetId=OUTPUT_SHEET_ID,
        range=f"{OUTPUT_TAB_NAME}!A1",
        valueInputOption="RAW",
        body={"values": values},
    ).execute()
    log.info("Done — data written to tab '%s'.", OUTPUT_TAB_NAME)


# ─────────────────────────────────────────────────────────────────────────────
# Entry point — runs when you do: python pipeline_summary.py
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("=== Pipeline Summary starting ===")
    conn = create_athena_conn()
    df   = build_team_summary(conn)
    log.info("Summary built — %d teams.", len(df))
    print(df.to_string(index=False))          # preview in terminal
    export_to_sheets(df)
    log.info("=== Done ===")