/*
 * OpenPGP keys trusted to sign HexOS installer images.
 *
 * HexOS verifies iX's signature and sha256 on each ISO in its own release
 * process, applies its changes, then signs the result with the HexOS key.
 * The imager trusts that key only. iX's key is not trusted here, so every
 * image in the manifest, old ones included, needs a HexOS signature.
 *
 * Trust is the full primary-key fingerprint, and the embedded copy must hash
 * to it. The key must be an OpenPGP v4 key (40-hex-digit fingerprint), and
 * images must carry v4 signatures. At most two keys are trusted at once so a new key can be pinned
 * beside the current one before a rotation.
 */

export interface TrustedSigningKey {
	owner: string;
	fingerprint: string;
	armoredKey: string;
}

export const MAX_TRUSTED_SIGNING_KEYS = 2;

/**
 * Stands in for the HexOS key until it exists. A key with this fingerprint,
 * or any value that is not a 40-hex-digit fingerprint, makes every
 * verification fail.
 */
export const PLACEHOLDER_SIGNING_KEY: TrustedSigningKey = Object.freeze({
	owner: 'PLACEHOLDER: HexOS release signing key not generated yet',
	fingerprint: 'PLACEHOLDER-HEXOS-SIGNING-KEY-FINGERPRINT',
	armoredKey: 'PLACEHOLDER: paste the armored HexOS public key here',
});

/**
 * The HexOS release signing key. Replace the placeholder with
 * `{ owner, fingerprint, armoredKey }` for the real public key, and set
 * OLDEST_ACCEPTED_SIGNATURE to the key's creation date.
 */
export const HEXOS_SIGNING_KEY: TrustedSigningKey = PLACEHOLDER_SIGNING_KEY;

/**
 * The next HexOS key during a rotation: pin it here in an imager release
 * before the first image signed with it, then move it to HEXOS_SIGNING_KEY
 * once nothing in the manifest is signed by the old one.
 */
export const HEXOS_NEXT_SIGNING_KEY: TrustedSigningKey | undefined = undefined;

export const TRUSTED_SIGNING_KEYS: TrustedSigningKey[] = [
	HEXOS_SIGNING_KEY,
	...(HEXOS_NEXT_SIGNING_KEY === undefined ? [] : [HEXOS_NEXT_SIGNING_KEY]),
];

/**
 * A sanity floor: no HexOS-key signature can predate this design. Every
 * image is re-signed when it is published, so a signature's date says when
 * it was signed, not which release it is, and this date cannot tell
 * versions apart. Raise it to the HexOS key's creation date when the key is
 * pinned.
 */
export const OLDEST_ACCEPTED_SIGNATURE = new Date('2026-11-01T00:00:00Z');

export function isPinnedSigningKey(key: TrustedSigningKey): boolean {
	return (
		key !== PLACEHOLDER_SIGNING_KEY &&
		/^[0-9A-F]{40}$/i.test(key.fingerprint) &&
		key.armoredKey.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')
	);
}
