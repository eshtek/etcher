import { PluginBase } from '@electron-forge/plugin-base';
import type {
	ForgeMultiHookMap,
	ResolvedForgeConfig,
} from '@electron-forge/shared-types';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { DefinePlugin } from 'webpack';

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import debug from 'debug';

const log = debug('sidecar');

function isStartScrpt(): boolean {
	return process.env.npm_lifecycle_event === 'start';
}

function addWebpackDefine(
	config: ResolvedForgeConfig,
	defineName: string,
	binDir: string,
	binName: string,
): ResolvedForgeConfig {
	config.plugins.forEach((plugin) => {
		if (plugin.name !== 'webpack' || !(plugin instanceof WebpackPlugin)) {
			return;
		}

		const { mainConfig } = plugin.config as any;
		if (mainConfig.plugins == null) {
			mainConfig.plugins = [];
		}

		const value = isStartScrpt()
			? // on `npm start`, point directly to the binary
				path.resolve(binDir, binName)
			: // otherwise point relative to the resources folder of the bundled app
				binName;

		log(`define '${defineName}'='${value}'`);

		mainConfig.plugins.push(
			new DefinePlugin({
				// expose path to helper via this webpack define
				[defineName]: JSON.stringify(value),
			}),
		);
	});

	return config;
}

/**
 * Node major embedded in the sidecar by pkg. The native modules the sidecar
 * carries are rebuilt below under whichever Node runs this script, and they
 * only load if the two match.
 */
const SIDECAR_NODE_MAJOR = 20;

function build(
	sourcesDir: string,
	buildForArchs: string,
	binDir: string,
	binName: string,
) {
	// A mismatch here builds without complaint and fails at runtime instead:
	// mountutils rebuilt under Node 22 reported NODE_MODULE_VERSION 127 where
	// the embedded Node 20 needs 115, and the sidecar only discovers that the
	// first time it tries to unmount a drive. Refuse up front.
	const hostMajor = parseInt(process.versions.node.split('.')[0], 10);
	if (hostMajor !== SIDECAR_NODE_MAJOR) {
		throw new Error(
			`The sidecar embeds Node ${SIDECAR_NODE_MAJOR} but this build is running under Node ${process.versions.node}. ` +
				`Native modules rebuilt now would not load inside it. Switch to Node ${SIDECAR_NODE_MAJOR} (see .nvmrc) and run npm ci.`,
		);
	}

	const commands: Array<[string, string[], object?]> = [
		['tsc', ['--project', 'tsconfig.sidecar.json', '--outDir', sourcesDir]],
	];

	buildForArchs.split(',').forEach((arch) => {
		const binPath = isStartScrpt()
			? // on `npm start`, we don't know the arch we're building for at the time we're
				// adding the webpack define, so we just build under binDir
				path.resolve(binDir, binName)
			: // otherwise build in arch-specific directory within binDir
				path.resolve(binDir, arch, binName);

		// FIXME: rebuilding mountutils shouldn't be necessary, but it is.
		// It's coming from etcher-sdk, a fix has been upstreamed but to use
		// the latest etcher-sdk we need to upgrade axios at the same time.
		commands.push(['npm', ['rebuild', 'mountutils', `--arch=${arch}`]]);

		commands.push([
			'pkg',
			[
				path.join(sourcesDir, 'util', 'api.js'),
				'-c',
				'pkg-sidecar.json',
				// shrink the snapshot; decompression cost at startup is negligible
				'--compress',
				'Brotli',
				// `--no-bytecode` so that we can cross-compile for arm64 on x64
				'--no-bytecode',
				'--public',
				'--public-packages',
				'"*"',
				// always build for host platform and node version
				// https://github.com/vercel/pkg-fetch/releases
				'--target',
				`node${SIDECAR_NODE_MAJOR}-${arch}`,
				'--output',
				binPath,
			],
		]);
	});

	commands.forEach(([cmd, args, opt]) => {
		log('running command:', cmd, args.join(' '));
		execFileSync(cmd, args, { shell: true, stdio: 'inherit', ...opt });
	});
}

function copyArtifact(
	buildPath: string,
	arch: string,
	binDir: string,
	binName: string,
) {
	const binPath = isStartScrpt()
		? // on `npm start`, we don't know the arch we're building for at the time we're
			// adding the webpack define, so look for the binary directly under binDir
			path.resolve(binDir, binName)
		: // otherwise look into arch-specific directory within binDir
			path.resolve(binDir, arch, binName);

	// buildPath points to appPath, which is inside resources dir which is the one we actually want
	const resourcesPath = path.dirname(buildPath);
	const dest = path.resolve(resourcesPath, path.basename(binPath));
	log(`copying '${binPath}' to '${dest}'`);
	fs.copyFileSync(binPath, dest);
}

export class SidecarPlugin extends PluginBase<void> {
	name = 'sidecar';

	constructor() {
		super();
		this.getHooks = this.getHooks.bind(this);
		log('isStartScript:', isStartScrpt());
	}

	getHooks(): ForgeMultiHookMap {
		const DEFINE_NAME = 'ETCHER_UTIL_BIN_PATH';
		const BASE_DIR = path.join('out', 'sidecar');
		const SRC_DIR = path.join(BASE_DIR, 'src');
		const BIN_DIR = path.join(BASE_DIR, 'bin');
		const BIN_NAME = `etcher-util${process.platform === 'win32' ? '.exe' : ''}`;

		return {
			resolveForgeConfig: async (currentConfig) => {
				log('resolveForgeConfig');
				return addWebpackDefine(currentConfig, DEFINE_NAME, BIN_DIR, BIN_NAME);
			},
			generateAssets: async (_config, platform, arch) => {
				log('generateAssets', { platform, arch });
				build(SRC_DIR, arch, BIN_DIR, BIN_NAME);
			},
			packageAfterCopy: async (
				_config,
				buildPath,
				electronVersion,
				platform,
				arch,
			) => {
				log('packageAfterCopy', {
					buildPath,
					electronVersion,
					platform,
					arch,
				});
				copyArtifact(buildPath, arch, BIN_DIR, BIN_NAME);
			},
		};
	}
}
