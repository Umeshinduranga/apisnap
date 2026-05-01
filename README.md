
<img width="3000" height="1500" alt="Group 1" src="https://github.com/user-attachments/assets/c162b436-1c64-470e-9f41-e5ceb09a31d4" />


## Quick start

```bash
npm install -g @umeshindu222/apisnap
cd your-project
apisnap init        # ← guided setup, takes 30 seconds
apisnap             # ← run your first health check
```

That's it. APISnap discovers all your Express routes automatically.

## Add to your server (one line)

```js
const apisnap = require('@umeshindu222/apisnap');

// ... your routes ...

apisnap.init(app);  // ← must be AFTER your routes
```

> Instant API auto-discovery and health-check CLI for Express.js

[![npm version](https://img.shields.io/npm/v/@umeshindu222/apisnap.svg)](https://www.npmjs.com/package/@umeshindu222/apisnap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Socket Badge](https://badge.socket.dev/npm/package/@umeshindu222/apisnap/1.2.3)](https://socket.dev/npm/package/%40umeshindu222%2Fapisnap)

---

## What is APISnap?

Every time you change your Express backend, manually testing all your routes in Postman is slow and boring. **APISnap auto-discovers every route in your app and health-checks all of them in seconds** — with zero configuration.

One command. Every route. Instant results.

<img width="700" height="300" alt="image" src="https://github.com/user-attachments/assets/325c7b40-37d5-47e1-830f-db1424956fee" />


---

## Features

-  **Auto Route Discovery** - finds every route including nested sub-routers
-  **Full Auth Support** - JWT, API Keys, Cookies, multiple headers at once
-  **Auth Hints** - tells you exactly how to fix 401/403 errors
-  **Slow Route Detection** - flags endpoints that are too slow
-  **Retry Logic** - auto-retries failed requests
-  **Rate-limit Backoff** - honors `429 Retry-After` and retries automatically
-  **HTML Reports** - beautiful visual reports you can share
-  **JSON Export** - structured output for CI/CD pipelines
-  **Config File** - save your settings so you don't retype every time
-  **Method Filter** - test only GET, POST, DELETE etc.
-  **Path Filter + Dry Run** - target a route subset and preview without requests
-  **OpenAPI Discovery** - load routes from an OpenAPI JSON spec
-  **Baseline Diffing** - compare against saved runs and fail on regressions
-  **Latency Percentiles** - p50 / p95 / p99 in terminal and reports
-  **Doctor Command** - quick setup diagnostics
-  **Smart Path Params** - auto-replaces `:id`, `:slug`, `:uuid` with safe defaults
-  **Express v4 & v5** - works with both versions

---

## Detailed Setup

### Step 1 - Install

```bash
npm install @umeshindu222/apisnap
```

### Step 2 - Add to your server file

Open your main server file (`server.js`, `app.js`, `app.ts`) and add **2 lines**:

```javascript
const apisnap = require('@umeshindu222/apisnap'); // ADD THIS at the top

// ... all your existing routes stay exactly the same ...

apisnap.init(app); // ADD THIS — after your routes
```

### Step 3 - Start your server

```bash
node server.js
# or
npm run dev
```

You will see this line confirming it works:
```
✅ [APISnap] Discovery active → http://localhost:3000/__apisnap_discovery
```

### Step 4 — Run the health check

Open a **second terminal** in your project folder and run:

```bash
npx @umeshindu222/apisnap --port 3000
```

That's it. You will see every route tested automatically.

---

## Full Setup Examples

### JavaScript (CommonJS)

```javascript
const express = require('express');
const apisnap = require('@umeshindu222/apisnap');

const app = express();
app.use(express.json());

// Your routes
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/users', (req, res) => res.json({ users: [] }));
app.post('/users', (req, res) => res.json({ message: 'created' }));
app.delete('/users/:id', (req, res) => res.json({ deleted: true }));

// APISnap — place AFTER your routes
apisnap.init(app);

app.listen(3000, () => console.log('Server running on port 3000'));
```

---

### TypeScript

>  **TypeScript users — import must be written exactly like this:**

```typescript
// ✅ CORRECT — use import * as
import * as apisnap from '@umeshindu222/apisnap';

// ❌ WRONG — will give "has no default export" red error
import apisnap from '@umeshindu222/apisnap';

// ❌ WRONG — never mix import and require in TypeScript
import apisnap from '@umeshindu222/apisnap';
const apisnap = require('@umeshindu222/apisnap');
```

Full example:

```typescript
import express, { Application, Request, Response, NextFunction } from 'express';
import * as apisnap from '@umeshindu222/apisnap'; // ✅ correct

const app: Application = express();
app.use(express.json());

// Your routes
app.get('/health', (req: Request, res: Response) => res.json({ status: 'ok' }));
app.get('/users', (req: Request, res: Response) => res.json({ users: [] }));
app.post('/users', (req: Request, res: Response) => res.json({ message: 'created' }));

// APISnap — place AFTER your routes
apisnap.init(app);

app.listen(3000, () => console.log('Server running on port 3000'));

export default app;
```

If TypeScript still shows a red error under the import, create a file called `apisnap.d.ts` in your project root:

```typescript
declare module '@umeshindu222/apisnap' {
  interface APISnapOptions {
    skip?: string[];
    name?: string;
  }
  export function init(app: any, options?: APISnapOptions): void;
}
```

---

### With Sub-Routers (Real World Project)

```javascript
const express = require('express');
const apisnap = require('@umeshindu222/apisnap');
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');
const authRoutes = require('./routes/auth');

const app = express();
app.use(express.json());

// Register all your routers
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/auth', authRoutes);

// APISnap discovers ALL routes including sub-routers
apisnap.init(app);

app.listen(3000);
```

---

### With Global Auth Middleware

>  **Important:** If you use global auth middleware (`app.use(authMiddleware)`), you must place `apisnap.init(app)` **before** it. Otherwise auth will block the discovery endpoint.

```javascript
const express = require('express');
const apisnap = require('@umeshindu222/apisnap');
const authMiddleware = require('./middleware/auth');

const app = express();
app.use(express.json());

// Register routes first
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);

// ✅ APISnap BEFORE global auth middleware
apisnap.init(app);

// ✅ Global auth AFTER apisnap
app.use(authMiddleware);

app.listen(3000);
```

---

### Skip Specific Routes

```javascript
// Don't test certain routes (e.g. auth callbacks, webhooks, admin)
apisnap.init(app, {
  skip: ['/api/auth', '/webhooks', '/admin']
});
```

---

##  Fixing 401 / 403 Errors

401 and 403 errors are **completely normal** — it just means your routes are protected and APISnap needs credentials, exactly like any real client would.

### JWT / Bearer Token

```bash
npx @umeshindu222/apisnap --port 3000 -H "Authorization: Bearer eyJhbGci..."
```

### API Key

```bash
npx @umeshindu222/apisnap --port 3000 -H "x-api-key: your-secret-key"
```

### Cookie / Session Auth (Passport.js, express-session)

```bash
npx @umeshindu222/apisnap --port 3000 --cookie "connect.sid=s%3Aabc123"
```

### Multiple Headers at Once

The `-H` flag can be repeated as many times as you need:

```bash
npx @umeshindu222/apisnap --port 3000 \
  -H "Authorization: Bearer TOKEN" \
  -H "x-api-key: SECRET" \
  -H "x-tenant-id: my-company"
```

### How to Get Your JWT Token

1. Open Postman
2. Call your login endpoint:
```
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{
  "email": "your@email.com",
  "password": "yourpassword"
}
```
3. Copy the token from the response
4. Use it in the `-H` flag above

---

## ⚙️ Config File (Recommended)

Instead of typing your token every single time, save your settings in a config file. Create `.apisnaprc.json` in your project root:

```json
{
  "port": "3000",
  "slow": "300",
  "headers": [
    "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
  ]
}
```

Now just run with no flags:
```bash
npx @umeshindu222/apisnap
```

APISnap reads the config file automatically.

> ⚠️ **Add `.apisnaprc.json` to your `.gitignore`** so your token is never committed to GitHub.

### Config Schema + Secrets

Use the bundled schema for autocomplete and validation:

```json
{
  "$schema": "./apisnaprc.schema.json"
}
```

You can reference environment variables anywhere in config values:

```json
{
  "headers": [
    "Authorization: Bearer $API_TOKEN"
  ],
  "authFlow": {
    "url": "/auth/login",
    "body": {
      "username": "$API_USER",
      "password": "$API_PASSWORD"
    },
    "tokenPath": "token"
  }
}
```

### Full Config File Options

```json
{
  "$schema": "./apisnaprc.schema.json",
  "port": "3000",
  "slow": "300",
  "timeout": "5000",
  "retry": "1",
  "concurrency": 5,
  "openapi": "./openapi.json",
  "body": {
    "name": "test",
    "email": "test@example.com"
  },
  "headers": [
    "Authorization: Bearer YOUR_TOKEN",
    "x-api-key: YOUR_API_KEY"
  ],
  "cookie": "sessionId=your-session-id",
  "params": {
    "id": "1",
    "userId": "1",
    "slug": "hello-world",
    "uuid": "550e8400-e29b-41d4-a716-446655440000"
  },
  "routes": [
    {
      "path": "/api/users",
      "body": { "name": "John", "email": "john@example.com" },
      "timeout": 10000
    },
    {
      "path": "/api/products",
      "body": { "title": "Widget", "price": 9.99 }
    }
  ],
  "envs": {
    "staging": {
      "baseUrl": "https://staging.example.com"
    }
  }
}
```

---

## CLI Reference

```bash
npx @umeshindu222/apisnap [options]
npx @umeshindu222/apisnap doctor [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <n>` | Port your server runs on | `3000` |
| `-H, --header <str>` | Auth header — can repeat multiple times | — |
| `-c, --cookie <str>` | Cookie string for session auth | — |
| `-s, --slow <n>` | Flag routes slower than this (ms) | `200` |
| `-t, --timeout <n>` | Request timeout in ms | `5000` |
| `-r, --retry <n>` | Retry failed requests N times | `0` |
| `-e, --export <file>` | Save JSON report to file | — |
| `--html <file>` | Save HTML report to file | — |
| `--only <methods>` | Only test these methods e.g. `GET,POST` | — |
| `--filter <pattern>` | Path substring/glob filter e.g. `/api/users*` | — |
| `--base-url <url>` | Test a different server e.g. staging | `localhost` |
| `--params <json>` | Override path params as JSON | — |
| `--dry-run` | Print resolved endpoint plan and exit | `false` |
| `--fail-on-slow` | Exit code 1 if slow routes found | `false` |
| `--concurrency <n>` | Concurrent requests to run | `1` |
| `--body <json>` | Default JSON body for POST/PUT/PATCH | — |
| `--auth-flow` | Execute configured authFlow login before tests | `false` |
| `--session` | Capture/replay cookies from responses | `false` |
| `--save-baseline <file>` | Save run as baseline JSON | — |
| `--diff <file>` | Compare against baseline and show regressions | — |
| `--openapi <file>` | Discover routes from OpenAPI JSON | — |
| `--ci` | CI-friendly JSON output and strict exit logic | `false` |
| `--env <name>` | Load environment profile from config | — |

Doctor options:

| Option | Description | Default |
|--------|-------------|---------|
| `doctor` | Diagnose config, server reachability, and middleware wiring | — |
| `doctor -p, --port <n>` | Port to diagnose | config/`3000` |
| `doctor --env <name>` | Diagnose a specific config environment | — |

---

## Examples

### Basic check
```bash
npx @umeshindu222/apisnap --port 3000
```

### With JWT auth
```bash
npx @umeshindu222/apisnap -p 3000 -H "Authorization: Bearer eyJhbGci..."
```

### Custom path params

If your route is `/users/:id/posts/:postId` and the default `1` doesn't work in your database:
```bash
npx @umeshindu222/apisnap --params '{"id":"42","postId":"7"}'
```

### Only test GET routes
```bash
npx @umeshindu222/apisnap --only GET
```

### Test your staging server
```bash
npx @umeshindu222/apisnap --base-url https://staging.myapp.com -H "Authorization: Bearer TOKEN"
```

### Generate an HTML report
```bash
npx @umeshindu222/apisnap --html report
```

Then open it:
```bash
# Windows
start report.html

# Mac
open report.html

# Linux
xdg-open report.html
```

### Generate a JSON report
```bash
npx @umeshindu222/apisnap --export report
# Creates: report.json
```

### Retry flaky endpoints
```bash
npx @umeshindu222/apisnap --retry 3
```

### Preview routes only (no HTTP calls)
```bash
npx @umeshindu222/apisnap --dry-run --filter "/api/users*"
```

### Diff against baseline and fail on regressions
```bash
npx @umeshindu222/apisnap --diff baseline.json
```

### Save a baseline for future comparisons
```bash
npx @umeshindu222/apisnap --save-baseline baseline.json
```

### Discover from OpenAPI instead of live discovery
```bash
npx @umeshindu222/apisnap --openapi ./openapi.json
```

### Run setup diagnostics
```bash
npx @umeshindu222/apisnap doctor -p 3000
```

### CI/CD — fail the pipeline if any endpoint is broken
```bash
npx @umeshindu222/apisnap --export ci-report
# Exits with code 1 automatically if any endpoint fails
```

### All options together
```bash
npx @umeshindu222/apisnap \
  -p 5000 \
  -H "Authorization: Bearer TOKEN" \
  -H "x-api-key: SECRET" \
  --cookie "sessionId=abc" \
  --slow 300 \
  --retry 2 \
  --html report \
  --export report
```

---

## Sample Output

```
📸 APISnap v1.2.3
   Target:     http://localhost:3000
   Slow:       >200ms
   Timeout:    5000ms
   Headers:    {"Authorization":"Bearer ey••••••"}

✔ Connected! Found 6 endpoints to test.

  ✔ GET     /health                             [200]  3ms
  ✔ GET     /users                              [200] 12ms
  ✔ POST    /users                              [200]  8ms
  ✔ GET     /users/1                            [200]  5ms
  ⚠️  GET     /reports                            [200] 543ms ← slow!
  ✖ DELETE  /users/1                            [401]  2ms
     💡 Hint: 401 Unauthorized — try adding -H "Authorization: Bearer YOUR_TOKEN"

📊 Summary:
  ✅ Passed:  5
  ❌ Failed:  1
  ⚠️  Slow:    1 (>200ms)
  ⏱  Avg:    95ms
  📈 p50:    12ms
  📈 p95:    543ms
  📈 p99:    543ms
  🕐 Total:  573ms

⚠️  Some endpoints are unhealthy!
```

---

## JSON Report Format

```json
{
  "tool": "APISnap",
  "version": "1.2.3",
  "generatedAt": "2026-03-08T10:00:00.000Z",
  "config": {
    "port": "3000",
    "slowThreshold": 200,
    "timeout": 5000
  },
  "summary": {
    "total": 6,
    "passed": 5,
    "failed": 1,
    "slow": 1,
    "avgDuration": 95,
    "p50Duration": 12,
    "p95Duration": 543,
    "p99Duration": 543,
    "totalDuration": 573
  },
  "results": [
    {
      "method": "GET",
      "path": "/users",
      "status": 200,
      "duration": 12,
      "success": true,
      "slow": false,
      "retries": 0
    }
  ]
}
```

> **CI/CD tip:** Check `summary.failed > 0` to fail your build automatically.

---

## Common Problems & Fixes

### "Cannot reach discovery endpoint"

```
✖ Cannot reach discovery endpoint: http://localhost:3000/__apisnap_discovery
```

**Causes:**
- Your server is not running — start it first in another terminal
- Wrong port — use `-p YOUR_PORT` to specify the correct one
- You forgot to add `apisnap.init(app)` to your server

---

### All routes show 401

**Cause:** Your routes are protected and no credentials were provided.

**Fix:**
```bash
npx @umeshindu222/apisnap -H "Authorization: Bearer YOUR_REAL_TOKEN"
```

Also check your middleware order — `apisnap.init(app)` must come **before** any global `app.use(authMiddleware)`.

---

### Routes are missing from the output

**Cause:** `apisnap.init(app)` was called before the routes were registered.

**Fix:** Make sure `apisnap.init(app)` is the **last thing** before `app.listen()`:

```javascript
// All routes first
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);

// APISnap last (before app.listen)
apisnap.init(app);

app.listen(3000);
```

---

### Config file not loading

**Cause:** On Windows, creating JSON files with PowerShell `echo` saves them with wrong encoding (UTF-16).

**Fix:** Create `.apisnaprc.json` manually in VS Code or Notepad — File → Save As → select **UTF-8** encoding.

---

### 404 on routes with path params

Routes like `/users/:id` get `:id` replaced with `1` by default. If `1` is not a valid ID in your database, override it:

```bash
npx @umeshindu222/apisnap --params '{"id":"YOUR_REAL_ID"}'
```

Or in your config file:
```json
{
  "params": {
    "id": "64f1a2b3c4d5e6f7a8b9c0d1"
  }
}
```

---

## How It Works

APISnap has two parts:

**1. Middleware** — `apisnap.init(app)` registers a hidden endpoint `/__apisnap_discovery` in your Express app. When called, it recursively walks the entire Express router stack and returns a map of every registered route — including all nested sub-routers.

**2. CLI** — `npx @umeshindu222/apisnap` calls the discovery endpoint, gets the full route list, then sends a real HTTP request to each route using your headers and cookies. It replaces path params with smart defaults (`:id` → `1`, `:uuid` → valid UUID, `:slug` → `"example"`), measures response time, and reports everything.

---

## Contributing

Contributions, issues and feature requests are welcome!

1. Fork the repo
2. Create your branch: `git checkout -b feat/amazing-feature`
3. Commit: `git commit -m 'feat: add amazing feature'`
4. Push: `git push origin feat/amazing-feature`
5. Open a Pull Request

---

## License

MIT © [Umesh Induranga](https://github.com/Umeshinduranga)
