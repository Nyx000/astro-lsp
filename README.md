# astro-lsp

Language server support for `.astro` files in Claude Code.

Otherwise Claude reads Astro components as plain text, which means guessing at the shape of your props and collections. This gives it somewhere to look instead: real types, definitions, every usage of a symbol, type errors as they appear.

Embedded TypeScript, CSS and HTML inside `.astro` files are covered too. It doesn't claim `.ts` or `.js`; `typescript-lsp` handles those.

## Install

```bash
claude plugin marketplace add Nyx000/astro-lsp
claude plugin install astro-lsp@astro-lsp
npm install -g @astrojs/language-server prettier prettier-plugin-astro
```

Needs `@astrojs/language-server` 2.16 or newer (2.16.6 and 2.16.13 both tested). The prettier packages are peer dependencies of the server; formatting degrades without them.

Your project also needs TypeScript of its own, at `node_modules/typescript/lib`. A fresh `create-astro` project does **not** include it — astro keeps TypeScript as its own devDependency, which never reaches your tree, and the `--typescript` flag only writes a `tsconfig.json`. If `node_modules/typescript` isn't there:

```bash
npm install -D typescript
```

Checked against create-astro 5.2.2 / Astro 7.1.3: a stock scaffold lists `astro` and nothing else. Projects that already run `astro check` will have TypeScript pulled in via `@astrojs/check`.

## When it doesn't work

Both failure modes are silent. Nothing shows up in the conversation either way.

**`astro-ls` isn't on PATH.** The server never starts. Check with `astro-ls --version`.

**No local TypeScript.** `initialize` fails with `Can't find typescript.js or tsserverlibrary.js in "node_modules/typescript/lib"`. Claude Code retries a few times, then gives up. Fix with `npm install -D typescript`. This is the most likely thing to catch you on a new project.

For either, run `claude --debug` and grep the output for `LSP MANAGER` or `astro`.

To test the server on its own, without Claude Code in the way:

```bash
node scripts/verify-lsp.js <projectRoot>
```

It spawns the server, checks initialize, hover and diagnostics against a real `.astro` file, and exits 0 if all three pass. Pass `--server <path to nodeServer.js>` to target a specific install.

## Layouts that don't work

TypeScript has to sit directly under your project root, so hoisted monorepos and Yarn PnP are out. There's no settings.json override for this, because LSP configuration only lives in a plugin manifest. Two things do work:

- Fork this repo, change the `tsdk` path in `.claude-plugin/plugin.json`, install from your fork.
- In a monorepo, start Claude Code at whichever directory actually has `node_modules/typescript` under it.

## Notes

The manifest sets `workspaceFolder` and `initializationOptions`, which most LSP plugins don't bother with. The Astro server refuses to start without a `typescript.tsdk` option, and that field isn't interpolated, so the path has to be relative. A relative path only resolves if the server's working directory is pinned to the project root, which is what `workspaceFolder` does. The two go together.

Nothing in the manifest is platform-specific. There are no absolute paths, and `astro-ls` is resolved from PATH, which npm sets up on every platform. It has only been exercised on Windows so far, though.

Completion isn't available. Claude Code's LSP interface has no completion operation, so nothing can reach it. Hover, go-to-definition, references and diagnostics all work.

## Links

- [@astrojs/language-server](https://www.npmjs.com/package/@astrojs/language-server)
- [withastro/language-tools](https://github.com/withastro/language-tools)
- [Astro docs](https://docs.astro.build)
