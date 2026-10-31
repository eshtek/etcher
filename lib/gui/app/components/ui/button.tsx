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
import styled, { css } from 'styled-components';

import { colors } from '../../theme';
import type { SystemProps } from './system';
import { darken, omitProps, palette, system } from './system';
import type { TooltipProps } from './tooltip';
import { withTooltip } from './tooltip';

export interface ButtonProps
	extends
		SystemProps,
		TooltipProps,
		Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
	// Filled with the brand gradient
	primary?: boolean;
	// Filled like primary, but hovers to the warning colour
	warning?: boolean;
	// Bordered style; the same as leaving out primary and warning
	outline?: boolean;
	// Text only: no fill, border or padding
	plain?: boolean;
	icon?: React.ReactNode;
	label?: React.ReactNode;
}

// Deck UI's brand gradient (accent to primary), shared with styled-components.tsx
export const deckGradient = 'linear-gradient(135deg, #cb2eff, #7f35b2)';

const tones = {
	primary: colors.primary.main,
	warning: palette.warning,
};

type Variant = 'plain' | 'filled' | 'default';

interface StyleProps {
	variant: Variant;
	tone: string;
}

const hover = (background: string, color: string) => css`
	&:hover:enabled,
	&:focus:enabled,
	&:active:enabled {
		svg {
			color: ${color} !important;
		}

		box-shadow: none;
		background: ${background};
		border-color: ${background};
		color: ${color};
		opacity: initial;
	}
`;

const filledStyle = css<StyleProps>`
	color: #fff;
	background-color: ${(props) => props.tone};
	border: 0 solid ${(props) => props.tone};
	padding: 4px 30px;

	&:enabled {
		background-image: ${deckGradient};
		background-color: ${colors.primary.main};
	}

	${(props) => hover(darken(props.tone), '#fff')}
`;

const defaultStyle = css`
	color: ${palette.text};
	background-color: transparent;
	border: 0 solid ${colors.secondary.main};
	padding: 4px 30px;

	${hover(colors.secondary.main, palette.text)}
`;

const plainStyle = css`
	color: ${colors.secondary.main};
	background: transparent;
	border: none;
	padding: 0;
	border-radius: 0;

	${hover('none', darken(colors.secondary.main))}
`;

const StyledButton = styled.button.withConfig<StyleProps & SystemProps>({
	shouldForwardProp: omitProps('variant', 'tone'),
})`
	display: inline-flex;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	margin: 0;
	border-radius: 8px;
	font-family: inherit;
	font-size: 14px;
	font-weight: 600;
	line-height: 1.5;
	text-align: center;
	white-space: nowrap;
	cursor: pointer;
	outline: none;
	transition:
		color 0.1s ease-in-out,
		background-color 0.1s ease-in-out,
		border-color 0.1s ease-in-out,
		box-shadow 0.1s ease-in-out;

	&& {
		width: 200px;
		height: 48px;
	}

	svg {
		color: inherit !important;
		font-size: 0.925em;
	}

	${(props) =>
		props.variant === 'plain'
			? plainStyle
			: props.variant === 'filled'
				? filledStyle
				: defaultStyle}

	&:disabled {
		cursor: not-allowed;
		background-image: none;
		background-color: ${colors.dark.disabled.background};
		color: ${colors.dark.disabled.foreground};
		opacity: 1;
	}

	${system}
`;

// The icon and label sit side by side with an 8px gap
const Content = styled.div`
	display: flex;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	max-width: 100%;
`;

const Gap = styled.div`
	flex: 0 0 auto;
	width: 8px;
`;

const BaseButton = React.forwardRef<HTMLButtonElement, ButtonProps>(
	(
		{ primary, warning, outline, plain, icon, label, children, ...props },
		ref,
	) => {
		const tone = primary ? 'primary' : warning ? 'warning' : undefined;
		const variant: Variant = plain
			? 'plain'
			: tone !== undefined && !outline
				? 'filled'
				: 'default';
		const text = label ?? children;
		return (
			<StyledButton
				type="button"
				ref={ref}
				variant={variant}
				tone={tones[tone ?? 'primary']}
				{...props}
			>
				{icon && text ? (
					<Content>
						{icon}
						<Gap />
						{text}
					</Content>
				) : (
					icon || text
				)}
			</StyledButton>
		);
	},
);

export const Button = withTooltip<ButtonProps>(BaseButton);
Button.displayName = 'Button';
