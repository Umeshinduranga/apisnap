import fs from 'fs';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import { Command } from 'commander';

const program = new Command();

program
    .name('apisnap')
    .description('Instant API health-check CLI for Express.js')
    .version('1.0.0')
    .option('-p, --port <number>', 'The port your server is running on', '3000')
    .option('-H, --header <string>', 'Add a custom header (e.g., "Authorization: Bearer token")')
    .option('-s, --slow <number>', 'Threshold for slow response warning (ms)', '200')
    .option('-e, --export <filename>', 'Export results to a JSON file (e.g., report.json)')
    .action(async (options) => {
        const port = options.port;
        const slowThreshold = parseInt(options.slow);
        const discoveryUrl = `http://localhost:${port}/__apisnap_discovery`;
        const results: any[] = []; // Collect all test results here

        // Parse custom header from CLI flag
        const customHeaders: any = {};
        if (options.header) {
            const [key, ...value] = options.header.split(':');
            if (key && value) {
                customHeaders[key.trim()] = value.join(':').trim();
            }
        }

        console.log(chalk.bold.cyan(`\n📸 APISnap v1.0.0`));

        // Show active options
        if (Object.keys(customHeaders).length > 0) {
            console.log(chalk.gray(`   Headers: ${JSON.stringify(customHeaders)}`));
        }
        console.log(chalk.gray(`   Slow threshold: ${slowThreshold}ms`));
        if (options.export) {
            console.log(chalk.gray(`   Export: ${options.export}`));
        }
        console.log();

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
                            ...customHeaders,
                            'User-Agent': 'APISnap/1.0.0',
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
                        headers: customHeaders,
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

program.parse(process.argv);
