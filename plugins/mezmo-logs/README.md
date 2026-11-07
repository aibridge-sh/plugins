# Mezmo logs

**Unofficial integration; not affiliated with Mezmo.** Mezmo and its logo
are trademarks of their owner.

An AI Bridge plugin for [Mezmo Log Analysis](https://docs.mezmo.com/log-analysis-api):
browse your saved views, filter by app, host, tag and level, search, follow
the newest lines, and open any line to read its whole message and fields.

## Connect

You need a Mezmo **service key** (in Mezmo: Settings › Organization › API
Keys; an ingestion key cannot read logs). AI Bridge asks for it when you open
the plugin, keeps it in your Mac's Keychain and sends it only to the address
you choose, `https://api.mezmo.com` or `https://api.logdna.com`, as
`Authorization: Token <key>`. The plugin's code never receives it.

## What it reads and changes

- It reads your saved views and log lines, only while you have it open.
- **Save view** is the one change it can make: it creates a new view in
  Mezmo from your current search and filters, after you name it and
  confirm. It never edits or deletes a view and never sets up an alert.

## Source

`plugin.json` declares the key, the two addresses and each read; `view.ts`
describes the screens; `data.ts`, `mezmo-api.ts`, `lines.ts` and `search.ts`
shape the answers. The signed package for each version is attached to its
release (`mezmo-logs-<version>`).
