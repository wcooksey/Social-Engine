import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { debounceTime, distinctUntilChanged, Subject } from 'rxjs';
import { LeadsService } from '../../core/services/leads.service';
import { LeadGroupsService } from '../../core/services/lead-groups.service';
import { Lead, LeadGroup } from '../../core/models/lead.model';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { DataTableComponent, DataTableCellDirective, DataTableColumn } from '../../shared/components/data-table';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-leads-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonComponent,
    InputComponent,
    SelectComponent,
    BadgeComponent,
    DialogComponent,
    DataTableComponent,
    DataTableCellDirective
  ],
  templateUrl: './leads-list.component.html',
  styleUrl: './leads-list.component.scss'
})
export class LeadsListComponent implements OnInit {
  leads = signal<Lead[]>([]);
  total = signal(0);
  loading = signal(false);
  groups = signal<LeadGroup[]>([]);

  search = '';
  status = '';
  groupId = '';
  page = 1;
  pageSize = 20;

  showAddDialog = signal(false);
  savingLead = signal(false);
  newLead = {
    companyName: '',
    website: '',
    phone: '',
    city: '',
    state: '',
    industry: '',
    groupId: ''
  };

  columns: DataTableColumn[] = [
    { key: 'companyName', header: 'Company' },
    { key: 'location', header: 'Location' },
    { key: 'status', header: 'Status' },
    { key: 'group', header: 'Group' },
    { key: 'contacts', header: 'Contacts', align: 'right' },
    { key: 'createdAt', header: 'Created' }
  ];

  private searchInput$ = new Subject<string>();

  statusOptions: SelectOption[] = [
    { label: 'New', value: 'NEW' },
    { label: 'Researching', value: 'RESEARCHING' },
    { label: 'Contacted', value: 'CONTACTED' },
    { label: 'Engaged', value: 'ENGAGED' },
    { label: 'Interested', value: 'INTERESTED' },
    { label: 'Not Interested', value: 'NOT_INTERESTED' },
    { label: 'Customer', value: 'CUSTOMER' },
    { label: 'Archived', value: 'ARCHIVED' }
  ];

  get groupOptions(): SelectOption[] {
    return this.groups().map(g => ({ label: g.name, value: g.id }));
  }

  constructor(
    private leadsService: LeadsService,
    private leadGroupsService: LeadGroupsService,
    private router: Router,
    private route: ActivatedRoute,
    private toast: ToastService
  ) {
    this.searchInput$.pipe(debounceTime(300), distinctUntilChanged()).subscribe(value => {
      this.search = value;
      this.page = 1;
      this.load();
    });
  }

  ngOnInit(): void {
    const groupIdParam = this.route.snapshot.queryParamMap.get('groupId');
    if (groupIdParam) {
      this.groupId = groupIdParam;
    }
    this.leadGroupsService.list().subscribe(groups => this.groups.set(groups));
    this.load();
  }

  onSearchChange(value: string): void {
    this.searchInput$.next(value);
  }

  onFilterChange(): void {
    this.page = 1;
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.leadsService
      .list({
        search: this.search || undefined,
        status: this.status || undefined,
        groupId: this.groupId || undefined,
        page: this.page,
        pageSize: this.pageSize
      })
      .subscribe({
        next: (res) => {
          this.leads.set(res.leads);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: () => this.loading.set(false)
      });
  }

  openAddDialog(): void {
    this.newLead = { companyName: '', website: '', phone: '', city: '', state: '', industry: '', groupId: '' };
    this.showAddDialog.set(true);
  }

  submitNewLead(): void {
    if (!this.newLead.companyName.trim()) return;
    this.savingLead.set(true);
    const payload = { ...this.newLead };
    if (!payload.groupId) delete (payload as any).groupId;
    this.leadsService.create(payload).subscribe({
      next: () => {
        this.savingLead.set(false);
        this.showAddDialog.set(false);
        this.toast.success('Lead created');
        this.load();
      },
      error: () => {
        this.savingLead.set(false);
        this.toast.error('Failed to create lead');
      }
    });
  }

  goToLead(lead: Lead): void {
    this.router.navigate(['/leads', lead.id]);
  }

  statusBadgeVariant(status: string): BadgeVariant {
    switch (status) {
      case 'NEW': return 'info';
      case 'RESEARCHING': return 'purple';
      case 'CONTACTED': return 'default';
      case 'ENGAGED': return 'warning';
      case 'INTERESTED': return 'success';
      case 'NOT_INTERESTED': return 'error';
      case 'CUSTOMER': return 'success';
      case 'ARCHIVED': return 'neutral';
      default: return 'default';
    }
  }

  location(lead: Lead): string {
    return [lead.city, lead.state].filter(Boolean).join(', ') || '—';
  }
}
