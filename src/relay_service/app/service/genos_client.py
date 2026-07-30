"""GenOS relay client.

Handles the three-step outbound auth flow:
  1. Fetch app_secret from IDPS (cached in process memory).
  2. Exchange app_id + app_secret for a short-lived IAM ticket via the Intuit
     Identity service (cached with a 55-minute TTL).
  3. Build the full PrivateAuth+ Authorization header and POST the caller's
     payload to the real GenOS endpoint, returning the raw response.

The auth pattern is copied directly from agentfordashappv3/app/service/auth.py,
which is the canonical outbound GenOS auth implementation in this org.
"""

import logging
import time
import uuid
from typing import Any

import requests

from app.config import SvcSettings, settings_factory
from app.utils.idps_utils import get_app_secret

logger = logging.getLogger(__name__)


class _TokenCache:
    """Simple in-memory cache for the short-lived IAM ticket."""

    def __init__(self) -> None:
        self._userid: str | None = None
        self._token: str | None = None
        self._fetched_at: float = 0.0

    def get(self, ttl: int) -> tuple[str, str] | None:
        if self._userid and self._token and (time.time() - self._fetched_at) < ttl:
            return self._userid, self._token
        return None

    def set(self, userid: str, token: str) -> None:
        self._userid = userid
        self._token = token
        self._fetched_at = time.time()


_token_cache = _TokenCache()


# ---------------------------------------------------------------------------
# Auth helpers — matches agentfordashappv3/app/service/auth.py exactly
# ---------------------------------------------------------------------------


def _fetch_iam_ticket(settings: SvcSettings) -> tuple[str, str]:
    """Call the Intuit Identity service to exchange app credentials for an IAM ticket.

    Returns:
        (legacyAuthId, accessToken) — fed into the PrivateAuth+ header.

    Raises:
        RuntimeError: if the Identity call fails or the response is malformed.
    """
    app_secret = get_app_secret(settings.app_secret_path)
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": (
            f"Intuit_IAM_Authentication "
            f"intuit_appid={settings.app_id},"
            f"intuit_app_secret={app_secret}"
        ),
    }
    logger.debug("Fetching IAM ticket from Identity service: %s", settings.identity_url)
    try:
        resp = requests.post(
            settings.identity_url,
            headers=headers,
            data=settings.identity_payload,
            timeout=15,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(f"Identity service call failed: {exc}") from exc

    body = resp.json()
    try:
        result = body["data"]["identityTestSignInWithPassword"]
        userid = result["legacyAuthId"]
        token = result["accessToken"]
    except (KeyError, TypeError) as exc:
        raise RuntimeError(
            f"Unexpected Identity service response shape: {body!r}"
        ) from exc

    logger.debug("IAM ticket obtained for userid %s", userid)
    return userid, token


def _get_cached_iam_ticket(settings: SvcSettings) -> tuple[str, str]:
    cached = _token_cache.get(settings.token_ttl_seconds)
    if cached:
        return cached
    userid, token = _fetch_iam_ticket(settings)
    _token_cache.set(userid, token)
    return userid, token


def _build_auth_header(
    app_id: str, app_secret: str, userid: str, token: str
) -> str:
    """Construct the Intuit PrivateAuth+ Authorization header value.

    Format matches the canonical get_auth_header() in agentfordashappv3.
    """
    return (
        "Intuit_IAM_Authentication "
        f"intuit_appid='{app_id}',"
        f"intuit_app_secret='{app_secret}',"
        "intuit_token_type='IAM-Ticket',"
        f"intuit_userid={userid},"
        f"intuit_token={token}"
    )


def _build_genos_headers(settings: SvcSettings) -> dict[str, str]:
    app_secret = get_app_secret(settings.app_secret_path)
    userid, token = _get_cached_iam_ticket(settings)
    auth = _build_auth_header(settings.app_id, app_secret, userid, token)
    return {
        "Authorization": auth,
        "intuit_originating_assetalias": settings.app_id,
        "intuit_experience_id": settings.genos_experience_id,
        "intuit_tid": str(uuid.uuid4()),
        "Content-Type": "application/json",
    }


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------


class GenosError(Exception):
    """Raised when GenOS returns a non-2xx response."""

    def __init__(self, status_code: int, body: str) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"GenOS returned {status_code}: {body[:200]}")


class IdpsError(Exception):
    """Raised when IDPS secret fetch or IAM ticket exchange fails."""


def call_genos(payload: dict[str, Any]) -> dict[str, Any]:
    """Forward *payload* to the configured GenOS endpoint and return the JSON response.

    Auth is fully managed here — callers (Apps Script) send a plain JSON body;
    this function injects the PrivateAuth+ header before forwarding.

    Args:
        payload: JSON-serialisable dict matching the GenOS chat/completions schema.

    Returns:
        Parsed JSON response from GenOS, unchanged.

    Raises:
        IdpsError: IDPS secret fetch or IAM ticket exchange failed.
        GenosError: GenOS returned a non-2xx status.
        requests.RequestException: network-level failure.
    """
    settings = settings_factory()

    try:
        headers = _build_genos_headers(settings)
    except RuntimeError as exc:
        raise IdpsError(str(exc)) from exc

    logger.info(
        "Forwarding request to GenOS endpoint=%s tid=%s",
        settings.genos_endpoint,
        headers.get("intuit_tid"),
    )

    resp = requests.post(
        settings.genos_endpoint,
        headers=headers,
        json=payload,
        timeout=settings.genos_timeout,
    )

    if resp.status_code != 200:
        logger.error(
            "GenOS error status=%s body=%s tid=%s",
            resp.status_code,
            resp.text[:500],
            headers.get("intuit_tid"),
        )
        raise GenosError(resp.status_code, resp.text)

    logger.info("GenOS call succeeded tid=%s", headers.get("intuit_tid"))
    return resp.json()
