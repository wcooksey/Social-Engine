import {
  AfterViewChecked,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  forwardRef,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { CommonModule } from '@angular/common';

export interface SelectOption {
  label: string;
  value: any;
  disabled?: boolean;
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
export class SelectComponent implements ControlValueAccessor, AfterViewChecked {
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

  @ViewChild('selectEl') selectEl?: ElementRef<HTMLSelectElement>;

  private onChange = (value: any) => {};
  private onTouched = () => {};

  writeValue(value: any): void {
    this.value = value;
  }

  /**
   * Re-apply the model value once the options actually exist.
   *
   * `[value]` on a <select> only takes when a matching <option> is already in
   * the DOM. Options usually arrive from an async fetch AFTER the value is set
   * (restoring a filter from the URL, say), and Angular does not re-run the
   * binding because the value itself never changed — so the control silently
   * fell back to the placeholder while the page was genuinely filtered. A
   * dropdown reading "All groups" over a filtered list is worse than no
   * dropdown at all.
   *
   * Guarded on a real mismatch AND on the option existing, so this is a string
   * compare per cycle and never fights a value the list cannot represent.
   */
  ngAfterViewChecked(): void {
    const el = this.selectEl?.nativeElement;
    if (!el) return;
    const desired = this.value == null ? '' : String(this.value);
    if (el.value === desired) return;
    if (desired !== '' && !this.options.some((o) => String(o.value) === desired)) return;
    el.value = desired;
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
