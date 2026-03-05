import { Request, Response } from 'express';

export const init = (app: any) => {
    const DISCOVERY_PATH = '/__apisnap_discovery';

    // Recursive function to find ALL routes, even in sub-routers
    const splitRoutes = (stack: any[]): any[] => {
        let routes: any[] = [];

        stack.forEach((layer: any) => {
            if (layer.route) {
                // Simple route
                const path = layer.route.path;
                const methods = Object.keys(layer.route.methods).map((m) =>
                    m.toUpperCase()
                );
                routes.push({ path, methods });
            } else if (layer.name === 'router' && layer.handle.stack) {
                // Nested Router - GO DEEPER
                const subRoutes = splitRoutes(layer.handle.stack);
                // Prepend the prefix of the router (like /api)
                const prefix = layer.regexp
                    .toString()
                    .replace('/^\\', '')
                    .replace('\\/?(?=\\/|$)/i', '')
                    .replace(/\\\//g, '/');

                subRoutes.forEach((sr) => {
                    routes.push({
                        path: (prefix + sr.path).replace('//', '/'),
                        methods: sr.methods,
                    });
                });
            }
        });
        return routes;
    };

    app.get(DISCOVERY_PATH, (req: Request, res: Response) => {
        try {
            const allRoutes = splitRoutes(app._router.stack);
            res.json({ name: 'APISnap', endpoints: allRoutes });
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse routes' });
        }
    });

    console.log(
        `\x1b[32m%s\x1b[0m`,
        ` [APISnap] Discovery active at ${DISCOVERY_PATH}`
    );
};
