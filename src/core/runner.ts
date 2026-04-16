import fs, { createWriteStream } from 'fs';
import path from 'path';
import axios, { AxiosError } from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import { Command } from 'commander';

const program = new Command();
const { version } = require('../../package.json');

// ─── Types ────────────────────────────────────────────────────────────────────

interface TestResult {
    method: string;
    path: string;
    fullUrl: string;
    status: number;
    statusText: string;
    duration: number;
    success: boolean;
    slow: boolean;
    error?: string;
    retries: number;
    authMethod?: string;
}

interface ReportData {
    tool: string;
    version: string;
    generatedAt: string;
    config: Record<string, any>;
    summary: {
        total: number;
        passed: number;
        failed: number;
        slow: number;
        avgDuration: number;
        totalDuration: number;
        p50Duration: number;
        p95Duration: number;
        p99Duration: number;
    };
    results: TestResult[];
}

interface DiffResult {
    regressions: Array<{ path: string; method: string; prev: Partial<TestResult>; curr: Partial<TestResult>; reason: string }>;
    improvements: Array<{ path: string; method: string; reason: string }>;
    unchanged: number;
    newEndpoints: string[];
    removedEndpoints: string[];
}

interface ConfigError {
    field: string;
    message: string;
    fix: string;
}

interface AuthFlowConfig {
    /** URL to POST credentials to */
    url: string;
    /** Body to send (e.g. { username, password }) */
    body: Record<string, any>;
    /** Dot-path to extract token from response (e.g. "data.token" or "token") */
    tokenPath: string;
    /** Header to inject the token into (default: "Authorization") */
    headerName?: string;
    /** Prefix for the token value (default: "Bearer ") */
    prefix?: string;
}

interface RouteConfig {
    path: string;
    body?: Record<string, any>;
    headers?: string[];
    /** Override auth for this specific route */
    auth?: 'none' | string;
    /** Override timeout for this specific route */
    timeout?: number;
}

function interpolateEnv(value: any): any {
    if (typeof value === 'string') {
        return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, key: string) => process.env[key] ?? match);
    }
    if (Array.isArray(value)) {
        return value.map((item) => interpolateEnv(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v)]));
    }
    return value;
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}

function pathMatchesFilter(pathname: string, pattern: string): boolean {
    if (pattern.includes('*') || pattern.includes('?')) {
        return globToRegExp(pattern).test(pathname);
    }
    return pathname.includes(pattern);
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function parseRetryAfterMs(retryAfterHeader: string | string[] | undefined): number {
    const raw = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    if (!raw) return 2000;

    const asSeconds = Number.parseInt(raw, 10);
    if (Number.isFinite(asSeconds)) {
        return Math.max(0, asSeconds * 1000);
    }

    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - Date.now());
    }

    return 2000;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOpenApiPath(p: string): string {
    return p.replace(/\{([^}]+)\}/g, ':$1');
}

function parseOpenApiEndpoints(spec: any): Array<{ path: string; methods: string[] }> {
    if (!spec || typeof spec !== 'object' || typeof spec.paths !== 'object') {
        return [];
    }

    const validMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
    const endpoints: Array<{ path: string; methods: string[] }> = [];

    for (const [rawPath, pathItem] of Object.entries(spec.paths as Record<string, any>)) {
        if (!pathItem || typeof pathItem !== 'object') continue;
        const methods = Object.keys(pathItem)
            .filter((method) => validMethods.has(method.toLowerCase()))
            .map((method) => method.toUpperCase());

        if (methods.length > 0) {
            endpoints.push({ path: normalizeOpenApiPath(rawPath), methods });
        }
    }

    return endpoints;
}

// ─── Config File Loader ───────────────────────────────────────────────────────

function loadConfigFile(env?: string): Record<string, any> {
    const configNames = ['.apisnaprc', '.apisnaprc.json', 'apisnap.config.json'];
    for (const name of configNames) {
        const filePath = path.resolve(process.cwd(), name);
        if (fs.existsSync(filePath)) {
            try {
                let raw = fs.readFileSync(filePath, 'utf-8');
                raw = raw.replace(/^\uFEFF/, '').trim();
                const config = JSON.parse(raw);
                console.log(chalk.gray(`   Config: ${name}${env ? ` (env: ${env})` : ''}\n`));
                const envMerged = env && config.envs?.[env]
                    ? { ...config, ...config.envs[env] }
                    : config;
                if (env && config.envs?.[env]) {
                    return interpolateEnv(envMerged);
                }
                return interpolateEnv(envMerged);
            } catch (e) {
                console.warn(chalk.yellow(`⚠️  Could not parse config file: ${name}`));
            }
        }
    }
    return {};
}

function validateConfig(config: Record<string, any>): ConfigError[] {
    const errors: ConfigError[] = [];

    if (config.port !== undefined && !Number.isInteger(Number(config.port))) {
        errors.push({ field: 'port', message: '"port" must be a whole number', fix: '"port": 3000' });
    }
    if (config.slow !== undefined && !Number.isInteger(Number(config.slow))) {
        errors.push({ field: 'slow', message: '"slow" must be a whole number', fix: '"slow": 200' });
    }
    if (config.concurrency !== undefined && Number(config.concurrency) < 1) {
        errors.push({ field: 'concurrency', message: '"concurrency" must be ≥ 1', fix: '"concurrency": 3' });
    }
    if (config.headers && !Array.isArray(config.headers)) {
        errors.push({ field: 'headers', message: '"headers" must be an array', fix: '"headers": ["Authorization: Bearer TOKEN"]' });
    }
    if (config.params && (typeof config.params !== 'object' || Array.isArray(config.params) || config.params === null)) {
        errors.push({ field: 'params', message: '"params" must be an object', fix: '"params": {"id": "1"}' });
    }
    if (config.envs && (typeof config.envs !== 'object' || Array.isArray(config.envs) || config.envs === null)) {
        errors.push({ field: 'envs', message: '"envs" must be an object', fix: '"envs": {"staging": {"baseUrl": "https://staging.example.com"}}' });
    }
    if (config.authFlow) {
        const af = config.authFlow;
        if (!af.url) errors.push({ field: 'authFlow.url', message: '"authFlow.url" is required', fix: '"authFlow": { "url": "/auth/login", ... }' });
        if (!af.body) errors.push({ field: 'authFlow.body', message: '"authFlow.body" is required', fix: '"authFlow": { "body": { "username": "test", "password": "pass" } }' });
        if (!af.tokenPath) errors.push({ field: 'authFlow.tokenPath', message: '"authFlow.tokenPath" is required', fix: '"authFlow": { "tokenPath": "token" }' });
    }

    return errors;
}

function parseIntOption(
    value: string | number | undefined,
    name: string,
    defaultValue: number,
    options: { min?: number; max?: number } = {}
): number {
    if (value === undefined || value === null || value === '') return defaultValue;
    const numericValue = typeof value === 'number' ? value : Number(String(value));
    if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue)) {
        console.error(chalk.red(`\n  ✖  Invalid value for --${name}: "${value}" must be a whole number.`));
        process.exit(1);
    }
    if (options.min !== undefined && numericValue < options.min) {
        console.error(chalk.red(`\n  ✖  Invalid value for --${name}: ${numericValue} is below minimum (${options.min}).\n`));
        process.exit(1);
    }
    if (options.max !== undefined && numericValue > options.max) {
        console.error(chalk.red(`\n  ✖  Invalid value for --${name}: ${numericValue} exceeds maximum (${options.max}).\n`));
        process.exit(1);
    }
    return numericValue;
}

// ─── Header Parser ────────────────────────────────────────────────────────

function parseHeaders(headerArgs: string[]): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const h of headerArgs) {
        const colonIdx = h.indexOf(':');
        if (colonIdx > 0) {
            headers[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim();
        } else {
            console.warn(chalk.yellow(`⚠️  Skipping malformed header: "${h}" (expected "Key: Value")`));
        }
    }
    return headers;
}

// ─── Dot-path resolver (for token extraction) ────────────────────────────────

function resolveDotPath(obj: any, dotPath: string): string | null {
    const parts = dotPath.split('.');
    let current = obj;
    for (const part of parts) {
        if (current == null || typeof current !== 'object') return null;
        current = current[part];
    }
    return typeof current === 'string' ? current : (current != null ? String(current) : null);
}

// ─── Auth Flow Executor ───────────────────────────────────────────────────────

async function executeAuthFlow(
    authFlow: AuthFlowConfig,
    baseUrl: string,
    timeout: number
): Promise<{ headerName: string; headerValue: string } | null> {
    const authSpinner = ora('  Authenticating via auth flow...').start();
    try {
        const loginUrl = authFlow.url.startsWith('http') ? authFlow.url : `${baseUrl}${authFlow.url}`;
        const res = await axios.post(loginUrl, authFlow.body, {
            timeout,
            validateStatus: () => true,
            headers: { 'Content-Type': 'application/json' },
        });

        if (res.status >= 400) {
            authSpinner.fail(chalk.red(`Auth flow failed: ${res.status} ${res.statusText}`));
            console.log(chalk.yellow(`  Hint: Check authFlow.body credentials and authFlow.url in your config.`));
            return null;
        }

        const token = resolveDotPath(res.data, authFlow.tokenPath);
        if (!token) {
            authSpinner.fail(chalk.red(`Auth flow: could not find token at path "${authFlow.tokenPath}" in response`));
            console.log(chalk.gray(`  Response body: ${JSON.stringify(res.data).slice(0, 200)}`));
            return null;
        }

        const headerName = authFlow.headerName || 'Authorization';
        const prefix = authFlow.prefix !== undefined ? authFlow.prefix : 'Bearer ';
        const headerValue = `${prefix}${token}`;

        authSpinner.succeed(chalk.green(`Auth flow succeeded → injecting ${headerName}: ${prefix}${token.slice(0, 8)}••••••`));
        return { headerName, headerValue };
    } catch (err: any) {
        authSpinner.fail(chalk.red(`Auth flow error: ${err.message}`));
        return null;
    }
}

// ─── Cookie Jar (session auth) ───────────────────────────────────────────────

class CookieJar {
    private cookies: Map<string, string> = new Map();

    ingest(setCookieHeaders: string | string[] | undefined) {
        if (!setCookieHeaders) return;
        const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
        for (const header of headers) {
            const [kv] = header.split(';');
            const idx = kv.indexOf('=');
            if (idx > 0) {
                this.cookies.set(kv.slice(0, idx).trim(), kv.slice(idx + 1).trim());
            }
        }
    }

    toString(): string {
        return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    has(): boolean {
        return this.cookies.size > 0;
    }
}

// ─── Smart Path Param Replacement ────────────────────────────────────────────

function replacePath(rawPath: string, paramMap: Record<string, string> = {}): string {
    return rawPath.replace(/:([a-zA-Z0-9_]+)/g, (_, param) => {
        if (paramMap[param]) return paramMap[param];
        if (/id$/i.test(param)) return '1';
        if (/slug$/i.test(param)) return 'example';
        if (/uuid$/i.test(param)) return '00000000-0000-0000-0000-000000000001';
        if (/name$/i.test(param)) return 'test';
        if (/token$/i.test(param)) return 'abc123';
        if (/page$/i.test(param)) return '1';
        if (/limit$/i.test(param)) return '10';
        return '1';
    });
}

// ─── Exponential Backoff ──────────────────────────────────────────────────────

function backoffDelay(attempt: number, baseMs = 300): number {
    return Math.min(baseMs * Math.pow(2, attempt) + Math.random() * 100, 10000);
}

// ─── Concurrency Limiter ──────────────────────────────────────────────────────

async function runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
    limit: number
): Promise<(T | Error)[]> {
    const results: (T | Error)[] = Array.from({ length: tasks.length }, () => new Error('Task never executed'));
    let index = 0;

    async function worker() {
        while (index < tasks.length) {
            const i = index++;
            try {
                results[i] = await tasks[i]();
            } catch (err) {
                results[i] = err instanceof Error ? err : new Error(String(err));
            }
        }
    }

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
    await Promise.all(workers);
    return results;
}

// ─── Baseline Diff Engine ─────────────────────────────────────────────────────

function diffAgainstBaseline(current: ReportData, baselinePath: string): DiffResult | null {
    if (!fs.existsSync(baselinePath)) return null;

    let baseline: ReportData;
    try {
        baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    } catch {
        console.warn(chalk.yellow(`⚠️  Could not parse baseline file: ${baselinePath}`));
        return null;
    }

    const baselineMap = new Map(baseline.results.map(r => [`${r.method}:${r.path}`, r]));
    const currentMap  = new Map(current.results.map(r => [`${r.method}:${r.path}`, r]));

    const regressions: DiffResult['regressions'] = [];
    const improvements: DiffResult['improvements'] = [];
    let unchanged = 0;

    const baselineKeys = new Set(baselineMap.keys());
    const currentKeys  = new Set(currentMap.keys());

    const newEndpoints     = [...currentKeys].filter(k => !baselineKeys.has(k));
    const removedEndpoints = [...baselineKeys].filter(k => !currentKeys.has(k));

    for (const [key, curr] of currentMap) {
        const prev = baselineMap.get(key);
        if (!prev) continue;

        const wasOk  = prev.success;
        const isOk   = curr.success;
        const wasSlow = prev.slow;
        const isSlow  = curr.slow;

        if (wasOk && !isOk) {
            regressions.push({ path: curr.path, method: curr.method, prev: { status: prev.status, duration: prev.duration }, curr: { status: curr.status, duration: curr.duration, error: curr.error }, reason: `Status changed ${prev.status} → ${curr.status}` });
        } else if (!wasOk && isOk) {
            improvements.push({ path: curr.path, method: curr.method, reason: `Fixed: ${prev.status} → ${curr.status}` });
        } else if (isOk && !wasSlow && isSlow) {
            regressions.push({ path: curr.path, method: curr.method, prev: { duration: prev.duration }, curr: { duration: curr.duration }, reason: `Latency spike: ${prev.duration}ms → ${curr.duration}ms` });
        } else if (isOk && wasSlow && !isSlow) {
            improvements.push({ path: curr.path, method: curr.method, reason: `Faster: ${prev.duration}ms → ${curr.duration}ms` });
        } else {
            unchanged++;
        }
    }

    return { regressions, improvements, unchanged, newEndpoints, removedEndpoints };
}

function printDiffReport(diff: DiffResult) {
    console.log(chalk.bold('\n🔍 Regression Diff:'));

    if (diff.regressions.length === 0 && diff.improvements.length === 0) {
        console.log(chalk.green('  ✅ No regressions — results match baseline.'));
    }

    if (diff.regressions.length > 0) {
        console.log(chalk.red.bold(`\n  ⛔ ${diff.regressions.length} regression(s):`));
        for (const r of diff.regressions) {
            console.log(chalk.red(`    ✖ [${r.method}] ${r.path}`));
            console.log(chalk.gray(`      ${r.reason}`));
        }
    }

    if (diff.improvements.length > 0) {
        console.log(chalk.green.bold(`\n  🎉 ${diff.improvements.length} improvement(s):`));
        for (const i of diff.improvements) {
            console.log(chalk.green(`    ✔ [${i.method}] ${i.path}`));
            console.log(chalk.gray(`      ${i.reason}`));
        }
    }

    if (diff.newEndpoints.length > 0) {
        console.log(chalk.cyan(`\n  🆕 ${diff.newEndpoints.length} new endpoint(s): ${diff.newEndpoints.join(', ')}`));
    }
    if (diff.removedEndpoints.length > 0) {
        console.log(chalk.yellow(`\n  🗑  ${diff.removedEndpoints.length} removed endpoint(s): ${diff.removedEndpoints.join(', ')}`));
    }
    console.log(chalk.gray(`\n  Unchanged: ${diff.unchanged} endpoint(s)`));
}

// ─── HTML Report Generator ────────────────────────────────────────────────────

function writeHTMLReport(filePath: string, data: ReportData, diff?: DiffResult | null): Promise<void> {
    const passRate = data.summary.total > 0
        ? Math.round((data.summary.passed / data.summary.total) * 100)
        : 0;

    const rowColor = (r: TestResult) => {
        if (!r.success) return '#fee2e2';
        if (r.slow) return '#fef9c3';
        return '#f0fdf4';
    };

    const diffSection = diff ? `
  <div class="diff-section">
    <h2>🔍 Regression Diff</h2>
    ${diff.regressions.length === 0 && diff.improvements.length === 0
        ? '<p class="no-regressions">✅ No regressions — results match baseline.</p>'
        : ''}
    ${diff.regressions.length > 0 ? `
      <h3 class="red">⛔ ${diff.regressions.length} Regression(s)</h3>
      <ul>${diff.regressions.map(r => `<li><strong>[${r.method}] ${r.path}</strong> — ${r.reason}</li>`).join('')}</ul>
    ` : ''}
    ${diff.improvements.length > 0 ? `
      <h3 class="green">🎉 ${diff.improvements.length} Improvement(s)</h3>
      <ul>${diff.improvements.map(i => `<li><strong>[${i.method}] ${i.path}</strong> — ${i.reason}</li>`).join('')}</ul>
    ` : ''}
    ${diff.newEndpoints.length > 0 ? `<p class="blue">🆕 New: ${diff.newEndpoints.join(', ')}</p>` : ''}
    ${diff.removedEndpoints.length > 0 ? `<p class="yellow">🗑 Removed: ${diff.removedEndpoints.join(', ')}</p>` : ''}
  </div>` : '';

        const head = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>APISnap Report — ${data.generatedAt}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8fafc;color:#1e293b;padding:2rem}
    h1{font-size:1.8rem;margin-bottom:.25rem}
    h2{font-size:1.2rem;margin:1.5rem 0 .75rem}
    h3{font-size:1rem;margin:.75rem 0 .4rem}
    .sub{color:#64748b;font-size:.9rem;margin-bottom:2rem}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;margin-bottom:2rem}
    .card{background:#fff;border-radius:12px;padding:1.2rem;box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:center}
    .card .num{font-size:2rem;font-weight:700}
    .card .lbl{font-size:.8rem;color:#64748b;margin-top:.25rem}
    .green{color:#16a34a}.red{color:#dc2626}.yellow{color:#ca8a04}.blue{color:#2563eb}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    th{background:#1e293b;color:#f8fafc;padding:.8rem 1rem;text-align:left;font-size:.85rem}
    td{padding:.75rem 1rem;font-size:.875rem;border-bottom:1px solid #f1f5f9}
    .badge{display:inline-block;padding:.15rem .5rem;border-radius:6px;font-weight:600;font-size:.75rem;color:#fff}
    .badge-get{background:#2563eb}.badge-post{background:#16a34a}.badge-put{background:#d97706}
    .badge-delete{background:#dc2626}.badge-patch{background:#7c3aed}
    .ok{color:#16a34a;font-weight:600}.fail{color:#dc2626;font-weight:600}.slow{color:#ca8a04;font-weight:600}
    .errtext{color:#dc2626;font-size:.8rem}
    .auth-tag{background:#e0e7ff;color:#3730a3;border-radius:4px;padding:.1rem .4rem;font-size:.75rem;font-weight:600}
    .progress{background:#e2e8f0;border-radius:999px;height:10px;margin:1rem 0}
    .progress-bar{background:#16a34a;height:10px;border-radius:999px;transition:width .3s}
    .diff-section{background:#fff;border-radius:12px;padding:1.5rem;margin-top:2rem;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .diff-section ul{padding-left:1.25rem;margin:.5rem 0}
    .diff-section li{margin:.3rem 0;font-size:.9rem}
    .no-regressions{color:#16a34a;font-weight:600}
    footer{margin-top:2rem;color:#94a3b8;font-size:.8rem;text-align:center}
  </style>
</head>
<body>
  <h1>📸 APISnap Health Report</h1>
  <p class="sub">Generated: ${data.generatedAt} &nbsp;|&nbsp; Port: ${data.config.port} &nbsp;|&nbsp; v${data.version}</p>

  <div class="cards">
    <div class="card"><div class="num blue">${data.summary.total}</div><div class="lbl">Total Endpoints</div></div>
    <div class="card"><div class="num green">${data.summary.passed}</div><div class="lbl">Passed</div></div>
    <div class="card"><div class="num red">${data.summary.failed}</div><div class="lbl">Failed</div></div>
    <div class="card"><div class="num yellow">${data.summary.slow}</div><div class="lbl">Slow (&gt;${data.config.slowThreshold}ms)</div></div>
    <div class="card"><div class="num blue">${data.summary.avgDuration}ms</div><div class="lbl">Avg Response</div></div>
        <div class="card"><div class="num blue">${data.summary.p50Duration}ms</div><div class="lbl">p50</div></div>
        <div class="card"><div class="num blue">${data.summary.p95Duration}ms</div><div class="lbl">p95</div></div>
        <div class="card"><div class="num blue">${data.summary.p99Duration}ms</div><div class="lbl">p99</div></div>
    <div class="card"><div class="num ${passRate === 100 ? 'green' : passRate >= 80 ? 'yellow' : 'red'}">${passRate}%</div><div class="lbl">Pass Rate</div></div>
  </div>

  <div class="progress"><div class="progress-bar" style="width:${passRate}%"></div></div>

  <table>
    <thead>
      <tr><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Retries</th><th>Auth</th><th>Error</th></tr>
    </thead>
        <tbody>`;

        const foot = `</tbody>
  </table>

  ${diffSection}

  <footer>APISnap v${data.version} — MIT License</footer>
</body>
</html>`;

        return new Promise((resolve, reject) => {
                const out = createWriteStream(filePath, { encoding: 'utf8' });
                out.on('error', reject);
                out.on('finish', resolve);

                out.write(head);
                for (const r of data.results) {
                        out.write(`
        <tr style="background:${rowColor(r)}">
            <td><span class="badge badge-${r.method.toLowerCase()}">${r.method}</span></td>
            <td><code>${r.path}</code></td>
            <td>${r.success
                                ? `<span class="ok">✔ ${r.status}</span>`
                                : `<span class="fail">✖ ${r.status || 'ERR'}</span>`
                        }</td>
            <td>${r.slow ? `<span class="slow">⚠️ ${r.duration}ms</span>` : `${r.duration}ms`}</td>
            <td>${r.retries > 0 ? `${r.retries} retry` : '—'}</td>
            <td>${r.authMethod ? `<span class="auth-tag">${r.authMethod}</span>` : '—'}</td>
            <td>${r.error ? `<span class="errtext">${r.error}</span>` : '—'}</td>
        </tr>`);
                }
                out.end(foot);
        });
}

// ─── Main CLI ─────────────────────────────────────────────────────────────────

program
    .command('init')
    .description('Set up APISnap interactively')
    .action(async () => {
        const { createInterface } = await import('readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const q = (prompt: string) => new Promise<string>(resolve => rl.question(prompt, resolve));

        console.log(chalk.bold.cyan('\n📸 APISnap — project setup\n'));
        console.log(chalk.gray('  This creates a .apisnaprc.json in your project root.\n'));

        const port = (await q(chalk.white('  Server port? ') + chalk.gray('[3000]: '))).trim() || '3000';
        const slowInput = (await q(chalk.white('  Slow threshold (ms)? ') + chalk.gray('[200]: '))).trim() || '200';
        const authRaw = await q(chalk.white('  Static auth token? ') + chalk.gray('(leave blank to skip): '));

        const useAuthFlow = (await q(chalk.white('  Set up auth flow (auto-login)? ') + chalk.gray('[y/N]: '))).trim().toLowerCase() === 'y';
        let authFlowConfig: Record<string, any> | null = null;
        if (useAuthFlow) {
            const loginUrl   = (await q(chalk.white('    Login endpoint? ') + chalk.gray('[/auth/login]: '))).trim() || '/auth/login';
            const username   = (await q(chalk.white('    Username/email field value: '))).trim();
            const password   = (await q(chalk.white('    Password field value: '))).trim();
            const tokenPath  = (await q(chalk.white('    Token path in response? ') + chalk.gray('[token]: '))).trim() || 'token';
            authFlowConfig = { url: loginUrl, body: { username, password }, tokenPath };
        }

        const skipRaw = await q(chalk.white('  Paths to skip? ') + chalk.gray('e.g. /admin,/internal (or blank): '));

        const configPath = path.resolve(process.cwd(), '.apisnaprc.json');
        const alreadyExists = fs.existsSync(configPath);
        if (alreadyExists) {
            const overwrite = (await q(chalk.yellow('\n  .apisnaprc.json already exists. Overwrite? [y/N]: '))).trim().toLowerCase();
            if (overwrite !== 'y') {
                rl.close();
                console.log(chalk.gray('\n  Cancelled. No changes made.\n'));
                return;
            }
        }
        rl.close();

        const parsedSlow = parseInt(slowInput, 10);
        const config: Record<string, any> = {
            port,
            slow: Number.isNaN(parsedSlow) ? 200 : parsedSlow,
        };
        if (authRaw.trim()) config.headers = [`Authorization: Bearer ${authRaw.trim()}`];
        if (authFlowConfig) config.authFlow = authFlowConfig;
        if (skipRaw.trim()) config.skip = skipRaw.split(',').map(s => s.trim()).filter(Boolean);

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(chalk.green('\n  ✅ Created .apisnaprc.json\n'));
        console.log(chalk.gray('  Next steps:'));
        console.log(chalk.cyan('    1. Start your server'));
        console.log(chalk.cyan('    2. Run: apisnap\n'));
    });

program
    .command('doctor')
    .description('Diagnose your APISnap setup')
    .option('-p, --port <number>', 'Port your server is running on')
    .option('--env <name>', 'Use environment profile from config')
    .action(async (options) => {
        const fileConfig = loadConfigFile(options.env);
        const port = options.port || fileConfig.port || '3000';
        const discoveryUrl = `http://localhost:${port}/__apisnap_discovery`;

        const checks: Array<{ name: string; run: () => Promise<boolean> }> = [
            {
                name: 'Config valid',
                run: async () => validateConfig(fileConfig).length === 0,
            },
            {
                name: 'Server reachable',
                run: async () => {
                    const res = await axios.get(discoveryUrl, { timeout: 2000, validateStatus: () => true });
                    return res.status < 500;
                },
            },
            {
                name: 'Middleware installed',
                run: async () => {
                    const res = await axios.get(discoveryUrl, { timeout: 2000, validateStatus: () => true });
                    return res.status === 200 && res.data?.tool === 'APISnap';
                },
            },
        ];

        if (fileConfig.authFlow) {
            checks.push({
                name: 'Auth flow works',
                run: async () => {
                    const baseUrl = fileConfig.baseUrl || `http://localhost:${port}`;
                    const timeout = parseIntOption(fileConfig.timeout, 'timeout', 5000, { min: 100 });
                    const authResult = await executeAuthFlow(fileConfig.authFlow, baseUrl, timeout);
                    return !!authResult;
                },
            });
        }

        let failedChecks = 0;
        console.log(chalk.bold('\n🩺 APISnap Doctor\n'));
        for (const check of checks) {
            try {
                const ok = await check.run();
                if (ok) {
                    console.log(chalk.green(`  ✅ ${check.name}`));
                } else {
                    failedChecks++;
                    console.log(chalk.red(`  ❌ ${check.name}`));
                }
            } catch (error: any) {
                failedChecks++;
                console.log(chalk.red(`  ❌ ${check.name}`));
                console.log(chalk.gray(`     ${error.message}`));
            }
        }

        console.log();
        process.exit(failedChecks > 0 ? 1 : 0);
    });

program
    .name('apisnap')
    .description('Instant API health-check CLI for Express.js')
    .version(version)
    .option('-p, --port <number>', 'Port your server is running on')
    .option('-H, --header <string>', 'Custom header (repeatable)', collect, [])
    .option('-c, --cookie <string>', 'Cookie string (e.g. "sessionId=abc; token=xyz")')
    .option('-s, --slow <number>', 'Slow response threshold in ms')
    .option('-t, --timeout <number>', 'Request timeout in ms')
    .option('-r, --retry <number>', 'Retry failed requests N times (uses exponential backoff)')
    .option('-e, --export <filename>', 'Export JSON report')
    .option('--html <filename>', 'Export HTML report')
    .option('--only <methods>', 'Only test specific methods (e.g. "GET,POST")')
    .option('--env <name>', 'Use environment profile from config')
    .option('--base-url <url>', 'Override base URL')
    .option('--params <json>', 'JSON map of param overrides')
    .option('--filter <pattern>', 'Only test paths matching pattern (glob or substring)')
    .option('--dry-run', 'Preview endpoints and config without sending requests')
    .option('--watch', 'Re-run checks when project files change')
    .option('--openapi <file>', 'Use OpenAPI JSON file for route discovery')
    .option('--fail-on-slow', 'Exit with code 1 if any slow routes are found')
    .option('--concurrency <number>', 'How many requests to run in parallel (default: 1)')
    .option('--body <json>', 'Default JSON body for POST/PUT/PATCH requests')
    .option('--auth-flow', 'Execute auth flow from config to obtain token automatically')
    .option('--save-baseline <filename>', 'Save results as baseline for future diffs (e.g. baseline)')
    .option('--diff <filename>', 'Diff current results against a saved baseline (e.g. baseline.json)')
    .option('--ci', 'CI mode: structured JSON to stdout, strict exit codes, no spinners')
    .option('--session', 'Enable cookie jar — capture Set-Cookie from login and replay on requests')
    .action(async (options) => {
        const fileConfig = loadConfigFile(options.env);
        const configErrors = validateConfig(fileConfig);

        if (configErrors.length > 0) {
            console.log(chalk.red.bold('\n  Config errors in .apisnaprc.json:\n'));
            configErrors.forEach(e => {
                console.log(chalk.red(`  ✖  ${e.message}`));
                console.log(chalk.gray(`     Fix: ${e.fix}\n`));
            });
            process.exit(1);
        }

        const mergedOptions = { ...fileConfig, ...options };
        const ciMode = !!mergedOptions.ci;

        const port           = mergedOptions.port || '3000';
        const slowThreshold  = parseIntOption(mergedOptions.slow, 'slow', 200, { min: 1 });
        const timeout        = parseIntOption(mergedOptions.timeout, 'timeout', 5000, { min: 100 });
        const retryCount     = parseIntOption(mergedOptions.retry, 'retry', 0, { min: 0, max: 10 });
        const concurrency    = parseIntOption(mergedOptions.concurrency, 'concurrency', 1, { min: 1, max: 50 });
        const onlyMethods    = mergedOptions.only
            ? mergedOptions.only.split(',').map((m: string) => m.trim().toUpperCase())
            : null;
        const cliParams = mergedOptions.params
            ? (typeof mergedOptions.params === 'string' ? JSON.parse(mergedOptions.params) : mergedOptions.params)
            : {};
        const paramOverrides = {
            ...(fileConfig.params || {}),
            ...(cliParams || {}),
        };
        const defaultBody = mergedOptions.body
            ? (typeof mergedOptions.body === 'string' ? JSON.parse(mergedOptions.body) : mergedOptions.body)
            : (fileConfig.body || null);
        const baseUrl       = mergedOptions.baseUrl || mergedOptions['base-url'] || `http://localhost:${port}`;
        const discoveryUrl  = `http://localhost:${port}/__apisnap_discovery`;
        const useAuthFlow   = !!(mergedOptions.authFlow || mergedOptions['auth-flow']);
        const useSession    = !!mergedOptions.session;
        const watchMode     = !!mergedOptions.watch;
        let cachedEndpoints: any[] | null = null;

        const headerArgs = [
            ...(Array.isArray(mergedOptions.header) ? mergedOptions.header : []),
            ...(Array.isArray(fileConfig.headers) ? fileConfig.headers : []),
        ];
        const customHeaders: Record<string, string> = {
            ...parseHeaders(headerArgs),
            'User-Agent': `APISnap/${version}`,
        };
        if (mergedOptions.cookie) customHeaders['Cookie'] = mergedOptions.cookie;

        let authMethod: string | undefined;
        const cookieJar = new CookieJar();

        if (useAuthFlow && fileConfig.authFlow) {
            const authResult = await executeAuthFlow(fileConfig.authFlow, baseUrl, timeout);
            if (authResult) {
                customHeaders[authResult.headerName] = authResult.headerValue;
                authMethod = 'auth-flow';
            }
        } else if (headerArgs.some(h => /^authorization:/i.test(h))) {
            authMethod = 'static-token';
        } else if (mergedOptions.cookie) {
            authMethod = 'cookie';
        }

        if (!ciMode) {
            console.log(chalk.bold.cyan(`\n📸 APISnap v${version}`));
            console.log(chalk.gray(`   Target:      ${baseUrl}`));
            console.log(chalk.gray(`   Slow:        >${slowThreshold}ms`));
            console.log(chalk.gray(`   Timeout:     ${timeout}ms`));
            if (retryCount > 0)   console.log(chalk.gray(`   Retries:     ${retryCount} (exponential backoff)`));
            if (concurrency > 1)  console.log(chalk.gray(`   Concurrency: ${concurrency}`));
            if (defaultBody)      console.log(chalk.gray(`   Body:        ${JSON.stringify(defaultBody)}`));
            if (authMethod)       console.log(chalk.gray(`   Auth:        ${authMethod}`));
            if (useSession)       console.log(chalk.gray(`   Session:     cookie jar enabled`));
            if (onlyMethods)      console.log(chalk.gray(`   Filter:      ${onlyMethods.join(', ')}`));
            const safeHeaders = { ...customHeaders };
            Object.keys(safeHeaders).forEach(k => {
                if (/auth|token|key|secret|cookie/i.test(k)) safeHeaders[k] = safeHeaders[k].slice(0, 8) + '••••••';
            });
            delete safeHeaders['User-Agent'];
            if (Object.keys(safeHeaders).length > 0) console.log(chalk.gray(`   Headers:     ${JSON.stringify(safeHeaders)}`));
            console.log();
        }

        const spinner = ciMode ? null : ora('Connecting to discovery endpoint...').start();
        const results: TestResult[] = [];

        try {
            let endpoints: any[] = [];
            const openApiPath = mergedOptions.openapi ?? fileConfig.openapi;

            if (openApiPath) {
                const configuredPath = openApiPath === true ? './openapi.json' : String(openApiPath);
                const resolvedOpenApi = path.isAbsolute(configuredPath)
                    ? configuredPath
                    : path.resolve(process.cwd(), configuredPath);
                const openApiRaw = fs.readFileSync(resolvedOpenApi, 'utf-8');
                const openApiSpec = JSON.parse(openApiRaw);
                endpoints = parseOpenApiEndpoints(openApiSpec);
                if (spinner) spinner.succeed(chalk.green(`Loaded ${endpoints.length} endpoint${endpoints.length !== 1 ? 's' : ''} from OpenAPI spec.`));
            } else if (watchMode && cachedEndpoints) {
                endpoints = cachedEndpoints;
                if (spinner) spinner.succeed(chalk.green(`Using cached discovery (${endpoints.length} endpoint${endpoints.length !== 1 ? 's' : ''}).`));
            } else {
                const discovery = await axios.get(discoveryUrl, { timeout: 5000 });
                endpoints = discovery.data.endpoints;
                if (watchMode) cachedEndpoints = endpoints;
            }

            if (fileConfig.skip?.length) {
                endpoints = endpoints.filter((e: any) => !fileConfig.skip.some((s: string) => e.path.startsWith(s)));
            }

            if (onlyMethods) {
                endpoints = endpoints.filter((e: any) => e.methods.some((m: string) => onlyMethods.includes(m)));
            }

            if (mergedOptions.filter) {
                endpoints = endpoints.filter((e: any) => pathMatchesFilter(e.path, mergedOptions.filter));
            }

            if (spinner?.isSpinning) spinner.succeed(chalk.green(`Connected! Found ${endpoints.length} endpoint${endpoints.length !== 1 ? 's' : ''} to test.\n`));

            if (mergedOptions['dry-run']) {
                if (!ciMode) {
                    console.log(chalk.bold('\n🧪 Dry Run Endpoints:\n'));
                    endpoints.forEach((e: any) => {
                        const method = (e.methods?.[0] || 'GET').padEnd(7);
                        const resolved = replacePath(e.path, paramOverrides);
                        console.log(`  ${method} ${resolved}`);
                    });
                    console.log();
                }
                process.exit(0);
            }

            let passed = 0, failed = 0, slow = 0;
            const allDurations: number[] = [];

            const tasks = endpoints.map((endpoint: any) => async (): Promise<TestResult> => {
                const method      = endpoint.methods[0];
                const rawPath     = endpoint.path;
                const resolvedPath = replacePath(rawPath, paramOverrides);
                const fullUrl     = `${baseUrl}${resolvedPath}`;

                const routeConfig: RouteConfig | undefined = (fileConfig.routes || []).find(
                    (r: RouteConfig) => r.path === rawPath || r.path === resolvedPath
                );
                const requestBody = routeConfig?.body ?? defaultBody;
                const routeTimeout = routeConfig?.timeout ?? timeout;

                const requestHeaders = { ...customHeaders };
                if (routeConfig?.headers) {
                    Object.assign(requestHeaders, parseHeaders(routeConfig.headers));
                }
                if (routeConfig?.auth === 'none') {
                    delete requestHeaders['Authorization'];
                    delete requestHeaders['Cookie'];
                }

                if (useSession && cookieJar.has() && routeConfig?.auth !== 'none') {
                    const existing = requestHeaders['Cookie'] || '';
                    requestHeaders['Cookie'] = [existing, cookieJar.toString()].filter(Boolean).join('; ');
                }

                const testResult: TestResult = {
                    method, path: rawPath, fullUrl,
                    status: 0, statusText: '', duration: 0,
                    success: false, slow: false, retries: 0,
                    authMethod: routeConfig?.auth === 'none' ? 'none' : authMethod,
                };

                const testSpinner = (ciMode || concurrency > 1) ? null : ora({
                    text: `${chalk.bold(method.padEnd(7))} ${chalk.dim(rawPath)}`,
                    prefixText: '  ',
                }).start();

                let lastError: any = null;
                let attempt = 0;

                while (attempt <= retryCount) {
                    try {
                        const start = Date.now();
                        const res = await axios({
                            method,
                            url: fullUrl,
                            headers: requestHeaders,
                            timeout: routeTimeout,
                            validateStatus: () => true,
                            data: ['POST', 'PUT', 'PATCH'].includes(method) ? requestBody : undefined,
                        });
                        const duration = Date.now() - start;

                        if (res.status === 429) {
                            const retryAfterMs = parseRetryAfterMs(res.headers['retry-after']);
                            if (!ciMode) {
                                process.stdout.write(chalk.gray(`     rate-limited — waiting ${retryAfterMs}ms...\n`));
                            }
                            await sleep(retryAfterMs);
                            continue;
                        }

                        if (useSession) cookieJar.ingest(res.headers['set-cookie']);

                        testResult.duration    = duration;
                        testResult.status      = res.status;
                        testResult.statusText  = res.statusText;
                        testResult.retries     = attempt;
                        testResult.success     = res.status < 400;
                        testResult.slow        = duration > slowThreshold;

                        allDurations.push(duration);

                        if (testResult.success) {
                            const durationStr = testResult.slow
                                ? chalk.yellow.bold(`${duration}ms ← slow!`)
                                : chalk.gray(`${duration}ms`);
                            const msg = `${chalk.bold(method.padEnd(7))} ${chalk.white(rawPath.padEnd(35))} ${chalk.green(`[${res.status}]`)} ${durationStr}`;
                            if (testSpinner) testResult.slow ? testSpinner.warn(msg) : testSpinner.succeed(msg);
                            passed++;
                            if (testResult.slow) slow++;
                        } else {
                            if (testSpinner) testSpinner.fail(
                                `${chalk.bold(method.padEnd(7))} ${chalk.white(rawPath.padEnd(35))} ${chalk.red(`[${res.status} ${res.statusText}]`)} ${chalk.gray(`${duration}ms`)}`
                            );

                            const paramNames = [...rawPath.matchAll(/:([a-zA-Z0-9_]+)/g)].map(match => match[1]);
                            const exampleParams = paramNames.reduce((acc, p) => ({ ...acc, [p]: '1' }), {});

                            if (!ciMode) {
                                if (res.status === 401) {
                                    if (useAuthFlow) {
                                        console.log(chalk.yellow('     hint: auth flow ran but this route still returned 401 — check token permissions'));
                                    } else {
                                        console.log(chalk.yellow('     hint: No credentials — use --auth-flow or add "headers" / "authFlow" to .apisnaprc'));
                                    }
                                } else if (res.status === 403) {
                                    console.log(chalk.yellow('     hint: Token lacks permission for this route — check RBAC/scopes'));
                                } else if (res.status === 404 && paramNames.length > 0) {
                                    console.log(chalk.yellow('     hint: path needs params — add to .apisnaprc:'));
                                    console.log(chalk.gray(`       "params": ${JSON.stringify(exampleParams)}`));
                                } else if (res.status === 404) {
                                    console.log(chalk.yellow('     hint: route not found — is the server fully started?'));
                                } else if (res.status === 400 || res.status === 422) {
                                    console.log(chalk.yellow('     hint: add a request body to .apisnaprc under "routes":'));
                                    console.log(chalk.gray(`       { "path": "${rawPath}", "body": {"field": "value"} }`));
                                }
                            }

                            failed++;
                        }
                        lastError = null;
                        break;
                    } catch (err: any) {
                        lastError = err;
                        attempt++;
                        if (attempt <= retryCount) {
                            const delay = backoffDelay(attempt - 1);
                            if (!ciMode) process.stdout.write(chalk.gray(`     ↺ retry ${attempt}/${retryCount} in ${Math.round(delay)}ms...\n`));
                            await new Promise(r => setTimeout(r, delay));
                        }
                    }
                }

                if (lastError) {
                    testResult.success  = false;
                    testResult.retries  = attempt - 1;
                    testResult.error    = lastError.code === 'ECONNABORTED' ? 'Timeout' : lastError.message;
                    if (testSpinner) testSpinner.fail(
                        `${chalk.bold(method.padEnd(7))} ${chalk.white(rawPath.padEnd(35))} ${chalk.red(`[${testResult.error}]`)}`
                    );
                    failed++;
                }

                return testResult;
            });

            const allResults = await runWithConcurrency<TestResult>(tasks, concurrency);
            for (let i = 0; i < allResults.length; i++) {
                const result = allResults[i];
                if (result instanceof Error) {
                    const ep = endpoints[i];
                    const method = ep?.methods?.[0] || 'UNKNOWN';
                    const rawPath = ep?.path || '(unknown route)';
                    results.push({
                        method, path: rawPath,
                        fullUrl: `${baseUrl}${replacePath(rawPath, paramOverrides)}`,
                        status: 0, statusText: 'Internal Error', duration: 0,
                        success: false, slow: false,
                        error: `Internal task failure: ${result.message}`, retries: 0,
                    });
                    failed++;
                } else {
                    results.push(result);
                }
            }

            if (!ciMode && concurrency > 1) {
                for (const r of results) {
                    const statusLabel = r.success
                        ? chalk.green(`[${r.status}]`)
                        : chalk.red(`[${r.status || 'ERR'} ${r.statusText || ''}]`);
                    const durationLabel = r.slow
                        ? chalk.yellow.bold(`${r.duration}ms ← slow!`)
                        : chalk.gray(`${r.duration}ms`);
                    console.log(`  ${chalk.bold(r.method.padEnd(7))} ${chalk.white(r.path.padEnd(35))} ${statusLabel} ${durationLabel}`.trimEnd());
                    if (!r.success && r.error) {
                        console.log(chalk.gray(`     ${r.error}`));
                    }
                }
            }

            const avgDuration   = allDurations.length > 0 ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length) : 0;
            const totalDuration = allDurations.reduce((a, b) => a + b, 0);
            const sortedDurations = [...allDurations].sort((a, b) => a - b);
            const p50Duration = percentile(sortedDurations, 50);
            const p95Duration = percentile(sortedDurations, 95);
            const p99Duration = percentile(sortedDurations, 99);

            const reportData: ReportData = {
                tool: 'APISnap', version,
                generatedAt: new Date().toISOString(),
                config: { port, baseUrl, slowThreshold, timeout, headers: Object.keys(customHeaders).filter(k => k !== 'User-Agent') },
                summary: { total: endpoints.length, passed, failed, slow, avgDuration, totalDuration, p50Duration, p95Duration, p99Duration },
                results,
            };

            const diffFile = mergedOptions.diff as string | undefined;
            let diff: DiffResult | null = null;

            if (diffFile) {
                const diffPath = diffFile.endsWith('.json') ? diffFile : `${diffFile}.json`;
                diff = diffAgainstBaseline(reportData, diffPath);
                if (diff) printDiffReport(diff);
            }

            if (!ciMode) {
                console.log(chalk.bold('\n📊 Summary:'));
                console.log(`  ${chalk.green('✅ Passed: ')} ${chalk.bold(passed)}`);
                console.log(`  ${chalk.red('❌ Failed: ')} ${chalk.bold(failed)}`);
                console.log(`  ${chalk.yellow('⚠️  Slow:   ')} ${chalk.bold(slow)} (>${slowThreshold}ms)`);
                console.log(`  ${chalk.cyan('⏱  Avg:    ')} ${chalk.bold(avgDuration + 'ms')}`);
                console.log(`  ${chalk.cyan('📈 p50:    ')} ${chalk.bold(p50Duration + 'ms')}`);
                console.log(`  ${chalk.cyan('📈 p95:    ')} ${chalk.bold(p95Duration + 'ms')}`);
                console.log(`  ${chalk.cyan('📈 p99:    ')} ${chalk.bold(p99Duration + 'ms')}`);
                console.log(`  ${chalk.cyan('🕐 Total:  ')} ${chalk.bold(totalDuration + 'ms')}`);

                if (failed > 0) console.log(chalk.red.bold('\n⚠️  Some endpoints are unhealthy!'));
                else if (slow > 0) console.log(chalk.yellow.bold('\n🐢 All alive, but some routes are slow!'));
                else console.log(chalk.green.bold('\n✨ All systems nominal!'));

                const authFailures = results.filter(r => r.status === 401 || r.status === 403);
                if (authFailures.length > 0 && !headerArgs.length && !mergedOptions.cookie && !useAuthFlow) {
                    console.log(chalk.bgYellow.black.bold('\n🔐 Auth Help'));
                    console.log(chalk.yellow(`  You have ${authFailures.length} auth failure(s) and no credentials were provided.`));
                    console.log(chalk.yellow('  Solutions:'));
                    console.log(chalk.gray('    Auto-login:  add "authFlow" to .apisnaprc + run: apisnap --auth-flow'));
                    console.log(chalk.gray('    JWT:         apisnap -H "Authorization: Bearer YOUR_JWT_TOKEN"'));
                    console.log(chalk.gray('    API Key:     apisnap -H "x-api-key: YOUR_KEY"'));
                    console.log(chalk.gray('    Cookie:      apisnap --cookie "sessionId=abc123"'));
                    console.log(chalk.gray('    Session:     apisnap --session  (auto cookie jar)\n'));
                }
            }

            const saveBaselineFlag = mergedOptions.saveBaseline || mergedOptions['save-baseline'];
            if (saveBaselineFlag) {
                const bp = saveBaselineFlag.endsWith('.json') ? saveBaselineFlag : `${saveBaselineFlag}.json`;
                fs.writeFileSync(bp, JSON.stringify(reportData, null, 2));
                if (!ciMode) console.log(chalk.cyan(`\n💾 Baseline saved → ${chalk.white(bp)}`));
            }

            if (mergedOptions.export) {
                const fp = mergedOptions.export.endsWith('.json') ? mergedOptions.export : `${mergedOptions.export}.json`;
                fs.writeFileSync(fp, JSON.stringify(reportData, null, 2));
                if (!ciMode) console.log(chalk.cyan(`\n💾 JSON report → ${chalk.white(fp)}`));
            }

            if (mergedOptions.html) {
                const fp = mergedOptions.html.endsWith('.html') ? mergedOptions.html : `${mergedOptions.html}.html`;
                await writeHTMLReport(fp, reportData, diff);
                if (!ciMode) console.log(chalk.cyan(`🌐 HTML report → ${chalk.white(fp)}`));
            }

            if (ciMode) {
                const ciOutput = {
                    ...reportData,
                    diff: diff ?? undefined,
                    exitCode: (failed > 0 || (mergedOptions['fail-on-slow'] && slow > 0) || (diff?.regressions?.length ?? 0) > 0) ? 1 : 0,
                };
                process.stdout.write(JSON.stringify(ciOutput, null, 2) + '\n');
            }

            console.log();

            const hasRegressions = diff?.regressions?.length ?? 0;
            const shouldFail = failed > 0
                || (mergedOptions['fail-on-slow'] && slow > 0)
                || (hasRegressions > 0);

            process.exit(shouldFail ? 1 : 0);

        } catch (error: any) {
            if (spinner) spinner.fail(chalk.red('Could not connect to your server.'));

            const isRefused = error?.code === 'ECONNREFUSED';
            const isTimeout = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
            const isNoInit  = error?.response?.status === 404;

            if (ciMode) {
                process.stdout.write(JSON.stringify({ error: error.message, code: error.code }) + '\n');
            } else if (isRefused) {
                console.log(chalk.yellow(`\n  Your server is not running on port ${port}.`));
                console.log(chalk.gray('  → Start it first, then run apisnap again.\n'));
            } else if (isTimeout) {
                console.log(chalk.yellow('\n  Connection timed out.'));
                console.log(chalk.gray('  → Is the port right? Try: apisnap -p YOUR_PORT\n'));
            } else if (isNoInit) {
                console.log(chalk.yellow('\n  Server is running but APISnap middleware not found.'));
                console.log(chalk.gray('  → Add this to your server AFTER your routes:\n'));
                console.log(chalk.cyan("      const apisnap = require('@umeshindu222/apisnap');"));
                console.log(chalk.cyan('      apisnap.init(app);\n'));
            } else {
                console.log(chalk.gray('\n  Checklist:'));
                console.log(chalk.gray('  1. Server running?  →  node server.js'));
                console.log(chalk.gray('  2. Middleware added? →  apisnap.init(app) after your routes'));
                console.log(chalk.gray('  3. Port correct?    →  apisnap -p YOUR_PORT\n'));
            }

            process.exit(1);
        }
    });

function collect(val: string, prev: string[]) {
    return prev.concat([val]);
}

program.parse(process.argv);
