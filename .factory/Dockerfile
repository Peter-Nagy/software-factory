# The factory's own toolchain: the worker image plus Playwright and Chromium for the dashboard smoke test.
FROM factory-worker:current
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN mkdir -p /opt/e2e && cd /opt/e2e && npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.65.0 \
    && npx playwright install --with-deps chromium && chmod -R a+rX /opt/ms-playwright /opt/e2e
ENV FACTORY_PLAYWRIGHT=/opt/e2e/node_modules/playwright/index.mjs
USER worker
