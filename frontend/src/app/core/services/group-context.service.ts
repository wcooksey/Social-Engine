import { Injectable, computed, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';

/** URL-owned workspace context; global links always leave the group explicitly. */
@Injectable({ providedIn: 'root' })
export class GroupContextService {
  private router = inject(Router);
  private url = toSignal(this.router.events.pipe(filter(e => e instanceof NavigationEnd), map(() => this.router.url)), { initialValue: this.router.url });
  readonly groupId = computed(() => this.url().match(/^\/groups\/([^/?]+)/)?.[1] ?? '');
  // Read the active route during component construction, before NavigationEnd.
  currentId(): string {
    let route = this.router.routerState.snapshot.root;
    while (route) {
      if (route.paramMap.has('groupId')) return route.paramMap.get('groupId')!;
      if (!route.firstChild) break;
      route = route.firstChild;
    }
    return '';
  }
  link(page: string, id?: string): string[] {
    const group = this.currentId();
    return [...(group ? ['/groups', group, ...(['campaigns', 'playbooks', 'experiments', 'sandbox'].includes(page) ? ['outreach', page] : [page])] : ['/' + page]), ...(id ? [id] : [])];
  }
}
