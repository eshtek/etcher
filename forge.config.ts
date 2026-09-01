import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDMG } from '@electron-forge/maker-dmg';
// import { MakerAppImage } from '@reforged/maker-appimage';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { exec } from 'child_process';

import { resolve } from 'path';

import { mainConfig, rendererConfig } from './webpack.config';
import * as sidecar from './forge.sidecar';

import { hostDependencies, productDescription } from './package.json';

const osxSigningConfig: any = {};
let winSigningConfig: any = {};

if (process.env.NODE_ENV === 'production') {
	// Prefer an App Store Connect API key. notarytool takes an app-specific
	// password as a command-line argument, which puts it in `ps` output for
	// every user on the machine and anywhere else a process list is captured.
	// The API key is read from a file instead, so the secret never appears in
	// argv. The password path stays as a fallback for machines that only have
	// one set up.
	osxSigningConfig.osxNotarize = process.env.APPLE_API_KEY
		? {
				tool: 'notarytool',
				appleApiKey: process.env.APPLE_API_KEY,
				appleApiKeyId: process.env.APPLE_API_KEY_ID,
				appleApiIssuer: process.env.APPLE_API_ISSUER,
			}
		: {
				tool: 'notarytool',
				appleId: process.env.XCODE_APP_LOADER_EMAIL,
				appleIdPassword: process.env.XCODE_APP_LOADER_PASSWORD,
				teamId: process.env.XCODE_APP_LOADER_TEAM_ID,
			};

	// Azure Artifact Signing: the key never leaves Microsoft's HSM, so signtool
	// is driven through the Azure dlib rather than a local certificate. Every
	// path handed to signtool must be free of spaces or it fails opaquely.
	// Keep /v /debug so timestamping warnings actually surface in the log.
	if (process.platform === 'win32') {
		winSigningConfig = {
			windowsSign: {
				signToolPath: process.env.SIGNTOOL_PATH,
				signWithParams: `/v /debug /dlib ${process.env.AZURE_CODE_SIGNING_DLIB} /dmdf ${process.env.AZURE_METADATA_JSON}`,
				timestampServer: 'http://timestamp.acs.microsoft.com',
				hashes: ['sha256'],
			},
		};
	}
}

const config: ForgeConfig = {
	packagerConfig: {
		asar: true,
		icon: './assets/icon',
		executableName:
			process.platform === 'linux' ? 'hexos-imager' : 'HexOS Imager',
		appBundleId: 'com.hexos.imager',
		appCategoryType: 'public.app-category.utilities',
		appCopyright: 'Copyright 2026 Eshtek Inc.',
		darwinDarkModeSupport: true,
		protocols: [{ name: 'hexos-imager', schemes: ['hexos-imager'] }],
		extraResource: [
			'lib/shared/sudo/sudo-askpass.osascript-zh.js',
			'lib/shared/sudo/sudo-askpass.osascript-en.js',
		],
		osxSign: {
			optionsForFile: () => ({
				entitlements: './entitlements.mac.plist',
				hardenedRuntime: true,
			}),
		},
		...osxSigningConfig,
		// Signs the packaged .exe. MakerSquirrel signs the installer separately;
		// both are needed or the app inside a signed installer stays unsigned.
		...winSigningConfig,
	},
	rebuildConfig: {
		onlyModules: [], // prevent rebuilding *any* native modules as they won't be used by electron but by the sidecar
	},
	makers: [
		new MakerZIP(),
		new MakerSquirrel({
			setupIcon: 'assets/icon.ico',
			// Squirrel shows this at its native size while installing, so the
			// 1024x1024 app icon filled most of the screen for a couple of
			// seconds. This is the same mark on a 640x480 canvas.
			loadingGif: 'assets/install-splash.png',
			// Programs and Features reads this one, and electron-winstaller
			// defaults it to Electron's own icon — which is why the entry
			// showed a stray Electron logo. It has to be a URL rather than a
			// path, so it points at the icon in this repo; tracking the branch
			// means updating assets/icon.ico is enough to update it.
			iconUrl:
				'https://raw.githubusercontent.com/eshtek/etcher/feature/hexos-imager/assets/icon.ico',
			...winSigningConfig,
		}),
		new MakerDMG({
			// Absolute paths: appdmg resolves relative paths against its
			// generated spec file, silently falling back to its default
			// background/icon. The .png background lets appdmg pick up the
			// @2x sibling for retina.
			background: resolve(__dirname, 'assets/dmg/background.png'),
			icon: resolve(__dirname, 'assets/icon.icns'),
			iconSize: 110,
			contents: ((opts: { appPath: string }) => {
				return [
					{ x: 140, y: 250, type: 'file', path: opts.appPath },
					{ x: 415, y: 250, type: 'link', path: '/Applications' },
					// park the DMG's hidden housekeeping files outside the
					// window so they don't clobber the background for users
					// who show hidden files
					{ x: 900, y: 250, type: 'position', path: '.background' },
					{ x: 900, y: 250, type: 'position', path: '.VolumeIcon.icns' },
					{ x: 900, y: 250, type: 'position', path: '.DS_Store' },
				];
			}) as any, // type of MakerDMGConfig omits `appPath`
			additionalDMGOptions: {
				window: {
					size: {
						width: 540,
						height: 425,
					},
					position: {
						x: 400,
						y: 500,
					},
				},
			},
		}),
		// new MakerAppImage({
		// 	options: {
		// 		icon: './assets/icon.png',
		// 		categories: ['Utility'],
		// 	},
		// }),
		new MakerRpm({
			options: {
				icon: './assets/icon.png',
				categories: ['Utility'],
				productDescription,
				requires: ['util-linux'],
			},
		}),
		new MakerDeb({
			options: {
				icon: './assets/icon.png',
				categories: ['Utility'],
				section: 'utils',
				priority: 'optional',
				productDescription,
				scripts: {
					postinst: './after-install.tpl',
				},
				depends: hostDependencies['debian'],
			},
		}),
	],
	plugins: [
		new AutoUnpackNativesPlugin({}),
		new WebpackPlugin({
			mainConfig,
			renderer: {
				config: rendererConfig,
				nodeIntegration: true,
				entryPoints: [
					{
						html: './lib/gui/app/index.html',
						js: './lib/gui/app/renderer.ts',
						name: 'main_window',
						preload: {
							js: './lib/gui/app/preload.ts',
						},
					},
				],
			},
		}),
		new sidecar.SidecarPlugin(),
	],
	hooks: {
		postPackage: async (_forgeConfig, options) => {
			if (options.platform === 'linux') {
				// symlink the binary under the old balenaEtcher name to ensure compatibility with the wdio suite
				await new Promise<void>((resolve, reject) => {
					exec(
						`ln -s "${options.outputPaths}/hexos-imager" "${options.outputPaths}/balenaEtcher"`,
						(err) => {
							if (err) {
								reject(err);
							} else {
								resolve();
							}
						},
					);
				});
			}
		},
	},
};

export default config;
