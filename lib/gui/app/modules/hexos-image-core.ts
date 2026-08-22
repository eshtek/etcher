/*
 * Pure-Node core of the HexOS download flow: manifest fetch, streamed
 * download with sha256 hashing, and file verification.
 *
 * Deliberately has no electron or axios imports — the renderer bundles
 * browser variants of http clients (axios's node adapter gets stubbed out
 * by the "browser" package.json field), so everything here talks straight
 * to Node's https module, which webpack leaves external for
 * electron-renderer targets.
 */

import { createHash } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import * as http from 'http';
import * as https from 'https';

export interface HexOSImageEntry {
	version: string;
	name: string;
	url: string;
	fallbackUrl?: string;
	sha256: string;
	size: number;
	releaseDate?: string;
	notesUrl?: string;
}

export interface HexOSManifest {
	latest: string;
	images: HexOSImageEntry[];
	/** Oldest imager version the release still supports; older builds nag. */
	minImagerVersion?: string;
	/** Which channel served this manifest ("stable" | "beta" | …). */
	channel?: string;
}

export interface DownloadProgress {
	// 'downloading' while bytes are transferred, 'verifying' while hashing
	phase: 'downloading' | 'verifying';
	transferred: number;
	total: number;
	// bytes per second, only meaningful while downloading
	speed: number;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

export class ChecksumMismatchError extends Error {
	constructor(expected: string, actual: string) {
		super(`Checksum mismatch: expected ${expected}, got ${actual}`);
		this.name = 'ChecksumMismatchError';
	}
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_REDIRECTS = 5;
const REDIRECT_CODES = [301, 302, 303, 307, 308];

function isValidEntry(entry: any): entry is HexOSImageEntry {
	return (
		entry != null &&
		typeof entry.version === 'string' &&
		typeof entry.name === 'string' &&
		typeof entry.url === 'string' &&
		typeof entry.sha256 === 'string' &&
		SHA256_RE.test(entry.sha256.toLowerCase()) &&
		typeof entry.size === 'number' &&
		entry.size > 0
	);
}

/**
 * GET a URL with redirect following; resolves with the final response.
 * The caller consumes the response stream and must destroy it when done.
 */
function httpsGet(
	url: string,
	options: { timeout?: number; abortSignal?: AbortSignal },
	redirectsLeft = MAX_REDIRECTS,
): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const transport = parsed.protocol === 'http:' ? http : https;
		const request = transport.get(
			parsed,
			{ headers: { 'Cache-Control': 'no-cache' } },
			(response) => {
				const status = response.statusCode ?? 0;
				const location = response.headers.location;
				if (REDIRECT_CODES.includes(status) && location) {
					response.resume();
					if (redirectsLeft <= 0) {
						reject(new Error(`Too many redirects fetching ${url}`));
						return;
					}
					resolve(
						httpsGet(
							new URL(location, parsed).href,
							options,
							redirectsLeft - 1,
						),
					);
					return;
				}
				if (status < 200 || status >= 300) {
					response.resume();
					reject(new Error(`HTTP ${status} fetching ${parsed.host}`));
					return;
				}
				resolve(response);
			},
		);
		if (options.timeout) {
			// Inactivity timeout, not a whole-transfer cap
			request.setTimeout(options.timeout, () => {
				request.destroy(new Error(`Timed out fetching ${parsed.host}`));
			});
		}
		const onAbort = () => {
			request.destroy(new Error('Aborted'));
		};
		options.abortSignal?.addEventListener('abort', onAbort, { once: true });
		request.on('error', reject);
		request.on('close', () => {
			options.abortSignal?.removeEventListener('abort', onAbort);
		});
	});
}

export async function fetchManifestFrom(
	url: string,
	timeout = 30000,
): Promise<HexOSManifest> {
	// Cache-bust so a CDN/browser cache can't pin users to an old release
	const bustedUrl = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
	const response = await httpsGet(bustedUrl, { timeout });
	const chunks: Buffer[] = [];
	for await (const chunk of response) {
		chunks.push(chunk as Buffer);
	}
	let manifest: any;
	try {
		manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new Error(`Manifest at ${url} is not valid JSON`);
	}
	if (
		manifest == null ||
		typeof manifest.latest !== 'string' ||
		!Array.isArray(manifest.images) ||
		!manifest.images.every(isValidEntry) ||
		(manifest.minImagerVersion !== undefined &&
			typeof manifest.minImagerVersion !== 'string') ||
		(manifest.channel !== undefined && typeof manifest.channel !== 'string')
	) {
		throw new Error(`Invalid HexOS manifest at ${url}`);
	}
	return manifest;
}

export function getLatestImage(manifest: HexOSManifest): HexOSImageEntry {
	const entry = manifest.images.find(
		(image) => image.version === manifest.latest,
	);
	if (entry === undefined) {
		throw new Error(
			`HexOS manifest lists latest version ${manifest.latest} but has no matching image entry`,
		);
	}
	return entry;
}

/**
 * Progress arrives once per stream chunk — on a fast link that is roughly a
 * hundred times a second. Every call reaches React, and under React 17 a
 * setState from outside an event handler renders synchronously, on the very
 * thread that has to drain the socket. Reporting every chunk measured about
 * 9x slower than the link could carry (6 MB/s against curl's 54 MB/s on the
 * same machine), so coalesce down to a rate a progress bar can actually use.
 */
const PROGRESS_INTERVAL_MS = 250;

function throttleProgress(onProgress: ProgressCallback): {
	report: ProgressCallback;
	flush: () => void;
} {
	let lastEmit = 0;
	let pending: DownloadProgress | undefined;
	return {
		report: (progress) => {
			const now = Date.now();
			if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
				lastEmit = now;
				pending = undefined;
				onProgress(progress);
			} else {
				pending = progress;
			}
		},
		// Always land on the true final numbers; the last chunk is usually
		// inside the throttle window and would otherwise never be shown.
		flush: () => {
			if (pending !== undefined) {
				onProgress(pending);
				pending = undefined;
			}
		},
	};
}

async function hashFile(
	filePath: string,
	total: number,
	onProgress: ProgressCallback,
	abortSignal?: AbortSignal,
): Promise<string> {
	const hash = createHash('sha256');
	const stream = createReadStream(filePath);
	const { report, flush } = throttleProgress(onProgress);
	let transferred = 0;
	return await new Promise<string>((resolve, reject) => {
		const onAbort = () => {
			stream.destroy();
			reject(new Error('Aborted'));
		};
		abortSignal?.addEventListener('abort', onAbort, { once: true });
		stream.on('data', (chunk) => {
			hash.update(chunk);
			transferred += chunk.length;
			report({ phase: 'verifying', transferred, total, speed: 0 });
		});
		stream.on('error', reject);
		stream.on('end', () => {
			abortSignal?.removeEventListener('abort', onAbort);
			flush();
			resolve(hash.digest('hex'));
		});
	});
}

/**
 * Returns true when destPath already exists with the expected size and
 * sha256, so the download can be skipped entirely.
 */
export async function verifyExistingFile(
	entry: HexOSImageEntry,
	destPath: string,
	onProgress: ProgressCallback,
	abortSignal?: AbortSignal,
): Promise<boolean> {
	let stat;
	try {
		stat = await fs.stat(destPath);
	} catch {
		return false;
	}
	if (!stat.isFile() || stat.size !== entry.size) {
		return false;
	}
	const digest = await hashFile(destPath, entry.size, onProgress, abortSignal);
	return digest === entry.sha256.toLowerCase();
}

async function downloadFromUrl(
	url: string,
	entry: HexOSImageEntry,
	partPath: string,
	onProgress: ProgressCallback,
	abortSignal?: AbortSignal,
): Promise<string> {
	const response = await httpsGet(url, { timeout: 60000, abortSignal });
	const hash = createHash('sha256');
	const output = createWriteStream(partPath);
	const { report, flush } = throttleProgress(onProgress);
	let transferred = 0;
	let lastTime = Date.now();
	let lastTransferred = 0;
	let speed = 0;
	await new Promise<void>((resolve, reject) => {
		response.on('data', (chunk: Buffer) => {
			hash.update(chunk);
			transferred += chunk.length;
			const now = Date.now();
			const elapsed = now - lastTime;
			if (elapsed >= 1000) {
				speed = ((transferred - lastTransferred) / elapsed) * 1000;
				lastTime = now;
				lastTransferred = transferred;
			}
			report({
				phase: 'downloading',
				transferred,
				total: entry.size,
				speed,
			});
		});
		response.on('error', reject);
		output.on('error', reject);
		output.on('finish', () => {
			flush();
			resolve();
		});
		response.pipe(output);
	});
	return hash.digest('hex');
}

/**
 * Ensure a verified copy of the image exists at destPath and return it.
 *
 * Skips the download when a verified copy is already present. Otherwise
 * downloads from the primary URL (falling back to fallbackUrl), verifying
 * the sha256 computed over the streamed bytes. The file is downloaded to
 * `<destPath>.part` and only renamed into place after the checksum matches.
 */
export async function ensureImageAt(
	entry: HexOSImageEntry,
	destPath: string,
	onProgress: ProgressCallback,
	abortSignal?: AbortSignal,
): Promise<{ path: string; alreadyExisted: boolean }> {
	if (await verifyExistingFile(entry, destPath, onProgress, abortSignal)) {
		return { path: destPath, alreadyExisted: true };
	}
	const partPath = `${destPath}.part`;
	const urls = [entry.url, entry.fallbackUrl].filter(
		(url): url is string => !!url,
	);
	let lastError: Error = new Error('No download URLs available');
	for (const url of urls) {
		try {
			const digest = await downloadFromUrl(
				url,
				entry,
				partPath,
				onProgress,
				abortSignal,
			);
			if (digest !== entry.sha256.toLowerCase()) {
				await fs.unlink(partPath).catch(() => undefined);
				throw new ChecksumMismatchError(entry.sha256, digest);
			}
			await fs.rename(partPath, destPath);
			return { path: destPath, alreadyExisted: false };
		} catch (error: any) {
			await fs.unlink(partPath).catch(() => undefined);
			// Don't retry on user cancellation or a corrupt download; a
			// checksum mismatch on an intact transfer means a bad publish,
			// not a flaky mirror.
			if (abortSignal?.aborted || error instanceof ChecksumMismatchError) {
				throw error;
			}
			lastError = error;
		}
	}
	throw lastError;
}
