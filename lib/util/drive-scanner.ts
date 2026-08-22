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

import * as sdk from 'etcher-sdk';
import type { Adapter } from 'etcher-sdk/build/scanner/adapters';
import {
	BlockDeviceAdapter,
	UsbbootDeviceAdapter,
} from 'etcher-sdk/build/scanner/adapters';
import { geteuid, platform } from 'process';

const adapters: Adapter[] = [
	new BlockDeviceAdapter({
		includeSystemDrives: () => true,
	}),
];

// Can't use permissions.isElevated() here as it returns a promise and we need to set
// module.exports = scanner right now.
if (platform !== 'linux' || (geteuid && geteuid() === 0)) {
	adapters.push(new UsbbootDeviceAdapter());
}

if (platform === 'win32') {
	// DriverlessDeviceAdapter requires winusb-driver-generator lazily, from
	// inside its scan loop. That module is an optionalDependency and a native
	// addon, and it is absent from these builds — pkg says so at build time
	// ("Cannot find module 'winusb-driver-generator'"). Because the require
	// happens asynchronously inside scanLoop, no try/catch here can catch it:
	// it surfaces as an uncaughtException, which the sidecar handles by
	// terminating. The listener closes, the process wedges in cleanup, and
	// every later request goes unanswered with no error — the client just
	// waits forever.
	//
	// So only register the adapter when the module it needs is actually
	// present. It detects Raspberry Pi compute modules in USB boot mode, which
	// is not something HexOS Imager flashes.
	try {
		require.resolve('winusb-driver-generator');
		const {
			DriverlessDeviceAdapter: driverless,
		} = require('etcher-sdk/build/scanner/adapters/driverless');
		adapters.push(new driverless());
	} catch {
		// winusb-driver-generator unavailable: skip driverless device scanning
	}
}

export const scanner = new sdk.scanner.Scanner(adapters);
