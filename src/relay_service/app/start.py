"""FastAPI application entry point for the GenOS relay service."""

import logging
import logging.config
import os

from fastapi import FastAPI

from app.router.proxy import router

_LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=_LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    app = FastAPI(
        title="e2e-sales-genos-relay",
        description=(
            "Internal relay: accepts GenOS chat/completions requests from Apps Script, "
            "injects Intuit PrivateAuth+ credentials fetched from IDPS, and forwards "
            "to the real GenOS endpoint."
        ),
        version="1.0.0",
        docs_url="/docs",
        redoc_url=None,
    )
    app.include_router(router)
    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.start:app",
        host="0.0.0.0",
        port=8080,
        log_level=_LOG_LEVEL.lower(),
        reload=False,
    )
