# Third-Party Notices

Hermetic is licensed under the MIT License (see [LICENSE](LICENSE)). It includes
third-party components under their own licenses, listed here. This file, and the
referenced license texts, travel with binary distributions (the `hermetic.mcpb`
bundle).

## json-render (Apache License 2.0)

The dashboard spec envelope and React renderer in [`src/spec/`](src/spec/) are a
vendored fork of `@json-render/core` and `@json-render/react` (version 0.8.0,
upstream `vercel-labs/json-render`, Copyright Vercel, Inc.).

- License: [`src/spec/LICENSE`](src/spec/LICENSE) (Apache-2.0)
- Attribution and modifications: [`src/spec/NOTICE.md`](src/spec/NOTICE.md)

## Geist / Geist Mono fonts (SIL Open Font License 1.1)

The `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` fonts are
bundled into the embedded viewer and self-contained HTML exports. They are
licensed under the SIL Open Font License, Version 1.1 — see
<https://github.com/vercel/geist-font> and the OFL text distributed with the
`@fontsource-variable/geist` package.

---

Other dependencies are consumed as libraries (not redistributed as source) and
retain their own licenses as declared in their packages; see `pnpm licenses list`.
