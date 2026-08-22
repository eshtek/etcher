/*
 * Guided "Download HexOS" flow: fetches the release manifest, downloads
 * the latest image to the user's Downloads folder, verifies its sha256,
 * and hands the verified file path back to the source selector.
 */

import * as React from 'react';
import { Flex, Spinner, Txt, ProgressBar } from 'rendition';
import prettyBytes from 'pretty-bytes';
import * as i18next from 'i18next';

import { Modal } from '../../styled-components';
import type {
	DownloadProgress,
	HexOSImageEntry,
} from '../../modules/hexos-image';
import {
	ChecksumMismatchError,
	ensureImage,
	fetchManifest,
	getLatestImage,
	getStaticManifestUrl,
	isImagerOutdated,
} from '../../modules/hexos-image';
import { open as openExternal } from '../../os/open-external/services/open-external';

type Phase = 'loading' | 'ready' | 'working' | 'error';

interface HexOSDownloadState {
	phase: Phase;
	/** Currently selected image; defaults to the channel's newest. */
	entry?: HexOSImageEntry;
	/** Every image the manifest offers, newest first. */
	images: HexOSImageEntry[];
	/** Version the manifest calls latest, so older picks can be labelled. */
	latestVersion?: string;
	progress?: DownloadProgress;
	errorMessage?: string;
	usedExisting: boolean;
	/** Set when the manifest requires a newer imager than this build. */
	minImagerVersion?: string;
	/** Non-stable channel served by the API, surfaced as a badge. */
	channel?: string;
}

export const HexOSDownload = ({
	done,
	cancel,
}: {
	done: (imagePath: string) => void;
	cancel: () => void;
}) => {
	const [state, setState] = React.useState<HexOSDownloadState>({
		phase: 'loading',
		images: [],
		usedExisting: false,
	});
	const abortRef = React.useRef<AbortController>();

	const loadManifest = React.useCallback(async () => {
		setState((s) => ({ ...s, phase: 'loading', errorMessage: undefined }));
		try {
			const { manifest, source } = await fetchManifest();
			const entry = getLatestImage(manifest);
			console.log(`HexOS manifest resolved from the ${source} source.`);
			setState((s) => ({
				...s,
				phase: 'ready',
				entry,
				images: manifest.images,
				latestVersion: manifest.latest,
				minImagerVersion: isImagerOutdated(manifest)
					? manifest.minImagerVersion
					: undefined,
				channel:
					manifest.channel && manifest.channel !== 'stable'
						? manifest.channel
						: undefined,
			}));
		} catch (error: any) {
			console.error('HexOS manifest fetch failed:', error);
			const url = await getStaticManifestUrl();
			setState((s) => ({
				...s,
				phase: 'error',
				errorMessage: `${i18next.t('hexos.manifestError', { url })}\n\n(${error?.message ?? error})`,
			}));
		}
	}, []);

	React.useEffect(() => {
		loadManifest();
		return () => {
			abortRef.current?.abort();
		};
	}, [loadManifest]);

	const startDownload = async () => {
		const entry = state.entry;
		if (entry === undefined) {
			return;
		}
		const abort = new AbortController();
		abortRef.current = abort;
		setState((s) => ({ ...s, phase: 'working', progress: undefined }));
		try {
			const result = await ensureImage(
				entry,
				(progress) => {
					setState((s) => ({ ...s, progress }));
				},
				abort.signal,
			);
			setState((s) => ({ ...s, usedExisting: result.alreadyExisted }));
			done(result.path);
		} catch (error: any) {
			if (abort.signal.aborted) {
				return;
			}
			console.error('HexOS download failed:', error);
			const errorMessage =
				error instanceof ChecksumMismatchError
					? i18next.t('hexos.checksumMismatch')
					: `${i18next.t('hexos.downloadFailed')}: ${error?.message ?? error}`;
			setState((s) => ({ ...s, phase: 'error', errorMessage }));
		}
	};

	const {
		phase,
		entry,
		images,
		latestVersion,
		progress,
		errorMessage,
		minImagerVersion,
		channel,
	} = state;
	const isLatest = entry !== undefined && entry.version === latestVersion;
	const working = phase === 'working';
	const percentage =
		progress !== undefined && progress.total > 0
			? Math.floor((progress.transferred / progress.total) * 100)
			: 0;

	let statusText = '';
	if (progress !== undefined) {
		statusText =
			progress.phase === 'downloading'
				? `${i18next.t('hexos.downloading')} ${prettyBytes(progress.transferred)} / ${prettyBytes(progress.total)}${
						progress.speed > 0 ? ` (${prettyBytes(progress.speed)}/s)` : ''
					}`
				: `${i18next.t('hexos.verifying')} ${percentage}%`;
	}

	return (
		<Modal
			cancel={() => {
				abortRef.current?.abort();
				cancel();
			}}
			primaryButtonProps={{
				disabled: phase === 'loading' || working,
			}}
			action={
				working ? (
					<Spinner />
				) : phase === 'error' ? (
					i18next.t('hexos.retry')
				) : (
					i18next.t('hexos.startDownload')
				)
			}
			done={() => {
				if (phase === 'error') {
					if (entry === undefined) {
						loadManifest();
					} else {
						startDownload();
					}
					return;
				}
				startDownload();
			}}
		>
			<Flex flexDirection="column" width="100%">
				<Txt mb="10px" fontSize="24px">
					{i18next.t('hexos.downloadTitle')}
				</Txt>

				{phase === 'loading' && (
					<Flex alignItems="center" mt={15}>
						<Spinner />
						<Txt ml={10}>{i18next.t('hexos.checkingLatest')}</Txt>
					</Flex>
				)}

				{entry !== undefined && (
					<Flex flexDirection="column" mt={10}>
						<Txt.p>
							<Txt.span bold>
								{isLatest
									? i18next.t('hexos.latestVersion')
									: i18next.t('hexos.selectedVersion')}
								:{' '}
							</Txt.span>
							<Txt.span>
								HexOS {entry.version} ({entry.name})
							</Txt.span>
						</Txt.p>

						{images.length > 1 && (
							<Flex alignItems="center" mb={10}>
								<Txt.span bold mr={8}>
									{i18next.t('hexos.chooseVersion')}:
								</Txt.span>
								<select
									value={entry.version}
									disabled={working}
									onChange={(evt: React.ChangeEvent<HTMLSelectElement>) => {
										const picked = images.find(
											(image) => image.version === evt.target.value,
										);
										if (picked) {
											setState((s) => ({ ...s, entry: picked }));
										}
									}}
									style={{
										fontFamily: 'inherit',
										fontSize: 14,
										fontWeight: 600,
										padding: '4px 8px',
										borderRadius: 8,
										border: '1px solid #c9c9d1',
										background: '#fff',
									}}
								>
									{images.map((image) => (
										<option key={image.version} value={image.version}>
											HexOS {image.version}
											{image.version === latestVersion
												? ` (${i18next.t('hexos.latestSuffix')})`
												: ''}
										</option>
									))}
								</select>
							</Flex>
						)}
						<Txt.p>
							<Txt.span bold>{i18next.t('hexos.size')}: </Txt.span>
							<Txt.span>{prettyBytes(entry.size)}</Txt.span>
							{channel !== undefined && (
								<Txt.span ml={10} color="#7f35b2" bold>
									{i18next.t('hexos.betaChannel')}
								</Txt.span>
							)}
						</Txt.p>
					</Flex>
				)}

				{minImagerVersion !== undefined && (
					<Flex flexDirection="column" mt={10}>
						<Txt color="#a2661c">
							{i18next.t('hexos.outdatedImager', { min: minImagerVersion })}
						</Txt>
						<Txt
							mt={4}
							color="#7f35b2"
							style={{ cursor: 'pointer', width: 'fit-content' }}
							onClick={() => openExternal('https://hexos.com/imager')}
						>
							{i18next.t('hexos.getLatestImager')}
						</Txt>
					</Flex>
				)}

				{working && (
					<Flex flexDirection="column" mt={20}>
						<ProgressBar value={percentage}>{`${percentage}%`}</ProgressBar>
						<Txt mt={10} fontSize="14px">
							{statusText}
						</Txt>
					</Flex>
				)}

				{phase === 'error' && errorMessage !== undefined && (
					<Txt mt={20} color="#d9534f" style={{ whiteSpace: 'pre-wrap' }}>
						{errorMessage}
					</Txt>
				)}
			</Flex>
		</Modal>
	);
};
