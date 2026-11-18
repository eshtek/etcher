# HexOS Imager

> Download, verify, and flash HexOS to a USB drive — safely and easily.

HexOS Imager is a HexOS-branded fork of [balenaEtcher](https://github.com/balena-io/etcher).
It downloads the latest HexOS installer ISO, verifies its SHA-256 checksum and
its OpenPGP signature, and flashes it to a USB drive so you can install HexOS on your server. The standard
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
2. The user clicks **Download HexOS**. The app fetches the ISO's detached
   OpenPGP signature from `<ISO URL>.gpg`, then streams the ISO to the
   Downloads folder while computing a SHA-256 digest and the signature hash
   over the received bytes. The file is written as `<name>.part` and renamed
   only after the checksum matches the manifest and the signature verifies
   (see [Image signatures](#image-signatures)). If the primary URL fails, the
   manifest's `fallbackUrl` is tried, with the signature beside it. When the
   primary's ISO matches the checksum but its signature does not hold (a
   stale `.gpg`, say), the fallback's signature is checked against the same
   bytes before anything is refused, so the ISO is not downloaded twice. The
   signature is saved next to the ISO as `<name>.gpg`. A copy that already
   exists in Downloads goes through the same two checks, and the download is
   skipped only if it passes both.
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
may return more than the static file does. An image may also carry
`signatureUrl`, a second place to look for its signature after `<url>.gpg`.
The app sends `Cache-Control: no-cache` and a cache-busting query parameter,
but keep the manifest's CDN TTL short regardless.

When publishing a new release, upload the ISO and its `.gpg` signature to
every mirror first (the `url` host and the `fallbackUrl` host), then update
the manifest. An image without a signature beside it cannot be downloaded by
this app, and that includes older images still listed in the manifest.

### Image signatures

The ISOs are built and signed by iXsystems, and each one is published with a
detached OpenPGP signature (`gpg --detach-sign`, binary or armored) at the
ISO's URL plus `.gpg`. The app verifies that signature with the iX SecTeam
public key built into it (`lib/shared/hexos-signing-keys.ts`), pinned by its
full fingerprint `C8D62DEF767C1DB0DFF4E6EC358EAA9112CF7946`. The manifest only
says where a file is and what its hash should be.

What this proves is that iXsystems signed the exact file. Someone who can
change the manifest, the storage bucket or DNS cannot get a file accepted
that iX did not sign, because they cannot produce the signature. It does not
prove the file is the release the manifest names. The same person could
still point an entry at a different image that carries a genuine iX
signature: an older HexOS ISO, or anything else signed with that key. Two
things narrow that. Signatures made before `OLDEST_ACCEPTED_SIGNATURE` in
`hexos-signing-keys.ts` (2024-11-01, before the first HexOS ISO) are refused.
The download dialog lets users pick any version the manifest lists, so that
date has to stay behind the oldest listed image; raise it in an imager
release when old versions are retired. The ISOs carry no cheap HexOS marker
to check (their volume label is the generic `ISOIMAGE`), so a stock image
signed after that date cannot be told apart from a HexOS one here.

- If no signature is published for an image, the download is refused before
  any of the ISO is fetched, with a message that the signature is not
  available yet.
- If the signature is not a signature, was made by another key, uses a weak
  hash, or does not match the file, the download is refused with a "could
  not be verified" message and the `.part` file is deleted. Every signature
  found at `<url>.gpg` and `signatureUrl` is tried before giving up.
- A copy already in Downloads that fails either check is not used. The app
  downloads a fresh copy, verifies it and replaces the old one.
- If the signature cannot be fetched because of a network or server error,
  that is an ordinary download failure and the user can retry.
- No manifest field or setting turns verification off. `signatureUrl` can
  only add a location.
- The built-in copy of the key cannot be refreshed, and iX extends the key's
  expiry from time to time, so the key's expiry date is not enforced. A
  revoked key or one with an invalid self-signature is rejected. Trusting a
  new key means adding it to `hexos-signing-keys.ts` and shipping a new
  imager release, so do that before the first ISO signed with it.
- The manifest, the ISO, the signature and every redirect on the way to them
  must be `https`. For a local release server during development, set
  `HEXOS_ALLOW_INSECURE_HTTP=1` in the environment to allow `http`.
  Signatures are still checked.

Known limits:

- A program already running as the user, with write access to the Downloads
  folder, can swap the file between verification and flashing. This check
  does not address that.
- If iX revokes the key after an imager release, that release keeps trusting
  it until an imager update removes it.
- The `.gpg` location is derived from the URL in the manifest, not from the
  URL the download was finally redirected to.
- A signature's date is not compared with the computer's clock, so a
  signature dated in the future is accepted. The date is covered by the
  signature and cannot be forged, and rejecting it would fail good images on
  machines with a wrong clock.

`npm run test:hexos-image` runs the tests for this flow. The release
workflow runs them in its Linux job.

## Supported Operating Systems

- Linux; most distros; Intel 64-bit.
- Windows 10 and later; Intel 64-bit.
- macOS 13.5 (Ventura) and later; both Intel and Apple Silicon. HexOS Imager
  2.1.6 remains available for macOS 11 to 13.4.

## Development

Requirements: Node.js 24.x and Python 3.

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
