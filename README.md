# docs.khanh.id

Docs7 site for Khanh's libraries. Each library is a product in `docs.json`.

Preview locally with Node.js 20.19 or newer:

```bash
npx @upstash/docs7 dev --port 3333
```

Open http://localhost:3333.

Publish from the Docs7 tab in the Context7 teamspace. Choose this repository and set the docs path to the repository root. Attach the custom domain `docs.khanh.id`.

Canonical URLs are `https://docs.khanh.id` plus each page path. A short library path such as `/fast-url` redirects to `/fast-url/overview`.

When you publish, enable **Add to Context7** so a production build refreshes the Context7 library for this site.

Install the repository's tooling with `npm ci`. Run `npm test` and `npm run format:check` before pushing changes.

To regenerate the Pulumi reference, point `PULUMI_PACKAGES` at the `packages` directory in a checkout of `hckhanh/pulumi-any-terraform`:

```bash
PULUMI_PACKAGES=/path/to/pulumi-any-terraform/packages npm run generate:providers
npm run format
```

Without `PULUMI_PACKAGES`, the generator uses a sibling `pulumi-any-terraform` checkout. It writes into the docs repository containing the script, regardless of the current directory.
