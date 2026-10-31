/**
 * Minimum macOS guard for everything the app ships.
 *
 * Electron, the Node runtime inside etcher-util and the native modules each
 * record the oldest macOS they run on. The highest of those is the app's real
 * floor, and nothing else enforces it: a module compiled with a newer
 * deployment target loads fine on the build runner and fails on an older Mac.
 * This reads the floor from every Mach-O slice for the target arch, in the
 * paths given and in the native modules pkg embeds in etcher-util (which are
 * inside its snapshot, not on disk in the .app), and fails above the maximum.
 *
 * Usage: ts-node macos-min.ts <arch> <max version> [path...]
 */

import * as fs from 'fs';
import * as path from 'path';

import { findLoadedNatives, MACHO_CPU } from './native-arch';

const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;

interface Slice {
	arch: string;
	/** undefined when the slice records no macOS minimum */
	minos?: string;
}

function readAt(fd: number, offset: number, size: number): Buffer {
	const b = Buffer.alloc(size);
	return b.subarray(0, fs.readSync(fd, b, 0, size, offset));
}

function formatVersion(v: number): string {
	const patch = v & 0xff;
	return `${v >>> 16}.${(v >>> 8) & 0xff}${patch ? `.${patch}` : ''}`;
}

/** A thin Mach-O image starting at `offset`; undefined if there is none. */
function readThin(fd: number, offset: number): Slice | undefined {
	const header = readAt(fd, offset, 32);
	if (header.length < 28) {
		return undefined;
	}
	const magic = header.readUInt32LE(0);
	if (magic !== 0xfeedfacf && magic !== 0xfeedface) {
		return undefined;
	}
	const headerSize = magic === 0xfeedfacf ? 32 : 28;
	const ncmds = header.readUInt32LE(16);
	const cmds = readAt(fd, offset + headerSize, header.readUInt32LE(20));
	const slice: Slice = { arch: MACHO_CPU[header.readUInt32LE(4)] ?? 'unknown' };
	for (let i = 0, at = 0; i < ncmds && at + 8 <= cmds.length; i++) {
		const cmd = cmds.readUInt32LE(at);
		const size = cmds.readUInt32LE(at + 4);
		if (size < 8) {
			break;
		}
		if (
			cmd === LC_BUILD_VERSION &&
			at + 16 <= cmds.length &&
			cmds.readUInt32LE(at + 8) === PLATFORM_MACOS
		) {
			slice.minos = formatVersion(cmds.readUInt32LE(at + 12));
		} else if (cmd === LC_VERSION_MIN_MACOSX && at + 12 <= cmds.length) {
			slice.minos = formatVersion(cmds.readUInt32LE(at + 8));
		}
		at += size;
	}
	return slice;
}

/** Every slice of a thin or fat Mach-O; empty for any other file. */
export function readSlices(file: string): Slice[] {
	const fd = fs.openSync(file, 'r');
	try {
		const head = readAt(fd, 0, 8);
		if (head.length < 8) {
			return [];
		}
		const magic = head.readUInt32BE(0);
		if (magic === 0xcafebabe || magic === 0xcafebabf) {
			// 0xcafebabe is also a Java class file, whose second word is a
			// version far above any real slice count
			const count = head.readUInt32BE(4);
			if (count === 0 || count > 32) {
				return [];
			}
			const wide = magic === 0xcafebabf;
			const entrySize = wide ? 32 : 20;
			const table = readAt(fd, 8, count * entrySize);
			const slices: Slice[] = [];
			for (let i = 0; i < count; i++) {
				const e = i * entrySize;
				const offset = wide
					? Number(table.readBigUInt64BE(e + 8))
					: table.readUInt32BE(e + 8);
				const slice = readThin(fd, offset);
				if (slice) {
					slices.push(slice);
				}
			}
			return slices;
		}
		const slice = readThin(fd, 0);
		return slice ? [slice] : [];
	} finally {
		fs.closeSync(fd);
	}
}

function parseVersion(v: string): number[] {
	return v.split('.').map((n) => parseInt(n, 10) || 0);
}

function isAbove(version: string, max: string): boolean {
	const a = parseVersion(version);
	const b = parseVersion(max);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) {
			return (a[i] ?? 0) > (b[i] ?? 0);
		}
	}
	return false;
}

/** Regular files under `p`. Symlinks are skipped: bundles link to their own files. */
function walk(p: string, found: string[] = []): string[] {
	const stat = fs.lstatSync(p);
	if (stat.isDirectory()) {
		for (const entry of fs.readdirSync(p)) {
			walk(path.join(p, entry), found);
		}
	} else if (stat.isFile()) {
		found.push(p);
	}
	return found;
}

export interface FloorProblem {
	file: string;
	problem: string;
}

/**
 * Mach-O files that would stop the target from running on `max`. A native
 * module is checked even when it is not Mach-O, because the target loads it.
 */
export function findFloorProblems(
	files: string[],
	natives: string[],
	arch: string,
	max: string,
): FloorProblem[] {
	const problems: FloorProblem[] = [];
	const nativeSet = new Set(natives);
	for (const file of new Set([...files, ...natives])) {
		const slices = readSlices(file);
		if (slices.length === 0) {
			if (nativeSet.has(file)) {
				problems.push({ file, problem: 'not a Mach-O binary' });
			}
			continue;
		}
		const slice = slices.find((s) => s.arch === arch);
		if (slice == null) {
			problems.push({
				file,
				problem: `no ${arch} slice (has ${slices.map((s) => s.arch).join('+')})`,
			});
		} else if (slice.minos == null) {
			problems.push({ file, problem: 'records no macOS minimum' });
		} else if (isAbove(slice.minos, max)) {
			problems.push({ file, problem: `needs macOS ${slice.minos}` });
		}
	}
	return problems;
}

if (require.main === module) {
	const [arch, max, ...paths] = process.argv.slice(2);
	if (!arch || !max) {
		console.error('usage: macos-min.ts <arch> <max version> [path...]');
		process.exit(2);
	}
	const files = paths.flatMap((p) => walk(p));
	const natives = findLoadedNatives('darwin', arch);
	const problems = findFloorProblems(files, natives, arch, max);
	if (problems.length > 0) {
		console.error(`Binaries that would not run on macOS ${max} (${arch}):`);
		for (const { file, problem } of problems) {
			console.error(`  ${path.relative(process.cwd(), file)}: ${problem}`);
		}
		process.exit(1);
	}
	console.log(
		`${files.length} files and ${natives.length} native modules run on macOS ${max} (${arch})`,
	);
}
