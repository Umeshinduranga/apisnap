# 📸 APISnap

> Instant API auto-discovery and health-check CLI for Express.js

[![npm version](https://img.shields.io/npm/v/@umeshindu222/apisnap.svg)](https://www.npmjs.com/package/@umeshindu222/apisnap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

##  Why APISnap?

**The Problem:** Every time you make a change to your Express.js backend, you have to manually open Postman, find every route, and click "Send" one by one. For a project with 20+ endpoints, this is slow, error-prone, and boring.

**The Solution:** APISnap plugs directly into your Express app, **automatically discovers every route you've registered**, and then health-checks all of them in seconds with zero configuration.

---

##  Features

-  **Auto Route Discovery** — Scans your Express router stack, no manual config needed
-  **Auth Header Support** — Pass JWT tokens or API keys via `--header`
-  **Slow Route Detection** — Flags endpoints that exceed your response time threshold
-  **JSON Report Export** — Save results to a file for CI/CD pipelines or sharing
-  **Beautiful CLI Output** — Color-coded results with spinners and summary table
-  **Express v4 & v5** — Compatible with both versions

---

## 🚀 Quick Start

### 1. Install & Add Middleware
```bash
npm install @umeshindu222/apisnap
```

In your Express application, initialize APISnap **after** all your routes:
```javascript
const express = require('express');
const apisnap = require('@umeshindu222/apisnap');
const app = express();

app.get('/users', (req, res) => res.json({ users: [] }));

// Add APISnap
apisnap.init(app);

app.listen(3000);
```

### 2. Initialize Config
Run this once in your project root to generate config templates:
```bash
npx @umeshindu222/apisnap init
```

### 3. Run the Check
```bash
npx @umeshindu222/apisnap
```

---

## ⚙️ Configuration

APISnap uses a dual-config system to keep your secrets safe:

| File | Purpose | Git Status |
| :--- | :--- | :--- |
| `apisnap.json` | Shared team settings (Port, Slow Threshold) | **Commit to Git** |
| `apisnap.local.json` | Personal secrets (Auth Tokens, API Keys) | **Add to .gitignore** |

---

## 🛠️ CLI Commands

```bash
npx @umeshindu222/apisnap [options]
```

- `npx @umeshindu222/apisnap init`: Create config templates.
- `npx @umeshindu222/apisnap --port 5000`: Override the port.
- `npx @umeshindu222/apisnap --header "Authorization:Bearer token"`: Add custom header.
- `npx @umeshindu222/apisnap --export report.json`: Export results to JSON.

---

##  Examples

### Basic health check
```bash
npx @umeshindu222/apisnap --port 3000
```

### With authentication (JWT / Bearer tokens)
```bash
npx @umeshindu222/apisnap --port 3000 --header "Authorization: Bearer eyJhbGci..."
```

### Custom slow threshold (flag routes > 500ms)
```bash
npx @umeshindu222/apisnap --port 3000 --slow 500
```

### Export report to JSON
```bash
npx @umeshindu222/apisnap --port 3000 --export my-report
# Creates: my-report.json
```

### All options together
```bash
npx @umeshindu222/apisnap --port 5000 --header "Authorization: Bearer TOKEN" --slow 300 --export ci-report
```

---

##  Sample Output

```
📸 APISnap v1.0.0
   Slow threshold: 200ms

✔ Connected! Found 6 endpoints.

✔  GET    /health          [200 OK]   3ms
✔  GET    /users           [200 OK]  12ms
✔  POST   /users           [200 OK]   8ms
✔  GET    /users/1         [200 OK]  15ms
⚠️  GET    /reports         [200 OK] 543ms   ← slow!
✖  DELETE /users/1         [401]

📊 Summary:
  ✅ Passed:  5
  ❌ Failed:  1
  ⚠️  Slow:    1 (>200ms)

⚠️  Some endpoints are unhealthy!
```

---

## 💾 JSON Report Format

When using `--export`, a structured JSON file is created:

```json
{
  "tool": "APISnap",
  "generatedAt": "2026-03-06T15:56:20.375Z",
  "config": { "port": "3000", "slowThreshold": 200 },
  "summary": { "total": 6, "passed": 5, "failed": 1, "slow": 1 },
  "results": [
    { "method": "GET", "path": "/health",  "status": 200, "duration": 3,  "success": true,  "slow": false },
    { "method": "GET", "path": "/users",   "status": 200, "duration": 12, "success": true,  "slow": false },
    { "method": "GET", "path": "/reports", "status": 200, "duration": 543,"success": true,  "slow": true  }
  ]
}
```

> **CI/CD tip:** Parse `summary.failed` and fail your pipeline build if it's greater than `0`!

---

## 🔧 How It Works

APISnap uses a two-part architecture:

1. **Middleware (The Seeker)** — `apisnap.init(app)` injects a hidden endpoint `/__apisnap_discovery` into your Express app. When called, it recursively walks the Express router stack and returns a map of every registered route — including nested sub-routers.

2. **CLI Runner (The Checker)** — `npx @umeshindu222/apisnap` calls the discovery endpoint, gets the route map, then "pings" each route using axios — injecting your headers, replacing path params with safe defaults (`:id` → `1`), and timing each response.

---

## 🤝 Contributing

Contributions, issues and feature requests are welcome!

1. Fork the repo
2. Create your feature branch: `git checkout -b feat/amazing-feature`
3. Commit your changes: `git commit -m 'feat: add amazing feature'`
4. Push to the branch: `git push origin feat/amazing-feature`
5. Open a Pull Request

---

## 📄 License

MIT © [Umesh Induranga](https://github.com/Umeshinduranga)
