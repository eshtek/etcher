/*
 * Copyright 2018 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License"),
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

export const colors = {
	dark: {
		foreground: '#fff',
		background: '#4d5057',
		soft: {
			foreground: '#ddd',
			background: '#64686a',
		},
		disabled: {
			foreground: '#787c7f',
			background: '#3a3c41',
		},
	},
	light: {
		foreground: '#666',
		background: '#fff',
		soft: {
			foreground: '#b3b3b3',
		},
		disabled: {
			foreground: '#787c7f',
			background: '#d5d5d5',
		},
	},
	default: {
		foreground: '#b3b3b3',
		background: '#ececec',
	},
	primary: {
		foreground: '#fff',
		// Deck UI --primary: hsl(276 54% 45%)
		background: '#7F35B2',
		// Shades in the shape the old UI library used; the primitives in
		// components/ui read main (fills, links, checkboxes) and dark (hover)
		main: '#7F35B2',
		light: '#9b4ed1',
		dark: '#6a2b96',
		semilight: '#d9b3f2',
	},
	secondary: {
		foreground: '#000',
		background: '#ddd',
		// Base colour of outline and plain buttons and of table rows in
		// components/ui
		main: '#fff',
	},
	warning: {
		foreground: '#fff',
		background: '#fca321',
	},
	danger: {
		foreground: '#fff',
		background: '#d9534f',
	},
	success: {
		foreground: '#fff',
		background: '#5fb835',
	},
};

// Handed to styled-components' ThemeProvider for components that read
// `props.theme`
export const theme = {
	colors,
	font: 'SourceSansPro',
};
