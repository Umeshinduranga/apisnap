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
    .action(async (options) => {
        const port = options.port;
        const discoveryUrl = `http://localhost:${port}/__apisnap_discovery`;

        console.log(chalk.bold.cyan(`\n📸 APISnap v1.0.0`));
        const spinner = ora('Connecting to your API...').start();

        try {
            // 1. Fetch the route map from the middleware
            const response = await axios.get(discoveryUrl);
            const { endpoints } = response.data;

            spinner.succeed(chalk.green(`Connected! Found ${endpoints.length} endpoints.\n`));

            // 2. Loop through each discovered endpoint
            for (const endpoint of endpoints) {
                const method = endpoint.methods[0]; // Start with the first method (usually GET)
                const path = endpoint.path;
                const fullUrl = `http://localhost:${port}${path}`;

                const testSpinner = ora(`Testing ${chalk.bold(method)} ${path}`).start();

                try {
                    const startTime = Date.now();
                    const res = await axios({
                        method: method,
                        url: fullUrl,
                        timeout: 5000, // Don't wait forever
                    });
                    const duration = Date.now() - startTime;

                    testSpinner.succeed(
                        `${chalk.bold(method)} ${chalk.white(path)} ` +
                        `${chalk.green(`[${res.status} OK]`)} ` +
                        `${chalk.gray(`${duration}ms`)}`
                    );
                } catch (err: any) {
                    const status = err.response?.status || 'FAIL';
                    testSpinner.fail(
                        `${chalk.bold(method)} ${chalk.white(path)} ` +
                        `${chalk.red(`[${status}]`)}`
                    );
                }
            }

            console.log(chalk.bold.green('\n✨ All checks complete!'));
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
