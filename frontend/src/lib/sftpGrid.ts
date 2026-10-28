import { COLUMN_MIN_WIDTHS, type SftpColumn } from "./sftpEntries";

const COLUMN_FLEX: Record<SftpColumn, number> = {
  modified: 1,
  size: 0.7,
  kind: 0.55,
  owner: 0.8,
  group: 0.8,
  permissions: 0.8,
};

export function sftpNameTrack(nameMin: number): string {
  return `minmax(${nameMin}px, 2.2fr)`;
}

export function sftpColumnTrack(column: SftpColumn, width: number): string {
  const minimum = Math.max(COLUMN_MIN_WIDTHS[column], width);
  return `minmax(${minimum}px, ${COLUMN_FLEX[column]}fr)`;
}

export function sftpGridMinWidth(nameMin: number, columns: readonly SftpColumn[], widths: Record<SftpColumn, number>): number {
  return nameMin + 20 + columns.reduce((total, column) => total + Math.max(COLUMN_MIN_WIDTHS[column], widths[column]) + 16, 0);
}
