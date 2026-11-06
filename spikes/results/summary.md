# S0 spike results

- Date: 2026-11-06T12:16Z
- Host: Darwin arm64, 27.2
- Docker: 29.8.0
- Host claude: 2.1.319 (Claude Code)
- Node: v26.10.0

- **S0-1 subscription token in container**: PASS - claude 2.1.318 (Claude Code) answered; est. cost $0.0014384200000000001
- **S0-2a stream-json usage**: PASS - event types: assistant/ rate_limit_event/ result/success system/init ; sample: `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793977200,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.13,"resetsAt":1793977200,"status":"allowed"},"seven_day":{"utilization":0.02,"resetsAt":1794301200,"status":"allowed"}}},"uuid":"8abd7272-7654-`
- **S0-2b /usage in -p**: FAIL - Permission deny rule (/home/worker/.claude/settings.json): Write(/.github/workflows/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(/.github/workflows/**) instead 
- **S0-2c status line probe**: FAIL - status line never ran (a trust or login prompt may have blocked it)
- **S0-4 GitHub App scoped token**: SKIP - missing env: GH_APP_ID GH_APP_KEY_FILE GH_INSTALLATION_ID GH_OWNER GH_REPO GH_OTHER_REPO
- **S0-6 usage per task (haiku)**: INFO - result=success, 17s, turns=7, est. $0.0037329800000000003, usage after (5h/7d)=null/null
- **S0-6 usage per task (sonnet)**: INFO - result=success, 13s, turns=5, est. $0.0454093, usage after (5h/7d)=null/null
- **S0-5 1Password service account**: PASS - read SPIKE_TEST; visible vaults: [Factory]
- **S0-3 auto mode and deny rules**: PASS - file=yes commit=yes ci-edit-blocked=yes token-in-output=no denials=[]
