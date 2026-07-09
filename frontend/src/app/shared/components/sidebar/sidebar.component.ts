import { Component, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { MobileMenuService } from '../../../core/services/mobile-menu.service';
import { ThemeService } from '../../../core/services/theme.service';
import { ThemeToggleComponent } from '../theme-toggle/theme-toggle.component';

interface NavItem {
  icon: string;
  label: string;
  route: string;
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule, ThemeToggleComponent],
  templateUrl: './sidebar.component.html',
  styleUrls: ['./sidebar.component.scss']
})
export class SidebarComponent {
  currentUser = computed(() => this.authService.currentUser());

  navItems: NavItem[] = [
    { icon: 'bi-grid-1x2', label: 'Dashboard', route: '/dashboard' },
    { icon: 'bi-stars', label: 'Engine', route: '/engine' },
    { icon: 'bi-building', label: 'Leads', route: '/leads' },
    { icon: 'bi-collection', label: 'Groups', route: '/groups' },
    { icon: 'bi-megaphone', label: 'Campaigns', route: '/campaigns' },
    { icon: 'bi-calendar3', label: 'Calendar', route: '/calendar' },
    { icon: 'bi-activity', label: 'Activity', route: '/activity' },
    { icon: 'bi-gear', label: 'Settings', route: '/settings' }
  ];

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
