/*
 * Copyright 2016 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as electron from 'electron';
import * as remote from '@electron/remote';
import type { Dictionary } from 'lodash';
import { debounce, capitalize, values } from 'lodash';
import outdent from 'outdent';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { v4 as uuidV4 } from 'uuid';

import * as packageJSON from '../../../package.json';
import type { DrivelistDrive } from '../../shared/drive-constraints';
import * as EXIT_CODES from '../../shared/exit-codes';
import * as messages from '../../shared/messages';
import * as availableDrives from './models/available-drives';
import * as flashState from './models/flash-state';
import * as settings from './models/settings';
import { Actions, observe, store } from './models/store';
import * as analytics from './modules/analytics';
import { spawnChildAndConnect } from './modules/api';
import * as exceptionReporter from './modules/exception-reporter';
import * as osDialog from './os/dialog';
import * as windowProgress from './os/window-progress';
import MainPage from './pages/main/MainPage';
import './css/main.css';
import * as i18next from 'i18next';
import type { SourceMetadata } from '../../shared/typings/source-selector';

window.addEventListener(
	'unhandledrejection',
	(event: PromiseRejectionEvent | any) => {
		// Promise: event.reason
		// Anything else: event
		const error = event.reason || event;
		analytics.logException(error);
		event.preventDefault();
	},
);

// Set application session UUID
store.dispatch({
	type: Actions.SET_APPLICATION_SESSION_UUID,
	data: uuidV4(),
});

// Set first flashing workflow UUID
store.dispatch({
	type: Actions.SET_FLASHING_WORKFLOW_UUID,
	data: uuidV4(),
});

console.log(outdent`
	${outdent}
	HexOS Imager
	https://hexos.com

	Version = ${packageJSON.version}, Type = ${packageJSON.packageType}
`);

const debouncedLog = debounce(console.log, 1000, { maxWait: 1000 });

function pluralize(word: string, quantity: number) {
	return `${quantity} ${word}${quantity === 1 ? '' : 's'}`;
}

observe(() => {
	if (!flashState.isFlashing()) {
		return;
	}
	const currentFlashState = flashState.getFlashState();
	windowProgress.set(currentFlashState);

	let eta = '';
	if (currentFlashState.eta !== undefined) {
		eta = `eta in ${currentFlashState.eta.toFixed(0)}s`;
	}
	let active = '';
	if (currentFlashState.type !== 'decompressing') {
		active = pluralize('device', currentFlashState.active);
	}
	// NOTE: There is usually a short time period between the `isFlashing()`
	// property being set, and the flashing actually starting, which
	// might cause some non-sense flashing state logs including
	// `undefined` values.
	debouncedLog(outdent({ newline: ' ' })`
		${capitalize(currentFlashState.type)}
		${active},
		${currentFlashState.percentage}%
		at
		${(currentFlashState.speed || 0).toFixed(2)}
		MB/s
		(total ${(currentFlashState.speed * currentFlashState.active).toFixed(2)} MB/s)
		${eta}
		with
		${pluralize('failed device', currentFlashState.failed)}
	`);
});

function setDrives(drives: Dictionary<DrivelistDrive>) {
	// prevent setting drives while flashing otherwise we might lose some while we unmount them
	if (!flashState.isFlashing()) {
		availableDrives.setDrives(values(drives));
	}
}

// Spawning the child process without privileges to get the drives list
// TODO: clean up this mess of exports
export let requestMetadata: any;

/** How long to wait for the sidecar to return image metadata. */
const SOURCE_METADATA_TIMEOUT_MS = 120000;

/**
 * Ask the sidecar to download and verify an image.
 *
 * The download runs there rather than here because Node's event loop in a
 * renderer is multiplexed with Chromium's, which cost about two thirds of the
 * available throughput. Progress arrives as `downloadProgress` messages.
 */
export let requestImageDownload:
	| ((
			entry: unknown,
			destPath: string,
			onProgress: (progress: any) => void,
			abortSignal?: AbortSignal,
	  ) => Promise<{ path: string; alreadyExisted: boolean }>)
	| undefined;

// start the api and spawn the child process
spawnChildAndConnect({
	withPrivileges: false,
})
	.then(({ emit, registerHandler }) => {
		// start scanning
		emit('scan', {});

		// When reading an image fails, the sidecar reports it on a separate
		// `fail` channel rather than answering `sourceMetadata`. Nothing was
		// listening for it, so the router hit its "Unknown message type" branch
		// and threw inside the socket callback, where the error went nowhere —
		// turning a perfectly reportable failure into an indefinite hang.
		// Route it to whichever metadata request is in flight.
		let failPendingMetadata: ((error: Error) => void) | undefined;

		registerHandler('fail', (data: any) => {
			const error =
				data instanceof Error
					? data
					: new Error(
							data?.message ?? `The image reader failed: ${JSON.stringify(data)}`,
						);
			if (failPendingMetadata !== undefined) {
				failPendingMetadata(error);
			} else {
				console.error('Sidecar reported a failure with no request in flight:', error);
			}
		});

		// make the sourceMetada awaitable to be used on source selection
		//
		// The deadline covers the other way this stalls: the sidecar accepting
		// a request and going silent, without even a `fail` — it dies mid-read,
		// or something outside the app blocks it from reading the image. The
		// budget is generous because metadata for a compressed image can
		// require scanning the whole archive; it exists to bound a hang, not to
		// police slow reads.
		requestMetadata = async (params: any): Promise<SourceMetadata> => {
			emit('sourceMetadata', JSON.stringify(params));

			return new Promise((resolve, reject) => {
				let timeout: ReturnType<typeof setTimeout>;
				const settle = () => {
					clearTimeout(timeout);
					failPendingMetadata = undefined;
				};

				timeout = setTimeout(() => {
					settle();
					reject(
						new Error(
							`No response from the image reader after ${
								SOURCE_METADATA_TIMEOUT_MS / 1000
							}s.`,
						),
					);
				}, SOURCE_METADATA_TIMEOUT_MS);

				failPendingMetadata = (error: Error) => {
					settle();
					reject(error);
				};

				registerHandler('sourceMetadata', (data: any) => {
					settle();
					resolve(JSON.parse(data));
				});
			});
		};

		requestImageDownload = async (entry, destPath, onProgress, abortSignal) => {
			return new Promise((resolve, reject) => {
				const onAbort = () => emit('cancelDownload', {});
				const settle = () => {
					abortSignal?.removeEventListener('abort', onAbort);
					registerHandler('downloadProgress', () => undefined);
					registerHandler('downloadDone', () => undefined);
					registerHandler('downloadError', () => undefined);
				};

				registerHandler('downloadProgress', (data: any) => {
					onProgress(JSON.parse(data));
				});
				registerHandler('downloadDone', (data: any) => {
					settle();
					resolve(JSON.parse(data));
				});
				registerHandler('downloadError', (data: any) => {
					settle();
					const { name, message } = JSON.parse(data);
					const error = new Error(message);
					// Preserve the distinction the caller acts on: a checksum
					// mismatch is a bad publish and must not be retried.
					error.name = name ?? 'Error';
					reject(error);
				});

				abortSignal?.addEventListener('abort', onAbort, { once: true });
				emit('downloadImage', JSON.stringify({ entry, destPath }));
			});
		};

		registerHandler('drives', (data: any) => {
			setDrives(JSON.parse(data));
		});
	})
	.catch((error: any) => {
		throw new Error(`Failed to start the flasher process. error: ${error}`);
	});

let popupExists = false;

analytics.initAnalytics();

window.addEventListener('beforeunload', async (event) => {
	if (!flashState.isFlashing() || popupExists) {
		return;
	}

	// Don't close window while flashing
	event.returnValue = false;

	// Don't open any more popups
	popupExists = true;

	try {
		const confirmed = await osDialog.showWarning({
			confirmationLabel: i18next.t('yesExit'),
			rejectionLabel: i18next.t('cancel'),
			title: i18next.t('reallyExit'),
			description: messages.warning.exitWhileFlashing(),
		});
		if (confirmed) {
			// This circumvents the 'beforeunload' event unlike
			// remote.app.quit() which does not.
			remote.process.exit(EXIT_CODES.SUCCESS);
		}

		popupExists = false;
	} catch (error: any) {
		exceptionReporter.report(error);
	}
});

export async function main() {
	try {
		const { init: ledsInit } = require('./models/leds');
		await ledsInit();
	} catch (error: any) {
		exceptionReporter.report(error);
	}

	ReactDOM.render(
		React.createElement(MainPage),
		document.getElementById('main'),
		// callback to set the correct zoomFactor for webviews as well
		async () => {
			const fullscreen = await settings.get('fullscreen');
			const width = fullscreen ? window.screen.width : window.outerWidth;
			try {
				electron.webFrame.setZoomFactor(width / settings.DEFAULT_WIDTH);
			} catch (err) {
				// noop
			}
		},
	);
}
