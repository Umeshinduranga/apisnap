import { Request, Response } from 'express';

export const init = (app: any) => {
    const DISCOVERY_PATH = '/__apisnap_discovery';

    // Recursive function to find ALL routes, even in sub-routers
    const splitRoutes = (stack: any[], prefix = ''): any[] => {
        let routes: any[] = [];

        stack.forEach((layer: any) => {
            if (layer.route) {
                // Simple direct route
                const path = prefix + layer.route.path;
                const methods = Object.keys(layer.route.methods).map((m) =>
                    m.toUpperCase()
                );
                routes.push({ path: path.replace('//', '/'), methods });
            } else if (layer.handle && layer.handle.stack) {
                // Nested Router - GO DEEPER
                // Extract the prefix from the regexp (e.g. /api)
                const match = layer.regexp
                    .toString()
                    .match(/^\/\^\\?(.*?)\\?\/?(?:\(\?=\\\/\|\$\))?\//);
                const routerPrefix = match
                    ? match[1].replace(/\\\//g, '/')
                    : '';
                routes = routes.concat(
                    splitRoutes(layer.handle.stack, prefix + '/' + routerPrefix)
                );
            }
        });
        return routes;
    };

    app.get(DISCOVERY_PATH, (req: Request, res: Response) => {
        try {
            // Safely get Express router (v4 uses _router, v5 uses router)
            let router = app._router;
            if (!router) {
                try {
                    router = app.router;
                } catch (err) {
                    // Ignore getter deprecation errors from Express 4
                }
            }
            if (!router) {
                res.status(500).json({ error: 'Router not initialized yet' });
                return;
            }
            const allRoutes = splitRoutes(router.stack);
            res.json({
                name: 'APISnap Discovery',
                timestamp: new Date().toISOString(),
                total: allRoutes.length,
                endpoints: allRoutes,
            });
        } catch (e: any) {
            res.status(500).json({ error: 'Failed to parse routes', detail: e.message });
        }
    });

    console.log(
        `\x1b[32m%s\x1b[0m`,
        `✅ [APISnap] Discovery active at ${DISCOVERY_PATH}`
    );
};

export default { init };
