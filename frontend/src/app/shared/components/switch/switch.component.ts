import { Component, Input, Output, EventEmitter, forwardRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Component({
  selector: 'app-switch',
  standalone: true,
  imports: [CommonModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SwitchComponent),
      multi: true
    }
  ],
  templateUrl: './switch.component.html',
  styleUrls: ['./switch.component.scss']
})
export class SwitchComponent implements ControlValueAccessor {
  @Input() label?: string;
  @Input() disabled: boolean = false;
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  
  value: boolean = false;
  private onChange = (value: boolean) => {};
  private onTouched = () => {};

  @Output() valueChange = new EventEmitter<boolean>();

  toggle(): void {
    if (this.disabled) return;
    
    this.value = !this.value;
    this.onChange(this.value);
    this.valueChange.emit(this.value);
  }

  // ControlValueAccessor implementation
  writeValue(value: boolean): void {
    this.value = value ?? false;
  }

  registerOnChange(fn: (value: boolean) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  getSwitchClasses(): string {
    const classes = ['switch'];
    classes.push(`switch--${this.size}`);
    if (this.value) classes.push('switch--checked');
    if (this.disabled) classes.push('switch--disabled');
    return classes.join(' ');
  }
}

