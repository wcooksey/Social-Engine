import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LeadGroupsService } from '../../core/services/lead-groups.service';
import { LeadGroup } from '../../core/models/lead.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-groups',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent, ButtonComponent, InputComponent, DialogComponent],
  templateUrl: './groups.component.html',
  styleUrl: './groups.component.scss'
})
export class GroupsComponent implements OnInit {
  groups = signal<LeadGroup[]>([]);
  loading = signal(true);

  showDialog = signal(false);
  saving = signal(false);
  editingGroup: LeadGroup | null = null;
  form = { name: '', goal: '' };

  constructor(
    private leadGroupsService: LeadGroupsService,
    private router: Router,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.leadGroupsService.list().subscribe({
      next: (groups) => {
        this.groups.set(groups);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  openCreate(): void {
    this.editingGroup = null;
    this.form = { name: '', goal: '' };
    this.showDialog.set(true);
  }

  openEdit(group: LeadGroup, event: Event): void {
    event.stopPropagation();
    this.editingGroup = group;
    this.form = { name: group.name, goal: group.goal };
    this.showDialog.set(true);
  }

  submit(): void {
    if (!this.form.name.trim() || !this.form.goal.trim()) return;
    this.saving.set(true);

    const request$ = this.editingGroup
      ? this.leadGroupsService.update(this.editingGroup.id, this.form)
      : this.leadGroupsService.create(this.form);

    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.showDialog.set(false);
        this.toast.success(this.editingGroup ? 'Group updated' : 'Group created');
        this.load();
      },
      error: () => {
        this.saving.set(false);
        this.toast.error('Failed to save group');
      }
    });
  }

  viewLeads(group: LeadGroup): void {
    this.router.navigate(['/leads'], { queryParams: { groupId: group.id } });
  }
}
