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

import DownloadSvg from '@fortawesome/fontawesome-free/svgs/solid/download.svg';
import FileSvg from '@fortawesome/fontawesome-free/svgs/solid/file.svg';
import ExclamationTriangleSvg from '@fortawesome/fontawesome-free/svgs/solid/triangle-exclamation.svg';
import type { IpcRendererEvent } from 'electron';
import { ipcRenderer } from 'electron';
import { isNil } from 'lodash';
import * as path from 'path';
import prettyBytes from 'pretty-bytes';
import * as React from 'react';
import { requestMetadata } from '../../app';

import type { ButtonProps } from 'rendition';
import { Flex, Modal as SmallModal, Txt, Spinner } from 'rendition';
import styled from 'styled-components';

import * as errors from '../../../../shared/errors';
import * as messages from '../../../../shared/messages';
import * as supportedFormats from '../../../../shared/supported-formats';
import * as selectionState from '../../models/selection-state';
import { observe } from '../../models/store';
import * as analytics from '../../modules/analytics';
import * as exceptionReporter from '../../modules/exception-reporter';
import * as osDialog from '../../os/dialog';

import {
	ChangeButton,
	deckGradient,
	DetailsText,
	StepButton,
	StepNameButton,
} from '../../styled-components';
import { colors } from '../../theme';
import { prettyHexOSImageName } from '../../utils/hexos-image-name';
import { middleEllipsis } from '../../utils/middle-ellipsis';
import { SVGIcon } from '../svg-icon/svg-icon';

import ImageSvg from '../../../assets/image.svg';
import { HexOSDownload } from '../hexos-download/hexos-download';
import type { DrivelistDrive } from '../../../../shared/drive-constraints';
import { isJson } from '../../../../shared/utils';
import type {
	SourceMetadata,
	Authentication,
	Source,
} from '../../../../shared/typings/source-selector';
import * as i18next from 'i18next';

const isURL = (imagePath: string) =>
	imagePath.startsWith('https://') || imagePath.startsWith('http://');

// TODO move these styles to rendition
const ModalText = styled.p`
	a {
		color: #a95fd8;

		&:hover {
			color: #8534c0;
		}
	}
`;

function getState() {
	const image = selectionState.getImage();
	return {
		hasImage: selectionState.hasImage(),
		imageName: image?.name,
		imageSize: image?.size,
	};
}

function isString(value: any): value is string {
	return typeof value === 'string';
}

interface Flow {
	icon?: JSX.Element;
	onClick: (evt: React.MouseEvent) => void;
	label: string;
}

const FlowSelector = styled(
	({ flow, ...props }: { flow: Flow } & ButtonProps) => (
		<StepButton
			plain={!props.primary}
			primary={props.primary}
			onClick={(evt: React.MouseEvent<Element, MouseEvent>) =>
				flow.onClick(evt)
			}
			icon={flow.icon}
			{...props}
		>
			{flow.label}
		</StepButton>
	),
)`
	border-radius: 8px;
	color: rgba(255, 255, 255, 0.92);
	font-weight: 600;

	:enabled:focus,
	:enabled:focus svg {
		color: ${colors.primary.foreground} !important;
	}

	:enabled:hover {
		background-image: ${deckGradient};
		background-color: ${colors.primary.background};
		color: ${colors.primary.foreground};

		svg {
			color: ${colors.primary.foreground} !important;
		}
	}
`;

interface SourceSelectorProps {
	flashing: boolean;
}

interface SourceSelectorState {
	hasImage: boolean;
	imageName?: string;
	imageSize?: number;
	warning: { message: string; title: string | null } | null;
	showImageDetails: boolean;
	showHexOSDownload: boolean;
	defaultFlowActive: boolean;
	imageSelectorOpen: boolean;
	imageLoading: boolean;
}

export class SourceSelector extends React.Component<
	SourceSelectorProps,
	SourceSelectorState
> {
	private unsubscribe: (() => void) | undefined;

	constructor(props: SourceSelectorProps) {
		super(props);
		this.state = {
			...getState(),
			warning: null,
			showImageDetails: false,
			showHexOSDownload: false,
			defaultFlowActive: true,
			imageSelectorOpen: false,
			imageLoading: false,
		};

		// Bind `this` since it's used in an event's callback
		this.onSelectImage = this.onSelectImage.bind(this);
	}

	public componentDidMount() {
		this.unsubscribe = observe(() => {
			this.setState(getState());
		});
		ipcRenderer.on('select-image', this.onSelectImage);
		ipcRenderer.send('source-selector-ready');
	}

	public componentWillUnmount() {
		this.unsubscribe?.();
		ipcRenderer.removeListener('select-image', this.onSelectImage);
	}

	private async onSelectImage(_event: IpcRendererEvent, imagePath: string) {
		this.setState({ imageLoading: true });
		await this.selectSource(
			imagePath,
			isURL(this.normalizeImagePath(imagePath)) ? 'Http' : 'File',
		).promise;
		this.setState({ imageLoading: false });
	}

	public normalizeImagePath(imgPath: string) {
		const decodedPath = decodeURIComponent(imgPath);
		if (isJson(decodedPath)) {
			return JSON.parse(decodedPath).url ?? decodedPath;
		}
		return decodedPath;
	}

	private reselectSource() {
		selectionState.deselectImage();
	}

	private selectSource(
		selected: string | DrivelistDrive,
		SourceType: Source,
		auth?: Authentication,
	): { promise: Promise<void>; cancel: () => void } {
		return {
			cancel: () => {
				// noop
			},
			promise: (async () => {
				const sourcePath = isString(selected) ? selected : selected.device;
				let metadata: SourceMetadata | undefined;
				if (isString(selected)) {
					if (
						SourceType === 'Http' &&
						!isURL(this.normalizeImagePath(selected))
					) {
						this.handleError(
							i18next.t('source.unsupportedProtocol'),
							selected,
							messages.error.unsupportedProtocol(),
						);
						return;
					}

					if (supportedFormats.looksLikeWindowsImage(selected)) {
						this.setState({
							warning: {
								message: messages.warning.looksLikeWindowsImage(),
								title: i18next.t('source.windowsImage'),
							},
						});
					}

					try {
						// this will send an event down the ipcMain asking for metadata
						// we'll get the response through an event

						// FIXME: This is a poor man wait while loading to prevent a potential race condition without completely blocking the interface
						// This should be addressed when refactoring the GUI
						let retriesLeft = 10;
						while (requestMetadata === undefined && retriesLeft > 0) {
							await new Promise((resolve) => setTimeout(resolve, 1050)); // api is trying to connect every 1000, this is offset to make sure we fall between retries
							retriesLeft--;
						}

						metadata = await requestMetadata({ selected, SourceType, auth });

						if (!metadata?.hasMBR && this.state.warning === null) {
							this.setState({
								warning: {
									message: messages.warning.missingPartitionTable(),
									title: i18next.t('source.partitionTable'),
								},
							});
						}
					} catch (error: any) {
						this.handleError(
							i18next.t('source.errorOpen'),
							sourcePath,
							messages.error.openSource(sourcePath, error.message),
							error,
						);
					}
				} else {
					if (selected.partitionTableType === null) {
						this.setState({
							warning: {
								message: messages.warning.driveMissingPartitionTable(),
								title: i18next.t('source.partitionTable'),
							},
						});
					}
					metadata = {
						path: selected.device,
						displayName: selected.displayName,
						description: selected.displayName,
						size: selected.size as SourceMetadata['size'],
						SourceType: 'BlockDevice',
						drive: selected,
					};
				}

				if (metadata !== undefined) {
					metadata.auth = auth;
					metadata.SourceType = SourceType;
					selectionState.selectSource(metadata);
				}
			})(),
		};
	}

	private handleError(
		title: string,
		sourcePath: string,
		description: string,
		error?: Error,
	) {
		const imageError = errors.createUserError({
			title,
			description,
		});
		osDialog.showError(imageError);
		if (error) {
			analytics.logException(error);
			return;
		}
	}

	private async openImageSelector() {
		this.setState({ imageSelectorOpen: true });

		try {
			const imagePath = await osDialog.selectImage();
			// Avoid analytics and selection state changes
			// if no file was resolved from the dialog.
			if (!imagePath) {
				return;
			}
			await this.selectSource(imagePath, 'File').promise;
		} catch (error: any) {
			exceptionReporter.report(error);
		} finally {
			this.setState({ imageSelectorOpen: false });
		}
	}

	private async onDrop(event: React.DragEvent<HTMLDivElement>) {
		const file = event.dataTransfer.files.item(0);
		if (file != null) {
			await this.selectSource(file.path, 'File').promise;
		}
	}

	private openHexOSDownload() {
		this.setState({
			showHexOSDownload: true,
		});
	}

	private onDragOver(event: React.DragEvent<HTMLDivElement>) {
		// Needed to get onDrop events on div elements
		event.preventDefault();
	}

	private onDragEnter(event: React.DragEvent<HTMLDivElement>) {
		// Needed to get onDrop events on div elements
		event.preventDefault();
	}

	private showSelectedImageDetails() {
		this.setState({
			showImageDetails: true,
		});
	}

	private setDefaultFlowActive(defaultFlowActive: boolean) {
		this.setState({ defaultFlowActive });
	}

	// TODO add a visual change when dragging a file over the selector
	public render() {
		const { flashing } = this.props;
		const { showImageDetails, imageLoading } = this.state;
		const selectionImage = selectionState.getImage();
		let image =
			selectionImage !== undefined ? selectionImage : ({} as SourceMetadata);

		image = image.drive ?? image;

		image.name = image.description || image.name;
		const imagePath = image.path || image.displayName || '';
		const imageBasename = path.basename(imagePath);
		const imageName = image.name || '';
		const imageSize = image.size;
		const imageLogo = image.logo || '';

		return (
			<>
				<Flex
					flexDirection="column"
					alignItems="center"
					onDrop={(evt: React.DragEvent<HTMLDivElement>) => this.onDrop(evt)}
					onDragEnter={(evt: React.DragEvent<HTMLDivElement>) =>
						this.onDragEnter(evt)
					}
					onDragOver={(evt: React.DragEvent<HTMLDivElement>) =>
						this.onDragOver(evt)
					}
				>
					<SVGIcon
						contents={imageLogo}
						fallback={ImageSvg}
						style={{
							marginBottom: 30,
						}}
					/>

					{selectionImage !== undefined || imageLoading ? (
						<>
							<StepNameButton
								plain
								onClick={() => this.showSelectedImageDetails()}
								tooltip={imageName || imageBasename}
							>
								<Spinner show={imageLoading}>
									{middleEllipsis(
										prettyHexOSImageName(imageName || imageBasename),
										20,
									)}
								</Spinner>
							</StepNameButton>
							{!flashing && !imageLoading && (
								<ChangeButton
									plain
									mb={14}
									onClick={() => this.reselectSource()}
								>
									{i18next.t('cancel')}
								</ChangeButton>
							)}
							{!isNil(imageSize) && !imageLoading && (
								<DetailsText>{prettyBytes(imageSize)}</DetailsText>
							)}
						</>
					) : (
						<>
							<FlowSelector
								primary={this.state.defaultFlowActive}
								key="Download HexOS"
								flow={{
									onClick: () => this.openHexOSDownload(),
									label: i18next.t('hexos.download'),
									icon: <DownloadSvg height="1em" fill="currentColor" />,
								}}
								onMouseEnter={() => this.setDefaultFlowActive(false)}
								onMouseLeave={() => this.setDefaultFlowActive(true)}
							/>
							<FlowSelector
								disabled={this.state.imageSelectorOpen}
								key="Flash from file"
								flow={{
									onClick: () => this.openImageSelector(),
									label: i18next.t('source.fromFile'),
									icon: <FileSvg height="1em" fill="currentColor" />,
								}}
								onMouseEnter={() => this.setDefaultFlowActive(false)}
								onMouseLeave={() => this.setDefaultFlowActive(true)}
							/>
						</>
					)}
				</Flex>

				{this.state.warning != null && (
					<SmallModal
						style={{
							boxShadow: '0 3px 7px rgba(0, 0, 0, 0.3)',
						}}
						title={
							<span>
								<ExclamationTriangleSvg fill="#fca321" height="1em" />{' '}
								<span>{this.state.warning.title}</span>
							</span>
						}
						action={i18next.t('continue')}
						cancel={() => {
							this.setState({ warning: null });
							this.reselectSource();
						}}
						done={() => {
							this.setState({ warning: null });
						}}
						primaryButtonProps={{ warning: true, primary: false }}
					>
						<ModalText
							dangerouslySetInnerHTML={{ __html: this.state.warning.message }}
						/>
					</SmallModal>
				)}

				{showImageDetails && (
					<SmallModal
						title={i18next.t('source.image')}
						done={() => {
							this.setState({ showImageDetails: false });
						}}
					>
						<Txt.p>
							<Txt.span bold>{i18next.t('source.name')}</Txt.span>
							<Txt.span>{imageName || imageBasename}</Txt.span>
						</Txt.p>
						<Txt.p>
							<Txt.span bold>{i18next.t('source.path')}</Txt.span>
							<Txt.span>{imagePath}</Txt.span>
						</Txt.p>
					</SmallModal>
				)}

				{this.state.showHexOSDownload && (
					<HexOSDownload
						cancel={() => {
							this.setState({ showHexOSDownload: false });
						}}
						done={async (imagePath: string) => {
							this.setState({
								showHexOSDownload: false,
								imageLoading: true,
							});
							// Clear the spinner in a finally: without it any
							// rejection leaves the user staring at a spinner
							// that never resolves and reports nothing.
							try {
								await this.selectSource(imagePath, 'File').promise;
							} catch (error: any) {
								this.handleError(
									i18next.t('source.errorOpen'),
									imagePath,
									messages.error.openSource(imagePath, error.message),
									error,
								);
							} finally {
								this.setState({ imageLoading: false });
							}
						}}
					/>
				)}

			</>
		);
	}
}
