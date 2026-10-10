#!/usr/bin/env node
// Launches an etcher-util binary and talks to it the way the GUI does: wait
// for `ready`, answer it and request a drive scan. Passes when the sidecar
// replies with a drive list and then keeps scanning for SETTLE_MS without
// exiting or logging a scanner error. A native module it cannot load makes it
// exit before any of that.
//
// Usage: node scripts/smoke-sidecar.js <etcher-util> [x86_64|arm64]
// The optional arch runs it through `arch` on macOS, x86_64 meaning Rosetta.

const { spawn } = require('child_process');
const net = require('net');

const WebSocketClient = globalThis.WebSocket ?? require('ws');
const TIMEOUT_MS = 90_000;
const SETTLE_MS = 10_000;
const ERROR_MARKERS = ['scanner error', 'Failed to import', 'Error:'];

const [bin, arch] = process.argv.slice(2);
if (!bin) {
	console.error('usage: smoke-sidecar.js <etcher-util> [x86_64|arm64]');
	process.exit(2);
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function main() {
	const port = await freePort();
	const [cmd, args] = arch ? ['arch', [`-${arch}`, bin]] : [bin, []];
	// Minimal env: the sidecar prints its whole environment at startup
	const child = spawn(cmd, args, {
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			TMPDIR: process.env.TMPDIR,
			ETCHER_SERVER_ADDRESS: '127.0.0.1',
			ETCHER_SERVER_PORT: String(port),
		},
	});
	let output = '';
	child.stdout.on('data', (d) => (output += d));
	child.stderr.on('data', (d) => (output += d));

	let done = false;
	const finish = (code, message) => {
		if (done) {
			return;
		}
		done = true;
		(code ? console.error : console.log)(message);
		if (code) {
			console.error(`--- sidecar output ---\n${output}`);
		}
		child.kill();
		process.exit(code);
	};

	child.on('exit', (code, signal) =>
		finish(1, `sidecar exited early (code ${code}, signal ${signal})`),
	);
	setTimeout(
		() => finish(1, `no drive list within ${TIMEOUT_MS / 1000}s`),
		TIMEOUT_MS,
	);

	let settling = false;
	const connect = () => {
		const ws = new WebSocketClient(`ws://127.0.0.1:${port}`);
		const send = (type) => ws.send(JSON.stringify({ type, payload: {} }));
		ws.addEventListener('error', () => {
			if (!done) {
				setTimeout(connect, 500);
			}
		});
		ws.addEventListener('message', (event) => {
			const { type, payload } = JSON.parse(String(event.data));
			if (type === 'ready') {
				send('ready');
				send('scan');
			} else if (type === 'drives' && !settling) {
				// the first list is the cached one, sent before enumeration runs
				settling = true;
				setTimeout(() => {
					const marker = ERROR_MARKERS.find((m) => output.includes(m));
					if (marker) {
						finish(1, `sidecar logged "${marker}" while scanning`);
					} else {
						finish(
							0,
							`sidecar answered a scan and ran ${SETTLE_MS / 1000}s without errors`,
						);
					}
				}, SETTLE_MS);
			} else if (type === 'error' || type === 'fail') {
				finish(1, `sidecar reported ${type}: ${JSON.stringify(payload)}`);
			}
		});
	};
	connect();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
