# intuit-e2e-sales-automation
Automated pipeline for the weekly E2E Sales Deck. Extracts data directly from source systems into Google Sheets, auto-generates localized Google Slides, and leverages AI to append key executive performance summaries.

## Documentation

**➡️ Full engineering + operations hand-off guide: [`docs/E2E_AUTOMATION.md`](docs/E2E_AUTOMATION.md)** — architecture, weekly runbook, every component, common bugs, and the handover checklist.

### Quick start (weekly run)

```bash
# 1. Refresh AWS/SSO token
eiamcli login
eiamcli getAWSTempCredentials -a 052517444781 -r longtail -p default

# 2. Run the pipeline
cd src/data_pipeline
source venv/bin/activate
export GENOS_APP_SECRET="<from IDPS — never commit>"
python3 fetch_data.py
```

Then run **Generate All Formulas** (dashboard, `Full_Formula_Generator.gs`) and the
deck generator (`Code.js` → `generateWeeklyPresentation`). See the guide for details.

### Components

| Component | File | Role |
|-----------|------|------|
| Data pipeline | `src/data_pipeline/fetch_data.py` | Athena → `Raw_Data`, `Calendar_Cache`, `Pipeline_Meta` (timestamp + AI summary) |
| Formula generator | `src/appsscript/Full_Formula_Generator.gs` | `Raw_Data` → live COUNTIFS + forecast/actual colour flips on the dashboard |
| Deck generator | `src/appsscript/Code.js` | Builds the Slides deck; pulls the AI summary from `Pipeline_Meta!B1` |
| GenOS relay (future) | `src/relay_service/` | Lets Apps Script/cloud call GenOS from inside the Intuit network |
