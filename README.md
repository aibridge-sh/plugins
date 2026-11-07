# AI Bridge plugins

Signed community plugins for [AI Bridge](https://aibridge.sh/?src=gh-plugins),
the Mac app that runs your coding agents side by side. A plugin adds a screen
to AI Bridge for a service you use, such as your logs, and reads it through a
connection you make.

AWS, Azure and Google Cloud are built-in plugins: they come with AI Bridge
and update with the app, so they are not in this catalogue.

## How plugins stay safe

- **Isolated.** Plugin code runs in a sandbox inside AI Bridge, with no
  access to your files, browser, terminal or network of its own. AI Bridge
  draws every screen from what the plugin describes.
- **Your keys stay with AI Bridge.** You connect a service in AI Bridge. The
  key is kept in your Mac's Keychain and attached by AI Bridge to each
  request; the plugin never sees it.
- **Declared sites only.** A plugin can reach only the addresses it declares,
  and you see them before anything installs.
- **Signed.** Every release is signed, and the catalogue that lists it is
  signed by a key built into AI Bridge. A changed or unlisted file is refused.
  A published version is never replaced; a revoked one stops running.
- **Read-only where it can be.** Plugins read. A plugin that can change
  something says so in its review, and every change is one you confirm.

## Install

In AI Bridge, open **Plugins** in the top bar, or **Settings › Plugins ›
Manage plugins**. Pick a plugin, check what it can reach, then install.
Updates are offered there, never applied on their own.

## Plugins

| Plugin | What it does |
| --- | --- |
| [Mezmo logs](plugins/mezmo-logs) | Search, filter and follow Mezmo Log Analysis lines. Unofficial integration; not affiliated with Mezmo. |

## Build your own

The plugin SDK is in preview and not published yet. When it is, its
documentation and packages will be linked here. Until then,
[`plugins/mezmo-logs`](plugins/mezmo-logs) shows what a plugin is: a
`plugin.json` that declares its sites, reads and key, a `view.ts` that
describes its screens and a `data.ts` that shapes what it reads.

To ask for a plugin, [suggest one](../../issues/new?template=plugin-idea.yml).

## Report a security issue

Please report security issues privately to security@aibridge.sh, not
in a public issue.

## What is in this repository

- `catalogue-v1.json`: the current signed catalogue. `catalogues/` keeps every
  earlier one; their numbers only go up.
- `trust/`: the catalogue's public key and the publisher's. AI Bridge has its
  own copy; downloading these files does not make anything trusted.
- `plugins/`: each plugin's source.
- Releases: each plugin version's signed package.

<sub>Made by CyberNucleus Pty Ltd, trading as AI Bridge sh.</sub>
