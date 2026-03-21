import fs from 'fs';
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
    };
    results: TestResult[];
}

interface ConfigError {
    field: string;
    message: string;
    fix: string;
}

// ─── Config File Loader ───────────────────────────────────────────────────────

function loadConfigFile(env?: string): Record<string, any> {
    const configNames = ['.apisnaprc', '.apisnaprc.json', 'apisnap.config.json'];
    for (const name of configNames) {
        const filePath = path.resolve(process.cwd(), name);
        if (fs.existsSync(filePath)) {
            try {
                // Strip BOM if present (fixes Windows PowerShell encoding issue)
                let raw = fs.readFileSync(filePath, 'utf-8');
                raw = raw.replace(/^\uFEFF/, '');
                raw = raw.trim();
                const config = JSON.parse(raw);
                console.log(chalk.gray(`   Config: ${name}${env ? ` (env: ${env})` : ''}\n`));

                if (env && config.envs?.[env]) {
                    return { ...config, ...config.envs[env] };
                }

                return config;
            } catch (e) {
                console.warn(chalk.yellow(`⚠️  Could not parse config file: ${name}`));
            }
        }
    }
    return {};
}

function validateConfig(config: Record<string, any>): ConfigError[] {
    const errors: ConfigError[] = [];

    if (config.port && isNaN(parseInt(config.port))) {
        errors.push({ field: 'port', message: '"port" must be a number', fix: '"port": "3000"' });
    }

    if (config.slow && isNaN(parseInt(config.slow))) {
        errors.push({ field: 'slow', message: '"slow" must be a number', fix: '"slow": 200' });
    }

    if (config.concurrency && parseInt(config.concurrency) < 1) {
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

    return errors;
}

// ─── Header Parser ─────────────────────────────────────────────────────────

function parseHeaders(headerArgs: string[]): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const h of headerArgs) {
        const colonIdx = h.indexOf(':');
        if (colonIdx > 0) {
            const key = h.slice(0, colonIdx).trim();
            const value = h.slice(colonIdx + 1).trim();
            headers[key] = value;
        } else {
            console.warn(chalk.yellow(`⚠️  Skipping malformed header: "${h}" (expected "Key: Value")`));
        }
    }
    return headers;
}

// ─── Smart Path Param Replacement ────────────────────────────────────────────

function replacePath(rawPath: string, paramMap: Record<string, string> = {}): string {
    return rawPath.replace(/:([a-zA-Z0-9_]+)/g, (_, param) => {
        if (paramMap[param]) return paramMap[param];
        // Smart defaults based on param name
        if (/id$/i.test(param)) return '1';
        if (/slug$/i.test(param)) return 'example';
        if (/uuid$/i.test(param)) return '00000000-0000-0000-0000-000000000001';
        if (/name$/i.test(param)) return 'test';
        if (/token$/i.test(param)) return 'abc123';
        if (/page$/i.test(param)) return '1';
        if (/limit$/i.test(param)) return '10';
        return '1'; // fallback
    });
}

// ─── Concurrency Limiter ──────────────────────────────────────────────────────

async function runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
    limit: number
): Promise<T[]> {
    const results: T[] = [];
    let index = 0;

    async function worker() {
        while (index < tasks.length) {
            const i = index++;
            results[i] = await tasks[i]();
        }
    }

    // Spin up `limit` workers — each pulls the next task when free
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
    await Promise.all(workers);
    return results;
}

// ─── HTML Report Generator ────────────────────────────────────────────────────

function generateHTMLReport(data: ReportData): string {
    const passRate = data.summary.total > 0
        ? Math.round((data.summary.passed / data.summary.total) * 100)
        : 0;

    const rowColor = (r: TestResult) => {
        if (!r.success) return '#fee2e2';
        if (r.slow) return '#fef9c3';
        return '#f0fdf4';
    };

    const rows = data.results.map(r => `
    <tr style="background:${rowColor(r)}">
      <td><span class="badge badge-${r.method.toLowerCase()}">${r.method}</span></td>
      <td><code>${r.path}</code></td>
      <td>${r.success
            ? `<span class="ok">✔ ${r.status}</span>`
            : `<span class="fail">✖ ${r.status || 'ERR'}</span>`
        }</td>
      <td>${r.slow ? `<span class="slow">⚠️ ${r.duration}ms</span>` : `${r.duration}ms`}</td>
      <td>${r.retries > 0 ? `${r.retries} retry` : '—'}</td>
      <td>${r.error ? `<span class="errtext">${r.error}</span>` : '—'}</td>
    </tr>
  `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>APISnap Report — ${data.generatedAt}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8fafc;color:#1e293b;padding:2rem}
    h1{font-size:1.8rem;margin-bottom:.25rem}
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
    .progress{background:#e2e8f0;border-radius:999px;height:10px;margin:1rem 0}
    .progress-bar{background:#16a34a;height:10px;border-radius:999px;transition:width .3s}
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
    <div class="card"><div class="num ${passRate === 100 ? 'green' : passRate >= 80 ? 'yellow' : 'red'}">${passRate}%</div><div class="lbl">Pass Rate</div></div>
  </div>

  <div class="progress"><div class="progress-bar" style="width:${passRate}%"></div></div>

  <table>
    <thead>
      <tr><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Retries</th><th>Error</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <footer>APISnap v${data.version} — MIT License</footer>
</body>
</html>`;
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
        const authRaw = await q(chalk.white('  Auth token? ') + chalk.gray('(leave blank to skip): '));
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

        if (authRaw.trim()) {
            config.headers = [`Authorization: Bearer ${authRaw.trim()}`];
        }

        if (skipRaw.trim()) {
            config.skip = skipRaw.split(',').map(s => s.trim()).filter(Boolean);
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        console.log(chalk.green('\n  ✅ Created .apisnaprc.json\n'));
        console.log(chalk.gray('  Next steps:'));
        console.log(chalk.cyan('    1. Start your server'));
        console.log(chalk.cyan('    2. Run: apisnap\n'));
    });

program
    .name('apisnap')
    .description('Instant API health-check CLI for Express.js')
    .version(version)
    .option('-p, --port <number>', 'Port your server is running on')
    .option('-H, --header <string>', 'Custom header — can be used multiple times (e.g. -H "Authorization: Bearer TOKEN" -H "x-api-key: SECRET")', collect, [])
    .option('-c, --cookie <string>', 'Cookie string (e.g. "sessionId=abc; token=xyz")')
    .option('-s, --slow <number>', 'Slow response threshold in ms')
    .option('-t, --timeout <number>', 'Request timeout in ms')
    .option('-r, --retry <number>', 'Retry failed requests N times')
    .option('-e, --export <filename>', 'Export JSON report (e.g. report)')
    .option('--html <filename>', 'Export HTML report (e.g. report)')
    .option('--only <methods>', 'Only test specific methods (e.g. "GET,POST")')
    .option('--env <name>', 'Use environment profile from config (e.g. staging, prod)')
    .option('--base-url <url>', 'Override base URL (e.g. https://staging.myapp.com)')
    .option('--params <json>', 'JSON map of param overrides (e.g. \'{"id":"42"}\')')
    .option('--fail-on-slow', 'Exit with code 1 if any slow routes are found')
    .option('--concurrency <number>', 'How many requests to run in parallel (default: 1)')
    .option('--body <json>', 'Default JSON body for POST/PUT/PATCH requests (e.g. \'{"name":"test"}\')')
    .action(async (options) => {
        // Merge config file with CLI options (CLI takes precedence)
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

        const port = mergedOptions.port || '3000';
        const slowThreshold = parseInt(mergedOptions.slow || '200');
        const timeout = parseInt(mergedOptions.timeout || '5000');
        const retryCount = parseInt(mergedOptions.retry || '0');
        const onlyMethods = mergedOptions.only
            ? mergedOptions.only.split(',').map((m: string) => m.trim().toUpperCase())
            : null;
        const paramOverrides = mergedOptions.params
            ? (typeof mergedOptions.params === 'string'
                ? JSON.parse(mergedOptions.params)  // from CLI flag — parse it
                : mergedOptions.params)             // from config file — already an object
            : (fileConfig.params || {});

        const concurrency = parseInt(mergedOptions.concurrency || '1');
        const defaultBody = mergedOptions.body
            ? (typeof mergedOptions.body === 'string'
                ? JSON.parse(mergedOptions.body)
                : mergedOptions.body)
            : (fileConfig.body || null);

        const baseUrl = mergedOptions.baseUrl || mergedOptions['base-url'] || `http://localhost:${port}`;
        const discoveryUrl = `http://localhost:${port}/__apisnap_discovery`;

        // Build headers
        const headerArgs = [
            ...(Array.isArray(mergedOptions.header) ? mergedOptions.header : []),
            ...(Array.isArray(fileConfig.headers) ? fileConfig.headers : []),
        ];
        const customHeaders: Record<string, string> = {
            ...parseHeaders(headerArgs),
            'User-Agent': `APISnap/${version}`,
        };

        if (mergedOptions.cookie) {
            customHeaders['Cookie'] = mergedOptions.cookie;
        }

        // ── Banner ──────────────────────────────────────────────────────────────
        console.log(chalk.bold.cyan(`\n📸 APISnap v${version}`));
        console.log(chalk.gray(`   Target:     ${baseUrl}`));
        console.log(chalk.gray(`   Slow:       >${slowThreshold}ms`));
        console.log(chalk.gray(`   Timeout:    ${timeout}ms`));
        if (retryCount > 0) console.log(chalk.gray(`   Retries:    ${retryCount}`));
        if (concurrency > 1) console.log(chalk.gray(`   Concurrency: ${concurrency}`));
        if (defaultBody)     console.log(chalk.gray(`   Body:        ${JSON.stringify(defaultBody)}`));
        if (Object.keys(customHeaders).filter(k => k !== 'User-Agent').length > 0) {
            const safeHeaders = { ...customHeaders };
            // Mask auth tokens in output
            Object.keys(safeHeaders).forEach(k => {
                if (/auth|token|key|secret|cookie/i.test(k)) {
                    safeHeaders[k] = safeHeaders[k].slice(0, 8) + '••••••';
                }
            });
            delete safeHeaders['User-Agent'];
            console.log(chalk.gray(`   Headers:    ${JSON.stringify(safeHeaders)}`));
        }
        if (onlyMethods) console.log(chalk.gray(`   Filter:     ${onlyMethods.join(', ')}`));
        console.log();

        const spinner = ora('Connecting to discovery endpoint...').start();
        const results: TestResult[] = [];

        try {
            // ── Discovery ───────────────────────────────────────────────────────
            const discovery = await axios.get(discoveryUrl, { timeout: 5000 });
            let { endpoints } = discovery.data;

            // Filter by method if --only flag provided
            if (onlyMethods) {
                endpoints = endpoints.filter((e: any) =>
                    e.methods.some((m: string) => onlyMethods.includes(m))
                );
            }

            spinner.succeed(chalk.green(`Connected! Found ${endpoints.length} endpoint${endpoints.length !== 1 ? 's' : ''} to test.\n`));

            let passed = 0, failed = 0, slow = 0;
            const allDurations: number[] = [];

            // ── Test Each Endpoint ───────────────────────────────────────────────
            // ── Build task list ───────────────────────────────────────────────────────
            const tasks = endpoints.map((endpoint: any) => async (): Promise<TestResult> => {
                const method = endpoint.methods[0];
                const rawPath = endpoint.path;
                const resolvedPath = replacePath(rawPath, paramOverrides);
                const fullUrl = `${baseUrl}${resolvedPath}`;

                // Per-route body: check fileConfig.routes first, fall back to defaultBody
                const routeConfig = (fileConfig.routes || []).find(
                    (r: any) => r.path === rawPath || r.path === resolvedPath
                );
                const requestBody = routeConfig?.body ?? defaultBody;

                const testResult: TestResult = {
                    method, path: rawPath, fullUrl,
                    status: 0, statusText: '', duration: 0,
                    success: false, slow: false, retries: 0,
                };

                const testSpinner = ora({
                    text: `${chalk.bold(method.padEnd(7))} ${chalk.dim(rawPath)}`,
                    prefixText: '  '
                }).start();

                let lastError: any = null;
                let attempt = 0;

                while (attempt <= retryCount) {
                    try {
                        const start = Date.now();
                        const res = await axios({
                            method,
                            url: fullUrl,
                            headers: customHeaders,
                            timeout,
                            validateStatus: () => true,
                            // Only send body for methods that accept one
                            data: ['POST', 'PUT', 'PATCH'].includes(method) ? requestBody : undefined,
                        });
                        const duration = Date.now() - start;

                        testResult.duration = duration;
                        testResult.status = res.status;
                        testResult.statusText = res.statusText;
                        testResult.retries = attempt;
                        testResult.success = res.status < 400;
                        testResult.slow = duration > slowThreshold;

                        allDurations.push(duration);

                        if (testResult.success) {
                            const durationStr = testResult.slow
                                ? chalk.yellow.bold(`${duration}ms ← slow!`)
                                : chalk.gray(`${duration}ms`);
                            const msg = `${chalk.bold(method.padEnd(7))} ${chalk.white(rawPath.padEnd(35))} ` +
                                `${chalk.green(`[${res.status}]`)} ${durationStr}`;
                            testResult.slow ? testSpinner.warn(msg) : testSpinner.succeed(msg);
                            passed++;
                            if (testResult.slow) slow++;
                        } else {
                            testSpinner.fail(
                                `${chalk.bold(method.padEnd(7))} ${chalk.white(rawPath.padEnd(35))} ` +
                                `${chalk.red(`[${res.status} ${res.statusText}]`)} ${chalk.gray(`${duration}ms`)}`
                            );

                            const paramNames = [...rawPath.matchAll(/:([a-zA-Z0-9_]+)/g)].map(match => match[1]);
                            const exampleParams = paramNames.reduce((acc, paramName) => ({ ...acc, [paramName]: '1' }), {});

                            if (res.status === 401 || res.status === 403) {
                                const hint = res.status === 401
                                    ? 'No credentials sent — add to .apisnaprc: "headers": ["Authorization: Bearer TOKEN"]'
                                    : 'Token lacks permission for this route';
                                console.log(chalk.yellow(`     hint: ${hint}`));
                            } else if (res.status === 404 && paramNames.length > 0) {
                                console.log(chalk.yellow('     hint: path needs params — add to .apisnaprc:'));
                                console.log(chalk.gray(`       "params": ${JSON.stringify(exampleParams)}`));
                            } else if (res.status === 404) {
                                console.log(chalk.yellow('     hint: route not found — is the server fully started?'));
                            } else if (res.status === 400 || res.status === 422) {
                                console.log(chalk.yellow('     hint: add a request body to .apisnaprc under "routes":'));
                                console.log(chalk.gray(`       { "path": "${rawPath}", "body": {"field": "value"} }`));
                            }

                            failed++;
                        }
                        lastError = null;
                        break;
                    } catch (err: any) {
                        lastError = err;
                        attempt++;
                        if (attempt <= retryCount) await new Promise(r => setTimeout(r, 500 * attempt));
                    }
                }

                if (lastError) {
                    testResult.success = false;
                    testResult.retries = attempt - 1;
                    testResult.error = lastError.code === 'ECONNABORTED' ? 'Timeout' : lastError.message;
                    testSpinner.fail(
                        `${chalk.bold(method.padEnd(7))} ${chalk.white(rawPath.padEnd(35))} ` +
                        chalk.red(`[${testResult.error}]`)
                    );
                    failed++;
                }

                return testResult;
            });

            // ── Run with concurrency limit ────────────────────────────────────────────
            const allResults = await runWithConcurrency<TestResult>(tasks, concurrency);
            results.push(...allResults);

            // ── Summary ──────────────────────────────────────────────────────────
            const avgDuration = allDurations.length > 0
                ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length)
                : 0;
            const totalDuration = allDurations.reduce((a, b) => a + b, 0);

            console.log(chalk.bold('\n📊 Summary:'));
            console.log(`  ${chalk.green('✅ Passed: ')} ${chalk.bold(passed)}`);
            console.log(`  ${chalk.red('❌ Failed: ')} ${chalk.bold(failed)}`);
            console.log(`  ${chalk.yellow('⚠️  Slow:   ')} ${chalk.bold(slow)} (>${slowThreshold}ms)`);
            console.log(`  ${chalk.cyan('⏱  Avg:    ')} ${chalk.bold(avgDuration + 'ms')}`);
            console.log(`  ${chalk.cyan('🕐 Total:  ')} ${chalk.bold(totalDuration + 'ms')}`);

            if (failed > 0) {
                console.log(chalk.red.bold('\n⚠️  Some endpoints are unhealthy!'));
            } else if (slow > 0) {
                console.log(chalk.yellow.bold('\n🐢 All alive, but some routes are slow!'));
            } else {
                console.log(chalk.green.bold('\n✨ All systems nominal!'));
            }

            // ── Auth Troubleshooting Summary ─────────────────────────────────────
            const authFailures = results.filter(r => r.status === 401 || r.status === 403);
            if (authFailures.length > 0 && !headerArgs.length && !mergedOptions.cookie) {
                console.log(chalk.bgYellow.black.bold('\n🔐 Auth Help'));
                console.log(chalk.yellow('  You have ' + authFailures.length + ' auth failure(s) and no credentials were provided.'));
                console.log(chalk.yellow('  Solutions:'));
                console.log(chalk.gray('    JWT:     apisnap -H "Authorization: Bearer YOUR_JWT_TOKEN"'));
                console.log(chalk.gray('    API Key: apisnap -H "x-api-key: YOUR_KEY"'));
                console.log(chalk.gray('    Cookie:  apisnap --cookie "sessionId=abc123"'));
                console.log(chalk.gray('    Multi:   apisnap -H "Authorization: Bearer TOKEN" -H "x-tenant: acme"'));
                console.log(chalk.gray('    Config:  create .apisnaprc.json  (see README)\n'));
            }

            // ── Exports ──────────────────────────────────────────────────────────
            const reportData: ReportData = {
                tool: 'APISnap', version,
                generatedAt: new Date().toISOString(),
                config: { port, baseUrl, slowThreshold, timeout, headers: Object.keys(customHeaders).filter(k => k !== 'User-Agent') },
                summary: { total: endpoints.length, passed, failed, slow, avgDuration, totalDuration },
                results,
            };

            if (mergedOptions.export) {
                const filePath = mergedOptions.export.endsWith('.json') ? mergedOptions.export : `${mergedOptions.export}.json`;
                fs.writeFileSync(filePath, JSON.stringify(reportData, null, 2));
                console.log(chalk.cyan(`\n💾 JSON report → ${chalk.white(filePath)}`));
            }

            if (mergedOptions.html) {
                const filePath = mergedOptions.html.endsWith('.html') ? mergedOptions.html : `${mergedOptions.html}.html`;
                fs.writeFileSync(filePath, generateHTMLReport(reportData));
                console.log(chalk.cyan(`🌐 HTML report → ${chalk.white(filePath)}`));
            }

            console.log();

            // Exit codes for CI/CD
            const shouldFail = failed > 0 || (mergedOptions['fail-on-slow'] && slow > 0);
            process.exit(shouldFail ? 1 : 0);

        } catch (error: any) {
            spinner.fail(chalk.red('Could not connect to your server.'));

            const isRefused = error?.code === 'ECONNREFUSED';
            const isTimeout = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
            const isNoInit = error?.response?.status === 404;

            if (isRefused) {
                console.log(chalk.yellow(`\n  Your server is not running on port ${port}.`));
                console.log(chalk.gray('  → Start it first, then run apisnap again.\n'));
            } else if (isTimeout) {
                console.log(chalk.yellow('\n  Connection timed out.'));
                console.log(chalk.gray('  → Is the port right? Try: apisnap -p YOUR_PORT\n'));
            } else if (isNoInit) {
                console.log(chalk.yellow('\n  Server is running but APISnap middleware not found.'));
                console.log(chalk.gray('  → Add this to your server AFTER your routes:\n'));
                console.log(chalk.cyan('      const apisnap = require(\'@umeshindu222/apisnap\');'));
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

// Allows -H to be used multiple times
function collect(val: string, prev: string[]) {
    return prev.concat([val]);
}

program.parse(process.argv);
