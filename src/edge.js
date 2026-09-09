import { DockRayClient } from '@dockcodes/dock-ray/edge';
import { createBrowserErrorHandler } from './browser-route.js';
import { describeNextRequest, optionsFromEnvironment, tagsFromContext } from './shared.js';

export { optionsFromEnvironment } from './shared.js';

let client = null;

/**
 * The client for Next.js middleware and routes running on the edge.
 *
 * Middleware is always an edge bundle, and an edge bundle cannot resolve
 * `node:fs` or `node:zlib`. Importing this entry point instead of the default
 * one keeps them out; events lose source context and gzip, nothing else.
 */
export function initRay(options = {}) {
    client = new DockRayClient(optionsFromEnvironment(options));

    return client;
}

export function getRay() {
    return client ?? initRay();
}

export function rayRequestError({ shouldReport = () => true } = {}) {
    return async function onRequestError(error, request, context) {
        const ray = getRay();

        if (!ray.enabled || !shouldReport(error, context)) {
            return;
        }

        const described = describeNextRequest(request);

        await ray.captureException(error, {
            request: described.http,
            user: described.user,
            tags: { ...tagsFromContext(context), runtime: 'edge' },
        });
    };
}

/**
 * Wraps middleware so a throw is reported before it bubbles.
 *
 * The report is awaited: an edge invocation can be frozen the moment it
 * returns, so a fire-and-forget send would often never leave.
 */
export function withRayMiddleware(middleware) {
    return async function rayWrappedMiddleware(request, event) {
        try {
            return await middleware(request, event);
        } catch (error) {
            const ray = getRay();

            if (ray.enabled) {
                const described = describeNextRequest(request);

                await ray.captureException(error, {
                    request: described.http,
                    user: described.user,
                    tags: { runtime: 'edge', source: 'middleware' },
                });
            }

            throw error;
        }
    };
}

export function createBrowserErrorRoute(options = {}) {
    return createBrowserErrorHandler(getRay, options);
}
