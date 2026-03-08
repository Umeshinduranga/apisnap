# 📸 APISnap

> Instant API auto-discovery and health-check CLI for Express.js

[![npm version](https://img.shields.io/npm/v/@umeshindu222/apisnap.svg)](https://www.npmjs.com/package/@umeshindu222/apisnap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Why APISnap?

Every time you change your Express backend, manually testing 20+ endpoints in Postman is slow and error-prone. APISnap **auto-discovers every route** and health-checks all of them in seconds — with zero config.

---

## Features

- 🔍 **Auto Route Discovery** — Scans your full Express router stack including sub-routers
- 🔐 **Full Auth Support** — JWT, API Keys, Cookies, multiple headers simultaneously
- 🔁 **Retry Logic** — Auto-retry failed requests with exponential backoff
- ⚡ **Slow Route Detection** — Flags endpoints exceeding your threshold
- 📊 **HTML Reports** — Beautiful visual reports for sharing/archiving
- 💾 **JSON Export** — Structured output for CI/CD pipelines
- ⚙️ **Config File** — Persist options in `.apisnaprc.json`
- 🎯 **Method Filter** — Test only GET, POST, etc.
- 🧠 **Smart Params** — Auto-replaces `:id`, `:slug`, `:uuid` with safe defaults
- 🚨 **Auth Hints** — Tells you exactly how to fix 401/403 errors
- 🏗️ **CI/CD Ready** — Exit code 1 on failures for pipeline integration

---

## Quick Start

### Step 1 — Install & add middleware

```bash
npm install @umeshindu222/apisnap
```

```javascript
const express = require('express');
const apisnap = require('@umeshindu222/apisnap');

const app = express();

// ✅ Your routes go here
app.get('/users', (req, res) => res.json({ users: [] }));
app.post('/users', (req, res) => res.json({ message: 'Created' }));

// ✅ APISnap goes AFTER your routes (so it can discover them)
// ✅ APISnap goes BEFORE global auth middleware (to allow discovery)
apisnap.init(app);

// ⚠️ If you use global auth middleware, place it AFTER apisnap.init():
// app.use(authMiddleware); ← AFTER init, not before

app.listen(3000);
```

### Step 2 — Run

```bash
npx @umeshindu222/apisnap --port 3000
```

---

## 🔐 Fixing 401 / 403 Errors

This is the most common issue. APISnap sends real HTTP requests, so **protected routes require credentials** just like any client would.

### JWT / Bearer Token
```bash
npx @umeshindu222/apisnap -H "Authorization: Bearer eyJhbGci..."
```

### API Key header
```bash
npx @umeshindu222/apisnap -H "x-api-key: my-secret-key"
```

### Cookie / Session auth
```bash
npx @umeshindu222/apisnap --cookie "sessionId=abc123; connect.sid=xyz"
```

### Multiple headers at once (`-H` can be repeated)
```bash
npx @umeshindu222/apisnap \
  -H "Authorization: Bearer TOKEN" \
  -H "x-tenant-id: acme" \
  -H "x-api-version: 2"
```

### Skip specific protected routes
```javascript
// In your server — skip routes you don't want tested:
apisnap.init(app, {
  skip: ['/admin', '/internal', '/webhooks']
});
```

### Use a config file (recommended for teams)

Create `.apisnaprc.json` in your project root:

```json
{
  "port": "3000",
  "slow": "300",
  "headers": [
    "Authorization: Bearer YOUR_DEV_TOKEN",
    "x-api-key: YOUR_KEY"
  ],
  "cookie": "sessionId=dev-session-abc",
  "params": {
    "id": "42",
    "slug": "hello-world",
    "uuid": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

Then just run:
```bash
npx @umeshindu222/apisnap
```

---

## Middleware Placement (Important!)

The order of middleware in Express matters:

```javascript
// ✅ CORRECT — apisnap can bypass auth because it registers first
app.use(express.json());
apisnap.init(app);         // ← BEFORE auth middleware
app.use(authMiddleware);   // ← AFTER apisnap.init

// ❌ WRONG — auth blocks the discovery endpoint
app.use(authMiddleware);   // ← BEFORE apisnap
apisnap.init(app);         // discovery endpoint gets blocked!
```

If you **must** put auth before apisnap, manually whitelist the discovery path:

```javascript
app.use((req, res, next) => {
  if (req.path === '/__apisnap_discovery') return next(); // bypass
  return authMiddleware(req, res, next);
});
```

---

## CLI Reference

```bash
npx @umeshindu222/apisnap [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <n>` | Port your server runs on | `3000` |
| `-H, --header <str>` | Add auth header (repeatable) | — |
| `-c, --cookie <str>` | Cookie string for session auth | — |
| `-s, --slow <n>` | Slow threshold in ms | `200` |
| `-t, --timeout <n>` | Request timeout in ms | `5000` |
| `-r, --retry <n>` | Retry failed requests N times | `0` |
| `-e, --export <file>` | Export JSON report | — |
| `--html <file>` | Export HTML report | — |
| `--only <methods>` | Filter methods (e.g. `GET,POST`) | — |
| `--base-url <url>` | Override base URL (for staging) | `localhost` |
| `--params <json>` | Path param overrides as JSON | — |
| `--fail-on-slow` | Exit code 1 if slow routes found | `false` |

---

## Examples

### Basic
```bash
npx @umeshindu222/apisnap --port 3000
```

### With JWT auth
```bash
npx @umeshindu222/apisnap -p 3000 -H "Authorization: Bearer eyJhbGci..."
```

### Custom path params (for routes like `/users/:id/posts/:postId`)
```bash
npx @umeshindu222/apisnap --params '{"id":"42","postId":"7"}'
```

### Test only GET routes
```bash
npx @umeshindu222/apisnap --only GET
```

### Test staging server
```bash
npx @umeshindu222/apisnap --base-url https://staging.myapp.com -H "Authorization: Bearer TOKEN"
```

### Generate HTML report
```bash
npx @umeshindu222/apisnap --html report

# Mac
# open report.html

# Windows
# start report.html

# Linux
# xdg-open report.html
```

### CI/CD — fail pipeline on any broken endpoint
```bash
npx @umeshindu222/apisnap --export ci-report && echo "All healthy!"
# Exit code 1 if any endpoint fails
```

### Full power
```bash
npx @umeshindu222/apisnap \
  -p 5000 \
  -H "Authorization: Bearer TOKEN" \
  -H "x-api-key: SECRET" \
  --cookie "sessionId=abc" \
  --slow 300 \
  --retry 2 \
  --html report \
  --export report \
  --fail-on-slow
```

---

## Sample Output

```
📸 APISnap v2.0.0
   Target:     http://localhost:3000
   Slow:       >200ms
   Timeout:    5000ms
   Headers:    {"Authorization":"Bearer ••••••"}

✔ Connected! Found 6 endpoints to test.

  ✔ GET     /health                             [200] 3ms
  ✔ GET     /users                              [200] 12ms
  ✔ POST    /users                              [200] 8ms
  ✔ GET     /users/1                            [200] 15ms
  ⚠️  GET     /reports                            [200] 543ms ← slow!
  ✖ DELETE  /users/1                            [401]
     💡 Hint: 401 Unauthorized — try adding -H "Authorization: Bearer YOUR_TOKEN"

📊 Summary:
  ✅ Passed:  5
  ❌ Failed:  1
  ⚠️  Slow:    1 (>200ms)
  ⏱  Avg:    100ms
  🕐 Total:  600ms

⚠️  Some endpoints are unhealthy!
```

---

## HTML Report

`--html report` generates a beautiful standalone HTML file:

- Pass rate progress bar
- Color-coded result table
- Per-endpoint timing, status, retry count
- No external dependencies — works offline

---

## JSON Report Format

```json
{
  "tool": "APISnap",
  "version": "2.0.0",
  "generatedAt": "2026-03-08T10:00:00.000Z",
  "config": { "port": "3000", "slowThreshold": 200 },
  "summary": {
    "total": 6, "passed": 5, "failed": 1,
    "slow": 1, "avgDuration": 100, "totalDuration": 600
  },
  "results": [
    { "method": "GET", "path": "/users", "status": 200, "duration": 12, "success": true, "slow": false, "retries": 0 }
  ]
}
```

> **CI/CD tip:** Check `summary.failed > 0` to fail your build.

---

## How It Works

1. **Middleware** — `apisnap.init(app)` registers `/__apisnap_discovery` and patches `app.use` so global auth middleware skips the discovery path automatically.

2. **CLI** — Calls the discovery endpoint, gets the full route map, then pings each route with your headers/cookies. Smart defaults replace `:id` → `1`, `:uuid` → a valid UUID, `:slug` → `"example"`, etc.

3. **Reports** — Results are collected and can be exported as JSON (for CI/CD) or a self-contained HTML file (for humans).

---

## Contributing

1. Fork → `git checkout -b feat/amazing` → commit → push → PR

---

## License

MIT © [Umesh Induranga](https://github.com/Umeshinduranga)
