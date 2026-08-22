/*
 * Electron glue for the HexOS image download flow.
 *
 * The release manifest is resolved from two sources, in order:
 *
 *   1. the HexOS API (api.hexos.com), which can vary the response by
 *      release channel and report a minimum supported imager version
 *   2. the static manifest on downloads.hexos.com
 *
 * The API is tried first with a short timeout and the static file is a
 * silent fallback, so a cloud incident can never block a new user's very
 * first download. The static file always serves the stable channel.
 *
 * Manifest shape (see README):
 * {
 *   "latest": "25.10.3",
 *   "minImagerVersion": "2.1.6",        // optional
 *   "channel": "stable",                // optional, echoed by the API
 *   "images": [
 *     {
 *       "version": "25.10.3",
 *       "name": "TrueNAS-SCALE-25.10.3-HexOS.iso",
 *       "url": "https://downloads.hexos.com/TrueNAS-SCALE-25.10.3-HexOS.iso",
 *       "fallbackUrl": "https://hexos-downloads.sfo3.cdn.digitaloceanspaces.com/…",
 *       "sha256": "…",
 *       "size": 2181978112
 *     }
 *   ]
 * }
 *
 * All network/hash logic lives in hexos-image-core.ts (pure Node); this
 * module only resolves URLs from settings and the destination path from
 * Electron's downloads directory.
 */

import { join } from 'path';
import * as semver from 'semver';

import { version as appVersion } from '../../../../package.json';
import * as settings from '../models/settings';
import type {
	HexOSImageEntry,
	HexOSManifest,
	ProgressCallback,
} from './hexos-image-core';
import { ensureImageAt, fetchManifestFrom } from './hexos-image-core';

export type {
	DownloadProgress,
	HexOSImageEntry,
	HexOSManifest,
	ProgressCallback,
} from './hexos-image-core';
export { ChecksumMismatchError, getLatestImage } from './hexos-image-core';

/**
 * Short on purpose: this is the budget before falling back to the static
 * manifest, not a normal request timeout.
 */
const API_TIMEOUT_MS = 6000;
const STATIC_TIMEOUT_MS = 30000;

export interface ManifestResult {
	manifest: HexOSManifest;
	/** Which source answered, for logging and diagnostics. */
	source: 'api' | 'static';
	url: string;
}

export async function getChannel(): Promise<string> {
	return (
		process.env.HEXOS_CHANNEL || (await settings.get('hexosChannel')) || 'stable'
	);
}

export async function getApiManifestUrl(): Promise<string | undefined> {
	const base =
		process.env.HEXOS_MANIFEST_URL || (await settings.get('hexosManifestUrl'));
	if (!base) {
		return undefined;
	}
	const channel = await getChannel();
	return `${base}${base.includes('?') ? '&' : '?'}channel=${encodeURIComponent(channel)}`;
}

export async function getStaticManifestUrl(): Promise<string> {
	return (
		process.env.HEXOS_MANIFEST_FALLBACK_URL ||
		(await settings.get('hexosManifestFallbackUrl'))
	);
}

/**
 * Fetch the manifest, preferring the API and falling back to the static
 * file. Throws only when *both* sources fail.
 */
export async function fetchManifest(): Promise<ManifestResult> {
	const apiUrl = await getApiManifestUrl();
	if (apiUrl) {
		try {
			const manifest = await fetchManifestFrom(apiUrl, API_TIMEOUT_MS);
			return { manifest, source: 'api', url: apiUrl };
		} catch (error: any) {
			// Expected whenever the API is unreachable, mid-deploy, or the
			// endpoint isn't live yet — the static manifest is authoritative
			// enough to carry the download on its own.
			console.warn(
				`HexOS release API unavailable (${error?.message ?? error}); using the static manifest.`,
			);
		}
	}
	const staticUrl = await getStaticManifestUrl();
	const manifest = await fetchManifestFrom(staticUrl, STATIC_TIMEOUT_MS);
	return { manifest, source: 'static', url: staticUrl };
}

/**
 * True when the manifest declares a minimum imager version newer than this
 * build. Advisory only — downloading still works.
 */
export function isImagerOutdated(manifest: HexOSManifest): boolean {
	const min = manifest.minImagerVersion;
	if (!min || !semver.valid(min) || !semver.valid(appVersion)) {
		return false;
	}
	return semver.lt(appVersion, min);
}

export function getDestinationPath(entry: HexOSImageEntry): string {
	const downloadsDir = require('@electron/remote').app.getPath('downloads');
	return join(downloadsDir, entry.name);
}

export async function ensureImage(
	entry: HexOSImageEntry,
	onProgress: ProgressCallback,
	abortSignal?: AbortSignal,
): Promise<{ path: string; alreadyExisted: boolean }> {
	return await ensureImageAt(
		entry,
		getDestinationPath(entry),
		onProgress,
		abortSignal,
	);
}
