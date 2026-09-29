import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { CardComponent } from '../../shared/components/card/card.component';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle.component';

@Component({
  selector: 'app-crm-accept',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonComponent, InputComponent, CardComponent, ThemeToggleComponent],
  styleUrl: './crm.component.scss',
  template: `
    <header class="crm-header">
      <a routerLink="/crm/login" class="brand"><img src="assets/brand/neuralnetics-mark-256.png" alt=""><span>Neuralnetics</span><span class="brand-context">Calling CRM</span></a>
      <app-theme-toggle></app-theme-toggle>
    </header>
    <main class="accept-page">
      <app-card padding="lg">
        <h1>Join the calling CRM</h1>
        <p class="accept-intro">Create your caller login to access the groups shared with you.</p>
        <p role="alert" class="message message--error" *ngIf="error">{{error}}</p>
        <div *ngIf="done" class="accept-form">
          <p role="status">Your account is ready.</p>
          <app-button link="/crm/login">Sign in to the CRM</app-button>
        </div>
        <form *ngIf="!done" class="accept-form" #inviteForm="ngForm" (ngSubmit)="inviteForm.valid && accept()">
          <app-input label="First name" name="first" [(ngModel)]="firstName" [required]="true" [maxlength]="100" autocomplete="given-name"></app-input>
          <app-input label="Last name" name="last" [(ngModel)]="lastName" [maxlength]="100" autocomplete="family-name"></app-input>
          <app-input label="Password" name="password" [(ngModel)]="password" type="password" [required]="true" [minlength]="12" [maxlength]="72" autocomplete="new-password" helperText="Use at least 12 characters."></app-input>
          <app-button type="submit" [disabled]="!!inviteForm.invalid" [loading]="saving" [fullWidth]="true">Create caller account</app-button>
        </form>
      </app-card>
    </main>
  `,
})
export class CrmAcceptComponent {
  api = inject(ApiService);
  firstName = ''; lastName = ''; password = ''; error = ''; done = false; saving = false;
  private token = location.hash.slice(1);
  constructor() { history.replaceState(null, '', location.pathname); }
  accept() {
    if (this.saving) return;
    this.saving = true; this.error = '';
    this.api.post('/api/crm/accept-invite', { token: this.token, firstName: this.firstName, lastName: this.lastName, password: this.password }).subscribe({
      next: () => { this.done = true; this.saving = false; this.password = ''; },
      error: e => { this.error = e.error?.error || 'Could not accept invitation'; this.saving = false; },
    });
  }
}
