# Stage 1: Build escript + dashboard assets
FROM hexpm/elixir:1.19-erlang-27.3.4.6-debian-trixie-20260316-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# Install Node 22 for dashboard build
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Elixir deps
COPY mix.exs mix.lock ./
RUN mix local.hex --force && mix local.rebar --force
RUN MIX_ENV=prod mix deps.get --only prod
RUN MIX_ENV=prod mix deps.compile

# Install dashboard deps
COPY dashboard/package.json dashboard/package-lock.json dashboard/
RUN cd dashboard && npm ci

# Copy source and build
COPY . .
RUN cd dashboard && npm run build
RUN MIX_ENV=prod mix build

# Stage 2: Minimal runtime
FROM erlang:27-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git openssh-client ca-certificates curl locales \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# IS_SANDBOX=1 allows Claude CLI to run --dangerously-skip-permissions as root
ENV IS_SANDBOX=1

COPY --from=build /app/bin/symphony /usr/local/bin/symphony

# The escript loads NIF .so files from _build/dev/lib/ at runtime
COPY --from=build /app/_build/prod/lib/exqlite /app/_build/dev/lib/exqlite
COPY --from=build /app/_build/prod/lib/symphony_elixir/ebin /app/_build/dev/lib/symphony_elixir/ebin
COPY --from=build /app/priv/static/dashboard /app/_build/dev/lib/symphony_elixir/priv/static/dashboard

# Workflow config files
COPY --from=build /app/*.md /app/

RUN mkdir -p /root/.symphony

WORKDIR /app

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:4000/healthz || exit 1

ENTRYPOINT ["symphony"]
CMD ["--i-understand-that-this-will-be-running-without-the-usual-guardrails", "--port", "4000", "/app/WORKFLOW.md", "/app/ENRICHMENT.md", "/app/TRIAGE.md", "/app/MENTION.md", "/app/REVIEW.md"]
