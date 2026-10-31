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

// A checkbox or toggle switch. The markup (label > div > input + box) is
// relied on by the table styles in styled-components.tsx, which target
// `input[type='checkbox'] + div`.

import * as React from 'react';
import styled from 'styled-components';

import { colors } from '../../theme';
import { palette } from './system';

export interface CheckboxProps extends Omit<
	React.InputHTMLAttributes<HTMLInputElement>,
	'type'
> {
	label?: React.ReactNode;
	indeterminate?: boolean;
	// Render as a sliding switch instead of a box
	toggle?: boolean;
}

// The toggle knob keeps the light blue it has always had
const toggleColor = '#00aeef';

const Container = styled.label.withConfig<{
	isChecked?: boolean;
	disabled?: boolean;
}>({
	shouldForwardProp: (prop) => prop !== 'isChecked',
})`
	display: flex;
	flex-direction: row;
	align-items: center;
	width: fit-content;
	user-select: none;
	cursor: pointer;

	&[disabled] {
		opacity: 0.4;
		cursor: default;
	}

	> div > div {
		background-color: white;
	}

	> span {
		font-size: 14px;
	}

	&:hover input:not([disabled]) + div {
		border-color: ${(props) =>
			props.isChecked ? colors.primary.dark : palette.tertiary} !important;
		${(props) => props.isChecked && `background: ${colors.primary.dark};`}
	}

	&:hover input:not([disabled]) + span > span {
		border-color: ${colors.primary.dark};
		background: ${colors.primary.dark};
	}
`;

const Control = styled.div<{ hasLabel: boolean }>`
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	max-width: 100%;
	margin-right: ${(props) => (props.hasLabel ? '12px' : '0')};
`;

const Input = styled.input`
	opacity: 0;
	width: 0;
	height: 0;
	margin: 0;
	cursor: ${(props) => (props.disabled ? 'default' : 'pointer')};

	&:checked + span > span {
		left: calc(40px - 20px);
		background: ${toggleColor};
	}
`;

const Box = styled.div<{ marked: boolean }>`
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	max-width: 100%;
	width: 20px;
	height: 20px;
	border: 1px solid
		${(props) => (props.marked ? colors.primary.main : palette.quartenary)};
	border-radius: 4px;

	&& {
		${(props) => props.marked && `background: ${colors.primary.main};`}
	}
`;

const Icon = styled.svg`
	box-sizing: border-box;
	width: 20px;
	height: 20px;
	stroke-width: 2px;
	stroke: #fff;
`;

const Track = styled.span`
	box-sizing: border-box;
	display: inline-block;
	vertical-align: middle;
	width: 40px;
	height: 20px;
	border: 1px solid ${palette.quartenary};
	border-radius: 20px;
	background-color: white;
`;

const Knob = styled.span`
	box-sizing: border-box;
	position: relative;
	display: inline-block;
	top: -1px;
	left: -1px;
	width: 20px;
	height: 20px;
	border-radius: 20px;
	background: ${palette.quartenary};
	transition: all 0.3s;
`;

export const Checkbox = ({
	label,
	indeterminate,
	toggle,
	checked,
	disabled,
	className,
	style,
	...props
}: CheckboxProps) => {
	const marked = !!checked || !!indeterminate;
	return (
		<div className={className} style={style}>
			<Container isChecked={!!checked} disabled={disabled}>
				<Control hasLabel={label != null}>
					<Input
						type="checkbox"
						checked={!!checked}
						disabled={disabled}
						{...props}
					/>
					{toggle ? (
						<Track>
							<Knob />
						</Track>
					) : (
						<Box marked={marked}>
							{checked && (
								<Icon viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet">
									<path fill="none" d="M6,11.3 L10.3,16 L18,6.2" />
								</Icon>
							)}
							{!checked && indeterminate && (
								<Icon viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet">
									<path fill="none" d="M6,12 L18,12" />
								</Icon>
							)}
						</Box>
					)}
				</Control>
				{typeof label === 'string' ? <span>{label}</span> : label}
			</Container>
		</div>
	);
};
