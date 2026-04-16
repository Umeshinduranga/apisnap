import { Request, Response, NextFunction } from 'express';

export interface APISnapOptions {
    /** Routes to skip during health checks (e.g. ['/admin', '/internal']) */
    skip?: string[];
    /** Custom name shown in discovery response */
    name?: string;
}

export const init = (app: any, options: APISnapOptions = {}) => {
    const DISCOVERY_PATH = '/__apisnap_discovery';
    const skipList = options.skip || [];

    // ─── Recursive Route Extractor ────────────────────────────────────────────
    const extractRoutes = (stack: any[], prefix = ''): any[] => {
        let routes: any[] = [];

        stack.forEach((layer: any) => {
            if (layer.route) {
                const path = (prefix + layer.route.path).replace('//', '/');
                // Skip the discovery endpoint itself and any user-skipped paths
                if (path === DISCOVERY_PATH) return;
                if (skipList.some((s) => path.startsWith(s))) return;

                const methods = Object.keys(layer.route.methods)
                    .filter((m) => m !== '_all')
                    .map((m) => m.toUpperCase());

                routes.push({ path, methods });
            } else if (layer.handle && layer.handle.stack) {
                let rStr = layer.regexp.toString();
                let routerPrefix = '';

                const standardMatch = rStr.match(/^\/\^\\\/(.*?)\\\/\?\(\?\=\\\/\|\$\)\/i$/);
                if (standardMatch) {
                    routerPrefix = standardMatch[1];
                } else {
                    const fallbackMatch = rStr.match(/^\/\^\\?(.*?)\\?\/?(?:\(\?=\\\/\|\$\))?\//);
                    routerPrefix = fallbackMatch ? fallbackMatch[1] : '';
                }

                routerPrefix = routerPrefix.replace(/\\\//g, '/');
                if (routerPrefix && !routerPrefix.startsWith('/')) {
                    routerPrefix = '/' + routerPrefix;
                }

                const newPrefix = (prefix + routerPrefix).replace(/\/\//g, '/');
                routes = routes.concat(extractRoutes(layer.handle.stack, newPrefix));
            }
        });

        return routes;
    };

    // ─── Discovery Endpoint ───────────────────────────────────────────────────
    // IMPORTANT: This is registered FIRST so auth middleware added later won't
    // wrap it. If your auth is global (app.use), see the bypass middleware below.
    app.get(DISCOVERY_PATH, (req: Request, res: Response) => {
        try {
            let router = app._router;
            if (!router) {
                try { router = app.router; } catch (_) { }
            }
            if (!router) {
                return res.status(500).json({ error: 'Router not initialized yet. Make sure apisnap.init(app) is called after your routes.' });
            }

            const allRoutes = extractRoutes(router.stack);

            res.json({
                tool: 'APISnap',
                appName: options.name || 'Express App',
                timestamp: new Date().toISOString(),
                total: allRoutes.length,
                endpoints: allRoutes,
            });
        } catch (e: any) {
            res.status(500).json({ error: 'Failed to parse routes', detail: e.message });
        }
    });

    // ─── Auth Bypass Middleware ───────────────────────────────────────────────
    // This intercepts requests to the discovery path and short-circuits any
    // downstream auth middleware the user may have added globally.
    // Works by monkey-patching app.use to detect auth-style middleware.
    const originalUse = app.use.bind(app);
    app.use = function (...args: any[]) {
        const middlewareIndex = typeof args[0] === 'function'
            ? 0
            : (typeof args[1] === 'function' ? 1 : -1);

        if (middlewareIndex >= 0) {
            const originalMiddleware = args[middlewareIndex];
            args[middlewareIndex] = (req: Request, res: Response, next: NextFunction) => {
                if (req.path === DISCOVERY_PATH) return next();
                return originalMiddleware(req, res, next);
            };
        }
        return originalUse(...args);
    };

    console.log(`\x1b[32m✅ [APISnap] Discovery active → http://localhost:PORT${DISCOVERY_PATH}\x1b[0m`);
    if (skipList.length > 0) {
        console.log(`\x1b[33m⏭  [APISnap] Skipping: ${skipList.join(', ')}\x1b[0m`);
    }
};

export default { init };
