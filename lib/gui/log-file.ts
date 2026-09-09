/*
 * Session log written to disk.
 *
 * Field reports used to arrive as screenshots of an error dialog, because the
 * only record of what happened lived in a DevTools console the user had to be
 * talked into opening. Everything the app already prints now also lands in a
 * file that can be attached to a bug report.
 *
 * Renderer output is included: the interesting lines during startup — sidecar
 * connection attempts, CHILD LOG messages, manifest resolution — are all
 * console calls from the renderer, so they are forwarded here rather than
 * rewritten to use a logger.
 */

import * as electron from 'electron';
import { createWriteStream, mkdirSync, renameSync, statSync } from 'fs';
import type { WriteStream } from 'fs';
import { join } from 'path';

import { LOG_FILE_NAME } from '../shared/log-file-name';

/** Rotate once the file passes this, keeping one previous generation. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let stream: WriteStream | undefined;
let logFilePath: string | undefined;

function timestamp(): string {
	return new Date().toISOString();
}

/**
 * Console arguments arrive as arbitrary values; render them the way the
 * console would rather than JSON, so an Error keeps its stack.
 */
function render(args: unknown[]): string {
	return args
		.map((arg) => {
			if (typeof arg === 'string') {
				return arg;
			}
			if (arg instanceof Error) {
				return arg.stack ?? `${arg.name}: ${arg.message}`;
			}
			try {
				return JSON.stringify(arg);
			} catch {
				// Circular structures, mostly.
				return String(arg);
			}
		})
		.join(' ');
}

function write(level: string, text: string) {
	stream?.write(`${timestamp()} [${level}] ${text}\n`);
}

/**
 * Absolute path of the current log file, or undefined if logging could not be
 * started. Callers use this to show the user where to find it.
 */
export function getLogFilePath(): string | undefined {
	return logFilePath;
}

/** Reveal the log in the OS file manager. No-op when logging is unavailable. */
export function showLogFile() {
	if (logFilePath !== undefined) {
		electron.shell.showItemInFolder(logFilePath);
	}
}

/**
 * Start writing to disk and mirror both processes' console output into it.
 *
 * Safe to call once the app is ready. Any failure here is swallowed: losing
 * logs is not a reason to stop the app from starting.
 */
export function initLogFile() {
	if (stream !== undefined) {
		return;
	}
	try {
		const dir = electron.app.getPath('logs');
		mkdirSync(dir, { recursive: true });
		const target = join(dir, LOG_FILE_NAME);

		try {
			if (statSync(target).size > MAX_LOG_BYTES) {
				renameSync(target, `${target}.1`);
			}
		} catch {
			// No existing log, or it cannot be rotated. Either way, append.
		}

		stream = createWriteStream(target, { flags: 'a' });
		logFilePath = target;
	} catch {
		// getPath('logs') can throw before the app is ready, and the directory
		// may be unwritable. Carry on without a log file.
		return;
	}

	const { app } = electron;
	write(
		'info',
		`=== ${app.getName()} ${app.getVersion()} started on ${process.platform} ${process.arch} (electron ${process.versions.electron}) ===`,
	);

	patchConsole();
}

/**
 * Tee the main process console to the file. The original methods still run so
 * a terminal-launched build behaves as before.
 */
function patchConsole() {
	const levels = ['log', 'info', 'warn', 'error'] as const;
	for (const level of levels) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			write(level, render(args));
			original(...args);
		};
	}
}

/** The pre-Electron-35 event passed the level as an index into this. */
const RENDERER_LEVELS = ['verbose', 'info', 'warn', 'error'];

/**
 * Forward a window's console output into the log file.
 *
 * Electron 35 changed `console-message` from positional arguments to a single
 * event object, so both shapes are accepted: getting this wrong does not fail
 * loudly, it quietly writes "undefined" for every line, which is worse than
 * having no log at all.
 */
export function captureRendererConsole(webContents: electron.WebContents) {
	if (stream === undefined) {
		return;
	}
	webContents.on('console-message' as any, (...args: any[]) => {
		let level: string | number | undefined;
		let message: string | undefined;
		let line: number | undefined;
		let sourceId: string | undefined;

		const first = args[0];
		if (args.length === 1 && first !== null && typeof first === 'object') {
			({ level, message, lineNumber: line, sourceId } = first);
		} else {
			[, level, message, line, sourceId] = args;
		}

		const name =
			typeof level === 'number'
				? (RENDERER_LEVELS[level] ?? 'info')
				: (level ?? 'info');
		// sourceId is a webpack bundle path; the basename is enough to tell
		// renderer entry points apart without a line of noise per message.
		const source = sourceId ? sourceId.split('/').pop() : undefined;
		const where = source ? ` (${source}:${line})` : '';
		write(`renderer:${name}`, `${message ?? ''}${where}`);
	});
}
