import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/guards/auth.guard';
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
        path: 'activity',
        loadComponent: () => import('./features/activity/activity.component').then(m => m.ActivityComponent)
      },
      {
        path: 'settings',
        loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent)
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
