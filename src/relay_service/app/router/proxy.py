"""Relay proxy router.

Exposes two endpoints:

  POST /generate
    - Validates the inbound X-Relay-Api-Key header.
    - Forwards the request body to GenOS via genos_client.call_genos().
    - Returns the GenOS response unchanged (same shape Apps Script already parses).

  GET /health/full
    - Kubernetes liveness/readiness probe; no auth required.
"""

import logging
from typing import Any

import requests
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from app.config import settings_factory
from app.service.genos_client import GenosError, IdpsError, call_genos

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Inbound API-key guard
# ---------------------------------------------------------------------------


def _require_api_key(x_relay_api_key: str = Header(...)) -> None:
    """FastAPI dependency — raises 401 if the caller's API key doesn't match."""
    settings = settings_factory()
    if x_relay_api_key != settings.relay_api_key:
        logger.warning("Rejected request: invalid X-Relay-Api-Key")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Relay-Api-Key",
        )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/generate", dependencies=[Depends(_require_api_key)])
async def generate(request: Request) -> JSONResponse:
    """Accept a GenOS chat/completions payload from Apps Script and proxy it.

    The request body must be JSON-serialisable and match the GenOS schema:

    .. code-block:: json

        {
          "messages": [{"role": "...", "content": "..."}],
          "temperature": 0.25,
          "max_tokens": 600
        }

    Returns the raw GenOS JSON response so Apps Script can parse ``choices``
    exactly as it did before.

    Error responses use the following shape so Apps Script can distinguish
    failure types:

    .. code-block:: json

        {"error": "idps_failure | genos_error | network_error", "detail": "..."}
    """
    try:
        payload: dict[str, Any] = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Request body must be valid JSON: {exc}",
        ) from exc

    logger.info("Received /generate request, payload keys=%s", list(payload.keys()))

    try:
        result = call_genos(payload)
    except IdpsError as exc:
        logger.error("IDPS / IAM ticket failure: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"error": "idps_failure", "detail": str(exc)},
        )
    except GenosError as exc:
        logger.error("GenOS returned error status=%s", exc.status_code)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": "genos_error", "detail": exc.body[:500]},
        )
    except requests.Timeout:
        logger.error("GenOS call timed out")
        return JSONResponse(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            content={"error": "network_error", "detail": "GenOS request timed out"},
        )
    except requests.RequestException as exc:
        logger.error("Network error calling GenOS: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"error": "network_error", "detail": str(exc)},
        )

    return JSONResponse(content=result)


@router.get("/health/full")
async def health() -> dict[str, str]:
    """Kubernetes liveness / readiness probe — no auth required."""
    return {"status": "UP"}
