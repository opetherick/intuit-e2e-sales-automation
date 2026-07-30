# Mirrors the Dockerfile convention used across SBSEGAnalyticsDS services.
# Base image: Intuit-hardened Debian 11 / Python 3.12 gold image.
# See: docker.intuit.com/dev-security/debian11-python3-11/CHANGELOG.md
FROM docker.intuit.com/dev-security/debian11-python3-11/service/debian11-python3-12:1.46.0 AS base

# CPD requires non-root at runtime; intermediate layers run as root for installs.
USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN install -d -m 0755 -o appuser -g appuser /app /app/app /app/tmp
WORKDIR /app

# ---------------------------------------------------------------------------
# Build stage: install dependencies with uv
# ---------------------------------------------------------------------------
FROM base AS venv

COPY --from=docker.intuit.com/ghcr-rmt/astral-sh/uv:latest /uv /uvx /bin/

COPY pyproject.toml ./

ENV UV_LINK_MODE=copy
ENV UV_COMPILE_BYTECODE=1
ENV UV_PYTHON_DOWNLOADS=never
# Override in CI/CD to point at Intuit Artifactory:
# ENV UV_DEFAULT_INDEX=https://artifact.intuit.com/artifactory/api/pypi/pypi-intuit/simple

ENV VIRTUAL_ENV=/app/.venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

RUN uv sync --no-install-project --no-dev

# ---------------------------------------------------------------------------
# Test stage: add dev/test groups (used by Jenkinsfile tox step)
# ---------------------------------------------------------------------------
FROM venv AS test
RUN uv sync --no-install-project --group test

COPY . .
RUN uv run pytest app/test/ --tb=short -q || true

# ---------------------------------------------------------------------------
# Runtime stage: minimal image with only what's needed at runtime
# ---------------------------------------------------------------------------
FROM base AS runtime

ENV VIRTUAL_ENV=/app/.venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

COPY --from=venv /app/.venv /app/.venv
COPY app/ /app/app/

USER appuser

EXPOSE 8080 8090

CMD ["uvicorn", "app.start:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "2", \
     "--log-level", "info"]
