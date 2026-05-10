# Sandbox container image for the Symphony sandbox-dispatcher Worker.
#
# Provides codex, claude-code, gh, and the standard Unix toolchain inside the
# per-issue Cloudflare Sandbox. The snapshot/restore target is /home/node — at
# bootstrap time the operator logs in interactively (codex auth login,
# claude login, gh auth login) and the dispatcher captures /home/node into an
# R2-backed DirectoryBackup. Subsequent /run invocations restore that backup
# before cloning the repo into /workspace/<issue_id>.
#
# Versions are pinned where possible to keep the image reproducible. Build
# inputs intentionally avoid /workspace so the snapshot stays small.

FROM docker.io/library/node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/node \
    PATH=/home/node/.local/bin:/home/node/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin

# Base packages: git, gh (GitHub CLI), ttyd for the bootstrap PTY (Phase 3),
# build tools the CLIs occasionally need, and certs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        gnupg \
        jq \
        less \
        openssh-client \
        sudo \
        unzip \
        ttyd \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Run the agent CLIs as the non-root `node` user that ships with the base image.
USER node
WORKDIR /home/node

# mise: runtime version manager used by per-repo bootstrap hooks.
RUN curl -fsSL https://mise.run | sh

# Anthropic Claude Code CLI + OpenAI Codex CLI installed under the user's
# global npm prefix so their auth files land in ~/.claude and ~/.codex.
RUN npm config set prefix "$HOME/.local" \
 && npm install -g \
        @anthropic-ai/claude-code \
        @openai/codex \
        @linear/cli

# Workspace lives outside /home/node so it is NOT included in the auth backup.
USER root
RUN mkdir -p /workspace && chown node:node /workspace
USER node

EXPOSE 7681

CMD ["bash", "-l"]
