# @dockcodes/dock-ray-next

Next.js integration for [DockRay](https://dockray.io). Reports server errors,
edge and middleware errors, request timings and - optionally - JavaScript
errors from the browser.

Works with the App Router and the Pages Router, Next 14 and 15.

## Installation

```bash
npm install @dockcodes/dock-ray-next
```

```dotenv
RAY_TOKEN=project-token
RAY_PRIVATE_KEY=project-private-key
RAY_TRACES_SAMPLE_RATE=0.2
```

`RAY_PRIVATE_KEY` has no `NEXT_PUBLIC_` prefix, and must never get one: a
public environment variable is inlined into the client bundle, where anyone can
read it. Without a token and a key the package is inert - no requests, no
errors.

## Server errors

`instrumentation.ts` in the project root:

```ts
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { initRay } = await import('@dockcodes/dock-ray-next');
        initRay();
    }
    if (process.env.NEXT_RUNTIME === 'edge') {
        const { initRay } = await import('@dockcodes/dock-ray-next/edge');
        initRay();
    }
}

// Next.js 15+; Next.js 14 projects can use withRay instead.
export async function onRequestError(...args) {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { rayRequestError } = await import('@dockcodes/dock-ray-next');
        await rayRequestError()(...args);
    }
    if (process.env.NEXT_RUNTIME === 'edge') {
        const { rayRequestError } = await import('@dockcodes/dock-ray-next/edge');
        await rayRequestError()(...args);
    }
}
```

`onRequestError` is the only hook that sees every error Next catches - server
components, route handlers, server actions, streaming renders. Next calls it
after the response has already failed, so reporting never delays a request.

Each report is tagged with the route context Next supplies, which is what makes
the panel readable: `router` (App / Pages), `route` (`/orders/[id]`, the
pattern rather than the concrete path), `route_type` and `render_source`.

For Pages Router API routes, or anywhere you want an explicit wrapper:

```ts
import { withRay } from '@dockcodes/dock-ray-next';

export default withRay(async function handler(req, res) { /* ... */ });
```

`withRay` reports and rethrows. It never swallows an error, so your own error
handling still runs.

## Middleware and edge routes

Middleware is always an edge bundle, and an edge bundle cannot resolve
`node:fs` or `node:zlib`. Import the edge entry point there:

```ts
import { initRay, withRayMiddleware } from '@dockcodes/dock-ray-next/edge';

initRay();

export const middleware = withRayMiddleware(async (request) => {
    // ...
});
```

Events lose stack source context and gzip; everything else is the same. The
edge wrapper **awaits** its report rather than firing and forgetting, because
an edge invocation can be frozen the moment it returns.

`instrumentation-edge.ts` should use `rayRequestError` from the same entry
point.

## JavaScript errors

Off by default. Two things are needed.

**The route that receives them** - `app/api/ray/browser/route.ts`:

```ts
import { createBrowserErrorRoute } from '@dockcodes/dock-ray-next';

export const POST = createBrowserErrorRoute();
export const runtime = 'nodejs';
```

**The collector**, mounted once in the root layout:

```tsx
import { RayBrowserReporting } from '@dockcodes/dock-ray-next/client';

export default function RootLayout({ children }) {
    return (
        <html>
            <body>
                <RayBrowserReporting />
                {children}
            </body>
        </html>
    );
}
```

```dotenv
NEXT_PUBLIC_RAY_JS_ERRORS=true
```

The browser reports to **your route**, not to the panel. It cannot report
directly: authenticating means holding the project private key, and a key in a
client bundle is a published key. Your server forwards each report with its
own.

The route answers `202` to everything - a valid report, a malformed one, a
rate-limited one - so a caller learns nothing about the guards. It drops
bodies over 16 KB and allows 20 reports per address per minute. Envelope
fields (environment, release, timestamp) are filled in on the server; a browser
cannot choose which environment its errors land in.

The collector caps itself as well: one report per distinct error per page view,
ten per page view by default, with `ResizeObserver loop` and cross-origin
`Script error.` filtered out.

From an error boundary or `app/global-error.tsx`:

```tsx
'use client';
import { captureBrowserException } from '@dockcodes/dock-ray-next/client';

export default function GlobalError({ error }) {
    captureBrowserException(error);

    return <html><body><h1>Something went wrong</h1></body></html>;
}
```

## What is reported and what is not

`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` and the collector's own
token are stripped from reported headers. The visitor's IP address and user
agent are only attached when `RAY_SEND_DEFAULT_PII=true`; without it a report
carries no `user` at all.

## Vercel

`VERCEL_ENV` becomes the environment and `VERCEL_GIT_COMMIT_SHA` the release
when `RAY_ENVIRONMENT` and `RAY_RELEASE` are not set, so a preview deployment
does not report as production.

## Package inventory and vulnerability alerts

Version 1.1 requires `@dockcodes/dock-ray` 1.1+. Inventory is opt-in and
runs only in the Node server, never in the browser or Edge runtime.
With the `register()` example above, set these server-only variables:

```dotenv
RAY_INVENTORY=true
RAY_INVENTORY_SITE_URL=https://your-site.example
# Optional comma-separated names or globs:
RAY_INVENTORY_EXCLUDE_PACKAGES=@company/*
# Optional paths (defaults: application root and private temporary state):
# RAY_INVENTORY_PROJECT_DIR=/srv/app
# RAY_INVENTORY_STATE_DIR=/var/lib/dockray/inventory
```

Alternatively pass `inventoryEnabled: true`, `inventorySiteUrl`,
`inventoryExcludePackages`, `inventoryProjectDirectory` and
`inventoryStateDirectory` to `initRay()` inside the Node branch.
Use a separate state directory for each application, outside public assets.
Never prefix these settings or credentials with `NEXT_PUBLIC_`.

The Node SDK collects installed production npm packages using package-lock.json
or npm-shrinkwrap.json v2/v3. This includes Next.js and React when installed as
production dependencies. Only the site URL and package names/versions are sent;
source code, environment files and credentials are not included in inventory.
DockRay matches these reports against known npm vulnerabilities and uses the
project's existing notification settings. The platform in the panel is Node.js.

The SDK starts a background check after initialization and checks hourly.
Changed inventory is sent on the next check; unchanged inventory is refreshed
at most every 12 hours. Its shared locks, retry backoff and backend limits also
apply across Next.js bundles and processes. Calling `initRay()` again stops the
previous client's timers; request handlers reuse `getRay()`.

For a trusted server-side task you can call `await reportInventory()` from this
package (or `getRay().reportInventory()`). `{ force: true }` still respects retry
backoff and server limits. Do not expose an unauthenticated inventory endpoint.

On serverless/Vercel deployments, background timers and temporary local state
cannot guarantee a recurring schedule. Use a separate scheduled Node process
with the Node SDK's `dockray-inventory` command and persistent private state.
That process needs the deployed application's npm lockfile and installed
production node_modules. Bundled/standalone-only output, Yarn, pnpm, workspaces
and lockfile v1 are not supported by this collector; a failed collection does
not send an empty inventory or clear existing findings. Merely enabling the
flag in a serverless function does not provide continuous monitoring.

Next.js 14 requires `experimental.instrumentationHook: true` in next.config.js.
Use runtime-specific dynamic imports as described in the
[Next.js instrumentation guide](https://nextjs.org/docs/app/guides/instrumentation).

## Tests

```bash
npm test
```

## License

MIT.
