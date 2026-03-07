import fs from 'fs';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import { Command } from 'commander';
import path from 'path';

const program = new Command();

const { version } = require('../../package.json');

program
    .name('apisnap')
    .description('Instant API health-check CLI for Express.js')
    .version(version)
    .option('-p, --port <number>', 'Override port')
    .option('-H, --header <string>', 'One-time header (Key:Value)')
    .option('-s, --slow <number>', 'Override slow threshold (ms)')
    .option('-e, --export <filename>', 'Export results to JSON file (e.g., report.json)')
    .action(async (options) => {
        let config: any = { port: 3000, slowThreshold: 200, headers: {} };

        // Smart Merge: Load shared, then override with local
        ['apisnap.json', 'apisnap.local.json'].forEach(file => {
            const filePath = path.join(process.cwd(), file);
            if (fs.existsSync(filePath)) {
                try {
                    const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    config = {
                        ...config,
                        ...fileData,
                        headers: { ...config.headers, ...fileData.headers }
                    };
                } catch (e) {
                    console.log(chalk.yellow(`⚠️  Warning: Failed to parse ${file}`));
                }
            }
        });

        // Final Priority: CLI Flags always win
        const port = options.port || config.port;
        const slowThreshold = options.slow ? parseInt(options.slow) : config.slowThreshold;
        const finalHeaders = { ...config.headers };

        if (options.header) {
            const [key, ...val] = options.header.split(':');
            finalHeaders[key.trim()] = val.join(':').trim();
        }

        const discoveryUrl = `http://localhost:${port}/__apisnap_discovery`;
        const results: any[] = []; // Collect all test results here

        console.log(chalk.bold.cyan(`\n📸 APISnap v${version}`));
        console.log(chalk.gray(` 🔌 Port: ${port} | 🛡️  Auth: ${finalHeaders.Authorization ? 'Detected' : 'None'}\n`));

        const spinner = ora('Connecting to your API...').start();

        try {
            // 1. Fetch the route map from the middleware
            const response = await axios.get(discoveryUrl);
            const { endpoints } = response.data;

            spinner.succeed(chalk.green(`Connected! Found ${endpoints.length} endpoints.\n`));

            // Summary counters
            let passed = 0;
            let failed = 0;
            let slow = 0;

            // 2. Loop through each discovered endpoint
            for (const endpoint of endpoints) {
                const method = endpoint.methods[0];
                let path = endpoint.path;

                // Smart Parameter Replacement — :id, :slug → 1
                if (path.includes(':')) {
                    path = path.replace(/:[a-zA-Z0-9]+/g, '1');
                }

                const fullUrl = `http://localhost:${port}${path}`;
                const testSpinner = ora(`Testing ${chalk.bold(method)} ${path}`).start();

                // Step 8: Initialize result object for this endpoint
                const testResult: any = {
                    method,
                    path,
                    fullUrl,
                    status: 0,
                    duration: 0,
                    success: false,
                    slow: false,
                };

                try {
                    const startTime = Date.now();
                    const res = await axios({
                        method: method,
                        url: fullUrl,
                        headers: {
                            ...finalHeaders,
                            'x-apisnap-key': 'apisnap_secret_handshake_2024',
                            'User-Agent': `APISnap/${version}`,
                        },
                        timeout: 5000,
                    });
                    const duration = Date.now() - startTime;

                    // Step 8: Populate result
                    testResult.duration = duration;
                    testResult.status = res.status;
                    testResult.success = true;

                    // Step 7: Performance threshold check
                    let statusIcon = chalk.green('✔');
                    let durationColor = chalk.gray;

                    if (duration > slowThreshold) {
                        statusIcon = chalk.yellow('⚠️ ');
                        durationColor = chalk.yellow.bold;
                        testResult.slow = true;
                        slow++;
                    }

                    testSpinner.succeed(
                        `${statusIcon} ${chalk.bold(method)} ${chalk.white(path)} ` +
                        `${chalk.green(`[${res.status} OK]`)} ` +
                        `${durationColor(`${duration}ms`)}`
                    );
                    passed++;
                } catch (err: any) {
                    testResult.status = err.response?.status || 500;
                    testResult.success = false;

                    const status = err.response?.status || 'FAIL';
                    testSpinner.fail(
                        `${chalk.bold(method)} ${chalk.white(path)} ` +
                        `${chalk.red(`[${status}]`)}`
                    );
                    failed++;
                }

                results.push(testResult); // Step 8: Save result to list
            }

            // Summary Statistics
            console.log(chalk.bold('\n📊 Summary:'));
            console.log(chalk.green(`  ✅ Passed:  ${passed}`));
            console.log(chalk.red(`  ❌ Failed:  ${failed}`));
            console.log(chalk.yellow(`  ⚠️  Slow:    ${slow} (>${slowThreshold}ms)`));

            if (failed > 0) {
                console.log(chalk.red.bold('\n⚠️  Some endpoints are unhealthy!'));
            } else if (slow > 0) {
                console.log(chalk.yellow.bold('\n🐢 All endpoints alive, but some are slow!'));
            } else {
                console.log(chalk.green.bold('\n✨ All systems nominal!'));
            }

            // Step 8: Export report to JSON file
            if (options.export) {
                const filePath = options.export.endsWith('.json')
                    ? options.export
                    : `${options.export}.json`;

                const reportData = {
                    tool: 'APISnap',
                    generatedAt: new Date().toISOString(),
                    config: {
                        port,
                        slowThreshold,
                        headers: finalHeaders,
                    },
                    summary: {
                        total: endpoints.length,
                        passed,
                        failed,
                        slow,
                    },
                    results,
                };

                fs.writeFileSync(filePath, JSON.stringify(reportData, null, 2));
                console.log(
                    chalk.cyan.bold(`\n💾 Report saved to: ${chalk.white(filePath)}`)
                );
            }
        } catch (error: any) {
            spinner.fail(chalk.red(`Failed to connect to ${discoveryUrl}`));
            console.log(
                chalk.yellow(
                    'Is your server running? Make sure apisnap.init(app) is added.\n'
                )
            );
            process.exit(1);
        }
    });

program
    .command('init')
    .description('Initialize APISnap configuration files')
    .action(() => {
        const sharedConfig = {
            port: 3000,
            slowThreshold: 200,
            description: "Shared project API settings"
        };

        const localConfig = {
            headers: {
                Authorization: "Bearer YOUR_PRIVATE_TOKEN_HERE"
            }
        };

        // Create the files in the user's current directory
        fs.writeFileSync('apisnap.json', JSON.stringify(sharedConfig, null, 2));
        fs.writeFileSync('apisnap.local.json', JSON.stringify(localConfig, null, 2));

        console.log(chalk.green.bold('\n✨ APISnap Initialized Successfully!'));
        console.log(chalk.cyan('Created:'));
        console.log(` 📄 ${chalk.white('apisnap.json')}        (Shared - Push to GitHub)`);
        console.log(` 📄 ${chalk.yellow('apisnap.local.json')}  (Private - DO NOT PUSH)`);

        console.log(chalk.red.bold('\n⚠️  IMPORTANT SECURITY STEP:'));
        console.log(`Add ${chalk.yellow.bold('apisnap.local.json')} to your ${chalk.white('.gitignore')} file now!\n`);
    });

program.parse(process.argv);
