import { expect } from 'chai';
import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as openpgp from 'openpgp';
import * as selfsigned from 'selfsigned';

import type { HexOSImageEntry } from '../../lib/shared/hexos-image-core';
import {
	ChecksumMismatchError,
	SignatureUnavailableError,
	SignatureVerificationError,
	ensureImageAt,
	fetchManifestFrom,
} from '../../lib/shared/hexos-image-core';
import {
	DEFAULT_SIGNATURE_POLICY,
	loadTrustedKeys,
	selectCandidates,
	startSignatureCheck,
} from '../../lib/shared/hexos-signature';
import type { TrustedSigningKey } from '../../lib/shared/hexos-signing-keys';
import {
	OLDEST_ACCEPTED_SIGNATURE,
	TRUSTED_SIGNING_KEYS,
} from '../../lib/shared/hexos-signing-keys';

const IX_FINGERPRINT = 'C8D62DEF767C1DB0DFF4E6EC358EAA9112CF7946';
const ISO_NAME = 'HexOS-test.iso';

interface Route {
	status?: number;
	body?: Buffer | string;
	location?: string;
}

interface TestKey {
	privateKey: openpgp.PrivateKey;
	trusted: TrustedSigningKey;
}

async function makeKey(options: object = {}): Promise<TestKey> {
	const generated = (await openpgp.generateKey({
		userIDs: [{ name: 'Test Signer', email: 'signer@example.invalid' }],
		format: 'object',
		...options,
	} as any)) as unknown as {
		privateKey: openpgp.PrivateKey;
		publicKey: openpgp.PublicKey;
	};
	return {
		privateKey: generated.privateKey,
		trusted: {
			owner: 'Test Signer',
			fingerprint: generated.publicKey.getFingerprint().toUpperCase(),
			armoredKey: generated.publicKey.armor(),
		},
	};
}

async function sign(
	data: Buffer,
	key: TestKey,
	format: 'binary' | 'armored',
	date?: Date,
): Promise<Buffer> {
	const signature = await openpgp.sign({
		message: await openpgp.createMessage({ binary: new Uint8Array(data) }),
		signingKeys: key.privateKey,
		detached: true,
		format: format as any,
		date,
	});
	return Buffer.from(signature as any);
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error: any) {
		return error;
	}
	throw new Error('Expected a rejection');
}

describe('Shared: HexOS image core', function () {
	this.timeout(60000);

	const iso = randomBytes(3 * 1024 * 1024 + 17);
	const otherIso = Buffer.concat([
		iso.subarray(0, iso.length - 1),
		Buffer.from([0]),
	]);
	const routes = new Map<string, Route>();
	const hits: string[] = [];
	const savedCa = https.globalAgent.options.ca;

	let secure: https.Server;
	let plain: http.Server;
	let secureBase: string;
	let plainBase: string;
	let signer: TestKey;
	let stranger: TestKey;
	let goodSignature: Buffer;
	let dir: string;
	let dest: string;

	const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
		const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
		hits.push(pathname);
		const route = routes.get(pathname);
		if (route === undefined) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(
			route.status ?? 200,
			route.location ? { location: route.location } : {},
		);
		res.end(route.body);
	};

	const entryFor = (
		data: Buffer,
		extra: Partial<HexOSImageEntry> = {},
	): HexOSImageEntry => ({
		version: '1.0.0',
		name: ISO_NAME,
		url: `${secureBase}/${ISO_NAME}`,
		sha256: createHash('sha256').update(data).digest('hex'),
		size: data.length,
		...extra,
	});

	const ensure = (
		entry: HexOSImageEntry,
		trustedKeys = [signer.trusted],
		notBefore = new Date(0),
	) =>
		ensureImageAt(entry, dest, () => undefined, undefined, {
			trustedKeys,
			notBefore,
		});

	const exists = (file: string) =>
		fs.stat(file).then(
			() => true,
			() => false,
		);

	const expectNothingKept = async () => {
		expect(await exists(dest)).to.equal(false);
		expect(await exists(`${dest}.part`)).to.equal(false);
	};

	before(async function () {
		const cert = selfsigned.generate(
			[{ name: 'commonName', value: '127.0.0.1' }],
			{
				keySize: 2048,
				extensions: [
					{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
				],
			},
		);
		secure = https.createServer(
			{ key: cert.private, cert: cert.cert },
			handler,
		);
		plain = http.createServer(handler);
		await new Promise<void>((resolve) =>
			secure.listen(0, '127.0.0.1', resolve),
		);
		await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
		secureBase = `https://127.0.0.1:${(secure.address() as AddressInfo).port}`;
		plainBase = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
		https.globalAgent.options.ca = cert.cert;

		signer = await makeKey({ type: 'rsa', rsaBits: 2048 });
		stranger = await makeKey();
		goodSignature = await sign(iso, signer, 'binary');
	});

	after(function () {
		https.globalAgent.options.ca = savedCa;
		secure.close();
		plain.close();
		secure.closeAllConnections();
		plain.closeAllConnections();
	});

	beforeEach(async function () {
		routes.clear();
		hits.length = 0;
		delete process.env.HEXOS_ALLOW_INSECURE_HTTP;
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hexos-image-'));
		dest = path.join(dir, ISO_NAME);
	});

	afterEach(async function () {
		delete process.env.HEXOS_ALLOW_INSECURE_HTTP;
		await fs.rm(dir, { recursive: true, force: true });
	});

	describe('embedded signing key', function () {
		it('matches the pinned iX fingerprint', async function () {
			expect(TRUSTED_SIGNING_KEYS.map((key) => key.fingerprint)).to.deep.equal([
				IX_FINGERPRINT,
			]);
			const keys = await loadTrustedKeys();
			expect(
				keys.map((key) => key.getFingerprint().toUpperCase()),
			).to.deep.equal([IX_FINGERPRINT]);
		});

		it('is rejected when it does not hash to its pin', async function () {
			const error = await failureOf(
				loadTrustedKeys([
					{
						...TRUSTED_SIGNING_KEYS[0],
						fingerprint: signer.trusted.fingerprint,
					},
				]),
			);
			expect(error.message).to.match(/does not match fingerprint/);
		});
	});

	describe('download', function () {
		it('accepts a binary signature from a trusted key', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const result = await ensure(entryFor(iso));
			expect(result).to.deep.equal({ path: dest, alreadyExisted: false });
			expect((await fs.readFile(dest)).equals(iso)).to.equal(true);
			expect((await fs.readFile(`${dest}.gpg`)).equals(goodSignature)).to.equal(
				true,
			);
			expect(await exists(`${dest}.part`)).to.equal(false);
			expect(hits[0]).to.equal(`/${ISO_NAME}.gpg`);
		});

		it('accepts an armored signature', async function () {
			const armored = await sign(iso, signer, 'armored');
			expect(armored.toString()).to.match(/^-----BEGIN PGP SIGNATURE-----/);
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, { body: armored });
			await ensure(entryFor(iso));
			expect(await exists(dest)).to.equal(true);
		});

		it('accepts a signature from any key in the trusted list', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			await ensure(entryFor(iso), [stranger.trusted, signer.trusted]);
			expect(await exists(dest)).to.equal(true);
		});

		it('refuses a tampered file whose sha256 matches the manifest', async function () {
			routes.set(`/${ISO_NAME}`, { body: otherIso });
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const error = await failureOf(ensure(entryFor(otherIso)));
			expect(error).to.be.instanceOf(SignatureVerificationError);
			expect(error.name).to.equal('SignatureVerificationError');
			await expectNothingKept();
		});

		it('refuses a signature made by an untrusted key', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, {
				body: await sign(iso, stranger, 'binary'),
			});
			const error = await failureOf(ensure(entryFor(iso)));
			expect(error).to.be.instanceOf(SignatureVerificationError);
			expect(hits).to.not.include(`/${ISO_NAME}`);
			await expectNothingKept();
		});

		it('refuses a missing signature before downloading the image', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			const error = await failureOf(ensure(entryFor(iso)));
			expect(error).to.be.instanceOf(SignatureUnavailableError);
			expect(error.name).to.equal('SignatureUnavailableError');
			expect(hits).to.deep.equal([`/${ISO_NAME}.gpg`]);
			await expectNothingKept();
		});

		it('refuses a file that is not a signature', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			for (const body of [
				'<html>not found</html>',
				randomBytes(600),
				signer.trusted.armoredKey,
				randomBytes(200 * 1024),
			]) {
				routes.set(`/${ISO_NAME}.gpg`, { body });
				const error = await failureOf(ensure(entryFor(iso)));
				expect(error).to.be.instanceOf(SignatureVerificationError);
			}
			expect(hits).to.not.include(`/${ISO_NAME}`);
		});

		it('treats a server error fetching the signature as retryable', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, { status: 503 });
			const error = await failureOf(ensure(entryFor(iso)));
			expect(error).to.not.be.instanceOf(SignatureVerificationError);
			expect(error.message).to.match(/HTTP 503/);
		});

		it('still reports a checksum mismatch', async function () {
			routes.set(`/${ISO_NAME}`, { body: otherIso });
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const error = await failureOf(ensure(entryFor(iso)));
			expect(error).to.be.instanceOf(ChecksumMismatchError);
			await expectNothingKept();
		});

		it('uses the fallback mirror when the primary lacks the signature', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/mirror/${ISO_NAME}`, { body: iso });
			routes.set(`/mirror/${ISO_NAME}.gpg`, { body: goodSignature });
			await ensure(
				entryFor(iso, { fallbackUrl: `${secureBase}/mirror/${ISO_NAME}` }),
			);
			expect(hits).to.not.include(`/${ISO_NAME}`);
			expect(await exists(dest)).to.equal(true);
		});

		it('lets signatureUrl add a location', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set('/signatures/test.sig', { body: goodSignature });
			await ensure(
				entryFor(iso, { signatureUrl: `${secureBase}/signatures/test.sig` }),
			);
			expect(await exists(dest)).to.equal(true);
		});

		it('gives the manifest no way to turn verification off', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			for (const extra of [
				{ signatureUrl: '' },
				{ signatureUrl: false },
				{ signatureUrl: null },
				{ verify: false, signature: false, skipSignature: true },
			]) {
				const error = await failureOf(ensure(entryFor(iso, extra as any)));
				expect(error).to.be.instanceOf(SignatureUnavailableError);
			}
			await expectNothingKept();
		});

		it('checks every signature in a file, not just the first', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, {
				body: Buffer.concat([
					await sign(iso, stranger, 'binary'),
					await sign(otherIso, signer, 'binary'),
					goodSignature,
				]),
			});
			await ensure(entryFor(iso));
			expect(await exists(dest)).to.equal(true);
		});

		it('tries signatureUrl when the adjacent signature is the wrong one', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set('/signatures/test.sig', { body: goodSignature });
			for (const body of [
				await sign(iso, stranger, 'binary'),
				await sign(otherIso, signer, 'binary'),
				'<html>oops</html>',
			]) {
				routes.set(`/${ISO_NAME}.gpg`, { body });
				hits.length = 0;
				await ensure(
					entryFor(iso, { signatureUrl: `${secureBase}/signatures/test.sig` }),
				);
				expect(hits.filter((hit) => hit === `/${ISO_NAME}`)).to.have.length(1);
				expect(
					(await fs.readFile(`${dest}.gpg`)).equals(goodSignature),
				).to.equal(true);
				await fs.rm(dest);
				await fs.rm(`${dest}.gpg`);
			}
		});

		it('accepts a signature made by a signing subkey of a trusted key', async function () {
			const withSubkey = await makeKey({ subkeys: [{ sign: true }] });
			const signature = await sign(iso, withSubkey, 'binary');
			const { candidates } = await selectCandidates([signature], {
				trustedKeys: [withSubkey.trusted],
				notBefore: new Date(0),
			});
			expect(candidates).to.have.length(1);
			expect(
				candidates[0].packet.issuerKeyID.equals(
					withSubkey.privateKey.getKeyID(),
				),
			).to.equal(false);
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, { body: signature });
			await ensure(entryFor(iso), [withSubkey.trusted]);
			expect(await exists(dest)).to.equal(true);
		});

		it('refuses a weak or unknown hash algorithm before downloading', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			// byte 6 of a detached RSA-2048 signature is its hash algorithm
			expect([8, 9, 10]).to.include(goodSignature[6]);
			for (const algorithm of [1, 2, 3, 99]) {
				const altered = Buffer.from(goodSignature);
				altered[6] = algorithm;
				routes.set(`/${ISO_NAME}.gpg`, { body: altered });
				const error = await failureOf(ensure(entryFor(iso)));
				expect(error).to.be.instanceOf(SignatureVerificationError);
			}
			expect(hits).to.not.include(`/${ISO_NAME}`);
			await expectNothingKept();
		});

		it('refuses a signature older than the floor before downloading', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
			const error = await failureOf(
				ensure(entryFor(iso), [signer.trusted], tomorrow),
			);
			expect(error).to.be.instanceOf(SignatureVerificationError);
			expect(error.message).to.match(/older than the oldest supported release/);
			expect(hits).to.not.include(`/${ISO_NAME}`);
			expect(DEFAULT_SIGNATURE_POLICY.notBefore).to.equal(
				OLDEST_ACCEPTED_SIGNATURE,
			);
			expect(OLDEST_ACCEPTED_SIGNATURE.toISOString()).to.equal(
				'2024-11-01T00:00:00.000Z',
			);
		});

		it('stops a download that runs past the size in the manifest', async function () {
			routes.set(`/${ISO_NAME}`, {
				body: Buffer.concat([iso, randomBytes(8 * 1024 * 1024)]),
			});
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const error = await failureOf(ensure(entryFor(iso)));
			expect(error.message).to.match(/sent more than/);
			await expectNothingKept();
		});

		it('refuses an oversized manifest', async function () {
			routes.set('/manifest.json', { body: Buffer.alloc(2 * 1024 * 1024, 32) });
			const error = await failureOf(
				fetchManifestFrom(`${secureBase}/manifest.json`),
			);
			expect(error.message).to.match(/larger than/);
		});
	});

	describe('https only', function () {
		it('refuses an http manifest URL', async function () {
			routes.set('/manifest.json', { body: '{}' });
			const error = await failureOf(
				fetchManifestFrom(`${plainBase}/manifest.json`),
			);
			expect(error.message).to.match(/only https is allowed/);
			expect(hits).to.deep.equal([]);
		});

		it('refuses an http image URL', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const error = await failureOf(
				ensure(entryFor(iso, { url: `${plainBase}/${ISO_NAME}` })),
			);
			expect(error.message).to.match(/only https is allowed/);
			expect(hits).to.deep.equal([]);
			await expectNothingKept();
		});

		it('refuses an http signatureUrl', async function () {
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set('/plain.sig', { body: goodSignature });
			const error = await failureOf(
				ensure(entryFor(iso, { signatureUrl: `${plainBase}/plain.sig` })),
			);
			expect(error.message).to.match(/only https is allowed/);
			expect(hits).to.not.include('/plain.sig');
		});

		it('refuses a redirect from https to http', async function () {
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			routes.set(`/${ISO_NAME}`, {
				status: 302,
				location: `${plainBase}/redirected.iso`,
			});
			routes.set('/redirected.iso', { body: iso });
			const error = await failureOf(ensure(entryFor(iso)));
			expect(error.message).to.match(/only https is allowed/);
			expect(hits).to.not.include('/redirected.iso');
			await expectNothingKept();

			routes.set('/manifest.json', {
				status: 301,
				location: `${plainBase}/manifest.json`,
			});
			const manifestError = await failureOf(
				fetchManifestFrom(`${secureBase}/manifest.json`),
			);
			expect(manifestError.message).to.match(/only https is allowed/);
		});

		it('follows a redirect that stays on https', async function () {
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			routes.set(`/${ISO_NAME}`, { status: 302, location: '/cdn/image' });
			routes.set('/cdn/image', { body: iso });
			await ensure(entryFor(iso));
			expect(await exists(dest)).to.equal(true);
		});

		it('allows http only through the environment, and still verifies', async function () {
			process.env.HEXOS_ALLOW_INSECURE_HTTP = '1';
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, {
				body: await sign(iso, stranger, 'binary'),
			});
			const entry = entryFor(iso, { url: `${plainBase}/${ISO_NAME}` });
			expect(await failureOf(ensure(entry))).to.be.instanceOf(
				SignatureVerificationError,
			);
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			await ensure(entry);
			expect(await exists(dest)).to.equal(true);
		});
	});

	describe('existing file', function () {
		it('is reused offline with the signature saved beside it', async function () {
			await fs.writeFile(dest, iso);
			await fs.writeFile(`${dest}.gpg`, goodSignature);
			const result = await ensure(entryFor(iso));
			expect(result.alreadyExisted).to.equal(true);
			expect(hits).to.deep.equal([]);
		});

		it('fetches the signature when none is saved', async function () {
			await fs.writeFile(dest, iso);
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const result = await ensure(entryFor(iso));
			expect(result.alreadyExisted).to.equal(true);
			expect(hits).to.deep.equal([`/${ISO_NAME}.gpg`]);
			expect(await exists(`${dest}.gpg`)).to.equal(true);
		});

		it('falls back to the published signature when the saved one is stale', async function () {
			await fs.writeFile(dest, iso);
			await fs.writeFile(`${dest}.gpg`, await sign(otherIso, signer, 'binary'));
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const result = await ensure(entryFor(iso));
			expect(result.alreadyExisted).to.equal(true);
			expect(hits).to.deep.equal([`/${ISO_NAME}.gpg`]);
		});

		it('never uses a planted file that matches the manifest', async function () {
			await fs.writeFile(dest, otherIso);
			await fs.writeFile(
				`${dest}.gpg`,
				await sign(otherIso, stranger, 'binary'),
			);
			routes.set(`/${ISO_NAME}`, { body: otherIso });
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const error = await failureOf(ensure(entryFor(otherIso)));
			expect(error).to.be.instanceOf(SignatureVerificationError);
			expect(await exists(`${dest}.part`)).to.equal(false);
		});

		it('reports a missing signature for a planted file', async function () {
			await fs.writeFile(dest, otherIso);
			const error = await failureOf(ensure(entryFor(otherIso)));
			expect(error).to.be.instanceOf(SignatureUnavailableError);
			expect(hits).to.not.include(`/${ISO_NAME}`);
		});

		it('is replaced, not blocked on, when its signature does not hold', async function () {
			await fs.writeFile(dest, otherIso);
			await fs.writeFile(`${dest}.gpg`, 'junk');
			const entry = entryFor(iso, {
				fallbackUrl: `${secureBase}/mirror/${ISO_NAME}`,
			});
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, {
				body: await sign(iso, stranger, 'binary'),
			});
			routes.set(`/mirror/${ISO_NAME}`, { body: iso });
			routes.set(`/mirror/${ISO_NAME}.gpg`, { body: goodSignature });
			const result = await ensure(entry);
			expect(result.alreadyExisted).to.equal(false);
			expect((await fs.readFile(dest)).equals(iso)).to.equal(true);
			expect((await fs.readFile(`${dest}.gpg`)).equals(goodSignature)).to.equal(
				true,
			);
		});

		it("is reused with the other mirror's signature", async function () {
			await fs.writeFile(dest, iso);
			routes.set(`/${ISO_NAME}.gpg`, {
				body: await sign(iso, stranger, 'binary'),
			});
			routes.set(`/mirror/${ISO_NAME}.gpg`, { body: goodSignature });
			const result = await ensure(
				entryFor(iso, { fallbackUrl: `${secureBase}/mirror/${ISO_NAME}` }),
			);
			expect(result.alreadyExisted).to.equal(true);
			expect(hits).to.not.include(`/${ISO_NAME}`);
		});

		it('is downloaded again when the signature server is down', async function () {
			await fs.writeFile(dest, iso);
			routes.set(`/${ISO_NAME}.gpg`, { status: 503 });
			const error = await failureOf(ensure(entryFor(iso)));
			expect(error.message).to.match(/HTTP 503/);
			expect((await fs.readFile(dest)).equals(iso)).to.equal(true);
		});

		it('is replaced when its sha256 does not match', async function () {
			await fs.writeFile(dest, otherIso);
			routes.set(`/${ISO_NAME}`, { body: iso });
			routes.set(`/${ISO_NAME}.gpg`, { body: goodSignature });
			const result = await ensure(entryFor(iso));
			expect(result.alreadyExisted).to.equal(false);
			expect((await fs.readFile(dest)).equals(iso)).to.equal(true);
		});
	});

	describe('key policy', function () {
		const check = async (signature: Buffer, trusted: TrustedSigningKey) => {
			const { candidates, reason } = await selectCandidates([signature], {
				trustedKeys: [trusted],
				notBefore: new Date(0),
			});
			if (candidates.length === 0) {
				return reason;
			}
			const started = await startSignatureCheck(candidates);
			started.sink.end(iso);
			return (await started.result()).failure;
		};

		it('accepts a signature made after the embedded key copy expired', async function () {
			const day = 24 * 60 * 60 * 1000;
			const created = new Date(Date.now() - 10 * day);
			const current = await makeKey({ date: created });
			const stale = await openpgp.reformatKey({
				privateKey: current.privateKey,
				userIDs: [{ name: 'Test Signer', email: 'signer@example.invalid' }],
				keyExpirationTime: 3600,
				date: created,
				format: 'object',
			});
			const embedded = {
				...current.trusted,
				armoredKey: stale.publicKey.armor(),
			};
			const [publicKey] = await loadTrustedKeys([embedded]);
			expect(
				((await publicKey.getExpirationTime()) as Date).getTime(),
			).to.be.below(Date.now());

			const signature = await sign(iso, current, 'binary');
			const strict = await openpgp.verify({
				message: await openpgp.createMessage({ binary: new Uint8Array(iso) }),
				signature: await openpgp.readSignature({
					binarySignature: new Uint8Array(signature),
				}),
				verificationKeys: publicKey,
			});
			expect((await failureOf(strict.signatures[0].verified)).message).to.match(
				/expired/i,
			);

			expect(await check(signature, embedded)).to.equal(undefined);
			expect(
				await check(await sign(otherIso, current, 'binary'), embedded),
			).to.match(/digest did not match/i);
		});

		it('rejects a signature that is not over the file', async function () {
			const [publicKey] = await loadTrustedKeys([signer.trusted]);
			const packets = new openpgp.PacketList<openpgp.SignaturePacket>();
			packets.push(publicKey.users[0].selfCertifications[0]);
			const reason = await check(
				Buffer.from(packets.write() as Uint8Array),
				signer.trusted,
			);
			expect(reason).to.match(/not a binary document signature/);
		});

		it('stops taking data when a signature fails before the end', async function () {
			const { candidates } = await selectCandidates([goodSignature], {
				trustedKeys: [signer.trusted],
				notBefore: new Date(0),
			});
			const failing = {
				...candidates[0],
				packet: {
					verify: () => Promise.reject(new Error('refused early')),
				} as any,
			};
			const started = await startSignatureCheck([failing]);
			const stopped = new Promise<Error>((resolve) =>
				started.sink.once('error', resolve),
			);
			started.sink.write(iso);
			expect((await stopped).message).to.equal('refused early');
			expect(started.sink.destroyed).to.equal(true);
			expect((await started.result()).failure).to.be.a('string');
		});

		it('rejects a signature from a revoked key', async function () {
			const key = await makeKey();
			const signature = await sign(iso, key, 'binary');
			expect(await check(signature, key.trusted)).to.equal(undefined);
			const revoked = await openpgp.revokeKey({
				key: key.privateKey,
				format: 'object',
			});
			const reason = await check(signature, {
				...key.trusted,
				armoredKey: revoked.publicKey.armor(),
			});
			expect(reason).to.match(/revoked/i);
		});
	});
});
