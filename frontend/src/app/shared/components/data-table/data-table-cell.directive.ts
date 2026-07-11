import { Directive, Input, TemplateRef } from '@angular/core';

/**
 * Marks an <ng-template> as the cell renderer for a given column key:
 *
 *   <ng-template appDataCell="role" let-row="row" let-value>
 *     <app-badge ...>{{ value }}</app-badge>
 *   </ng-template>
 *
 * Template context: $implicit = the cell value (row[key]), row = the full row,
 * index = the row index.
 */
@Directive({
  selector: 'ng-template[appDataCell]',
  standalone: true,
})
export class DataTableCellDirective {
  @Input('appDataCell') key!: string;

  constructor(public template: TemplateRef<{ $implicit: any; row: any; index: number }>) {}
}
