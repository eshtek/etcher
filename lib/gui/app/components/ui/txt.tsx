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

import CopySvg from '@fortawesome/fontawesome-free/svgs/regular/copy.svg';
import { clipboard } from 'electron';
import * as React from 'react';
import styled, { css } from 'styled-components';

import { colors } from '../../theme';
import { Box } from './box';
import type { SystemProps } from './system';
import { darken, monospace, omitProps, system } from './system';
import type { TooltipProps } from './tooltip';
import { withTooltip } from './tooltip';

export interface TxtProps
	extends
		SystemProps,
		TooltipProps,
		Omit<React.HTMLAttributes<HTMLElement>, 'color'> {
	align?: React.CSSProperties['textAlign'];
	bold?: boolean;
	code?: boolean;
	// Text copied to the clipboard by an icon shown on hover
	copy?: string;
}

const txtStyle = css<TxtProps>`
	${(props) => props.align && `text-align: ${props.align};`}
	${(props) =>
		props.code &&
		`
		font-family: ${monospace};
		padding: 2px 4px;
		font-size: 1em;
		color: #c7254e;
		background-color: #f9f2f4;
	`}
	${(props) => props.bold && 'font-weight: 600;'}
	${system}
`;

const BaseTxt = styled.div.withConfig<TxtProps>({
	shouldForwardProp: omitProps('align', 'bold', 'code', 'copy'),
})`
	${txtStyle}
`;

const CopyIcon = styled(Box)`
	visibility: hidden;
	cursor: pointer;
	font-size: 0.875em;

	svg {
		margin: 0 4px;
	}
`;

const CopyContainer = styled(Box)`
	display: inline-flex;
	align-items: center;

	&:hover ${CopyIcon} {
		visibility: visible;
	}
`;

function factory(tag?: 'span' | 'p') {
	const Component = withTooltip<TxtProps>(({ copy, ...props }: TxtProps) => {
		if (copy == null) {
			return <BaseTxt as={tag} {...props} />;
		}
		const text = copy.toString().trim();
		return (
			<CopyContainer>
				<BaseTxt as={tag} {...props} />
				<CopyIcon
					tooltip={{ text: 'Copied!', trigger: 'click' }}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						event.preventDefault();
						clipboard.writeText(text);
					}}
				>
					<CopySvg height="1em" fill="currentColor" />
				</CopyIcon>
			</CopyContainer>
		);
	});
	Component.displayName = tag ? `Txt.${tag}` : 'Txt';
	return Component;
}

export const Txt = Object.assign(factory(), {
	span: factory('span'),
	p: factory('p'),
});

export interface LinkProps
	extends
		SystemProps,
		Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'color'> {}

export const Link = styled.a.withConfig<LinkProps>({
	shouldForwardProp: omitProps(),
})`
	display: inline-block;
	cursor: pointer;
	text-decoration: none;
	color: ${colors.primary.main};
	${system}

	&:active,
	&:hover {
		color: ${(props) => darken(props.color || colors.primary.main)};
	}
`;

// Pastel background and legible text colour pairs, picked by `shade`
const shades = [
	['#C7FFFF', '#007171'],
	['#BAECC2', '#1B6327'],
	['#FFD4F1', '#BB007E'],
	['#F1CDE3', '#9D2C71'],
	['#D7E4FE', '#0650E5'],
	['#FFD5D2', '#BA0C00'],
	['#CAE1AC', '#4A6625'],
	['#D6D3FA', '#3C2DE7'],
	['#C3C7CA', '#4A5054'],
	['#FFDA93', '#794F00'],
	['#E1EEE5', '#3B6748'],
	['#DBE0E3', '#4E5C64'],
	['#FEEC63', '#695D01'],
	['#FBE6F4', '#BB1E86'],
	['#FFECAE', '#816300'],
	['#F1CDFF', '#9500CF'],
	['#C3EFFF', '#006387'],
	['#F3E8FD', '#8A1FEC'],
	['#E0FEB4', '#406B01'],
	['#FDE8E7', '#C91911'],
	['#CAFECD', '#027008'],
	['#D7E46C', '#5B6312'],
	['#F7D8BA', '#884B10'],
	['#00AEEF', '#003D54'],
];

const BaseBadge = styled(Txt.span)`
	display: inline-block;
	border-radius: 1em;
	line-height: 1;
`;

export interface BadgeProps extends TxtProps {
	shade?: number;
	children: string;
}

export const Badge = ({ shade = 0, ...props }: BadgeProps) => {
	const [bg, color] = shades[shade % shades.length];
	return (
		<BaseBadge py={1} px="12px" fontSize={1} bg={bg} color={color} {...props} />
	);
};
