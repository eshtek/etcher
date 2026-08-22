# HexOS Imager

> Download, verify, and flash HexOS to a USB drive — safely and easily.

HexOS Imager is a HexOS-branded fork of [balenaEtcher](https://github.com/balena-io/etcher).
It downloads the latest HexOS installer ISO, verifies its SHA-256 checksum, and
flashes it to a USB drive so you can install HexOS on your server. The standard
Etcher flows (flash from file, flash from URL, clone drive) remain available.

## How the HexOS flow works

1. The app resolves a release manifest from two sources, in order:
   1. the HexOS API — `https://api.hexos.com/api/releases?channel=<channel>`
      (6s budget), which can vary by release channel and report a minimum
      supported imager version
   2. the static manifest — `https://downloads.hexos.com/manifest.json`
   The API is a silent optimisation, never a dependency: if it is slow,
   down, or not yet deployed, the static file carries the download, so a
   cloud incident cannot block a new user's first install. Overridable with
   `HEXOS_MANIFEST_URL` / `HEXOS_MANIFEST_FALLBACK_URL` / `HEXOS_CHANNEL`
   (or the `hexosManifestUrl`, `hexosManifestFallbackUrl`, `hexosChannel`
   settings). The static fallback always serves the stable channel.
2. The user clicks **Download HexOS**; the ISO is streamed to their Downloads
   folder while a SHA-256 digest is computed over the received bytes. The file
   is written as `<name>.part` and renamed only after the checksum matches.
   If the primary URL fails, the manifest's `fallbackUrl` is tried.
   If a verified copy already exists in Downloads, the download is skipped.
3. The verified ISO is selected as the flash source, and Etcher's normal
   flash + read-back validation takes over.

### Manifest format

Hosted at `https://downloads.hexos.com/manifest.json` (live; example below):

```json
{
  "latest": "25.10.3",
  "images": [
    {
      "version": "25.10.3",
      "name": "TrueNAS-SCALE-25.10.3-HexOS.iso",
      "url": "https://downloads.hexos.com/TrueNAS-SCALE-25.10.3-HexOS.iso",
      "fallbackUrl": "https://hexos-downloads.sfo3.cdn.digitaloceanspaces.com/TrueNAS-SCALE-25.10.3-HexOS.iso",
      "sha256": "e551911445c95c1943e6638091896f34d2d423900cccd688ac09d811e78ed450",
      "size": 2181978112,
      "releaseDate": "2026-04-17",
      "notesUrl": "https://docs.hexos.com/getting-started/installation/InstallGuide"
    }
  ]
}
```

`version`, `name`, `url`, `sha256` (lowercase hex), and `size` (bytes) are
required per image; `latest` must match one image's `version`. Two optional
top-level fields are understood, and are what the API adds over the static
file: `minImagerVersion` (semver — older imagers show a non-blocking "update
available" notice) and `channel` (echoed back; anything other than `stable`
is badged in the download dialog). Unknown fields are ignored, so the API
may return more than the static file does. When publishing
a new release, upload the ISO first, then update the manifest. The app sends
`Cache-Control: no-cache` and a cache-busting query parameter, but keep the
manifest's CDN TTL short regardless.

## Supported Operating Systems

- Linux; most distros; Intel 64-bit.
- Windows 10 and later; Intel 64-bit.
- macOS 10.13 (High Sierra) and later; both Intel and Apple Silicon.

## Development

Requirements: Node.js 20.x and Python 3.

```sh
npm ci           # install dependencies
npm start        # run in development
npm run package  # build the app bundle for this platform
npm run make     # build installers (DMG/Squirrel/deb/rpm/zip)
npm run lint     # balena-lint + prettier
```

The privileged writer runs in a separate "sidecar" binary built from
`lib/util/` via `@yao-pkg/pkg`; the Electron renderer drives it over a local
WebSocket API (see `lib/gui/app/modules/api.ts`).

## Upstream

This fork tracks [balena-io/etcher](https://github.com/balena-io/etcher)
(`upstream` remote). The flashing engine is
[etcher-sdk](https://github.com/balena-io-modules/etcher-sdk).

## License

Etcher is free software and remains licensed under the
[Apache License 2.0](https://github.com/balena-io/etcher/blob/master/LICENSE).
"Etcher" and "balena" are trademarks of Balena Ltd; this fork is rebranded as
HexOS Imager and is not affiliated with or endorsed by Balena.
