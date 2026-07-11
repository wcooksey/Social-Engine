export type DataTableAlign = 'left' | 'right' | 'center';

export interface DataTableColumn {
  /** Unique id. Also used to match a cell template and, as a fallback, to read row[key]. */
  key: string;
  /** Header label. */
  header: string;
  /** Text alignment for header + cells. Default 'left'. */
  align?: DataTableAlign;
  /** Show a clickable sort control on this column's header. */
  sortable?: boolean;
  /** Optional fixed width, e.g. '40px' or '18%'. */
  width?: string;
  /** Extra class(es) applied to the <th>. */
  headerClass?: string;
  /** Extra class(es) applied to each <td> in this column. */
  cellClass?: string;
  /** Hide the column without removing it from the config. */
  hidden?: boolean;
}

export interface DataTableSort {
  key: string;
  direction: 'asc' | 'desc';
}
