# Releasing `@chaosity/location-client-react`

```bash
git switch -c release/0.2.0
npm version patch                              # or minor / major
git push -u origin release/0.2.0 --follow-tags
```

Then open a PR for that branch and merge it. Merging is what publishes:
`.github/workflows/publish.yml` sees the changed version on `main`, and builds,
lints, tests and publishes to npm with provenance.

`npm version` does the whole bump in one step — edits `package.json`, makes the
commit, and tags it `v0.2.0` — so the tag and the published version cannot
disagree. Do it on a **branch**, never on `main`: the commit then goes through
review like everything else, and `main branch protection` is never bypassed.

The tag stays reachable after the merge. `/ship-pr` merges with a merge commit,
so the branch tip becomes one of its parents and `git log v0.1.19..v0.2.0` and
`git switch --detach v0.2.0` work as normal.

If the PR is closed without merging, delete the tag — it points at a commit that
never landed:

```bash
git push --delete origin v0.2.0 && git tag -d v0.2.0
```

## This package releases AFTER location-client

`@chaosity/location-client-react` depends on `@chaosity/location-client`. A caret
range on a `0.x` version does not cross the minor — `^0.1.14` will never resolve
`0.2.0` — so a client minor bump means this package's dependency range has to
move too, and it cannot until the client is actually on npm.

Order, whenever both change:

1. release `@chaosity/location-client`, wait for it to appear on npm
2. on the release branch here, bump the `@chaosity/location-client` range **and**
   run `npm version` — one PR, one tag
3. merge

## The tag records the release; it does not cause it

Publishing triggers on the **version change**, not on the tag. That separation is
what keeps a release reviewable:

- A tag pushed from your machine uses **your SSH key**, not a token. Tag pushes
  also fall outside the `main branch protection` ruleset, which targets
  `refs/heads/main`.
- A stray or mistaken tag cannot publish anything.
- Equally, if a tag is ever missed, nothing breaks — the package is already out.

To spot a release that never got tagged:

```bash
npm view @chaosity/location-client-react versions --json    # compare against:
git tag -l 'v*'
```

## Why there is no release workflow

`release.yml` ran `npm version` on a runner and pushed with
`secrets.GITHUB_TOKEN`, needing `contents: write`. It was removed on 2026-08-23:

- **Nothing here should hold a credential that can write to the repository.**
- **It had never run once, and could not have.** The `main branch protection`
  ruleset requires a pull request and its only bypass actor is the repository
  **admin** role, which a workflow's `GITHUB_TOKEN` is not — it acts as
  `github-actions[bot]`, which has write permission but is not an admin.

Running `npm version` yourself, on a branch, has neither problem.

## The trigger, precisely

`publish.yml` is triggered by **`build.yml` completing**, not by the push:

```yaml
on:
  workflow_run:
    workflows: [build]
    types: [completed]
    branches: [main]
```

and the job only runs when that build actually passed
(`github.event.workflow_run.conclusion == 'success'`). So a publish can never
overtake its own validation. Previously both workflows were fired by the same
push and ran in **parallel**, which meant a failing build did not stop a
release — and a release cannot be taken back.

Because of that ordering, nothing is re-run here: no lint, no tests, no matrix.
`build.yml` did all of it on this exact commit, and this workflow only exists
because it passed.

Two consequences worth knowing:

- **The checkout is pinned to `workflow_run.head_sha`.** A `workflow_run` job
  otherwise checks out the default branch tip, not the commit that was built —
  which would quietly release something other than what passed.
- **`workflow_run` supports no `paths` filter**, so the "is this version already
  on npm?" check in the job is what decides. Without it, every successful build
  on `main` would attempt a publish and fail red on the commits that are not
  releases.

`npm publish` runs `prepublishOnly`, which builds the package, so the tarball is
produced whether or not a step names it.

## What publish.yml uses

`contents: read` and `id-token: write`. The id-token is an **OIDC** exchange —
short-lived, scoped to this repository and workflow — and it is what produces the
SLSA provenance attestation on the published package.

`actions/checkout` still uses the implicit, read-only `GITHUB_TOKEN` to clone.
That cannot write and cannot be removed.

## Verifying a published package

```bash
npm view @chaosity/location-client-react version
npm audit signatures
curl -s "https://registry.npmjs.org/-/npm/v1/attestations/$(node -p \
  "encodeURIComponent('@chaosity/location-client-react')")@<version>" | jq
```

The attestation records the repository, workflow path, ref and exact source
revision the tarball was built from.
