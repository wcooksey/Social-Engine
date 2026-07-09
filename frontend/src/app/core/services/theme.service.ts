import { Injectable, signal, effect } from '@angular/core';

export type Theme = 'light' | 'dark';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  // Use signal for reactive theme state, default to 'dark'
  private readonly themeSignal = signal<Theme>('dark');
  public readonly theme = this.themeSignal.asReadonly();

  constructor() {
    // Load theme from localStorage on initialization
    const savedTheme = localStorage.getItem('theme') as Theme | null;
    if (savedTheme && (savedTheme === 'light' || savedTheme === 'dark')) {
      this.themeSignal.set(savedTheme);
    }

    // Apply theme whenever it changes
    effect(() => {
      const currentTheme = this.themeSignal();
      this.applyTheme(currentTheme);
      localStorage.setItem('theme', currentTheme);
    }, { allowSignalWrites: true });

    // Apply initial theme
    this.applyTheme(this.themeSignal());
  }

  /**
   * Toggle between light and dark themes
   */
  toggleTheme(): void {
    const currentTheme = this.themeSignal();
    this.setTheme(currentTheme === 'light' ? 'dark' : 'light');
  }

  /**
   * Set a specific theme
   */
  setTheme(theme: Theme): void {
    this.themeSignal.set(theme);
  }

  /**
   * Apply theme to document
   */
  private applyTheme(theme: Theme): void {
    const html = document.documentElement;

    if (theme === 'dark') {
      html.classList.add('dark-theme');
      html.classList.remove('light-theme');
    } else {
      html.classList.add('light-theme');
      html.classList.remove('dark-theme');
    }

    // Also set data attribute for CSS variable support
    html.setAttribute('data-theme', theme);
  }

  /**
   * Check if current theme is dark
   */
  isDarkMode(): boolean {
    return this.themeSignal() === 'dark';
  }
}
