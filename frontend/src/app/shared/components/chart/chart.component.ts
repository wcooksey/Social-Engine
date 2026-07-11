import { Component, Input, OnInit, OnDestroy, AfterViewInit, OnChanges, SimpleChanges, ViewChild, ElementRef, ChangeDetectionStrategy, ChangeDetectorRef, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Chart, ChartConfiguration, ChartType, registerables } from 'chart.js';
import { ThemeService } from '../../../core/services/theme.service';

Chart.register(...registerables);

@Component({
  selector: 'app-chart',
  standalone: true,
  imports: [CommonModule],
  template: '<canvas #chartCanvas></canvas>',
  styles: [`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
    }
    canvas {
      max-width: 100%;
      height: auto !important;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChartComponent implements OnInit, AfterViewInit, OnChanges, OnDestroy {
  @Input() type: ChartType = 'line';
  @Input() data: any;
  @Input() options: any;
  @Input() height?: number;

  @ViewChild('chartCanvas') chartCanvas!: ElementRef<HTMLCanvasElement>;
  private chart?: Chart;
  private isDarkMode = false;

  constructor(
    private cdr: ChangeDetectorRef,
    private themeService: ThemeService
  ) {
    // Watch for theme changes and update chart colors
    effect(() => {
      const currentTheme = this.themeService.theme();
      this.isDarkMode = currentTheme === 'dark';
      if (this.chart) {
        this.updateChartColors();
      }
    });
  }

  ngOnInit(): void {
    // Initialize theme state
    this.isDarkMode = this.themeService.isDarkMode();
  }

  ngAfterViewInit(): void {
    this.createChart();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.chart && (changes['data'] || changes['options'])) {
      this.updateChart();
    }
  }

  ngOnDestroy(): void {
    if (this.chart) {
      this.chart.destroy();
    }
  }

  private getChartColors() {
    if (this.isDarkMode) {
      return {
        text: 'rgba(255, 255, 255, 0.8)',
        textSecondary: 'rgba(255, 255, 255, 0.6)',
        grid: 'rgba(255, 255, 255, 0.1)',
        legend: 'rgba(255, 255, 255, 0.8)',
      };
    } else {
      return {
        text: '#374151', // gray-700
        textSecondary: '#6B7280', // gray-500
        grid: 'rgba(0, 0, 0, 0.1)',
        legend: '#374151', // gray-700
      };
    }
  }

  private createChart(): void {
    if (!this.chartCanvas || !this.data) {
      console.warn('[Chart] Cannot create chart: missing canvas or data', {
        hasCanvas: !!this.chartCanvas,
        hasData: !!this.data
      });
      return;
    }

    const colors = this.getChartColors();
    
    // Log chart creation for debugging
    console.log('[Chart] Creating chart:', {
      type: this.type,
      hasData: !!this.data,
      dataLabels: this.data.labels,
      datasetsCount: this.data.datasets?.length || 0
    });

    const config: ChartConfiguration = {
      type: this.type,
      data: this.data,
      options: {
        ...this.options,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: colors.legend,
              font: {
                size: 12,
              },
              usePointStyle: this.options?.plugins?.legend?.labels?.usePointStyle ?? false,
              padding: this.options?.plugins?.legend?.labels?.padding ?? 10,
              boxWidth: this.options?.plugins?.legend?.labels?.boxWidth ?? 12,
              boxHeight: this.options?.plugins?.legend?.labels?.boxHeight ?? 12,
            },
            align: this.options?.plugins?.legend?.align ?? 'center',
          },
          tooltip: {
            backgroundColor: this.isDarkMode ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.95)',
            titleColor: colors.text,
            bodyColor: colors.text,
            borderColor: this.isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)',
            borderWidth: 1,
          },
        },
        scales: this.options?.scales || (this.type !== 'pie' && this.type !== 'doughnut' ? {
          x: {
            ticks: { 
              color: colors.textSecondary,
              font: {
                size: 11,
              },
            },
            grid: { 
              color: colors.grid,
              drawBorder: false,
            },
          },
          y: {
            ticks: { 
              color: colors.textSecondary,
              font: {
                size: 11,
              },
            },
            grid: { 
              color: colors.grid,
              drawBorder: false,
            },
          },
        } : undefined),
      },
    };

    try {
      this.chart = new Chart(this.chartCanvas.nativeElement, config);
      console.log('[Chart] Chart created successfully:', {
        type: this.type,
        dataPoints: this.data.datasets?.[0]?.data || [],
        chartId: this.chart.id
      });
      this.cdr.markForCheck();
    } catch (error: any) {
      console.error('[Chart] Error creating chart:', error);
      console.error('[Chart] Chart config:', config);
    }
  }

  private updateChartColors(): void {
    if (!this.chart) return;

    const colors = this.getChartColors();

    // Update legend colors
    if (this.chart.options.plugins?.legend?.labels) {
      this.chart.options.plugins.legend.labels.color = colors.legend;
    }

    // Update tooltip colors
    if (this.chart.options.plugins?.tooltip) {
      this.chart.options.plugins.tooltip.backgroundColor = this.isDarkMode 
        ? 'rgba(0, 0, 0, 0.8)' 
        : 'rgba(255, 255, 255, 0.95)';
      this.chart.options.plugins.tooltip.titleColor = colors.text;
      this.chart.options.plugins.tooltip.bodyColor = colors.text;
      this.chart.options.plugins.tooltip.borderColor = this.isDarkMode 
        ? 'rgba(255, 255, 255, 0.2)' 
        : 'rgba(0, 0, 0, 0.1)';
    }

    // Update scale colors for non-pie/doughnut charts
    if (this.type !== 'pie' && this.type !== 'doughnut' && this.chart.options.scales) {
      const scales = this.chart.options.scales;
      if (scales['x']) {
        scales['x'].ticks = {
          ...scales['x'].ticks,
          color: colors.textSecondary,
        };
        scales['x'].grid = {
          ...scales['x'].grid,
          color: colors.grid,
        };
      }
      if (scales['y']) {
        scales['y'].ticks = {
          ...scales['y'].ticks,
          color: colors.textSecondary,
        };
        scales['y'].grid = {
          ...scales['y'].grid,
          color: colors.grid,
        };
      }
    }

    this.chart.update();
    this.cdr.markForCheck();
  }

  private updateChart(): void {
    if (!this.chart || !this.data) return;

    this.chart.data = this.data;
    this.chart.update();
    this.cdr.markForCheck();
  }
}

