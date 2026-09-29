---
name: sync-package-docs
description: >-
  Regenerates docs.khanh.id from the latest package sources. Use when syncing
  the docs repo with packages, refreshing Pulumi provider reference pages, or
  updating library API pages after an upstream release.
---

# Sync package docs

Update this repository from the latest `main` of each package. Do not document a local feature branch. Do not invent fields, examples, hostnames, or sample values. Do not commit or publish unless the user asks.

Scratch files go in the operating-system temp directory. Do not create `tmp/` in this repository.

## Sources

| Product | Repository | Read |
| --- | --- | --- |
| Pulumi Any Terraform | `hckhanh/pulumi-any-terraform` | `packages/*/index.ts` and the generated SDK |
| fast-url | `/Users/khanh/Projects/fast-url` | `src/index.ts` |
| format-prompt | `/Users/khanh/Projects/format-prompt` | `src/index.ts` |
| what-the-fetch | `/Users/khanh/Projects/what-the-fetch` | `src/index.ts`, `src/types.ts` |
| vn-number | `/Users/khanh/Projects/vn-number` | `src/index.ts` |
| ja4 | `/Users/khanh/Projects/ja4` | `src/index.ts` |

Fetch `origin/main` in each repository first. Read that commit, not the working tree, when the checkout is on another branch.

## Pulumi reference

Run the generator. It rewrites `pulumi-any-terraform/`, the Pulumi product groups in `docs.json`, and the Pulumi sentence on `index.mdx`. It leaves the other products alone.

```bash
git -C /Users/khanh/KhanhProjects/pulumi-any-terraform fetch origin main
git -C /Users/khanh/KhanhProjects/pulumi-any-terraform worktree add --detach "$TMPDIR/pulumi-docs-src" origin/main
PULUMI_PACKAGES="$TMPDIR/pulumi-docs-src/packages" node scripts/generate-provider-reference.mjs
git -C /Users/khanh/KhanhProjects/pulumi-any-terraform worktree remove --force "$TMPDIR/pulumi-docs-src"
```

Run the command from this repository. The script loads TypeScript from the Pulumi checkout's `node_modules` and writes pages here. The script exits non-zero when a documented field does not match the SDK. Do not hand-edit the generated MDX to silence that failure.

If the script reports a package missing from its provider list, add that package's title and existing icon to `providerMeta` in `scripts/generate-provider-reference.mjs`, then run it again. Do not draw a new icon.

The generator keeps nested object fields on that object's heading. `Pullzone.origin` is `PullzoneOrigin`; a storage zone is `origin.storagezone`, and `origin.type` includes `StorageZone`. `Pullzone` has no `originUrl` or `storageZoneId` argument.

OpenFGA `getAuthorizationModelDocument` is split across linked part pages because the SDK unrolls recursive types. Leave that split in place.

Package READMEs are hand-written and are not updated by this sync. The weekly Pulumi update does not copy the generated README stub.

## Library pages

For each library, compare the public exports on `origin/main` with that product's MDX:

- A new or removed export changes `docs.json` and the API page.
- A changed parameter, return type, or required field changes the API page.
- Keep the page limited to names and types that exist in the source.
- Leave benchmarks and overview prose unchanged when the API did not change.

## Check

1. The generator command exits 0.
2. Every page path in `docs.json` has a matching `.mdx` file, and every `.mdx` file is listed in `docs.json`.
3. `git diff` contains only the packages that actually changed.
4. Preview with `npx @upstash/docs7 dev` and open one updated provider page plus one updated library page. Confirm the sidebar shows one group per provider, with Resources and Functions nested inside it.
