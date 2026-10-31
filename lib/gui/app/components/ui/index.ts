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

// The app's own UI primitives, which replaced a deprecated third-party UI
// library. They keep that library's component names and the props the app
// uses, so call sites read the same.

export type { BoxProps, FlexProps } from './box';
export { Box, Flex } from './box';
export type { ButtonProps } from './button';
export { Button, deckGradient } from './button';
export type { CheckboxProps } from './checkbox';
export { Checkbox } from './checkbox';
export type { ModalProps } from './modal';
export { Modal } from './modal';
export type { ProgressBarProps, SpinnerProps } from './progress';
export { ProgressBar, Spinner } from './progress';
export { font, palette } from './system';
export type { TableColumn, TableProps } from './table';
export { Table } from './table';
export type { BadgeProps, LinkProps, TxtProps } from './txt';
export { Badge, Link, Txt } from './txt';
