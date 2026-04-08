# APISnap — Enhanced Features Guide

## Overview

This guide covers the new authentication, performance, reliability, and CI/CD features added to APISnap.

---

## 🔐 Authentication Flows

### Auto-Login (Auth Flow)

Stop manually copying tokens. Define a login endpoint in your `.apisnaprc.json` and APISnap will automatically authenticate before running tests.

#### Setup

```json
{
  "port": 3000,
  "authFlow": {
    "url": "/auth/login",
    "body": { "username": "admin@example.com", "password": "secret" },
    "tokenPath": "data.token",
    "headerName": "Authorization",
    "prefix": "Bearer "
  }
}
```

**Fields:**
- `url` — Login endpoint (relative or absolute URL)
- `body` — Credentials to POST
- `tokenPath` — Dot-path to token in response (e.g., `"data.token"`, `"auth.jwt"`)
- `headerName` — Header name to inject token (default: `Authorization`)
- `prefix` — Token prefix (default: `Bearer `, use `""` for API keys)

#### Running with Auth Flow

```bash
apisnap --auth-flow
```

Output:
```
📸 APISnap v1.0.0
   Target:      http://localhost:3000
   Auth:        auth-flow

  Authenticating via auth flow...
  ✔ Auth flow succeeded → injecting Authorization: Bearer 12345678••••••
```

#### Nested Token Extraction

If your login response has a nested token:

```json
{
  "success": true,
  "auth": {
    "jwt": "eyJhbGc..."
  }
}
```

Use dot-path notation:

```json
{
  "authFlow": {
    "url": "/auth/login",
    "body": { "username": "test", "password": "pass" },
    "tokenPath": "auth.jwt"
  }
}
```

#### API Key Example

For APIs using API keys instead of bearer tokens:

```json
{
  "authFlow": {
    "url": "/api/keys/generate",
    "body": { "clientId": "myapp" },
    "tokenPath": "key",
    "headerName": "x-api-key",
    "prefix": ""
  }
}
```

### Per-Route Auth Overrides

Some routes are intentionally public. Skip auth for them:

```json
{
  "authFlow": { "..." },
  "routes": [
    { "path": "/health",       "auth": "none" },
    { "path": "/public/items", "auth": "none" },
    { "path": "/orders",       "body": { "productId": "1", "qty": 2 } }
  ]
}
```

Routes with `"auth": "none"` will have their `Authorization` and `Cookie` headers stripped, allowing you to test public endpoints alongside protected ones.

---

## 🍪 Session-Based Auth (Cookie Jar)

For apps using session cookies instead of bearer tokens:

```bash
apisnap --session
```

APISnap will:
1. Capture `Set-Cookie` headers from login responses
2. Automatically replay those cookies on subsequent requests
3. Handle cookie updates throughout the test session

### Seeding Cookies

Pre-populate session cookies:

```bash
apisnap --session --cookie "sessionId=abc123; Path=/; HttpOnly"
```

Mix of auto-captured and seeded cookies:
- Auto-captured cookies override seeded ones if they have the same name (set during the session)
- Useful for testing already-authenticated flows

---

## 🔄 Exponential Backoff Retries

Retries now use exponential backoff with jitter instead of linear delays, making tests more resilient to transient failures.

```bash
apisnap --retry 3
```

**Attempt Schedule:**
| Attempt | Delay |
|---------|-------|
| 1st retry | ~330ms (300 × 2^0 + jitter) |
| 2nd retry | ~630ms (300 × 2^1 + jitter) |
| 3rd retry | ~1230ms (300 × 2^2 + jitter) |
| Cap | 10 seconds |

This avoids thundering-herd problems and gives flaky services time to recover.

---

## 🔍 Baseline Diffing (Regression Detection)

Catch performance regressions and broken endpoints across deploys.

### Step 1: Save a Baseline

On your main branch or after a stable release, save the current results:

```bash
apisnap --save-baseline baseline
# Creates: baseline.json
```

### Step 2: Diff Against Baseline

On PRs or before deploying:

```bash
apisnap --diff baseline.json
```

**Output:**

```
🔍 Regression Diff:

  ⛔ 2 regression(s):
    ✖ [GET] /users/:id
      Status changed 200 → 500
    ✖ [POST] /orders
      Latency spike: 120ms → 890ms

  🎉 1 improvement(s):
    ✔ [POST] /auth/login
      Fixed: 503 → 200

  🆕 1 new endpoint(s): GET:/webhooks
  🗑  1 removed endpoint(s): DELETE:/deprecated
  Unchanged: 14 endpoint(s)
```

**Exit codes:**
- `0` — All OK, no regressions
- `1` — Regressions detected

### In CI Pipelines

GitHub Actions example:

```yaml
jobs:
  api-health:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Start server
        run: node server.js &
        
      - name: Save baseline (main branch only)
        if: github.ref == 'refs/heads/main'
        run: npx apisnap --save-baseline .apisnap/baseline

      - name: Test API (diff on PRs)
        run: |
          if [ "${{ github.event_name }}" == "pull_request" ]; then
            npx apisnap --diff .apisnap/baseline --ci > report.json
          else
            npx apisnap --save-baseline .apisnap/baseline
          fi

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: apisnap-report
          path: report.json
```

---

## 🤖 CI Mode

For CI/CD pipelines, use `--ci` for structured output and strict exit codes.

```bash
apisnap --ci --auth-flow --diff baseline.json > report.json
```

**Features:**
- ✅ Suppresses all spinners, colors, and interactive output
- ✅ Outputs valid JSON to stdout (parseable by jq, Python, etc.)
- ✅ Exit codes reflect test results:
  - `0` — All passed, no regressions
  - `1` — Failures, slow routes, or regressions detected
- ✅ Includes diff results (if `--diff` is used)

**Output shape:**

```json
{
  "tool": "APISnap",
  "version": "1.0.0",
  "generatedAt": "2024-01-01T12:00:00.000Z",
  "config": {
    "port": "3000",
    "baseUrl": "http://localhost:3000",
    "slowThreshold": 200,
    "timeout": 5000,
    "headers": ["Authorization"]
  },
  "summary": {
    "total": 20,
    "passed": 18,
    "failed": 2,
    "slow": 1,
    "avgDuration": 45,
    "totalDuration": 900
  },
  "results": [
    {
      "method": "GET",
      "path": "/health",
      "fullUrl": "http://localhost:3000/health",
      "status": 200,
      "statusText": "OK",
      "duration": 12,
      "success": true,
      "slow": false,
      "retries": 0,
      "authMethod": "static-token"
    }
  ],
  "diff": {
    "regressions": [],
    "improvements": [],
    "unchanged": 20,
    "newEndpoints": [],
    "removedEndpoints": []
  },
  "exitCode": 0
}
```

**Parsing in CI:**

```bash
# Check if regressions exist
if jq -e '.diff.regressions | length > 0' report.json > /dev/null; then
  echo "Regressions detected!"
  exit 1
fi

# Extract failure count
FAILED=$(jq '.summary.failed' report.json)
echo "Failed: $FAILED endpoints"
```

---

## 📋 Full Configuration Example

Complete `.apisnaprc.json` with all features:

```json
{
  "port": 3000,
  "slow": 200,
  "timeout": 5000,
  "concurrency": 5,
  "retry": 2,

  "headers": ["x-tenant: acme"],

  "authFlow": {
    "url": "/auth/login",
    "body": { "username": "test@example.com", "password": "test" },
    "tokenPath": "token",
    "headerName": "Authorization",
    "prefix": "Bearer "
  },

  "params": {
    "id": "42",
    "slug": "my-post"
  },

  "skip": ["/admin", "/internal", "/_health"],

  "routes": [
    { "path": "/health",  "auth": "none" },
    { "path": "/public/*", "auth": "none" },
    { "path": "/orders",  "body": { "productId": "1", "qty": 1 } },
    { "path": "/upload",  "headers": ["Content-Type: multipart/form-data"] }
  ],

  "envs": {
    "staging": {
      "baseUrl": "https://staging.example.com",
      "authFlow": {
        "url": "https://staging.example.com/auth/login",
        "body": { "username": "staging@example.com", "password": "stagingpass" },
        "tokenPath": "token"
      }
    },
    "prod": {
      "baseUrl": "https://api.example.com",
      "concurrency": 1,
      "timeout": 10000
    }
  }
}
```

---

## 🚀 CLI Flags Reference

### New Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--auth-flow` | Auto-login using authFlow config | `apisnap --auth-flow` |
| `--session` | Enable cookie jar (auto-capture Set-Cookie) | `apisnap --session` |
| `--save-baseline <file>` | Save results as baseline | `apisnap --save-baseline baseline` |
| `--diff <file>` | Diff against baseline | `apisnap --diff baseline.json` |
| `--ci` | CI mode: JSON output, no spinners, strict exit codes | `apisnap --ci` |

### Retry Behavior

```bash
# Old (linear): 500ms, 1000ms, 1500ms
# New (exponential + jitter): ~300ms, ~600ms, ~1200ms, capped at 10s

apisnap --retry 3
```

### Example Workflows

**Development:**
```bash
apisnap --auth-flow --session --retry 2
```

**CI (save baseline on main):**
```bash
apisnap --ci --auth-flow --save-baseline .cisnap/baseline
```

**CI (diff on PR):**
```bash
apisnap --ci --auth-flow --diff .apisnap/baseline
```

**Performance testing with slow threshold:**
```bash
apisnap --slow 100 --fail-on-slow --export perf-report.json
```

---

## 🛠️  Troubleshooting

### Auth flow fails with 401

```
⚠️  Auth flow: could not find token at path "token" in response
   Response body: {"error": "Invalid credentials"}
```

**Check:**
- Credentials in `authFlow.body` are correct
- `authFlow.tokenPath` matches your response structure
- Server is running

### Token not applied to requests

```bash
# Check auth method was detected
apisnap --auth-flow    # should show "Auth: auth-flow"
```

If it still shows auth failures:
- Verify `headerName` matches what your API expects
- Check `prefix` format (e.g., "Bearer " vs "Bearer")
- Inspect the actual request: `apisnap -H "x-debug: true"`

### Session cookies not persisting

```bash
# Ensure session mode is enabled
apisnap --session --retry 2
```

Only `Set-Cookie` headers from server responses are automatically captured. Seeded cookies with `--cookie` are merged with auto-captured ones.

### Baseline diffs show too many false positives

```bash
# Save baseline during stable runs, e.g., after merging to main
# Avoid saving during flaky test environments
# Use --concurrency 1 if load-dependent endpoints vary
```

---

## 📊 Real-World Examples

### Example 1: Protected API with Auto-Login

```bash
# Config
cat > .apisnaprc.json << 'EOF'
{
  "port": 8000,
  "authFlow": {
    "url": "/api/auth/login",
    "body": { "email": "bot@company.com", "password": "$BOT_PASSWORD" },
    "tokenPath": "accessToken"
  }
}
EOF

# Run
apisnap --auth-flow --ci --export report.json
```

### Example 2: Session-Based with Cookies

```bash
apisnap --session \
  --save-baseline session-baseline \
  --concurrency 3 \
  --export session-results.html --html session-report.html
```

### Example 3: PR Regression Detection

```bash
#!/bin/bash

# Run tests and diff against baseline
apisnap --ci \
  --auth-flow \
  --diff .apisnap/baseline.json \
  --export pr-report.json

# Check for regressions
REGRESSIONS=$(jq '.diff.regressions | length' pr-report.json)

if [ "$REGRESSIONS" -gt 0 ]; then
  echo "❌ $REGRESSIONS regressions detected"
  jq '.diff.regressions' pr-report.json
  exit 1
else
  echo "✅ No regressions"
  exit 0
fi
```

---

## ✅ Checklist: Getting Started

- [ ] Update `.apisnaprc.json` with `authFlow` if your API requires auth
- [ ] Test with `apisnap --auth-flow` locally
- [ ] Save a baseline: `apisnap --save-baseline .apisnap/main`
- [ ] Test PR workflow: `apisnap --diff .apisnap/main`
- [ ] Add to CI/CD pipeline with `--ci` flag
- [ ] Monitor for regressions across deploys
- [ ] Use `--session` if endpoints use cookie-based auth

---

**Questions?** Check the main README or open an issue on GitHub.
