import { Routes } from '@angular/router';
import { authGuard, guestGuard, superAdminGuard } from './core/guards/auth.guard';
import { LayoutComponent } from './shared/components/layout/layout.component';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login/login.component').then(m => m.LoginComponent)
  },
  {
    path: 'register',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/register/register.component').then(m => m.RegisterComponent)
  },
  {
    // Public, unauthenticated self-serve booking page — no auth guard, no app shell.
    path: 'book/:slug',
    loadComponent: () => import('./features/public-booking/public-booking.component').then(m => m.PublicBookingComponent)
  },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    children: [
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent)
      },
      {
        path: 'engine',
        loadComponent: () => import('./features/engine/engine.component').then(m => m.EngineComponent)
      },
      {
        path: 'inbox',
        loadComponent: () => import('./features/inbox/inbox.component').then(m => m.InboxComponent)
      },
      {
        path: 'leads',
        children: [
          {
            path: '',
            loadComponent: () => import('./features/leads/leads-list.component').then(m => m.LeadsListComponent)
          },
          {
            path: ':id',
            loadComponent: () => import('./features/leads/lead-detail.component').then(m => m.LeadDetailComponent)
          }
        ]
      },
      {
        path: 'groups',
        loadComponent: () => import('./features/groups/groups.component').then(m => m.GroupsComponent)
      },
      {
        path: 'campaigns',
        loadComponent: () => import('./features/campaigns/campaigns.component').then(m => m.CampaignsComponent)
      },
      {
        path: 'campaigns/:id',
        loadComponent: () => import('./features/campaigns/campaign-detail.component').then(m => m.CampaignDetailComponent)
      },
      {
        path: 'playbooks',
        loadComponent: () => import('./features/playbooks/playbooks.component').then(m => m.PlaybooksComponent)
      },
      {
        path: 'experiments',
        loadComponent: () => import('./features/experiments/experiments.component').then(m => m.ExperimentsComponent)
      },
      {
        path: 'calendar',
        loadComponent: () => import('./features/calendar/calendar.component').then(m => m.CalendarComponent)
      },
      {
        path: 'live',
        loadComponent: () => import('./features/live/live.component').then(m => m.LiveComponent)
      },
      {
        path: 'sandbox',
        loadComponent: () => import('./features/sandbox/sandbox.component').then(m => m.SandboxComponent)
      },
      {
        path: 'activity',
        loadComponent: () => import('./features/activity/activity.component').then(m => m.ActivityComponent)
      },
      {
        path: 'settings',
        loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent)
      },
      {
        // Super admin only. /api/admin enforces the same rule server-side.
        path: 'admin',
        canActivate: [superAdminGuard],
        loadComponent: () => import('./features/admin/admin.component').then(m => m.AdminComponent)
      },
      {
        path: '',
        redirectTo: 'dashboard',
        pathMatch: 'full'
      }
    ]
  },
  {
    path: '**',
    redirectTo: 'dashboard'
  }
];
