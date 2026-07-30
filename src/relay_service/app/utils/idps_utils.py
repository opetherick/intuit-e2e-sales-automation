"""IDPS secret retrieval.

Mirrors the canonical idps_utils.py pattern used across SBSEGAnalyticsDS services
(agentfordashappv3, blob-agent-qna, mktops-chatbot-svc, etc.).

Secrets are cached in memory for the lifetime of the process; the container
restarts periodically so staleness is not a concern.
"""

import logging

from idps_sdk.idps_client import IdpsClientFactory

from app.config import LocalSettings, SvcSettings, settings_factory

logger = logging.getLogger(__name__)

_app_secrets: dict[str, str] = {}


def _get_idps_client(settings: SvcSettings):
    if isinstance(settings, LocalSettings):
        # Local mode: authenticate with the numeric asset_id instead of a policy_id.
        return IdpsClientFactory.get_instance(
            endpoint=settings.idps_endpoint,
            resource_asset_id=settings.asset_id,
        )
    return IdpsClientFactory.get_instance(
        endpoint=settings.idps_endpoint,
        policy_id=settings.idps_policy_id,
    )


def get_app_secret(secret_path: str) -> str:
    """Fetch and cache the plain-text secret at *secret_path* from IDPS.

    Args:
        secret_path: IDPS path to the secret, e.g.
            ``managed-items/api-security/private-auth/preProd/appsecret``.

    Returns:
        The secret's string value.

    Raises:
        Exception: propagated from the IDPS SDK if the path is invalid or
            the service lacks read permission.
    """
    global _app_secrets
    if secret_path not in _app_secrets:
        settings = settings_factory()
        logger.debug("Fetching secret from IDPS: %s", secret_path)
        client = _get_idps_client(settings)
        _app_secrets[secret_path] = client.get_secret(secret_path).get_string_value()
        logger.debug("Cached secret for path: %s", secret_path)
    return _app_secrets[secret_path]
