import os

from pydantic import Field
from pydantic_settings import BaseSettings


class SvcSettings(BaseSettings):
    """Base settings shared across all environments. Values are overridden per-env below.

    Nothing secret is stored here — IDPS paths and app_id are config, not credentials.
    """

    log_level: str = "INFO"

    # Identity of this asset in Intuit DevPortal
    asset_id: str = Field(
        "REPLACE_WITH_DEVPORTAL_ASSET_ID",
        validation_alias="ASSET_ID",
        description="Numeric asset ID assigned by DevPortal on service registration",
    )
    app_id: str = Field(
        "Intuit.sbseganalyticsds.e2eautomationsales",
        validation_alias="INTUIT_APP_ID",
    )

    # IDPS — path to the PrivateAuth app secret for e2eautomationsales
    app_secret_path: str = Field(
        "managed-items/api-security/private-auth/preProd/appsecret",
        validation_alias="APP_SECRET_PATH",
    )
    idps_endpoint: str = "vkm-e2e.ps.idps.a.intuit.com"
    idps_policy_id: str = Field(
        "REPLACE_WITH_IDPS_POLICY_ID",
        validation_alias="IDPS_POLICY_ID",
        description="IDPS policy ID granting this service read access; get from DevPortal",
    )

    # GenOS — target endpoint and experience registration
    genos_endpoint: str = Field(
        "https://genos-platform-e2e.api.intuit.com/llm/v3/anthropic.claude-sonnet-4-6/chat/completions",
        validation_alias="GENOS_ENDPOINT",
    )
    genos_experience_id: str = Field(
        "ecf5d504-ded2-418c-95c3-825cc8342f12",
        validation_alias="GENOS_EXPERIENCE_ID",
    )

    # Intuit Identity — used to exchange app credentials for a short-lived IAM ticket
    # so the relay can make service-to-service GenOS calls without a browser user session.
    identity_url: str = "https://identityinternal-e2e.api.intuit.com/signin/graphql"
    # GraphQL mutation that signs in a test service account and returns legacyAuthId + accessToken.
    # This is the standard pre-prod pattern used by services in this org (see agentfordashappv3).
    identity_payload: str = (
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
    # How long (seconds) to keep an IAM ticket before re-fetching. Tokens are ~60 min; use 55.
    token_ttl_seconds: int = 3300

    # Inbound auth — Apps Script presents this key in the X-Relay-Api-Key header.
    # Injected from a K8s secret; never committed to source.
    relay_api_key: str = Field(..., validation_alias="RELAY_API_KEY")

    # Request timeout for outbound GenOS calls (seconds)
    genos_timeout: int = 60


class LocalSettings(SvcSettings):
    """Local dev — uses resource_asset_id for IDPS (no policy_id required)."""

    log_level: str = "DEBUG"
    # IDPS local mode authenticates with asset_id instead of policy_id.
    # Set ASSET_ID env var to your numeric asset ID when running locally.


class E2ESettings(SvcSettings):
    log_level: str = "DEBUG"


class QALSettings(SvcSettings):
    log_level: str = "DEBUG"


class PRDSettings(SvcSettings):
    idps_endpoint: str = "vkm.ps.idps.a.intuit.com"
    genos_endpoint: str = Field(
        "https://genos-platform.api.intuit.com/llm/v3/anthropic.claude-sonnet-4-6/chat/completions",
        validation_alias="GENOS_ENDPOINT",
    )
    # In PRD the app_secret_path points to the prod secret (no "preProd" segment)
    app_secret_path: str = Field(
        "managed-items/api-security/private-auth/appsecret",
        validation_alias="APP_SECRET_PATH",
    )
    identity_url: str = "https://identityinternal.api.intuit.com/signin/graphql"


_ENV_SETTINGS: dict[str, type[SvcSettings]] = {
    "local": LocalSettings,
    "e2e": E2ESettings,
    "qal": QALSettings,
    "prd": PRDSettings,
}


def settings_factory() -> SvcSettings:
    env = os.getenv("APP_ENV", "local").lower()
    cls = _ENV_SETTINGS.get(env, E2ESettings)
    return cls()
