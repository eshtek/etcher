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

import * as _ from 'lodash';
import { Theme } from 'rendition';

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
		// rendition's own components (modal action buttons, progress bars,
		// links, checkboxes) read main/light/dark/semilight and default to
		// blue unless every key is overridden
		main: '#7F35B2',
		light: '#9b4ed1',
		dark: '#6a2b96',
		semilight: '#d9b3f2',
	},
	secondary: {
		foreground: '#000',
		background: '#ddd',
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

const font = 'SourceSansPro';

export const theme = _.merge({}, Theme, {
	colors,
	font,
	header: {
		height: '40px',
	},
	global: {
		font: {
			family: font,
			size: 16,
		},
		text: {
			medium: {
				size: 16,
			},
		},
	},
	button: {
		border: {
			width: '0',
			// Deck UI rounded-lg
			radius: '8px',
		},
		disabled: {
			opacity: 1,
		},
		extend: (props: any) => `
			width: 200px;
			font-size: 16px;
			font-weight: 600;

			&& {
				width: 200px;
				height: 48px;
			}

			${
				props?.primary && !props?.plain
					? `
			:enabled {
				background-image: linear-gradient(135deg, #cb2eff, #7f35b2);
				background-color: #7f35b2;
			}

			:enabled:hover,
			:enabled:focus {
				background-image: none;
				background-color: #7f35b2;
			}
			`
					: ''
			}

			:disabled {
				background-image: none;
				background-color: ${colors.dark.disabled.background};
				color: ${colors.dark.disabled.foreground};
				opacity: 1;

				:hover {
					background-image: none;
					background-color: ${colors.dark.disabled.background};
					color: ${colors.dark.disabled.foreground};
				}
			}
		`,
	},
	layer: {
		extend: () => `
			> div:first-child {
				background-color: transparent;
			}
		`,
	},
});
