import { Component, Input, Output, EventEmitter, forwardRef } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { CommonModule } from '@angular/common';

export interface SelectOption {
  label: string;
  value: any;
}

@Component({
  selector: 'app-select',
  standalone: true,
  imports: [CommonModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SelectComponent),
      multi: true
    }
  ],
  templateUrl: './select.component.html',
  styleUrl: './select.component.scss'
})
export class SelectComponent implements ControlValueAccessor {
  @Input() label?: string;
  @Input() placeholder: string = 'Select an option...';
  @Input() required: boolean = false;
  @Input() disabled: boolean = false;
  @Input() error?: string | null;
  @Input() helperText?: string;
  @Input() options: SelectOption[] = [];
  @Input() icon?: string;
  @Input() size: 'sm' | 'md' = 'md';
  /** Render the leading empty/placeholder <option>. Set false when every value
   *  maps to a real option (e.g. an "All" filter or an always-set picker). */
  @Input() showPlaceholderOption = true;
  @Output() selectionChange = new EventEmitter<any>();

  value: any = null;

  private onChange = (value: any) => {};
  private onTouched = () => {};

  writeValue(value: any): void {
    this.value = value;
  }

  registerOnChange(fn: (value: any) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  onSelectionChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.value = target.value === '' ? null : target.value;
    this.onChange(this.value);
    this.selectionChange.emit(this.value);
  }

  onBlur(): void {
    this.onTouched();
  }
}
