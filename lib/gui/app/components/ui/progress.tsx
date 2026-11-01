/*
 * Copyright 2026 Eshtek Inc.
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

import * as React from 'react';
import styled, { keyframes } from 'styled-components';

import { colors } from '../../theme';
import type { BoxProps } from './box';
import { Flex } from './box';
import type { SystemProps } from './system';
import { omitProps, palette, space, system } from './system';

export interface ProgressBarProps
	extends SystemProps, Omit<React.HTMLAttributes<HTMLDivElement>, 'color'> {
	// Percentage filled, 0 to 100
	value: number;
	// Colour of the filled part
	background?: string;
	emphasized?: boolean;
}

const transition = 'width linear 250ms';

const Sleeve = styled.div.withConfig<Omit<ProgressBarProps, 'value'>>({
	shouldForwardProp: omitProps('emphasized'),
})`
	position: relative;
	border-radius: 3px;
	height: ${(props) => space[props.emphasized ? 4 : 3]}px;
	line-height: ${(props) => space[props.emphasized ? 4 : 3]}px;
	background: ${palette.quartenary};
	font-size: ${(props) => (props.emphasized ? 1 : 0.6)}em;
	overflow: hidden;
	${system}
`;

// Text over the unfilled part
const LoadingContent = styled.div`
	position: absolute;
	top: 0;
	left: 0;
	bottom: 0;
	right: 0;
	text-align: center;
	color: #000;
	text-shadow: 0 0 3px rgba(255, 255, 255, 0.5);
`;

const Bar = styled.div<{ barColor: string; emphasized?: boolean }>`
	position: relative;
	height: ${(props) => space[props.emphasized ? 5 : 4]}px;
	overflow: hidden;
	background: ${(props) => props.barColor};
	transition: ${transition};
	text-align: center;
`;

// The same text again over the filled part, stretched to the full sleeve
// width and clipped by the bar
const Content = styled.div`
	text-align: center;
	position: absolute;
	left: 0;
	bottom: 0;
	top: 0;
	text-shadow: 0 0 3px rgba(0, 0, 0, 0.5);
	transition: ${transition};
`;

export const ProgressBar = ({
	value,
	background = colors.primary.main,
	children,
	emphasized,
	...props
}: ProgressBarProps) => (
	<Sleeve color="#fff" emphasized={emphasized} {...props}>
		<LoadingContent>{children}</LoadingContent>
		<Bar
			barColor={background}
			emphasized={emphasized}
			style={{ width: `${value}%` }}
		>
			<Content style={{ width: `${value && (100 * 100) / value}%` }}>
				{children}
			</Content>
		</Bar>
	</Sleeve>
);

const rotate360 = keyframes`
	0% {
		transform: rotate(0deg);
	}
	100% {
		transform: rotate(360deg);
	}
`;

const CircleLoader = styled.div<{ emphasized?: boolean }>`
	background: transparent !important;
	width: ${(props) => (props.emphasized ? 40 : 20)}px;
	height: ${(props) => (props.emphasized ? 40 : 20)}px;
	border: ${(props) => (props.emphasized ? 6 : 4)}px solid;
	color: ${palette.tertiary};
	border-radius: 100%;
	border-bottom-color: transparent;
	display: inline-block;
	animation: ${rotate360} 1s 0s infinite linear;
	animation-fill-mode: both;
`;

const Container = styled(Flex)`
	position: relative;
	flex-direction: column;
`;

const Overlay = styled(Flex)`
	position: absolute;
	top: 0;
	left: 0;
	bottom: 0;
	right: 0;
	z-index: 4;
`;

const ChildrenContainer = styled.div<{ show: boolean }>`
	opacity: ${(props) => (props.show ? 0.4 : 1)};
	transition: opacity 250ms;
	flex: 1;
`;

export interface SpinnerProps extends BoxProps {
	// When there are children, false leaves them visible without the spinner
	show?: boolean;
	emphasized?: boolean;
}

const Circle = ({ emphasized, ...props }: SpinnerProps) => (
	<Flex
		flexDirection={emphasized ? 'column' : 'row'}
		justifyContent="center"
		alignItems="center"
		width="fit-content"
		{...props}
	>
		<CircleLoader emphasized={emphasized} />
	</Flex>
);

export const Spinner = ({
	show = true,
	emphasized,
	children,
	...props
}: SpinnerProps) => {
	if (!children) {
		return show ? <Circle emphasized={emphasized} {...props} /> : null;
	}
	return (
		<Container {...props}>
			{show && (
				<Overlay justifyContent="center" alignItems="center">
					<Circle emphasized={emphasized} />
				</Overlay>
			)}
			<ChildrenContainer show={show}>{children}</ChildrenContainer>
		</Container>
	);
};
