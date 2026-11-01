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

// A dialog drawn over the page with a cancel and an action button. Escape or
// a click outside it cancels, Enter confirms; with dialogs stacked, only the
// most recently opened one listens.
//
// The element nesting (layer > container > sizer > padded box > title,
// children, buttons) is what the full-window Modal in styled-components.tsx
// styles with child selectors, so keep it as it is.

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import styled from 'styled-components';

import type { ButtonProps } from './button';
import { Button } from './button';
import { Box, Flex } from './box';
import { font, palette, space } from './system';

export interface ModalProps {
	title?: React.ReactNode;
	// Accepted but not drawn, as before the port: the dialogs that pass these
	// were laid out without a heading
	titleElement?: React.ReactNode;
	titleDetails?: React.ReactNode;
	width?: number | string;
	position?: 'center' | 'top';
	style?: React.CSSProperties;
	className?: string;
	id?: string;
	children?: React.ReactNode;
	// Called by Cancel, Escape and a click outside; without it those call done
	cancel?: () => void;
	done: () => any;
	// Label of the action button, "OK" when left out
	action?: React.ReactNode;
	primaryButtonProps?: ButtonProps;
	cancelButtonProps?: ButtonProps;
}

// Room left above a top-aligned dialog for the window header
const HEADER_HEIGHT = 40;
// Gap kept between the dialog and the window edges
const MARGIN = 12;
const DEFAULT_WIDTH = 700;

const Layer = styled.div`
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 4999;
	box-sizing: border-box;
	background: transparent;
	font-family: ${font};
	line-height: 1.5;
	pointer-events: none;
	outline: none;
	-webkit-text-size-adjust: 100%;
	-webkit-font-smoothing: antialiased;
`;

// Catches clicks outside the dialog; transparent, so the page stays undimmed
const Overlay = styled.div`
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	pointer-events: all;
`;

const Container = styled.div<{ placement: 'center' | 'top' }>`
	position: absolute;
	display: flex;
	flex-direction: column;
	min-height: 48px;
	max-height: calc(100% - ${2 * MARGIN}px);
	max-width: calc(100% - ${2 * MARGIN}px);
	border-radius: 4px;
	background: #fff;
	outline: none;
	pointer-events: all;
	z-index: 5000;
	left: 50%;
	${(props) =>
		props.placement === 'top'
			? `top: ${MARGIN}px; transform: translate(-50%, 0);`
			: 'top: 50%; transform: translate(-50%, -50%);'}
`;

const Sizer = styled(Box)`
	overflow-y: auto;
`;

const Padding = styled(Box)`
	padding: ${space[3]}px;

	@media screen and (min-width: 576px) {
		padding: 40px 50px 30px;
	}
`;

const Heading = styled.h3`
	margin: 0 0 ${space[4]}px;
	font-size: 24px;
	font-weight: normal;
`;

// Open dialogs, most recent last
const stack: object[] = [];

export class Modal extends React.Component<ModalProps> {
	private readonly token = {};
	private submitting = false;
	private container = React.createRef<HTMLDivElement>();
	// Focus goes back here on close, as it did with the old UI library's modal
	private previousFocus: Element | null = null;

	public componentDidMount() {
		this.previousFocus = document.activeElement;
		stack.push(this.token);
		window.addEventListener('keydown', this.handleKeyDown);
		// Move focus into the dialog so Tab starts inside it
		if (!this.container.current?.contains(document.activeElement)) {
			this.container.current?.focus();
		}
	}

	public componentWillUnmount() {
		stack.splice(stack.indexOf(this.token), 1);
		window.removeEventListener('keydown', this.handleKeyDown);
		// Deferred by a tick, as the old modal did
		const previous = this.previousFocus;
		if (previous instanceof HTMLElement) {
			setTimeout(() => previous.focus(), 0);
		}
	}

	private isTop() {
		return stack[stack.length - 1] === this.token;
	}

	private handleKeyDown = (event: KeyboardEvent) => {
		if (!this.isTop() || event.defaultPrevented) {
			return;
		}
		if (event.key === 'Escape') {
			this.dismiss();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			if (!this.props.primaryButtonProps?.disabled && !this.submitting) {
				this.done();
			}
		}
	};

	private done = async () => {
		try {
			this.submitting = true;
			await this.props.done();
		} finally {
			this.submitting = false;
		}
	};

	private dismiss = () => {
		if (this.isTop()) {
			(this.props.cancel || this.done)();
		}
	};

	public render() {
		const {
			title,
			width,
			position = 'center',
			style,
			className,
			id,
			children,
			cancel,
			action,
			cancelButtonProps,
			primaryButtonProps,
		} = this.props;
		// A warning action goes first so it is not mistaken for the safe choice
		const reorder = primaryButtonProps?.warning === true;
		return ReactDOM.createPortal(
			<Layer tabIndex={-1}>
				<Overlay onClick={this.dismiss} />
				<Container
					ref={this.container}
					tabIndex={-1}
					placement={position}
					style={{
						marginTop: position === 'top' ? HEADER_HEIGHT : undefined,
						color: palette.text,
					}}
				>
					<Sizer
						width={width || DEFAULT_WIDTH}
						maxWidth="100%"
						onClick={(event: React.MouseEvent) => event.stopPropagation()}
						style={style}
						id={id}
						className={className}
					>
						<Padding>
							{!!title && <Heading>{title}</Heading>}
							{children}
							<Flex mt={5} alignItems="center" justifyContent="flex-end">
								{cancel && (
									<Button ml={3} {...cancelButtonProps} onClick={cancel}>
										{cancelButtonProps?.children || 'Cancel'}
									</Button>
								)}
								<Button
									primary
									ml={3}
									{...primaryButtonProps}
									style={{
										...(reorder && { order: -1 }),
										...primaryButtonProps?.style,
									}}
									onClick={this.done}
								>
									{action || 'OK'}
								</Button>
							</Flex>
						</Padding>
					</Sizer>
				</Container>
			</Layer>,
			document.body,
		);
	}
}
