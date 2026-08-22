/*
 * Copyright 2019 balena.io
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

import QuestionCircleSvg from '@fortawesome/fontawesome-free/svgs/solid/circle-question.svg';

import * as path from 'path';
import * as React from 'react';
import { Flex } from 'rendition';
import styled from 'styled-components';

import FinishPage from '../../components/finish/finish';
import { SourceSelector } from '../../components/source-selector/source-selector';
import type { SourceMetadata } from '../../../../shared/typings/source-selector';
import * as flashState from '../../models/flash-state';
import * as selectionState from '../../models/selection-state';
import * as settings from '../../models/settings';
import { observe } from '../../models/store';
import { open as openExternal } from '../../os/open-external/services/open-external';
import { IconButton as BaseIcon, ThemedProvider } from '../../styled-components';

import {
	TargetSelector,
	getDriveListLabel,
} from '../../components/target-selector/target-selector';
import { FlashStep } from './Flash';

import HexOSWordmarkSvg from '../../../assets/hexos-wordmark.svg';

const Icon = styled(BaseIcon)`
	margin-right: 20px;
`;

function getDrivesTitle() {
	const drives = selectionState.getSelectedDrives();

	if (drives.length === 1) {
		return drives[0].description || 'Untitled Device';
	}

	if (drives.length === 0) {
		return 'No targets found';
	}

	return `${drives.length} Targets`;
}

function getImageBasename(image?: SourceMetadata) {
	if (image === undefined) {
		return '';
	}

	if (image.drive) {
		return image.drive.description;
	}
	const imageBasename = path.basename(image.path);
	return image.name || imageBasename;
}

const StepBorder = styled.div<{
	disabled: boolean;
	left?: boolean;
	right?: boolean;
}>`
	position: relative;
	height: 2px;
	background-color: ${(props) =>
		props.disabled
			? props.theme.colors.dark.disabled.foreground
			: props.theme.colors.dark.foreground};
	width: 120px;
	top: 19px;

	left: ${(props) => (props.left ? '-67px' : undefined)};
	margin-right: ${(props) => (props.left ? '-120px' : undefined)};
	right: ${(props) => (props.right ? '-67px' : undefined)};
	margin-left: ${(props) => (props.right ? '-120px' : undefined)};
`;

interface MainPageStateFromStore {
	isFlashing: boolean;
	hasImage: boolean;
	hasDrive: boolean;
	imageLogo?: string;
	imageSize?: number;
	imageName?: string;
	driveTitle: string;
	driveLabel: string;
}

interface MainPageState {
	current: 'main' | 'success';
}

export class MainPage extends React.Component<
	object,
	MainPageState & MainPageStateFromStore
> {
	constructor(props: object) {
		super(props);
		this.state = {
			current: 'main',
			...this.stateHelper(),
		};
	}

	private stateHelper(): MainPageStateFromStore {
		const image = selectionState.getImage();
		return {
			isFlashing: flashState.isFlashing(),
			hasImage: selectionState.hasImage(),
			hasDrive: selectionState.hasDrive(),
			imageLogo: image?.logo,
			imageSize: image?.size,
			imageName: getImageBasename(selectionState.getImage()),
			driveTitle: getDrivesTitle(),
			driveLabel: getDriveListLabel(),
		};
	}

	public async componentDidMount() {
		observe(() => {
			this.setState(this.stateHelper());
		});
	}

	private renderMain() {
		const state = flashState.getFlashState();
		const shouldDriveStepBeDisabled = !this.state.hasImage;
		const shouldFlashStepBeDisabled =
			!this.state.hasImage || !this.state.hasDrive;
		return (
			<Flex m="110px 55px 18px 55px" flexDirection="column">
				<Flex justifyContent="space-between" mb="92px">
					<SourceSelector flashing={this.state.isFlashing} />
					<Flex>
						<StepBorder disabled={shouldDriveStepBeDisabled} left />
					</Flex>
					<TargetSelector
						disabled={shouldDriveStepBeDisabled}
						hasDrive={this.state.hasDrive}
						flashing={this.state.isFlashing}
					/>
					<Flex>
						<StepBorder disabled={shouldFlashStepBeDisabled} right />
					</Flex>

					<FlashStep
						width="200px"
						goToSuccess={() => this.setState({ current: 'success' })}
						shouldFlashStepBeDisabled={shouldFlashStepBeDisabled}
						isFlashing={this.state.isFlashing}
						step={state.type}
						percentage={state.percentage}
						position={state.position}
						failed={state.failed}
						speed={state.speed}
						eta={state.eta}
						style={{ zIndex: 1 }}
					/>
				</Flex>
			</Flex>
		);
	}

	private renderSuccess() {
		return (
			<FinishPage
				goToMain={() => {
					flashState.resetState();
					this.setState({ current: 'main' });
				}}
			/>
		);
	}

	public render() {
		return (
			<ThemedProvider style={{ height: '100%', width: '100%' }}>
				<Flex
					justifyContent="space-between"
					alignItems="center"
					paddingTop="14px"
					style={{
						// Allow window to be dragged from header
						// @ts-ignore
						WebkitAppRegion: 'drag',
						position: 'relative',
						zIndex: 2,
					}}
				>
					<Flex width="100%" />
					<Flex width="100%" alignItems="center" justifyContent="center">
						<HexOSWordmarkSvg
							width="110px"
							height="30px"
							style={{
								cursor: 'pointer',
							}}
							onClick={() => openExternal('https://hexos.com')}
							tabIndex={100}
						/>
					</Flex>

					<Flex width="100%" alignItems="center" justifyContent="flex-end">
						{!settings.getSync('disableExternalLinks') && (
							<Icon
								icon={<QuestionCircleSvg height="1em" fill="currentColor" />}
								onClick={() =>
									openExternal(
										'https://docs.hexos.com/getting-started/installation/InstallGuide',
									)
								}
								tabIndex={6}
								style={{
									// Make touch events click instead of dragging
									WebkitAppRegion: 'no-drag',
								}}
							/>
						)}
					</Flex>
				</Flex>
				{this.state.current === 'main'
					? this.renderMain()
					: this.renderSuccess()}
			</ThemedProvider>
		);
	}
}

export default MainPage;
