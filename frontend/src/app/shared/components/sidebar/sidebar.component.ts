import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { MobileMenuService } from '../../../core/services/mobile-menu.service';
import { ThemeService } from '../../../core/services/theme.service';
import { ThemeToggleComponent } from '../theme-toggle/theme-toggle.component';

import { GroupContextService } from '../../../core/services/group-context.service';

interface NavItem {
  icon: string;
  label: string;
  route: string;
}

const GLOBAL_ITEMS: NavItem[] = [
  { icon: 'bi-collection', label: 'Groups', route: '/groups' },
  { icon: 'bi-grid-1x2', label: 'Overview', route: '/dashboard' },
  { icon: 'bi-broadcast', label: 'Live across groups', route: '/live' },
  { icon: 'bi-building', label: 'All leads', route: '/leads' },
  { icon: 'bi-chat-left-text', label: 'All inbox', route: '/inbox' },
  { icon: 'bi-stars', label: 'Global Engine', route: '/engine' }
];
const GROUP_ITEMS: NavItem[] = [
  { icon: 'bi-grid-1x2', label: 'Group overview', route: '' },
  { icon: 'bi-stars', label: 'Engine & activity', route: '/engine' },
  { icon: 'bi-building', label: 'Find & qualify', route: '/leads' },
  { icon: 'bi-send', label: 'Outreach', route: '/outreach' },
  { icon: 'bi-chat-left-text', label: 'Replies', route: '/inbox' }
];
const OPERATIONS: NavItem[] = [
  { icon: 'bi-megaphone', label: 'All campaigns', route: '/campaigns' },
  { icon: 'bi-journal-text', label: 'All playbooks', route: '/playbooks' },
  { icon: 'bi-beaker', label: 'All experiments', route: '/experiments' },
  { icon: 'bi-activity', label: 'All activity', route: '/activity' },
  { icon: 'bi-chat-square-dots', label: 'Global sandbox', route: '/sandbox' },
  { icon: 'bi-clock-history', label: 'All scheduled', route: '/scheduled' },
  { icon: 'bi-calendar3', label: 'Calendar', route: '/calendar' },
  { icon: 'bi-send', label: 'Sending', route: '/sending' },
  { icon: 'bi-gear', label: 'Settings', route: '/settings' }
];

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule, ThemeToggleComponent],
  templateUrl: './sidebar.component.html',
  styleUrls: ['./sidebar.component.scss']
})
export class SidebarComponent {
  currentUser = computed(() => this.authService.currentUser());

  context = inject(GroupContextService);
  navItems = computed<NavItem[]>(() => this.context.groupId()
    ? GROUP_ITEMS.map(item => ({ ...item, route: '/groups/' + this.context.groupId() + item.route }))
    : GLOBAL_ITEMS);
  operations = computed<NavItem[]>(() => this.currentUser()?.isSuperAdmin
    ? [...OPERATIONS, { icon: 'bi-shield-lock', label: 'Admin', route: '/admin' }] : OPERATIONS);

  constructor(
    private authService: AuthService,
    private router: Router,
    public mobileMenuService: MobileMenuService,
    public themeService: ThemeService
  ) {}

  handleNavClick(): void {
    this.mobileMenuService.close();
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  trackByRoute(index: number, item: NavItem): string {
    return item.route;
  }
}
