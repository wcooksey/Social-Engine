import {
  Component,
  ContentChildren,
  EventEmitter,
  Input,
  Output,
  QueryList,
  TemplateRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DataTableCellDirective } from './data-table-cell.directive';
import { DataTableColumn, DataTableSort } from './data-table.types';

/**
 * Standardized data table for the app. Provides the one shared (dense) table
 * look, plus opt-in row selection + bulk-action slot, sortable headers, and
 * loading/empty/footer states. Cells are supplied by the host via per-column
 * <ng-template appDataCell="key"> templates, so each page keeps full control of
 * its cell content (switches, inline edits, links, pills) while sharing styling.
 */
@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './data-table.component.html',
  styleUrls: ['./data-table.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DataTableComponent<T = any> {
  @Input() columns: DataTableColumn[] = [];
  @Input() rows: T[] | null = [];

  /** trackBy for the row loop. Defaults to the row's rowKey. */
  @Input() trackBy: (index: number, row: T) => any = (index, row) => this.rowKey(row) ?? index;

  /** How to derive a stable string id for a row (used by selection). */
  @Input() rowKey: (row: T) => string = (row: any) => row?.id;

  @Input() loading = false;
  @Input() emptyText = 'No records found';

  /** Minimum table width before horizontal scroll kicks in (keeps columns readable on mobile). */
  @Input() minWidth: string | null = '720px';

  /** Make whole rows clickable (emits rowClick). */
  @Input() clickableRows = false;

  /** Optional per-row CSS class (e.g. to dim inactive rows). Must be a global
   *  class since the row is rendered inside this component. */
  @Input() rowClass: (row: T, index: number) => string | null = () => null;

  // ---- Selection ----
  @Input() selectable = false;
  /** Render the built-in bulk-actions bar (count + [dataTableBulkActions] slot).
   *  Set false when the host renders its own external bulk bar. */
  @Input() showBulkBar = true;
  @Input() selectedIds: Set<string> = new Set<string>();
  @Output() selectedIdsChange = new EventEmitter<Set<string>>();
  @Output() selectionChange = new EventEmitter<string[]>();

  // ---- Sorting ----
  /** Show sort controls + emit sortChange. */
  @Input() sort: DataTableSort | null = null;
  /** When true (default) the table sorts its own rows; set false when the host
   *  sorts/paginates externally (it then just reflects sort state + emits). */
  @Input() clientSort = true;
  @Output() sortChange = new EventEmitter<DataTableSort | null>();

  @Output() rowClick = new EventEmitter<T>();

  @ContentChildren(DataTableCellDirective) cellTemplates!: QueryList<DataTableCellDirective>;

  get visibleColumns(): DataTableColumn[] {
    return (this.columns || []).filter((c) => !c.hidden);
  }

  get colspan(): number {
    return this.visibleColumns.length + (this.selectable ? 1 : 0);
  }

  get displayRows(): T[] {
    const rows = this.rows || [];
    if (!this.clientSort || !this.sort) return rows;
    const { key, direction } = this.sort;
    const dir = direction === 'desc' ? -1 : 1;
    // Copy so we never mutate the caller's array.
    return [...rows].sort((a, b) => {
      const av = (a as any)?.[key];
      const bv = (b as any)?.[key];
      if (av == null && bv == null) return 0;
      if (av == null) return -1 * dir;
      if (bv == null) return 1 * dir;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
    });
  }

  templateFor(key: string): TemplateRef<any> | null {
    const match = this.cellTemplates?.find((t) => t.key === key);
    return match ? match.template : null;
  }

  cellValue(row: T, key: string): any {
    return (row as any)?.[key];
  }

  // ---- Sorting handlers ----
  onSort(column: DataTableColumn): void {
    if (!column.sortable) return;
    const next: DataTableSort =
      this.sort?.key === column.key && this.sort.direction === 'asc'
        ? { key: column.key, direction: 'desc' }
        : { key: column.key, direction: 'asc' };
    this.sort = next;
    this.sortChange.emit(next);
  }

  sortIcon(column: DataTableColumn): string {
    if (!column.sortable) return '';
    if (this.sort?.key !== column.key) return 'bi-arrow-down-up';
    return this.sort.direction === 'asc' ? 'bi-sort-down-alt' : 'bi-sort-up-alt';
  }

  // ---- Selection handlers ----
  isSelected(row: T): boolean {
    return this.selectedIds.has(this.rowKey(row));
  }

  toggleRow(row: T, checked: boolean): void {
    const next = new Set(this.selectedIds);
    const id = this.rowKey(row);
    if (checked) next.add(id);
    else next.delete(id);
    this.emitSelection(next);
  }

  get allSelected(): boolean {
    const rows = this.rows || [];
    return rows.length > 0 && rows.every((r) => this.selectedIds.has(this.rowKey(r)));
  }

  get someSelected(): boolean {
    const rows = this.rows || [];
    return rows.some((r) => this.selectedIds.has(this.rowKey(r))) && !this.allSelected;
  }

  toggleAll(checked: boolean): void {
    const next = new Set(this.selectedIds);
    for (const row of this.rows || []) {
      const id = this.rowKey(row);
      if (checked) next.add(id);
      else next.delete(id);
    }
    this.emitSelection(next);
  }

  private emitSelection(next: Set<string>): void {
    this.selectedIds = next;
    this.selectedIdsChange.emit(next);
    this.selectionChange.emit([...next]);
  }

  onRowClick(row: T): void {
    if (this.clickableRows) this.rowClick.emit(row);
  }
}
