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

// Hover tooltips: one shared black bubble rendered under document.body and
// positioned next to whatever element is hovered, so tooltips are never
// clipped by a scrolling container or a modal

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import styled from 'styled-components';

type Placement = 'top' | 'right' | 'bottom' | 'left';

export type TooltipProp =
	| string
	| {
			text: string;
			placement?: Placement;
			trigger?: 'hover' | 'click';
	  };

export interface TooltipProps {
	tooltip?: TooltipProp;
}

const TARGET_OFFSET = 3;
const CLICK_TIMEOUT = 1000;

const arrowStyle = `
	position: absolute;
	width: 0;
	height: 0;
	border-color: transparent;
	border-style: solid;
`;

const arrows: { [key in Placement]: ReturnType<typeof styled.div> } = {
	top: styled.div`
		${arrowStyle}
		bottom: 0;
		left: 50%;
		margin-left: -5px;
		border-width: 5px 5px 0;
		border-top-color: #000;
	`,
	right: styled.div`
		${arrowStyle}
		top: 50%;
		left: 0;
		margin-top: -5px;
		border-width: 5px 5px 5px 0;
		border-right-color: #000;
	`,
	bottom: styled.div`
		${arrowStyle}
		top: 0;
		left: 50%;
		margin-left: -5px;
		border-width: 0 5px 5px;
		border-bottom-color: #000;
	`,
	left: styled.div`
		${arrowStyle}
		top: 50%;
		right: 0;
		margin-top: -5px;
		border-width: 5px 0 5px 5px;
		border-left-color: #000;
	`,
};

const Bubble = styled.div`
	display: block;
	position: absolute;
	z-index: 10000;
	max-width: 300px;
	padding: 5px;
	font-size: 12px;
	font-style: normal;
	font-weight: 400;
	line-height: 1.42857143;
	letter-spacing: normal;
	text-align: start;
	text-decoration: none;
	text-shadow: none;
	text-transform: none;
	white-space: normal;
	word-break: normal;
	word-spacing: normal;
	color: white;
`;

const BubbleInner = styled.div`
	background: black;
	border-radius: 4px;
	padding: 3px 8px;
	text-align: center;
`;

interface LayerState {
	show: boolean;
	placement: Placement;
	top: number;
	left: number;
}

class TooltipLayer extends React.Component<object, LayerState> {
	private bubble: HTMLDivElement | null = null;
	private inner: HTMLDivElement | null = null;
	private observer?: MutationObserver;

	public state: LayerState = {
		show: false,
		placement: 'top',
		top: 0,
		left: 0,
	};

	public show(target: HTMLElement, text: string, placement: Placement) {
		this.observer?.disconnect();
		// Hide when the hovered element leaves the document, since it then
		// never fires mouseleave
		this.observer = new MutationObserver(() => {
			if (!document.contains(target)) {
				this.hide();
			}
		});
		this.observer.observe(document, { childList: true, subtree: true });

		// The text is written straight into the DOM so the bubble can be
		// measured before it is positioned
		if (this.inner) {
			this.inner.innerText = text;
		}
		const width = this.bubble?.clientWidth ?? 0;
		const height = this.bubble?.clientHeight ?? 0;
		const rect = target.getBoundingClientRect();
		const top = rect.top + window.scrollY;
		const left = rect.left + window.scrollX;
		const position = {
			top: {
				top: top - height - TARGET_OFFSET,
				left: left + rect.width / 2 - width / 2,
			},
			right: {
				top: top + rect.height / 2 - height / 2,
				left: left + rect.width + TARGET_OFFSET,
			},
			bottom: {
				top: top + rect.height + TARGET_OFFSET,
				left: left + rect.width / 2 - width / 2,
			},
			left: {
				top: top + rect.height / 2 - height / 2,
				left: left - width - TARGET_OFFSET,
			},
		}[placement];
		this.setState({ show: true, placement, ...position });
	}

	public hide() {
		this.observer?.disconnect();
		this.observer = undefined;
		this.setState({ show: false, top: 0, left: 0 });
	}

	public render() {
		const Arrow = arrows[this.state.placement];
		return (
			<Bubble
				ref={(el: HTMLDivElement | null) => (this.bubble = el)}
				style={{
					top: this.state.top,
					left: this.state.left,
					visibility: this.state.show ? 'visible' : 'hidden',
				}}
			>
				<BubbleInner ref={(el: HTMLDivElement | null) => (this.inner = el)} />
				<Arrow />
			</Bubble>
		);
	}
}

let layer: TooltipLayer | null = null;
let hideOnMouseOut: HTMLElement | null = null;
let hideTimeout: number | undefined;

function getLayer(): TooltipLayer | null {
	if (layer === null && document?.body) {
		const root = document.createElement('div');
		root.id = 'tooltip-root';
		document.body.appendChild(root);
		// Disabled elements fire no mouseleave, so the bubble shown for one is
		// dropped as soon as the pointer is over anything else
		document.addEventListener('mouseover', (event) => {
			const target = event.target as Node;
			if (
				hideOnMouseOut === null ||
				hideOnMouseOut === target ||
				hideOnMouseOut.contains(target)
			) {
				return;
			}
			layer?.hide();
			hideOnMouseOut = null;
		});
		ReactDOM.render(
			<TooltipLayer
				ref={(instance: TooltipLayer | null) => (layer = instance)}
			/>,
			root,
		);
	}
	return layer;
}

type Handlers = Pick<
	React.DOMAttributes<HTMLElement>,
	'onClick' | 'onMouseEnter' | 'onMouseLeave'
>;

// Wraps the element's own handlers so it shows the tooltip
export function bindTooltip<P extends Handlers & { disabled?: boolean }>(
	tooltip: TooltipProp | undefined,
	props: P,
): P {
	const text = typeof tooltip === 'string' ? tooltip : tooltip?.text;
	if (!text) {
		return props;
	}
	const placement = (typeof tooltip === 'object' && tooltip.placement) || 'top';
	const trigger = (typeof tooltip === 'object' && tooltip.trigger) || 'hover';
	const show = (event: React.MouseEvent<HTMLElement>) =>
		getLayer()?.show(event.target as HTMLElement, text, placement);
	const bound: P = props.disabled ? ({} as P) : { ...props };
	if (trigger === 'click') {
		bound.onClick = (event) => {
			show(event);
			window.clearTimeout(hideTimeout);
			hideTimeout = window.setTimeout(() => getLayer()?.hide(), CLICK_TIMEOUT);
			props.onClick?.(event);
		};
	} else {
		bound.onMouseEnter = (event) => {
			show(event);
			props.onMouseEnter?.(event);
			if ((event.target as HTMLButtonElement).disabled) {
				hideOnMouseOut = event.target as HTMLElement;
			}
		};
		bound.onMouseLeave = (event) => {
			getLayer()?.hide();
			props.onMouseLeave?.(event);
		};
	}
	return bound;
}

// Adds the `tooltip` prop to a component. A disabled element receives no
// mouse events, so it is wrapped in a layout-neutral span that listens
// instead.
export function withTooltip<P extends Handlers & { disabled?: boolean }>(
	Component: React.ElementType,
) {
	const Base = Component as React.ComponentType<any>;
	const Wrapped = React.forwardRef<unknown, P & TooltipProps>(
		({ tooltip, ...rest }, ref) => {
			const props = rest as unknown as P;
			if (!tooltip) {
				return <Base {...props} ref={ref} />;
			}
			const handlers = bindTooltip(tooltip, props);
			if (props.disabled) {
				return (
					<span
						style={{ display: 'contents' }}
						onClick={handlers.onClick}
						onMouseEnter={handlers.onMouseEnter}
						onMouseLeave={handlers.onMouseLeave}
					>
						<Base {...props} ref={ref} />
					</span>
				);
			}
			return <Base {...handlers} ref={ref} />;
		},
	);
	Wrapped.displayName = `withTooltip(${(Component as any).displayName || (Component as any).name || 'Component'})`;
	return Wrapped;
}
