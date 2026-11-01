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

// The small subset of styled-system props the app passes to its layout and
// text primitives (margins, padding, sizes, flex alignment, font size and
// colour), resolved against the same scales the old UI library used so that numeric
// values such as `mr={2}` or `mb={14}` keep their old meaning.

import type { CSSProperties } from 'react';
import type { CSSObject } from 'styled-components';

import { colors } from '../../theme';

// Index-addressable scales: a number below the scale length is an index,
// anything else is taken as pixels
export const space = [0, 4, 8, 16, 38, 48, 128];
export const fontSizes = [10, 12, 14, 16, 18, 24, 34, 58, 72];

export const font = 'SourceSansPro';
export const monospace = "'Ubuntu Mono', 'Courier New', monospace";

// Colours the old UI library's components drew with; the HexOS palette in theme.ts
// overrides the primary ones
export const palette = {
	text: '#2a506f',
	tertiary: '#527699',
	quartenary: '#dde1f0',
	quartenarySemilight: '#f2f4fa',
	quartenaryLight: '#f8f9fd',
	info: '#1496e1',
	infoLight: '#e8f5fc',
	warning: colors.warning.background,
};

type Value = number | string;

export interface SpaceProps {
	m?: Value;
	mt?: Value;
	mr?: Value;
	mb?: Value;
	ml?: Value;
	mx?: Value;
	my?: Value;
	p?: Value;
	pt?: Value;
	pr?: Value;
	pb?: Value;
	pl?: Value;
	px?: Value;
	py?: Value;
	paddingTop?: Value;
}

export interface LayoutProps {
	width?: Value;
	height?: Value;
	minWidth?: Value;
	maxWidth?: Value;
	minHeight?: Value;
	maxHeight?: Value;
	display?: string;
}

export interface ColorProps {
	color?: string;
	bg?: string;
	backgroundColor?: string;
}

export interface FlexItemProps {
	flex?: Value;
	order?: Value;
	alignSelf?: string;
}

export interface FlexContainerProps {
	flexDirection?: CSSProperties['flexDirection'];
	alignItems?: string;
	justifyContent?: string;
	flexWrap?: CSSProperties['flexWrap'];
}

export interface SystemProps
	extends
		SpaceProps,
		LayoutProps,
		ColorProps,
		FlexItemProps,
		FlexContainerProps {
	fontSize?: Value;
}

const px = (value: Value) => (typeof value === 'number' ? `${value}px` : value);

function fromScale(scale: number[], value: Value) {
	if (typeof value === 'number') {
		const index = Math.abs(value);
		if (Number.isInteger(index) && index < scale.length) {
			return px(value < 0 ? -scale[index] : scale[index]);
		}
	}
	return px(value);
}

// Widths and heights between 0 and 1 are fractions, as in styled-system
function size(value: Value) {
	return typeof value === 'number' && value >= 0 && value <= 1
		? `${value * 100}%`
		: px(value);
}

// Accepts a raw CSS colour or a dotted path into the theme colours
function color(value: string) {
	if (!value.includes('.') || value.startsWith('rgb')) {
		return value;
	}
	const found = value
		.split('.')
		.reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), colors);
	return typeof found === 'string' ? found : value;
}

const spaceKeys: { [key: string]: string[] } = {
	m: ['margin'],
	mt: ['marginTop'],
	mr: ['marginRight'],
	mb: ['marginBottom'],
	ml: ['marginLeft'],
	mx: ['marginLeft', 'marginRight'],
	my: ['marginTop', 'marginBottom'],
	p: ['padding'],
	pt: ['paddingTop'],
	pr: ['paddingRight'],
	pb: ['paddingBottom'],
	pl: ['paddingLeft'],
	px: ['paddingLeft', 'paddingRight'],
	py: ['paddingTop', 'paddingBottom'],
	paddingTop: ['paddingTop'],
};

const sizeKeys = [
	'width',
	'height',
	'minWidth',
	'maxWidth',
	'minHeight',
	'maxHeight',
];

const rawKeys = [
	'display',
	'flex',
	'order',
	'alignSelf',
	'flexDirection',
	'alignItems',
	'justifyContent',
	'flexWrap',
];

const colorKeys: { [key: string]: string } = {
	color: 'color',
	bg: 'backgroundColor',
	backgroundColor: 'backgroundColor',
};

export const systemPropNames = new Set([
	...Object.keys(spaceKeys),
	...sizeKeys,
	...rawKeys,
	...Object.keys(colorKeys),
	'fontSize',
]);

// Turns the system props into a style object; props are applied in the order
// they were passed, so a later `mt` refines an earlier `m`
export function system(props: { [key: string]: any }): CSSObject {
	const css: CSSObject = {};
	for (const key of Object.keys(props)) {
		const value = props[key];
		if (value == null || value === '') {
			continue;
		}
		if (key in spaceKeys) {
			for (const property of spaceKeys[key]) {
				css[property] = fromScale(space, value);
			}
		} else if (sizeKeys.includes(key)) {
			css[key] = size(value);
		} else if (rawKeys.includes(key)) {
			css[key] = value;
		} else if (key in colorKeys) {
			css[colorKeys[key]] = color(value);
		} else if (key === 'fontSize') {
			css.fontSize = fromScale(fontSizes, value);
		}
	}
	return css;
}

// Keeps styling props off the DOM, which styled-components would otherwise
// forward whenever the name happens to be a valid HTML attribute
export function omitProps(...extra: string[]) {
	const omitted = new Set([...systemPropNames, ...extra]);
	return (prop: string | number | symbol, isValid: (p: any) => boolean) =>
		!omitted.has(prop as string) && isValid(prop);
}

function parseHex(hex: string): [number, number, number] | undefined {
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) {
		return;
	}
	const digits =
		match[1].length === 3
			? match[1]
					.split('')
					.map((d) => d + d)
					.join('')
			: match[1];
	return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [
		number,
		number,
		number,
	];
}

// Lowers the HSL lightness by `amount` (a fraction of itself), which is how
// the old UI library derived hover colours from a base colour
export function darken(value: string, amount = 0.2) {
	const rgb = parseHex(value);
	if (rgb === undefined) {
		return value;
	}
	const [r, g, b] = rgb.map((c) => c / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		h =
			max === r
				? (g - b) / d + (g < b ? 6 : 0)
				: max === g
					? (b - r) / d + 2
					: (r - g) / d + 4;
		h *= 60;
	}
	const round = (n: number) => Math.round(n * 10) / 10;
	return `hsl(${round(h)}, ${round(s * 100)}%, ${round(l * (1 - amount) * 100)}%)`;
}
