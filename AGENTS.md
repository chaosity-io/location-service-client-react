# AGENTS.md

Notes for anyone — human or coding agent — working in this repository. It covers
what is expensive to rediscover; `README.md` covers usage and `RELEASING.md` the
release procedure.

`@chaosity/location-client-react` is the React binding for
`@chaosity/location-client`. It is deliberately thin: a provider that owns one
authenticated client, a hook to read it, and a map-language hook. Everything
else — commands, types, map helpers — comes from the core package.

## Commands

```bash
npm run build       # tsc
npm run dev         # tsc --watch
npm test            # vitest run — 24 tests across 4 files
npm run test:watch  # vitest interactive
npm run lint        # eslint . AND prettier --check .
npm run lint:fix    # eslint --fix . && prettier --write .
```

`npm run lint` runs Prettier as well as ESLint, so a formatting-only problem
fails the lint step. Use `lint:fix`, not bare `eslint --fix`.

### The push gate

`.husky/pre-push` runs `npm ci --dry-run` (lockfile drift), `npm run lint`,
`npm test`, then **`npm run build`** — so a push needs a clean compile, not just
green tests. Type errors that vitest tolerates are stopped here.

## The whole public surface

```ts
import {
  LocationClientProvider,
  useLocationClient,
  useMapLanguage,
} from '@chaosity/location-client-react'
```

That is all of it — plus the `LocationClient`, `LocationClientProviderProps` and
`SendOptions` types. There is no `exports` map and no subpath entry: a single
`main`/`types` pair pointing at `dist/`. Adding a second entry point is a
packaging decision, not a refactor.

Keep it thin. Anything that is not React-specific belongs in the core package,
where it can be used by consumers who are not on React.

## The peer dependency range is intentionally open

```json
"peerDependencies": {
  "@chaosity/location-client": ">=0.3.0",
  "maplibre-gl": "^5.0.0",
  "react": "^18.0.0 || ^19.0.0"
}
```

`>=0.3.0`, **not** `^0.3.0`. That matters on a pre-1.0 core: npm treats each
`0.x` minor as incompatible, so a caret range here would refuse every core
release after `0.3.x` and force a lockstep bump of this package for each one.
The open range lets a consumer take core `0.5.x` or `0.6.x` without waiting.

The trade-off is real and worth stating: this package does **not** get npm's
protection against a breaking core change. When the core removes or renames
something this provider uses, nothing warns you — the break surfaces at runtime
in a consumer's app. So:

- a core change that alters what this package consumes needs a change here, in
  the same release cycle;
- `maplibre-gl` and `react` keep ordinary caret/or ranges, because those are
  post-1.0 and semver behaves normally.

This package is itself `0.x`, so **its own breaking changes go in the MINOR**,
not the major — `^0.4.0` will never resolve `0.5.0`, and that is the only signal
a consumer gets. `RELEASING.md` has the procedure.

## Credentials never reach this package

The provider takes an already-authenticated client or a token-getter. It must
never take a `clientId` / `clientSecret`, and must never import from
`@chaosity/location-client/server` — that entry point is server-only and pulls
credential handling into whatever bundle imports it, which here is always the
browser.

If a feature seems to need secrets in the provider, the token exchange belongs
on the consumer's server, not in this library.

## Conventions

- **ESM only** (`"type": "module"`), compiled to `dist/` by `tsc`; `files` ships
  `dist` and the README.
- Tests are vitest. React changes want a test that renders — a provider that
  compiles is not a provider that mounts.
- Prettier runs with `prettier-plugin-organize-imports`, so import order is
  managed; do not hand-sort.
