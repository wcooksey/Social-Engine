import { Injectable, NgZone, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';

@Injectable({ providedIn: 'root' })
export class NativeAppService {
  private location = inject(Location);
  private zone = inject(NgZone);

  constructor() {
    if (Capacitor.getPlatform() === 'android') {
      void App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) this.zone.run(() => this.location.back());
        else void App.minimizeApp();
      });
    }
  }

  async openExternal(url: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await Browser.open({ url });
    } else {
      window.location.href = url;
    }
  }
}
