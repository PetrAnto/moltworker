FROM docker.io/cloudflare/sandbox:0.7.20

# Install Node.js 22 (required by OpenClaw) and rclone (for R2 persistence)
# The base image has Node 20, we need to replace it with Node 22
# Using direct binary download for reliability
ENV NODE_VERSION=22.22.1
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get install -y xz-utils ca-certificates rclone \
       procps iproute2 netcat-openbsd \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

# Install Git and GitHub CLI for Storia orchestrator
RUN apt-get update && apt-get install -y git \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && git --version \
    && gh --version

# Configure git for Storia Bot
RUN git config --global user.email "bot@storia.digital" \
    && git config --global user.name "Storia Bot" \
    && git config --global init.defaultBranch main

# Create repos directory for cloning
RUN mkdir -p /root/repos

# Install pnpm globally
RUN npm install -g pnpm

# Install OpenClaw (formerly clawdbot/moltbot)
RUN npm install -g openclaw@2026.3.23-2 \
    && openclaw --version

# Use /home/openclaw as the home directory in addition to /root.
# The Sandbox SDK backup API only allows directories under /home, /workspace,
# /tmp, or /var/tmp — not /root. Symlinks allow both paths to work.
# .codex is scaffolded here so the bundled Codex provider (OpenClaw >= 2026.4.10)
# has a writable home for ~/.codex/auth.json that participates in R2 backup.
ENV HOME=/home/openclaw
RUN mkdir -p /home/openclaw/.openclaw \
    && mkdir -p /home/openclaw/.codex \
    && mkdir -p /home/openclaw/clawd \
    && mkdir -p /home/openclaw/clawd/skills \
    && ln -sf /home/openclaw/.openclaw /root/.openclaw \
    && ln -sf /home/openclaw/.codex /root/.codex \
    && ln -sf /home/openclaw/clawd /root/clawd

# Build cache bust: 2026-04-11-v2-codex-bootstrap-scaffold
COPY start-openclaw.sh /usr/local/bin/start-openclaw.sh
COPY scripts/codex-auth-watcher.mjs /usr/local/bin/codex-auth-watcher.mjs
RUN chmod +x /usr/local/bin/start-openclaw.sh \
    && chmod +x /usr/local/bin/codex-auth-watcher.mjs

COPY skills/ /home/openclaw/clawd/skills/

# Ensure all files are readable for mksquashfs (Sandbox SDK backup).
# OpenClaw and other tools may create restrictive config files at runtime,
# but we fix build-time permissions here; runtime permissions are fixed
# before each backup via sandbox.exec("chmod -R a+rX /home/openclaw").
RUN chmod -R a+rX /home/openclaw

WORKDIR /home/openclaw/clawd

EXPOSE 18789
