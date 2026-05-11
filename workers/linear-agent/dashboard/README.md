# Symphony Dashboard

React SPA for Symphony observability.

## Development

Start Phoenix on port `4000`, then run the Vite dev server:

```bash
mix phx.server
cd dashboard && npm run dev
```

The dev server proxies `/api` requests to `http://127.0.0.1:4000`.

## Production

Build the SPA and copy the output into Phoenix static assets:

```bash
mix assets.build
```

Phoenix then serves the built bundle from `priv/static/dashboard/`.
