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
npm run build       # tsc (ESM) + tsc -p tsconfig.cjs.json (CJS) + the CJS marker
npm run dev         # tsc --watch
npm test            # vitest run — 28 tests across 5 files
npm run smoke       # loads dist/ as ESM and as CJS — run it after build
npm run test:watch  # vitest interactive
npm run lint        # eslint . AND prettier --check .
npm run lint:fix    # eslint --fix . && prettier --write .
```

`npm run lint` runs Prettier as well as ESLint, so a formatting-only problem
fails the lint step. Use `lint:fix`, not bare `eslint --fix`.

### The push gate

`.husky/pre-push` runs `npm ci --dry-run` (lockfile drift), `npm run lint`,
`npm test`, **`npm run build`**, then **`npm run smoke`** — so a push needs a
clean compile and a package that actually loads, not just green tests. Type
errors that vitest tolerates are stopped by the build; a package that compiles
but cannot be `import`ed is stopped by the smoke step (see Conventions).

## The whole public surface

```ts
import {
  LocationClientProvider,
  useLocationClient,
  useMapLanguage,
} from '@chaosity/location-client-react'
```

That is all of it — plus the `LocationClient`, `LocationClientProviderProps` and
`SendOptions` types. There is **one** entry point. The `exports` map declares it
twice, once per module system (`import` and `require`), which is not the same as
a second entry point: adding a subpath is still a packaging decision, not a
refactor.

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

The other half of that trade-off is quieter: a core feature this package uses is
simply absent below the version that added it, with nothing to say so. The
provider passes `refreshToken` to the client so a 401 on a revoked token can
self-heal (#19); on core `0.6.x` the field does not exist, is ignored, and the
request fails exactly as it did before — no crash, no warning, and the peer range
still says `>=0.3.0`. Nothing is going to catch that for you, so state the
version a feature needs in the README beside the feature, which is the only place
a consumer looks.

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

- **Relative imports in `src/` must carry a `.js` extension**, even though the
  source is `.ts`/`.tsx`: `import { x } from './provider/LocationClientProvider.js'`.
  `tsconfig.json` is `moduleResolution: NodeNext`, which is what Node's own ESM
  resolver requires — TypeScript maps the `.js` specifier back to the real file
  for you. This used to be wrong: the package emitted extensionless specifiers,
  so every `import` outside a bundler died with `ERR_MODULE_NOT_FOUND` (#16), and
  it took `@chaosity/address-form` down with it. The rule applies to `src/` —
  what `tsc` compiles and emits. Files in `test/` are outside `tsconfig.json`'s
  `include`, are never emitted, and are resolved by vitest, so they stay
  extensionless; leave them alone.
- **Dual ESM/CJS** (`"type": "module"`). `npm run build` runs `tsc` twice: ESM
  into `dist/`, CommonJS into `dist/cjs/`, and `scripts/finish-cjs.mjs` writes a
  `{"type":"commonjs"}` package.json beside the second so Node reads it as CJS.
  `files` ships `dist` and the README.
- **One process must load one half, not both.** That is the standing cost of a
  dual package, and it is sharper here than in the core: `require` and `import`
  get separate module registries, so each half runs its own `createContext`. A
  consumer whose provider resolves through one half and whose hook resolves
  through the other gets a `useLocationClient` reading a context
  `LocationClientProvider` never wrote — it throws the "must be used within a
  provider" error while the provider is right there in the tree, so it reads as
  the consumer's mistake rather than a packaging one. Pick a module system per
  process and stay in it.
- **`npm run smoke` is the test a build cannot replace.** It resolves `dist/`
  through Node as ESM and as CJS, checks the surface is identical in both, and
  re-asserts that no server-only core export has leaked into it. It runs in the
  push gate, in CI, and in `prepublishOnly` — the last so it guards the exact
  tarball that publishes.
- Tests are vitest. React changes want a test that renders — a provider that
  compiles is not a provider that mounts.
- Prettier runs with `prettier-plugin-organize-imports`, so import order is
  managed; do not hand-sort.
