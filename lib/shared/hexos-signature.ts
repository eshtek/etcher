/*
 * Detached OpenPGP signature verification for HexOS installer images.
 *
 * The file is never held in memory: its bytes are piped through `sink` in
 * the same pass that writes or hashes them, and the outcome is read once the
 * stream has ended.
 */

import { Writable } from 'stream';
import * as openpgp from 'openpgp';

import type { TrustedSigningKey } from './hexos-signing-keys';
import {
	OLDEST_ACCEPTED_SIGNATURE,
	TRUSTED_SIGNING_KEYS,
} from './hexos-signing-keys';

export type { TrustedSigningKey } from './hexos-signing-keys';

export interface SignaturePolicy {
	trustedKeys: TrustedSigningKey[];
	/** Signatures created before this are refused. */
	notBefore: Date;
}

export const DEFAULT_SIGNATURE_POLICY: SignaturePolicy = {
	trustedKeys: TRUSTED_SIGNING_KEYS,
	notBefore: OLDEST_ACCEPTED_SIGNATURE,
};

export const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_CANDIDATES = 4;
const ARMOR_HEADER = '-----BEGIN PGP SIGNATURE-----';
const ACCEPTED_HASHES: number[] = [
	openpgp.enums.hash.sha256,
	openpgp.enums.hash.sha384,
	openpgp.enums.hash.sha512,
];

/** One signature that could still verify the file, and the key to check it with. */
export interface SignatureCandidate {
	packet: openpgp.SignaturePacket;
	keyPacket: openpgp.AnyKeyPacket;
	/** The signature file this packet came from. */
	source: Buffer;
}

export interface SignatureCheck {
	/** Receives exactly the bytes of the file being verified. */
	sink: Writable;
	/**
	 * `source` is the signature file that verified; without one, `failure`
	 * says why none did.
	 */
	result: () => Promise<{ source?: Buffer; failure?: string }>;
}

const describe = (error: any): string => error?.message ?? String(error);

/** Accepts both `gpg --detach-sign` (binary) and `--armor` output. */
export async function parseSignature(
	bytes: Buffer,
): Promise<openpgp.SignaturePacket[]> {
	const signature = bytes
		.toString('latin1')
		.trimStart()
		.startsWith(ARMOR_HEADER)
		? await openpgp.readSignature({ armoredSignature: bytes.toString('utf8') })
		: await openpgp.readSignature({ binarySignature: new Uint8Array(bytes) });
	return [...signature.packets];
}

export async function loadTrustedKeys(
	trusted: TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
): Promise<openpgp.PublicKey[]> {
	return Promise.all(
		trusted.map(async ({ fingerprint, armoredKey }) => {
			const key = await openpgp.readKey({ armoredKey });
			if (
				key.isPrivate() ||
				key.getFingerprint().toUpperCase() !== fingerprint.toUpperCase()
			) {
				throw new Error(
					`Embedded signing key does not match fingerprint ${fingerprint}`,
				);
			}
			return key;
		}),
	);
}

/**
 * Pick, from any number of signature files, the signatures worth hashing the
 * image for. Everything that can be known from the signature alone is
 * decided here, before a byte of the image is read: signer, signature type,
 * hash and key algorithms, and age.
 *
 * Key policy: trust is the pinned fingerprint. The embedded copy of a key
 * cannot be refreshed when its owner extends the expiry, so key validity is
 * checked without a date: a copy that has passed its expiry still verifies,
 * including signatures made after that date. Revoked keys, invalid
 * self-signatures and subkeys without a valid signing binding are rejected.
 * Signatures dated in the future are not rejected either: the date is
 * covered by the signature, so it cannot be forged, and a wrong clock on
 * the user's machine would otherwise fail a good image.
 */
export async function selectCandidates(
	files: Buffer[],
	policy: SignaturePolicy = DEFAULT_SIGNATURE_POLICY,
): Promise<{ candidates: SignatureCandidate[]; reason: string }> {
	const keys = await loadTrustedKeys(policy.trustedKeys);
	const candidates: SignatureCandidate[] = [];
	const seen = new Set<string>();
	let reason = 'no signature found';
	for (const source of files) {
		let packets: openpgp.SignaturePacket[];
		try {
			packets = await parseSignature(source);
		} catch {
			reason = 'the signature file is not an OpenPGP signature';
			continue;
		}
		for (const packet of packets) {
			const key = keys.find(
				(trusted) => trusted.getKeys(packet.issuerKeyID).length > 0,
			);
			if (key === undefined) {
				reason = 'not signed by a trusted key';
				continue;
			}
			// Only a signature over the file's bytes counts; other types
			// (standalone, certifications) sign something else entirely.
			if (
				packet.signatureType !== openpgp.enums.signature.binary ||
				packet.version !== 4
			) {
				reason = 'not a binary document signature';
				continue;
			}
			if (
				packet.hashAlgorithm === null ||
				!ACCEPTED_HASHES.includes(packet.hashAlgorithm)
			) {
				reason = 'the signature uses an unsupported hash algorithm';
				continue;
			}
			if (!(packet.created instanceof Date)) {
				reason = 'the signature has no creation time';
				continue;
			}
			if (packet.created < policy.notBefore) {
				reason = 'the signature is older than the oldest supported release';
				continue;
			}
			let signingKey;
			try {
				signingKey = await key.getSigningKey(packet.issuerKeyID, null);
			} catch (error) {
				reason = describe(error);
				continue;
			}
			if (packet.publicKeyAlgorithm !== signingKey.keyPacket.algorithm) {
				reason = 'the signature does not match its key type';
				continue;
			}
			const id = Buffer.from(packet.write() as Uint8Array).toString('base64');
			if (seen.has(id) || candidates.length >= MAX_CANDIDATES) {
				continue;
			}
			seen.add(id);
			candidates.push({ packet, keyPacket: signingKey.keyPacket, source });
		}
	}
	return { candidates, reason };
}

/**
 * Check every candidate against one pass over the file. The file verifies
 * if any candidate does.
 */
export async function startSignatureCheck(
	candidates: SignatureCandidate[],
): Promise<SignatureCheck> {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const message = await openpgp.createMessage({ binary: readable as any });
	const literal = message.packets.filterByTag(
		openpgp.enums.packet.literalData,
	)[0];
	let inputEnded = false;

	const sink = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			writer.write(chunk).then(() => callback(), callback);
		},
		final(callback) {
			inputEnded = true;
			writer.close().then(() => callback(), callback);
		},
		destroy(error, callback) {
			writer.abort(error ?? undefined).catch(() => undefined);
			callback(error);
		},
	});

	// Each packet hashes its own passive clone of the data, taken
	// synchronously here; reading the original below is what drives them.
	const verdicts = candidates.map(({ packet, keyPacket }) =>
		packet
			.verify(
				keyPacket,
				openpgp.enums.signature.binary,
				literal,
				null as any,
				true,
			)
			.then(
				() => undefined,
				(error) => {
					// A clone nobody reads any more would buffer the rest of
					// the file, so a verdict before the end stops the transfer.
					if (!inputEnded) {
						sink.destroy(new Error(describe(error)));
					}
					return describe(error);
				},
			),
	);

	const outcome = (async () => {
		const reader = (
			message.getLiteralData() as unknown as ReadableStream<Uint8Array>
		).getReader();
		for (;;) {
			const { done } = await reader.read();
			if (done) {
				break;
			}
		}
		const failures = await Promise.all(verdicts);
		const verified = failures.indexOf(undefined);
		return verified === -1
			? { failure: failures[0] ?? 'no signature to check' }
			: { source: candidates[verified].source };
	})().catch((error) => ({ failure: describe(error) }));

	return { sink, result: () => outcome };
}
