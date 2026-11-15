/*
 * Pure-Node core of the HexOS download flow: manifest fetch, streamed
 * download with sha256 hashing, and file verification against the image's
 * detached OpenPGP signature.
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
import type { Writable } from 'stream';

import type { SignatureCandidate, SignaturePolicy } from './hexos-signature';

export interface HexOSImageEntry {
	version: string;
	name: string;
	url: string;
	fallbackUrl?: string;
	sha256: string;
	size: number;
	/**
	 * Extra place to look for the detached signature. `<url>.gpg` is always
	 * tried first, and nothing in the manifest can switch verification off.
	 */
	signatureUrl?: string;
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

/**
 * The image has a signature but it does not hold: wrong signer, wrong file,
 * or not a signature at all. Never retried against another mirror once the
 * bytes are known to match the manifest.
 */
export class SignatureVerificationError extends Error {
	constructor(reason: string) {
		super(`Signature verification failed: ${reason}`);
		this.name = 'SignatureVerificationError';
	}
}

/**
 * No signature is published for the image, so it cannot be checked and
 * nothing was downloaded. Refused just the same.
 */
export class SignatureUnavailableError extends Error {
	constructor(reason: string) {
		super(`Signature unavailable: ${reason}`);
		this.name = 'SignatureUnavailableError';
	}
}

class BodyTooLargeError extends Error {}

class HttpStatusError extends Error {
	constructor(
		public status: number,
		host: string,
	) {
		super(`HTTP ${status} fetching ${host}`);
	}
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_REDIRECTS = 5;
const REDIRECT_CODES = [301, 302, 303, 307, 308];
const SIGNATURE_SUFFIX = '.gpg';
const SIGNATURE_TIMEOUT_MS = 30000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
// Statuses that can clear up on their own, unlike a file that is not there
const TRANSIENT_CLIENT_STATUSES = [408, 425, 429];

// Loaded on first use so the renderer, which only fetches manifests through
// this module, never evaluates the OpenPGP library.
const signatureModule = () => import('./hexos-signature');

/**
 * Plain http is refused for every request and every redirect hop. The one
 * exception is for developers running a local release server, and it is read
 * from the process environment only, so no manifest can reach it. Signature
 * verification stays on either way.
 */
function isAllowedProtocol(protocol: string): boolean {
	return (
		protocol === 'https:' ||
		(protocol === 'http:' && process.env.HEXOS_ALLOW_INSECURE_HTTP === '1')
	);
}

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
		if (!isAllowedProtocol(parsed.protocol)) {
			reject(
				new Error(
					`Refusing to fetch ${parsed.protocol}//${parsed.host}: only https is allowed`,
				),
			);
			return;
		}
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
					reject(new HttpStatusError(status, parsed.host));
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

async function readBody(
	response: http.IncomingMessage,
	limit: number,
): Promise<Buffer> {
	try {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of response) {
			size += chunk.length;
			if (size > limit) {
				throw new BodyTooLargeError(
					`Response is larger than the ${limit} bytes allowed`,
				);
			}
			chunks.push(chunk as Buffer);
		}
		return Buffer.concat(chunks);
	} finally {
		response.destroy();
	}
}

export async function fetchManifestFrom(
	url: string,
	timeout = 30000,
): Promise<HexOSManifest> {
	// Cache-bust so a CDN/browser cache can't pin users to an old release
	const bustedUrl = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
	const body = await readBody(
		await httpsGet(bustedUrl, { timeout }),
		MAX_MANIFEST_BYTES,
	);
	let manifest: any;
	try {
		manifest = JSON.parse(body.toString('utf8'));
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

/**
 * Node defaults streams to 64 KB, which for a 2 GB image means tens of
 * thousands of chunk events, each one a JS callback and a hash update. A
 * larger buffer cuts that by a factor of sixty-four and lets the disk work
 * in sizes it actually likes.
 */
const STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Close a stream and wait until the OS handle is actually released.
 *
 * Windows refuses to unlink or re-create a file while a handle is still open,
 * so abandoning the write stream on cancel left the .part file locked: the
 * cleanup unlink failed silently and the next attempt failed outright with
 * "EPERM: operation not permitted, open '...iso.part'". destroy() alone is not
 * enough — it returns before 'close' fires.
 */
function closeStream(stream: {
	destroy: () => void;
	once: (event: string, listener: () => void) => void;
	closed?: boolean;
	destroyed?: boolean;
}): Promise<void> {
	return new Promise((resolve) => {
		if (stream.closed) {
			resolve();
			return;
		}
		stream.once('close', () => resolve());
		stream.destroy();
	});
}

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
	signatureSink?: Writable,
): Promise<string> {
	const hash = createHash('sha256');
	const stream = createReadStream(filePath, {
		highWaterMark: STREAM_CHUNK_BYTES,
	});
	const { report, flush } = throttleProgress(onProgress);
	let transferred = 0;
	try {
		return await new Promise<string>((resolve, reject) => {
			const onAbort = () => reject(new Error('Aborted'));
			abortSignal?.addEventListener('abort', onAbort, { once: true });
			stream.on('data', (chunk) => {
				hash.update(chunk);
				transferred += chunk.length;
				report({ phase: 'verifying', transferred, total, speed: 0 });
			});
			stream.on('error', reject);
			const onDone = () => {
				abortSignal?.removeEventListener('abort', onAbort);
				flush();
				resolve(hash.digest('hex'));
			};
			if (signatureSink === undefined) {
				stream.on('end', onDone);
			} else {
				signatureSink.on('error', (error) =>
					reject(new SignatureVerificationError(error.message)),
				);
				signatureSink.on('finish', onDone);
				stream.pipe(signatureSink);
			}
		});
	} finally {
		signatureSink?.destroy();
		// A read handle left open on the destination blocks the rename that
		// puts a freshly downloaded file into place, so release it here rather
		// than leaving it to the abort path.
		await closeStream(stream);
	}
}

function imageUrls(entry: HexOSImageEntry): string[] {
	return [entry.url, entry.fallbackUrl].filter((url): url is string => !!url);
}

/**
 * Where an image's detached signature may be: `<image url>.gpg` for each
 * given image URL, then the manifest's optional `signatureUrl`.
 */
function signatureLocations(urls: string[], entry: HexOSImageEntry): string[] {
	const locations = urls.map((url) => {
		const parsed = new URL(url);
		parsed.pathname += SIGNATURE_SUFFIX;
		return parsed.href;
	});
	if (typeof entry.signatureUrl === 'string' && entry.signatureUrl) {
		locations.push(entry.signatureUrl);
	}
	return locations;
}

/**
 * Fetch every signature location and return the signatures that could
 * verify the image. Throws when there are none, and the error says which
 * kind of nothing it was: a location that could not be reached (retryable),
 * no signature published anywhere (SignatureUnavailableError), or only
 * files that can never verify (SignatureVerificationError).
 */
async function fetchCandidates(
	locations: string[],
	policy?: SignaturePolicy,
	abortSignal?: AbortSignal,
): Promise<SignatureCandidate[]> {
	const { selectCandidates, MAX_SIGNATURE_BYTES } = await signatureModule();
	const files: Buffer[] = [];
	let unreachable: Error | undefined;
	let oversized = false;
	for (const location of locations) {
		try {
			const response = await httpsGet(location, {
				timeout: SIGNATURE_TIMEOUT_MS,
				abortSignal,
			});
			files.push(await readBody(response, MAX_SIGNATURE_BYTES));
		} catch (error: any) {
			if (abortSignal?.aborted) {
				throw error;
			}
			if (error instanceof BodyTooLargeError) {
				oversized = true;
			} else if (
				!(error instanceof HttpStatusError) ||
				error.status < 400 ||
				error.status >= 500 ||
				TRANSIENT_CLIENT_STATUSES.includes(error.status)
			) {
				unreachable = error;
			}
		}
	}
	const { candidates, reason } = await selectCandidates(files, policy);
	if (candidates.length > 0) {
		return candidates;
	}
	if (unreachable !== undefined) {
		throw unreachable;
	}
	if (files.length === 0 && !oversized) {
		throw new SignatureUnavailableError(
			'no signature is published for this image',
		);
	}
	throw new SignatureVerificationError(
		files.length === 0 ? 'the signature file is too large' : reason,
	);
}

/** Candidates from the signature kept beside a verified download, if any. */
async function savedCandidates(
	destPath: string,
	policy?: SignaturePolicy,
): Promise<SignatureCandidate[]> {
	const { selectCandidates, MAX_SIGNATURE_BYTES } = await signatureModule();
	try {
		const signaturePath = destPath + SIGNATURE_SUFFIX;
		if ((await fs.stat(signaturePath)).size > MAX_SIGNATURE_BYTES) {
			return [];
		}
		const saved = await fs.readFile(signaturePath);
		return (await selectCandidates([saved], policy)).candidates;
	} catch {
		return [];
	}
}

/**
 * Returns true when destPath already exists with the expected size and
 * sha256 and carries a valid signature, so the download can be skipped.
 *
 * The signature saved beside the file by an earlier download is tried first
 * so reuse needs no network; where it came from does not matter because it
 * only counts if a trusted key made it. Without one, or if it does not
 * verify, the published signatures are fetched from every mirror. A file
 * that fails either check, or whose signature cannot be had, is simply not
 * reusable: the caller downloads a fresh copy, which is verified on its own
 * and replaces this one.
 */
export async function verifyExistingFile(
	entry: HexOSImageEntry,
	destPath: string,
	onProgress: ProgressCallback,
	abortSignal?: AbortSignal,
	policy?: SignaturePolicy,
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
	const { startSignatureCheck } = await signatureModule();
	for (const saved of [true, false]) {
		let candidates: SignatureCandidate[];
		try {
			candidates = saved
				? await savedCandidates(destPath, policy)
				: await fetchCandidates(
						signatureLocations(imageUrls(entry), entry),
						policy,
						abortSignal,
					);
		} catch (error) {
			if (abortSignal?.aborted) {
				throw error;
			}
			return false;
		}
		if (candidates.length === 0) {
			continue;
		}
		const check = await startSignatureCheck(candidates);
		let digest: string;
		try {
			digest = await hashFile(
				destPath,
				entry.size,
				onProgress,
				abortSignal,
				check.sink,
			);
		} catch (error) {
			if (error instanceof SignatureVerificationError) {
				continue;
			}
			throw error;
		}
		if (digest !== entry.sha256.toLowerCase()) {
			return false;
		}
		const { source } = await check.result();
		if (source !== undefined) {
			if (!saved) {
				await fs
					.writeFile(destPath + SIGNATURE_SUFFIX, source)
					.catch(() => undefined);
			}
			return true;
		}
	}
	return false;
}

async function downloadFromUrl(
	url: string,
	entry: HexOSImageEntry,
	partPath: string,
	onProgress: ProgressCallback,
	abortSignal?: AbortSignal,
	signatureSink?: Writable,
): Promise<string> {
	const hash = createHash('sha256');
	let response: http.IncomingMessage | undefined;
	let output: ReturnType<typeof createWriteStream> | undefined;
	try {
		const source = await httpsGet(url, { timeout: 60000, abortSignal });
		response = source;
		const target = createWriteStream(partPath, {
			highWaterMark: STREAM_CHUNK_BYTES,
		});
		output = target;
		const { report, flush } = throttleProgress(onProgress);
		let transferred = 0;
		let lastTime = Date.now();
		let lastTransferred = 0;
		let speed = 0;
		await new Promise<void>((resolve, reject) => {
			source.on('data', (chunk: Buffer) => {
				hash.update(chunk);
				transferred += chunk.length;
				if (transferred > entry.size) {
					reject(
						new Error(
							`${new URL(url).host} sent more than the ${entry.size} bytes the manifest lists`,
						),
					);
					source.destroy();
					return;
				}
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
			source.on('error', reject);
			let pending = signatureSink === undefined ? 1 : 2;
			const onFinish = () => {
				pending -= 1;
				if (pending === 0) {
					flush();
					resolve();
				}
			};
			target.on('error', reject);
			target.on('finish', onFinish);
			source.pipe(target);
			if (signatureSink !== undefined) {
				signatureSink.on('error', (error) =>
					reject(new SignatureVerificationError(error.message)),
				);
				signatureSink.on('finish', onFinish);
				source.pipe(signatureSink);
			}
		});
	} finally {
		signatureSink?.destroy();
		// Runs on cancellation too: the abort destroys the request, but the
		// file handle is ours to release. Whoever cleans up the .part file
		// next needs it closed first.
		response?.destroy();
		if (output !== undefined) {
			await closeStream(output);
		}
	}
	return hash.digest('hex');
}

/**
 * Ensure a verified copy of the image exists at destPath and return it.
 *
 * Skips the download when a verified copy is already present. Otherwise
 * fetches the image's detached signature first, so a release published
 * without one fails before any bytes are downloaded, then downloads from the
 * primary URL (falling back to fallbackUrl) while computing the sha256 and
 * the signature hash over the streamed bytes. The file is downloaded to
 * `<destPath>.part` and only renamed into place after the checksum matches
 * and a trusted key's signature verifies.
 */
export async function ensureImageAt(
	entry: HexOSImageEntry,
	destPath: string,
	onProgress: ProgressCallback,
	abortSignal?: AbortSignal,
	policy?: SignaturePolicy,
): Promise<{ path: string; alreadyExisted: boolean }> {
	if (
		await verifyExistingFile(entry, destPath, onProgress, abortSignal, policy)
	) {
		return { path: destPath, alreadyExisted: true };
	}
	const { startSignatureCheck } = await signatureModule();
	const partPath = `${destPath}.part`;
	let unreachable: Error | undefined;
	let unverifiable: SignatureVerificationError | undefined;
	let unavailable: SignatureUnavailableError | undefined;
	for (const url of imageUrls(entry)) {
		let downloaded = false;
		try {
			const candidates = await fetchCandidates(
				signatureLocations([url], entry),
				policy,
				abortSignal,
			);
			const check = await startSignatureCheck(candidates);
			const digest = await downloadFromUrl(
				url,
				entry,
				partPath,
				onProgress,
				abortSignal,
				check.sink,
			);
			downloaded = true;
			if (digest !== entry.sha256.toLowerCase()) {
				throw new ChecksumMismatchError(entry.sha256, digest);
			}
			const { source, failure } = await check.result();
			if (source === undefined) {
				throw new SignatureVerificationError(failure ?? 'not verified');
			}
			await fs.rename(partPath, destPath);
			await fs
				.writeFile(destPath + SIGNATURE_SUFFIX, source)
				.catch(() => undefined);
			return { path: destPath, alreadyExisted: false };
		} catch (error: any) {
			await fs.unlink(partPath).catch(() => undefined);
			// Don't retry on user cancellation or a download that arrived
			// intact and still failed its checksum or signature: that is a
			// bad publish, not a flaky mirror. A mirror whose signature is
			// missing or unusable is skipped like any other broken mirror.
			if (
				abortSignal?.aborted ||
				error instanceof ChecksumMismatchError ||
				(downloaded && error instanceof SignatureVerificationError)
			) {
				throw error;
			}
			if (error instanceof SignatureVerificationError) {
				unverifiable = error;
			} else if (error instanceof SignatureUnavailableError) {
				unavailable = error;
			} else {
				unreachable = error;
			}
		}
	}
	throw (
		unreachable ??
		unverifiable ??
		unavailable ??
		new Error('No download URLs available')
	);
}
