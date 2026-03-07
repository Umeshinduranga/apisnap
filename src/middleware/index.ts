import { Request, Response, NextFunction } from 'express';

export const init = (app: any) => {
    const MASTER_KEY = 'apisnap_secret_handshake_2024';
    const DISCOVERY_PATH = '/__apisnap_discovery';

    // --- THE VIP GATE ---
    app.use((req: Request, res: Response, next: NextFunction) => {
        const clientKey = req.headers['x-apisnap-key'];
        const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';

        // If the key matches AND it's local, we bypass ALL other auth (Better Auth, etc.)
        if (clientKey === MASTER_KEY && isLocal) {
            // We "mock" a dev user so the routes think someone is logged in
            (req as any).user = { id: 'dev-bypass', role: 'admin', name: 'APISnap-Bot' };
            return next();
        }
        next();
    });

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
                // Extract the prefix from the regexp (e.g. /api or /api/community)
                let rStr = layer.regexp.toString();
                let routerPrefix = '';

                // Try to match standard Express router regexp: /^\/api\/?(?=\/|$)/i
                const standardMatch = rStr.match(/^\/\^\\\/(.*?)\\\/\?\(\?\=\\\/\|\$\)\/i$/);
                if (standardMatch) {
                    routerPrefix = standardMatch[1];
                } else {
                    // Fallback for custom or older regexes
                    const fallbackMatch = rStr.match(/^\/\^\\?(.*?)\\?\/?(?:\(\?=\\\/\|\$\))?\//);
                    routerPrefix = fallbackMatch ? fallbackMatch[1] : '';
                }

                routerPrefix = routerPrefix.replace(/\\\//g, '/');
                if (routerPrefix && !routerPrefix.startsWith('/')) {
                    routerPrefix = '/' + routerPrefix;
                }

                // Avoid double slashes in concatenation
                const newPrefix = (prefix + routerPrefix).replace(/\/\//g, '/');

                routes = routes.concat(splitRoutes(layer.handle.stack, newPrefix));
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
