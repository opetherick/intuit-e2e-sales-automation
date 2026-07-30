SELECT
    cal.year_fy                           AS FY,
    cal.quarter_fy                        AS Qtr,
    cal.week_for_year_fy                  AS FWeek,
    sb.txn_event_date,
    sb.channel_super_aggr_name            AS Super_Channel,
    sb.channel_aggr_name                  AS Channel,
    CASE WHEN sb.country_name IN (
        'Argentina','Brazil','Chile','Colombia','Mexico','Peru','Anguilla','Antigua And Barbuda','Aruba','Bahamas','Barbados','Belize','Bermuda','Bolivia','Bonaire','Cayman Islands','Costa Rica','Curacao','Dominica','Dominican Republic','Ecuador','El Salvador','Falkland Islands (Malvinas)','French Guiana','Grenada','Guadeloupe','Guatemala','Guyana','Haiti','Honduras','Jamaica','Martinique','Montserrat','Netherlands Antilles','Nicaragua','Panama','Paraguay','Puerto Rico','Saint Barthlemy','Saint Kitts And Nevis','Saint Lucia','Saint Martin (French Part)','Saint Vincent and the Grenadines','Sint Maarten (Dutch Part)','South Georgia And The South Sandwich Islands','Suriname','Trinidad And Tobago','Turks And Caicos Islands','Uruguay','Venezuela','Virgin Islands'
    ) THEN 'LATAM'
    WHEN sb.country_name = 'Canada' THEN 'Canada'
    ELSE 'Other'
    END                                   AS Region,
    sb.country_name,
    sb.division_l3_name                   AS L3_Division,
    ''                                    AS AccountOwner,
    sb.txn_event_date_type                AS Event,
    sb.realm_id                           AS QBO_ID,
    sb.qboa_company_id                    AS QBOA_ID,
    sb.firm_company_id                    AS TopLevelQBOA,
    sb.product                            AS SKU,
    sb.offer_name,
    sb.ecosystem_offering_name            AS Product,
    am.account_owner__c                   AS FY26AccountOwner,
    COUNT(DISTINCT realm_id)              AS distinct_realms

FROM sales_rpt.rpt_sales_booking          AS sb
-- LEFT JOIN international_analytics.dim_agent dim ON sb.corp_id = dim.corp_id
LEFT JOIN sbseg_dm.dim_calendar           cal ON sb.txn_event_date = cal.date_for_day
LEFT JOIN ued_salesforce_dwh.sales_account am  ON am.company_id__c = sb.qboa_company_id
WHERE sb.division_l6_name = 'Canada Sales L6'
  -- AND dim.rec_end_date = '2999-12-31'
  --AND sb.channel_super_aggr_name = 'Accountants'
  --AND sb.eco_event_category_name = 'GNS'
  --AND sb.division_l3_name = 'National Sales CA L3'
  --AND sb.country_name = 'Canada'
  --AND sb.product = 'Ledger'
  --AND sb.ecosystem_offering_name = 'QBO'
  AND cal.year_fy = 2026
  AND cal.quarter_fy = 4
  --AND sb.clndr_544_week_nbr = 45
GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18