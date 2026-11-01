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

// A table of rows with an optional checkbox column (with select-all in the
// header) and clickable rows. It is laid out with divs carrying
// `data-display='table-head' | 'table-body' | 'table-row' | 'table-cell'`
// and `data-highlight`, which the table styles in styled-components.tsx and
// the drive selector target.

import { get } from 'lodash';
import * as React from 'react';
import styled from 'styled-components';

import { Box, Flex } from './box';
import { Checkbox } from './checkbox';
import { colors } from '../../theme';
import { palette } from './system';

export interface TableColumn<T> {
	field: Extract<keyof T, string> | string;
	// Tells apart several columns built from the same field
	key?: string;
	label?: string | JSX.Element;
	render?: (value: any, row: T) => React.ReactNode;
}

export interface TableProps<T> {
	columns: Array<TableColumn<T>>;
	data?: T[];
	// Field whose value identifies a row; needed for checkboxes and row clicks
	rowKey?: keyof T;
	checkedItems?: T[];
	// Adds the checkbox column; called with the checked rows on every change
	onCheck?: (checkedItems: T[]) => void;
	onRowClick?: (row: T, event: React.MouseEvent<HTMLAnchorElement>) => void;
	// rowKey values of rows whose checkbox is disabled
	disabledRows?: string[];
	getRowClass?: (row: T) => string[];
	className?: string;
}

type CheckedState = 'none' | 'some' | 'all';

interface TableState<T> {
	checkedItems: T[];
	checkedState: CheckedState;
	lastSelected: any;
}

const FIRST_COLUMN_WIDTH = '60px';

const Wrapper = styled.div`
	overflow-x: auto;
	max-width: 100%;
	border-bottom: 1px solid ${palette.quartenary};
`;

// Rows highlight on hover only when they react to clicks or have checkboxes
const highlight = `background-color: ${palette.infoLight};`;

const Base = styled.div<{ hasRowClick: boolean; hasCheckbox: boolean }>`
	display: table;
	width: 100%;
	border-spacing: 0;

	> [data-display='table-head'] {
		display: table-header-group;
		background-color: ${palette.quartenarySemilight};

		> [data-display='table-row'] {
			display: table-row;
			height: 42px;

			> [data-display='table-cell'] {
				display: table-cell;
				border-bottom: 1px solid ${palette.quartenary};
				text-align: left;
				vertical-align: middle;
				padding: 5px 20px;
				font-size: 14px;
				font-weight: normal;
				white-space: nowrap;
			}
		}
	}

	> [data-display='table-body'] {
		display: table-row-group;

		> [data-display='table-row'] {
			display: table-row;
			height: 50px;
			text-decoration: none;
			color: ${colors.secondary.main};
			background-color: #fff;
			font-size: 14px;

			> [data-display='table-cell'] {
				display: table-cell;
				text-align: left;
				vertical-align: middle;
				padding: 5px 20px;
				text-decoration: none;
				color: inherit;
				white-space: nowrap;
			}

			> a[data-display='table-cell'] {
				cursor: ${(props) => (props.hasRowClick ? 'pointer' : 'auto')};
			}

			&:nth-of-type(even) {
				background-color: ${palette.quartenaryLight};
			}

			&:hover {
				text-decoration: none;
				${(props) => (props.hasRowClick || props.hasCheckbox ? highlight : '')}
			}

			&[data-highlight='true'] {
				${highlight}

				> [data-display='table-cell']:first-child {
					box-shadow: inset 3px 0px 0 ${palette.info};
				}
			}
		}
	}

	> [data-display='table-head'] > [data-display='table-row'],
	> [data-display='table-body'] > [data-display='table-row'] {
		${(props) =>
			props.hasCheckbox
				? `
		> [data-display='table-cell']:first-child {
			width: ${FIRST_COLUMN_WIDTH};
		}`
				: `
		> [data-display='table-cell']:first-child {
			padding-left: 40px;
		}

		> [data-display='table-cell']:last-child {
			padding-right: 40px;
		}`}
	}

	${(props) =>
		props.hasCheckbox
			? `
	max-width: calc(100% - ${FIRST_COLUMN_WIDTH});
	margin-left: ${FIRST_COLUMN_WIDTH};

	> [data-display='table-head'] > [data-display='table-row'] > [data-display='table-cell'],
	> [data-display='table-body'] > [data-display='table-row'] > [data-display='table-cell'] {
		&:first-child {
			position: absolute;
			left: 0;
			display: flex;
			align-items: center;
			width: ${FIRST_COLUMN_WIDTH};
			height: inherit;
			z-index: 3;
			background-color: inherit;

			> input[type='checkbox'] {
				margin: 0;
			}
		}
	}

	> [data-display='table-head'] > [data-display='table-row'] > [data-display='table-cell']:first-child {
		background-color: ${palette.quartenarySemilight};
	}`
			: ''}
`;

const CheckboxCell = styled(Box)`
	display: inline-block;
	vertical-align: middle;
`;

function renderField<T>(row: T, column: TableColumn<T>) {
	const value = get(row, column.field);
	if (column.render) {
		return column.render(value, row);
	}
	return value == null ? '' : value;
}

export class Table<T extends object> extends React.Component<
	TableProps<T>,
	TableState<T>
> {
	constructor(props: TableProps<T>) {
		super(props);
		this.state = {
			lastSelected: null,
			...this.getSelectedRows(props.checkedItems ?? []),
		};
	}

	public componentDidUpdate(prevProps: TableProps<T>) {
		const { checkedItems, data, rowKey } = this.props;
		if (
			checkedItems &&
			(prevProps.checkedItems !== checkedItems ||
				prevProps.rowKey !== rowKey ||
				prevProps.data !== data)
		) {
			this.setRowSelection(checkedItems);
		}
	}

	private identifier(row: T) {
		return this.props.rowKey === undefined
			? undefined
			: (row as any)[this.props.rowKey];
	}

	// Keeps only the checked rows still present in data, preserving the given
	// array when nothing was dropped
	private getSelectedRows(selected: T[]) {
		const { data, rowKey } = this.props;
		const keys = new Set(selected.map((row) => this.identifier(row)));
		const found =
			!data || rowKey === undefined || keys.size === 0
				? []
				: data.filter((row) => keys.has(this.identifier(row)));
		const changed =
			found.length !== selected.length ||
			found.some((row, i) => row !== selected[i]);
		const checkedItems = changed ? found : selected;
		return { checkedItems, checkedState: this.countChecked(checkedItems) };
	}

	private setRowSelection(selected: T[]) {
		const next = this.getSelectedRows(selected);
		const changed = next.checkedItems !== this.state.checkedItems;
		this.setState(next);
		if (this.props.onCheck && changed) {
			this.props.onCheck(next.checkedItems);
		}
	}

	private countChecked(checkedItems: T[]): CheckedState {
		const { data, rowKey } = this.props;
		if (rowKey === undefined || !data) {
			return 'none';
		}
		return data.length === checkedItems.length
			? 'all'
			: checkedItems.length > 0
				? 'some'
				: 'none';
	}

	private checkedIdentifiers() {
		return new Set(this.state.checkedItems.map((row) => this.identifier(row)));
	}

	private findRow(key: string | undefined) {
		const { data, rowKey } = this.props;
		if (!data || key === undefined) {
			return;
		}
		if (rowKey !== undefined) {
			return data.find((row) => `${this.identifier(row)}` === key);
		}
		return data[Number(key)];
	}

	// Checking with select-all picks every row whose checkbox is enabled;
	// unchecking clears them all
	private toggleAllChecked = () => {
		const { data, rowKey, onCheck, disabledRows } = this.props;
		let checkedItems: T[] = [];
		if (data && this.state.checkedItems.length === 0) {
			const disabled = new Set(disabledRows);
			checkedItems =
				rowKey !== undefined && disabled.size > 0
					? data.filter((row) => !disabled.has(this.identifier(row)))
					: data.slice();
		}
		const checkedState = this.countChecked(checkedItems);
		onCheck?.(checkedItems);
		this.setState({ lastSelected: null, checkedState, checkedItems });
	};

	// Shift-click checks or unchecks the whole range since the previous click
	private toggleChecked = (event: React.ChangeEvent<HTMLInputElement>) => {
		const { rowKey, data, checkedItems: checkedProp, onCheck } = this.props;
		const row = this.findRow(event.currentTarget.dataset.key);
		if (rowKey === undefined || !data || row === undefined) {
			return;
		}
		const identifier = this.identifier(row);
		const check = !this.checkedIdentifiers().has(identifier);
		const stored = checkedProp || this.state.checkedItems;
		const checked = new Map(stored.map((r) => [this.identifier(r), r]));
		const shiftKey = (event.nativeEvent as MouseEvent).shiftKey;
		let keysToFind = [identifier];
		if (this.state.lastSelected != null && shiftKey) {
			keysToFind.push(this.state.lastSelected);
		}
		for (let i = 0; i < data.length && keysToFind.length > 0; i++) {
			const current = this.identifier(data[i]);
			let found = false;
			if (keysToFind.includes(current)) {
				keysToFind = keysToFind.filter((key) => key !== current);
				found = true;
			}
			if (
				found ||
				(shiftKey && keysToFind.length === 1 && this.state.lastSelected != null)
			) {
				if (check && !checked.has(current)) {
					checked.set(current, data[i]);
				} else if (!check && checked.has(current)) {
					checked.delete(current);
				}
			}
		}
		const checkedItems = Array.from(checked.values());
		onCheck?.(checkedItems);
		this.setState({
			lastSelected: identifier,
			checkedState: this.countChecked(checkedItems),
			checkedItems,
		});
	};

	private onRowClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
		const row = this.findRow(event.currentTarget.dataset.key);
		if (this.props.onRowClick && row !== undefined) {
			this.props.onRowClick(row, event);
		}
	};

	public render() {
		const {
			columns,
			data = [],
			onCheck,
			onRowClick,
			getRowClass,
			disabledRows,
			className,
		} = this.props;
		const { checkedState, checkedItems } = this.state;
		const checked = this.checkedIdentifiers();
		const disabled = new Set(disabledRows);
		const selectedCount =
			checkedState === 'all' ? data.length : checkedItems.length;
		return (
			<Flex style={{ position: 'relative' }}>
				<Flex flexDirection="column" flex="1" width="100%">
					<Wrapper>
						<Base
							className={className}
							hasRowClick={!!onRowClick}
							hasCheckbox={!!onCheck}
						>
							<div data-display="table-head">
								<div data-display="table-row">
									{onCheck && (
										<CheckboxCell
											data-display="table-cell"
											tooltip={`Selected: ${selectedCount}`}
										>
											<Checkbox
												checked={checkedState === 'all'}
												indeterminate={checkedState === 'some'}
												onChange={this.toggleAllChecked}
											/>
										</CheckboxCell>
									)}
									{columns.map((column) => (
										<div
											data-display="table-cell"
											key={column.key || column.field}
										>
											{column.label || column.field}
										</div>
									))}
								</div>
							</div>
							<div data-display="table-body">
								{data.map((row, i) => {
									const identifier = this.identifier(row);
									const key = identifier ?? i;
									const isChecked =
										checkedState === 'all' ||
										(!!onCheck && checked.has(identifier));
									return (
										<div
											data-display="table-row"
											data-highlight={isChecked}
											className={getRowClass?.(row).join(' ') ?? ''}
											key={key}
										>
											{onCheck && (
												<CheckboxCell data-display="table-cell">
													<Checkbox
														checked={isChecked}
														disabled={disabled.has(identifier)}
														data-key={key}
														onChange={this.toggleChecked}
													/>
												</CheckboxCell>
											)}
											{columns.map((column) => (
												<a
													data-display="table-cell"
													data-key={key}
													onClick={this.onRowClick}
													key={column.key || column.field}
												>
													{renderField(row, column)}
												</a>
											))}
										</div>
									);
								})}
							</div>
						</Base>
					</Wrapper>
				</Flex>
			</Flex>
		);
	}
}
