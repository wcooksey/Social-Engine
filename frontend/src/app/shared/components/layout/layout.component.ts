import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from '../sidebar/sidebar.component';
import { NotificationsBellComponent } from '../notifications-bell/notifications-bell.component';
import { MobileMenuService } from '../../../core/services/mobile-menu.service';
import { NotificationService } from '../../../core/services/notification.service';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, NotificationsBellComponent],
  templateUrl: './layout.component.html',
  styleUrls: ['./layout.component.scss']
})
export class LayoutComponent implements OnInit, OnDestroy {
  constructor(
    public mobileMenuService: MobileMenuService,
    private notificationService: NotificationService
  ) {}

  ngOnInit(): void {
    this.notificationService.startPolling();
  }

  ngOnDestroy(): void {
    this.notificationService.stopPolling();
  }
}
