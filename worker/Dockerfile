# Worker image: one container per agent run. Built for the Mac mini's architecture (linux/arm64 on Apple silicon).
#   docker build -t factory-worker:current --build-arg CLAUDE_CODE_VERSION=<pinned> worker/
FROM node:24-bookworm-slim

ARG TARGETARCH
ARG CLAUDE_CODE_VERSION=latest
ARG GITLEAKS_VERSION=8.28.0
ARG OSV_SCANNER_VERSION=2.2.4
ARG GH_VERSION=2.83.1

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq ripgrep python3 python3-pip python3-venv sqlite3 unzip procps \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI, gitleaks, osv-scanner (pinned release binaries)
RUN set -eux; arch="${TARGETARCH:-arm64}"; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" | tar -xz -C /tmp; \
    mv /tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh /usr/local/bin/gh; \
    garch=$([ "$arch" = "amd64" ] && echo x64 || echo arm64); \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${garch}.tar.gz" | tar -xz -C /usr/local/bin gitleaks; \
    curl -fsSL -o /usr/local/bin/osv-scanner "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_${arch}"; \
    chmod +x /usr/local/bin/osv-scanner

# Semgrep (free rules) in its own venv
RUN python3 -m venv /opt/semgrep && /opt/semgrep/bin/pip install --no-cache-dir semgrep && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep

# Claude Code CLI (pinned per image build), pnpm, Playwright with Chromium
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" pnpm@10 \
    && npx -y playwright@1 install --with-deps chromium \
    && chmod -R a+rx /ms-playwright

RUN useradd --create-home --shell /bin/bash worker \
    # Pre-create ~/.claude as the worker: a volume mounted below it would otherwise make Docker create it as root.
    && mkdir -p /home/worker/.claude/projects && chown -R worker:worker /home/worker/.claude
COPY entrypoint.sh /usr/local/bin/factory-entrypoint
RUN chmod +x /usr/local/bin/factory-entrypoint

USER worker
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/factory-entrypoint"]
CMD ["claude", "--version"]
