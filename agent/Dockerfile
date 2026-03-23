FROM python:3.11-slim

# System deps for hermes-agent build
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl build-essential && \
    rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Clone and install hermes-agent from source
RUN git clone --recurse-submodules --depth 1 \
    https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent

WORKDIR /opt/hermes-agent
RUN uv venv /opt/venv --python 3.11 && \
    VIRTUAL_ENV=/opt/venv uv pip install -e ".[all]" && \
    VIRTUAL_ENV=/opt/venv uv pip install -e "./mini-swe-agent" 2>/dev/null || true

ENV PATH="/opt/venv/bin:$PATH"
ENV VIRTUAL_ENV="/opt/venv"

# Copy defaults to a staging area (NOT directly to /root/.hermes)
# The entrypoint merges these with any existing state on the volume
WORKDIR /app
COPY config.yaml /app/defaults/config.yaml
COPY skills/ /app/defaults/skills/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

VOLUME /root/.hermes

ENTRYPOINT ["/app/entrypoint.sh"]
