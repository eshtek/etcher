/**
 * Architecture guard for the native modules the sidecar can embed.
 *
 * pkg copies whatever .node files it finds into etcher-util and never checks
 * them against the target, so a cross-arch build can embed host binaries that
 * fail to load on the user's machine.
 *
 * Usage: ts-node native-arch.ts <platform> <arch>
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MACHO_CPU: Record<number, string> = {
	0x7: 'ia32',
	0xc: 'arm',
	0x01000007: 'x64',
	0x0100000c: 'arm64',
};
const ELF_MACHINE: Record<number, string> = {
	0x03: 'ia32',
	0x28: 'arm',
	0x3e: 'x64',
	0xb7: 'arm64',
};
const PE_MACHINE: Record<number, string> = {
	0x014c: 'ia32',
	0x01c4: 'arm',
	0x8664: 'x64',
	0xaa64: 'arm64',
};

interface BinaryInfo {
	platform: string;
	archs: string[];
}

function readHead(file: string, size: number): Buffer {
	const fd = fs.openSync(file, 'r');
	try {
		const b = Buffer.alloc(size);
		return b.subarray(0, fs.readSync(fd, b, 0, size, 0));
	} finally {
		fs.closeSync(fd);
	}
}

/** Platform and architectures of a Mach-O, ELF or PE binary, from its headers. */
export function readBinaryInfo(file: string): BinaryInfo | undefined {
	const b = readHead(file, 4096);
	if (b.length < 64) {
		return undefined;
	}
	const magic = b.readUInt32BE(0);
	if (magic === 0xcafebabe || magic === 0xcafebabf) {
		const entrySize = magic === 0xcafebabe ? 20 : 32;
		const count = b.readUInt32BE(4);
		if (count === 0 || 8 + count * entrySize > b.length) {
			return undefined;
		}
		const archs: string[] = [];
		for (let i = 0; i < count; i++) {
			archs.push(MACHO_CPU[b.readUInt32BE(8 + i * entrySize)] ?? 'unknown');
		}
		return { platform: 'darwin', archs };
	}
	if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
		return {
			platform: 'darwin',
			archs: [MACHO_CPU[b.readUInt32LE(4)] ?? 'unknown'],
		};
	}
	if (magic === 0x7f454c46) {
		const machine = b[5] === 1 ? b.readUInt16LE(18) : b.readUInt16BE(18);
		return { platform: 'linux', archs: [ELF_MACHINE[machine] ?? 'unknown'] };
	}
	if (b.readUInt16LE(0) === 0x5a4d) {
		const pe = b.readUInt32LE(0x3c);
		// e_lfanew can point past the 4 KB read; that reads as unrecognized
		if (pe + 6 <= b.length && b.readUInt32LE(pe) === 0x4550) {
			return {
				platform: 'win32',
				archs: [PE_MACHINE[b.readUInt16LE(pe + 4)] ?? 'unknown'],
			};
		}
	}
	return undefined;
}

/** Directories of every installed production dependency. */
function productionPackageDirs(root: string): string[] {
	let out: string;
	try {
		out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
			cwd: root,
			encoding: 'utf8',
			shell: true,
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error: any) {
		// npm ls exits non-zero over a missing optional dependency (e.g.
		// winusb-driver-generator off Windows) but still lists the tree
		out = error.stdout ?? '';
	}
	const dirs = new Set(
		out
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && path.resolve(line) !== path.resolve(root)),
	);
	if (dirs.size === 0) {
		throw new Error('npm ls listed no production dependencies');
	}
	return [...dirs];
}

function findNodeFiles(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// nested packages are listed separately by npm ls
			if (entry.name !== 'node_modules') {
				findNodeFiles(full, found);
			}
		} else if (entry.isFile() && entry.name.endsWith('.node')) {
			found.push(full);
		}
	}
	return found;
}

/**
 * node-gyp-build loads build/Release before it looks at prebuilds, and only
 * picks a prebuilds/<platform>-<arch>[+<arch>]/ directory matching the
 * running process. Returns false for binaries the target will never load.
 * `rel` is relative to the package directory.
 */
function isLoadedOn(
	rel: string,
	pkgHasBuild: boolean,
	platform: string,
	arch: string,
): boolean {
	const parts = rel.split(path.sep);
	const i = parts.indexOf('prebuilds');
	if (i === -1) {
		return true;
	}
	// a file directly in prebuilds/ sits in no platform directory
	if (pkgHasBuild || parts.length < i + 3) {
		return false;
	}
	const match = /^([a-z0-9]+)-(.+)$/.exec(parts[i + 1]);
	return (
		match != null && match[1] === platform && match[2].split('+').includes(arch)
	);
}

export interface Mismatch {
	/** npm name of the package that ships the binary */
	pkg: string;
	file: string;
	found: string;
}

/** Native binaries the target would load that are not built for it. */
export function findMismatchedNatives(
	platform: string,
	arch: string,
	root = process.cwd(),
): Mismatch[] {
	return findMismatchedIn(productionPackageDirs(root), platform, arch, root);
}

export function findMismatchedIn(
	packageDirs: string[],
	platform: string,
	arch: string,
	root: string,
): Mismatch[] {
	const mismatched: Mismatch[] = [];
	for (const dir of packageDirs) {
		if (!fs.existsSync(dir)) {
			continue;
		}
		const files = findNodeFiles(dir).map((f) => path.relative(dir, f));
		const buildDir = path.join('build', 'Release') + path.sep;
		const pkgHasBuild = files.some((rel) => rel.startsWith(buildDir));
		for (const rel of files) {
			if (!isLoadedOn(rel, pkgHasBuild, platform, arch)) {
				continue;
			}
			const file = path.join(dir, rel);
			const info = readBinaryInfo(file);
			if (info?.platform !== platform || !info.archs.includes(arch)) {
				const pkgJson = path.join(dir, 'package.json');
				mismatched.push({
					pkg: JSON.parse(fs.readFileSync(pkgJson, 'utf8')).name,
					file: path.relative(root, file),
					found: info
						? `${info.platform}/${info.archs.join('+')}`
						: 'unrecognized',
				});
			}
		}
	}
	return mismatched;
}

export function assertNativeArch(platform: string, arch: string) {
	const mismatched = findMismatchedNatives(platform, arch);
	if (mismatched.length > 0) {
		const list = mismatched.map((m) => `${m.file} (${m.found})`);
		throw new Error(
			`Native modules not built for ${platform}/${arch}:\n  ${list.join('\n  ')}`,
		);
	}
	console.log(`native modules match ${platform}/${arch}`);
}

if (require.main === module) {
	const [platform = process.platform, arch = process.arch] =
		process.argv.slice(2);
	try {
		assertNativeArch(platform, arch);
	} catch (error: any) {
		console.error(error.message);
		process.exit(1);
	}
}
