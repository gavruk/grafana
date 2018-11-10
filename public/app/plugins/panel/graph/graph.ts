import 'vendor/flot/jquery.flot';
import 'vendor/flot/jquery.flot.selection';
import 'vendor/flot/jquery.flot.time';
import 'vendor/flot/jquery.flot.stack';
import 'vendor/flot/jquery.flot.stackpercent';
import 'vendor/flot/jquery.flot.fillbelow';
import 'vendor/flot/jquery.flot.crosshair';
import 'vendor/flot/jquery.flot.dashes';
import './jquery.flot.events';

import $ from 'jquery';
import _ from 'lodash';
import moment from 'moment';
import kbn from 'app/core/utils/kbn';
import { tickStep } from 'app/core/utils/ticks';
import { appEvents, coreModule, updateLegendValues } from 'app/core/core';
import GraphTooltip from './graph_tooltip';
import { ThresholdManager } from './threshold_manager';
import { EventManager } from 'app/features/annotations/all';
import { convertToHistogramData } from './histogram';
import { alignYLevel } from './align_yaxes';
import config from 'app/core/config';

import { GraphCtrl } from './module';

class GraphElement {
  ctrl: GraphCtrl;
  tooltip: any;
  timestampPart: any;
  dashboard: any;
  annotations: object[];
  panel: any;
  plot: any;
  sortedSeries: any[];
  data: any[];
  panelWidth: number;
  eventManager: EventManager;
  thresholdManager: ThresholdManager;

  constructor(private scope, private elem, private timeSrv) {
    this.ctrl = scope.ctrl;
    this.dashboard = this.ctrl.dashboard;
    this.panel = this.ctrl.panel;
    this.annotations = [];

    this.panelWidth = 0;
    this.eventManager = new EventManager(this.ctrl);
    this.thresholdManager = new ThresholdManager(this.ctrl);
    this.tooltip = new GraphTooltip(this.elem, this.ctrl.dashboard, this.scope, () => {
      return this.sortedSeries;
    });

    // panel events
    this.ctrl.events.on('panel-teardown', this.onPanelteardown.bind(this));

    /**
     * Split graph rendering into two parts.
     * First, calculate series stats in buildFlotPairs() function. Then legend rendering started
     * (see ctrl.events.on('render') in legend.ts).
     * When legend is rendered it emits 'legend-rendering-complete' and graph rendered.
     */
    this.ctrl.events.on('render', this.onRender.bind(this));
    this.ctrl.events.on('legend-rendering-complete', this.onLegendRenderingComplete.bind(this));

    // global events
    appEvents.on('graph-hover', this.onGraphHover.bind(this), scope);

    appEvents.on('graph-hover-clear', this.onGraphHoverClear.bind(this), scope);

    this.elem.bind('plotselected', this.onPlotSelected.bind(this));

    this.elem.bind('plotclick', this.onPlotClick.bind(this));
    scope.$on('$destroy', this.onScopeDestroy.bind(this));
  }

  onRender(renderData) {
    this.data = renderData || this.data;
    if (!this.data) {
      return;
    }
    this.annotations = this.ctrl.annotations || [];
    this.buildFlotPairs(this.data);
    const graphHeight = this.elem.height();
    updateLegendValues(this.data, this.panel, graphHeight);

    this.ctrl.events.emit('render-legend');
  }

  onGraphHover(evt) {
    // ignore other graph hover events if shared tooltip is disabled
    if (!this.dashboard.sharedTooltipModeEnabled()) {
      return;
    }

    // ignore if we are the emitter
    if (!this.plot || evt.panel.id === this.panel.id || this.ctrl.otherPanelInFullscreenMode()) {
      return;
    }

    this.tooltip.show(evt.pos);
  }

  onPanelteardown() {
    this.thresholdManager = null;

    if (this.plot) {
      this.plot.destroy();
      this.plot = null;
    }
  }

  onLegendRenderingComplete() {
    this.render_panel();
  }

  onGraphHoverClear(event, info) {
    if (this.plot) {
      this.tooltip.clear(this.plot);
    }
  }

  onPlotSelected(event, ranges) {
    if (this.panel.xaxis.mode !== 'time') {
      // Skip if panel in histogram or series mode
      this.plot.clearSelection();
      return;
    }

    if (typeof ranges.xaxis.from === 'number' && this.timestampPart) {
      ranges.xaxis.from = `${this.timestampPart}${ranges.xaxis.from.toString().replace('.', '')}`;
      ranges.xaxis.from = `${ranges.xaxis.from.substr(0, 13)}.${ranges.xaxis.from.substr(13, 6)}`;
      ranges.xaxis.to = `${this.timestampPart}${ranges.xaxis.to.toString().replace('.', '')}`;
      ranges.xaxis.to = `${ranges.xaxis.to.substr(0, 13)}.${ranges.xaxis.to.substr(13, 6)}`;
    }
    if ((ranges.ctrlKey || ranges.metaKey) && (this.dashboard.meta.canEdit || this.dashboard.meta.canMakeEditable)) {
      // Add annotation
      setTimeout(() => {
        this.eventManager.updateTime(ranges.xaxis);
      }, 100);
    } else {
      this.scope.$apply(() => {
        this.timeSrv.setTime({
          from: moment.utc(ranges.xaxis.from),
          to: moment.utc(ranges.xaxis.to),
        });
      });
    }
  }

  onPlotClick(event, pos, item) {
    if (this.panel.xaxis.mode !== 'time') {
      // Skip if panel in histogram or series mode
      return;
    }

    if ((pos.ctrlKey || pos.metaKey) && (this.dashboard.meta.canEdit || this.dashboard.meta.canMakeEditable)) {
      // Skip if range selected (added in "plotselected" event handler)
      const isRangeSelection = pos.x !== pos.x1;
      if (!isRangeSelection) {
        setTimeout(() => {
          this.eventManager.updateTime({ from: pos.x, to: null });
        }, 100);
      }
    }
  }

  onScopeDestroy() {
    this.tooltip.destroy();
    this.elem.off();
    this.elem.remove();
  }

  shouldAbortRender() {
    if (!this.data) {
      return true;
    }

    if (this.panelWidth === 0) {
      return true;
    }

    return false;
  }

  drawHook(plot) {
    // add left axis labels
    if (this.panel.yaxes[0].label && this.panel.yaxes[0].show) {
      $("<div class='axisLabel left-yaxis-label flot-temp-elem'></div>")
        .text(this.panel.yaxes[0].label)
        .appendTo(this.elem);
    }

    // add right axis labels
    if (this.panel.yaxes[1].label && this.panel.yaxes[1].show) {
      $("<div class='axisLabel right-yaxis-label flot-temp-elem'></div>")
        .text(this.panel.yaxes[1].label)
        .appendTo(this.elem);
    }

    if (this.ctrl.dataWarning) {
      $(`<div class="datapoints-warning flot-temp-elem">${this.ctrl.dataWarning.title}</div>`).appendTo(this.elem);
    }

    this.thresholdManager.draw(plot);
  }

  processOffsetHook(plot, gridMargin) {
    const left = this.panel.yaxes[0];
    const right = this.panel.yaxes[1];
    if (left.show && left.label) {
      gridMargin.left = 20;
    }
    if (right.show && right.label) {
      gridMargin.right = 20;
    }

    // apply y-axis min/max options
    const yaxis = plot.getYAxes();
    for (let i = 0; i < yaxis.length; i++) {
      const axis = yaxis[i];
      const panelOptions = this.panel.yaxes[i];
      axis.options.max = axis.options.max !== null ? axis.options.max : panelOptions.max;
      axis.options.min = axis.options.min !== null ? axis.options.min : panelOptions.min;
    }
  }

  processRangeHook(plot) {
    const yAxes = plot.getYAxes();
    const align = this.panel.yaxis.align || false;

    if (yAxes.length > 1 && align === true) {
      const level = this.panel.yaxis.alignLevel || 0;
      alignYLevel(yAxes, parseFloat(level));
    }
  }

  // Series could have different timeSteps,
  // let's find the smallest one so that bars are correctly rendered.
  // In addition, only take series which are rendered as bars for this.
  getMinTimeStepOfSeries(data) {
    let min = Number.MAX_VALUE;

    for (let i = 0; i < data.length; i++) {
      if (!data[i].stats.timeStep) {
        continue;
      }
      if (this.panel.bars) {
        if (data[i].bars && data[i].bars.show === false) {
          continue;
        }
      } else {
        if (typeof data[i].bars === 'undefined' || typeof data[i].bars.show === 'undefined' || !data[i].bars.show) {
          continue;
        }
      }

      if (data[i].stats.timeStep < min) {
        min = data[i].stats.timeStep;
      }
    }

    return min;
  }

  // Function for rendering panel
  render_panel() {
    this.panelWidth = this.elem.width();
    if (this.shouldAbortRender()) {
      return;
    }

    // give space to alert editing
    this.thresholdManager.prepare(this.elem, this.data);

    // un-check dashes if lines are unchecked
    this.panel.dashes = this.panel.lines ? this.panel.dashes : false;

    // Populate element
    const options: any = this.buildFlotOptions(this.panel);
    this.prepareXAxis(options, this.panel);
    this.configureYAxisOptions(this.data, options);
    this.thresholdManager.addFlotOptions(options, this.panel);
    this.eventManager.addFlotEvents(this.annotations, options);

    this.sortedSeries = this.sortSeries(this.data, this.panel);
    this.callPlot(options, true);
  }

  buildFlotPairs(data) {
    for (let i = 0; i < data.length; i++) {
      const series = data[i];
      series.data = series.getFlotPairs(series.nullPointMode || this.panel.nullPointMode);

      // if hidden remove points and disable stack
      if (this.ctrl.hiddenSeries[series.alias]) {
        series.data = [];
        series.stack = false;
      }
    }
  }

  prepareXAxis(options, panel) {
    switch (panel.xaxis.mode) {
      case 'series': {
        options.series.bars.barWidth = 0.7;
        options.series.bars.align = 'center';

        for (let i = 0; i < this.data.length; i++) {
          const series = this.data[i];
          series.data = [[i + 1, series.stats[panel.xaxis.values[0]]]];
        }

        this.addXSeriesAxis(options);
        break;
      }
      case 'histogram': {
        let bucketSize: number;

        if (this.data.length) {
          const histMin = _.min(_.map(this.data, s => s.stats.min));
          const histMax = _.max(_.map(this.data, s => s.stats.max));
          const ticks = panel.xaxis.buckets || this.panelWidth / 50;
          bucketSize = tickStep(histMin, histMax, ticks);
          options.series.bars.barWidth = bucketSize * 0.8;
          this.data = convertToHistogramData(this.data, bucketSize, this.ctrl.hiddenSeries, histMin, histMax);
        } else {
          bucketSize = 0;
        }

        this.addXHistogramAxis(options, bucketSize);
        break;
      }
      case 'table': {
        options.series.bars.barWidth = 0.7;
        options.series.bars.align = 'center';
        this.addXTableAxis(options);
        break;
      }
      default: {
        options.series.bars.barWidth = this.getMinTimeStepOfSeries(this.data) / 1.5;
        this.addTimeAxis(options);
        break;
      }
    }
  }

  callPlot(options, incrementRenderCounter) {
    const copied = [...this.sortedSeries];
    let timestampPart;

    copied.forEach(c => {
      for (let i = 0; i < c.data.length; i++) {
        if (!timestampPart && options.xaxis.isNano) {
          timestampPart = c.datapoints[0][1].toString().substr(0, 6);
        }

        if (options.xaxis.isNano) {
          c.data[i][0] = +`${c.datapoints[i][1].toString().substr(6, 4)}${c.datapoints[i][3]}`;
        } else {
          let decimalPart = c.datapoints[i][4].toString();
          while (decimalPart.length < 6) {
            decimalPart = '0' + decimalPart;
          }
          c.data[i][0] = `${c.datapoints[i][1]}.${decimalPart}`;
        }
      }
    });
    this.timestampPart = timestampPart;
    this.scope.timestampPart = timestampPart;
    try {
      this.plot = $.plot(this.elem, copied, options);
      if (this.ctrl.renderError) {
        delete this.ctrl.error;
        delete this.ctrl.inspector;
      }
    } catch (e) {
      console.log('flotcharts error', e);
      this.ctrl.error = e.message || 'Render Error';
      this.ctrl.renderError = true;
      this.ctrl.inspector = { error: e };
    }

    if (incrementRenderCounter) {
      this.ctrl.renderingCompleted();
    }
  }

  buildFlotOptions(panel) {
    let gridColor = '#c8c8c8';
    if (config.bootData.user.lightTheme === true) {
      gridColor = '#a1a1a1';
    }
    const stack = panel.stack ? true : null;
    const options = {
      hooks: {
        draw: [this.drawHook.bind(this)],
        processOffset: [this.processOffsetHook.bind(this)],
        processRange: [this.processRangeHook.bind(this)],
      },
      legend: { show: false },
      series: {
        stackpercent: panel.stack ? panel.percentage : false,
        stack: panel.percentage ? null : stack,
        lines: {
          show: panel.lines,
          zero: false,
          fill: this.translateFillOption(panel.fill),
          lineWidth: panel.dashes ? 0 : panel.linewidth,
          steps: panel.steppedLine,
        },
        dashes: {
          show: panel.dashes,
          lineWidth: panel.linewidth,
          dashLength: [panel.dashLength, panel.spaceLength],
        },
        bars: {
          show: panel.bars,
          fill: 1,
          barWidth: 1,
          zero: false,
          lineWidth: 0,
        },
        points: {
          show: panel.points,
          fill: 1,
          fillColor: false,
          radius: panel.points ? panel.pointradius : 2,
        },
        shadowSize: 0,
      },
      yaxes: [],
      xaxis: {},
      grid: {
        minBorderMargin: 0,
        markings: [],
        backgroundColor: null,
        borderWidth: 0,
        hoverable: true,
        clickable: true,
        color: gridColor,
        margin: { left: 0, right: 0 },
        labelMarginX: 0,
      },
      selection: {
        mode: 'x',
        color: '#666',
      },
      crosshair: {
        mode: 'x',
      },
    };
    return options;
  }

  sortSeries(series, panel) {
    const sortBy = panel.legend.sort;
    const sortOrder = panel.legend.sortDesc;
    const haveSortBy = sortBy !== null && sortBy !== undefined;
    const haveSortOrder = sortOrder !== null && sortOrder !== undefined;
    const shouldSortBy = panel.stack && haveSortBy && haveSortOrder;
    const sortDesc = panel.legend.sortDesc === true ? -1 : 1;

    if (shouldSortBy) {
      return _.sortBy(series, s => s.stats[sortBy] * sortDesc);
    } else {
      return _.sortBy(series, s => s.zindex);
    }
  }

  translateFillOption(fill) {
    if (this.panel.percentage && this.panel.stack) {
      return fill === 0 ? 0.001 : fill / 10;
    } else {
      return fill / 10;
    }
  }

  addTimeAxis(options) {
    const ticks = this.panelWidth / 100;
    let min = _.isUndefined(this.ctrl.range.from) ? null : this.ctrl.range.from.valueOf();
    let max = _.isUndefined(this.ctrl.range.to) ? null : this.ctrl.range.to.valueOf();

    if (this.ctrl.intervalMs >= 1) {
      options.xaxis = {
        timezone: this.dashboard.getTimezone(),
        show: this.panel.xaxis.show,
        mode: 'time',
        min: min,
        max: max,
        label: 'Datetime',
        ticks: ticks,
        timeformat: this.time_format(ticks, min, max),
      };
    } else {
      if (this.ctrl.range.from && this.ctrl.range.from._d._nanoseconds) {
        if (min.toString().indexOf('.') > 1) {
          min = min.toString();
        } else {
          min = min.toString() + this.ctrl.range.from._d._nanoseconds;
        }
      }
      if (this.ctrl.range.to && this.ctrl.range.to._d._nanoseconds) {
        if (max.toString().indexOf('.') > 1) {
          max = max.toString();
        } else {
          max = max.toString() + this.ctrl.range.to._d._nanoseconds;
        }
      }
      if (typeof min === 'number') {
        min = min.toString();
      }
      if (typeof max === 'number') {
        max = max.toString();
      }
      while (min.length < 19) {
        min += '0';
      }
      while (max.length < 19) {
        max += '0';
      }
      min = min.substr(6);
      max = max.substr(6);

      options.xaxis = {
        timezone: this.dashboard.getTimezone(),
        show: this.panel.xaxis.show,
        //mode: 'time',
        min: +min,
        max: +max,
        label: 'Datetime',
        isNano: true,
        ticks: ticks,
        tickFormatter: (tick, series) => {
          return tick.toString().substring(4);
          //const decimalPart = Math.round((tick % 1) * 1e4) / 1e4;
          //const msPart = Math.round(((tick / 1000) % 1) * 1000);
          //return msPart + decimalPart;
        },
      };
    }
  }

  addXSeriesAxis(options) {
    const ticks = _.map(this.data, (series, index) => {
      return [index + 1, series.alias];
    });

    options.xaxis = {
      timezone: this.dashboard.getTimezone(),
      show: this.panel.xaxis.show,
      mode: null,
      min: 0,
      max: ticks.length + 1,
      label: 'Datetime',
      ticks: ticks,
    };
  }

  addXHistogramAxis(options, bucketSize) {
    let ticks, min, max;
    const defaultTicks = this.panelWidth / 50;

    if (this.data.length && bucketSize) {
      const tickValues = [];
      for (const d of this.data) {
        for (const point of d.data) {
          tickValues[point[0]] = true;
        }
      }
      ticks = Object.keys(tickValues).map(v => Number(v));
      min = _.min(ticks);
      max = _.max(ticks);

      // Adjust tick step
      let tickStep = bucketSize;
      let ticksNum = Math.floor((max - min) / tickStep);
      while (ticksNum > defaultTicks) {
        tickStep = tickStep * 2;
        ticksNum = Math.ceil((max - min) / tickStep);
      }

      // Expand ticks for pretty view
      min = Math.floor(min / tickStep) * tickStep;
      // 1.01 is 101% - ensure we have enough space for last bar
      max = Math.ceil(max * 1.01 / tickStep) * tickStep;

      ticks = [];
      for (let i = min; i <= max; i += tickStep) {
        ticks.push(i);
      }
    } else {
      // Set defaults if no data
      ticks = defaultTicks / 2;
      min = 0;
      max = 1;
    }

    options.xaxis = {
      timezone: this.dashboard.getTimezone(),
      show: this.panel.xaxis.show,
      mode: null,
      min: min,
      max: max,
      label: 'Histogram',
      ticks: ticks,
    };

    // Use 'short' format for histogram values
    this.configureAxisMode(options.xaxis, 'short');
  }

  addXTableAxis(options) {
    let ticks = _.map(this.data, (series, seriesIndex) => {
      return _.map(series.datapoints, (point, pointIndex) => {
        const tickIndex = seriesIndex * series.datapoints.length + pointIndex;
        return [tickIndex + 1, point[1]];
      });
    });
    ticks = _.flatten(ticks, true);

    options.xaxis = {
      timezone: this.dashboard.getTimezone(),
      show: this.panel.xaxis.show,
      mode: null,
      min: 0,
      max: ticks.length + 1,
      label: 'Datetime',
      ticks: ticks,
    };
  }

  configureYAxisOptions(data, options) {
    const defaults = {
      position: 'left',
      show: this.panel.yaxes[0].show,
      index: 1,
      logBase: this.panel.yaxes[0].logBase || 1,
      min: this.parseNumber(this.panel.yaxes[0].min),
      max: this.parseNumber(this.panel.yaxes[0].max),
      tickDecimals: this.panel.yaxes[0].decimals,
    };

    options.yaxes.push(defaults);

    if (_.find(data, { yaxis: 2 })) {
      const secondY = _.clone(defaults);
      secondY.index = 2;
      secondY.show = this.panel.yaxes[1].show;
      secondY.logBase = this.panel.yaxes[1].logBase || 1;
      secondY.position = 'right';
      secondY.min = this.parseNumber(this.panel.yaxes[1].min);
      secondY.max = this.parseNumber(this.panel.yaxes[1].max);
      secondY.tickDecimals = this.panel.yaxes[1].decimals;
      options.yaxes.push(secondY);

      this.applyLogScale(options.yaxes[1], data);
      this.configureAxisMode(
        options.yaxes[1],
        this.panel.percentage && this.panel.stack ? 'percent' : this.panel.yaxes[1].format
      );
    }
    this.applyLogScale(options.yaxes[0], data);
    this.configureAxisMode(
      options.yaxes[0],
      this.panel.percentage && this.panel.stack ? 'percent' : this.panel.yaxes[0].format
    );
  }

  parseNumber(value: any) {
    if (value === null || typeof value === 'undefined') {
      return null;
    }

    return _.toNumber(value);
  }

  applyLogScale(axis, data) {
    if (axis.logBase === 1) {
      return;
    }

    const minSetToZero = axis.min === 0;

    if (axis.min < Number.MIN_VALUE) {
      axis.min = null;
    }
    if (axis.max < Number.MIN_VALUE) {
      axis.max = null;
    }

    let series, i;
    let max = axis.max,
      min = axis.min;

    for (i = 0; i < data.length; i++) {
      series = data[i];
      if (series.yaxis === axis.index) {
        if (!max || max < series.stats.max) {
          max = series.stats.max;
        }
        if (!min || min > series.stats.logmin) {
          min = series.stats.logmin;
        }
      }
    }

    axis.transform = v => {
      return v < Number.MIN_VALUE ? null : Math.log(v) / Math.log(axis.logBase);
    };
    axis.inverseTransform = v => {
      return Math.pow(axis.logBase, v);
    };

    if (!max && !min) {
      max = axis.inverseTransform(+2);
      min = axis.inverseTransform(-2);
    } else if (!max) {
      max = min * axis.inverseTransform(+4);
    } else if (!min) {
      min = max * axis.inverseTransform(-4);
    }

    if (axis.min) {
      min = axis.inverseTransform(Math.ceil(axis.transform(axis.min)));
    } else {
      min = axis.min = axis.inverseTransform(Math.floor(axis.transform(min)));
    }
    if (axis.max) {
      max = axis.inverseTransform(Math.floor(axis.transform(axis.max)));
    } else {
      max = axis.max = axis.inverseTransform(Math.ceil(axis.transform(max)));
    }

    if (!min || min < Number.MIN_VALUE || !max || max < Number.MIN_VALUE) {
      return;
    }

    if (Number.isFinite(min) && Number.isFinite(max)) {
      if (minSetToZero) {
        axis.min = 0.1;
        min = 1;
      }

      axis.ticks = this.generateTicksForLogScaleYAxis(min, max, axis.logBase);
      if (minSetToZero) {
        axis.ticks.unshift(0.1);
      }
      if (axis.ticks[axis.ticks.length - 1] > axis.max) {
        axis.max = axis.ticks[axis.ticks.length - 1];
      }
    } else {
      axis.ticks = [1, 2];
      delete axis.min;
      delete axis.max;
    }
  }

  generateTicksForLogScaleYAxis(min, max, logBase) {
    let ticks = [];

    let nextTick;
    for (nextTick = min; nextTick <= max; nextTick *= logBase) {
      ticks.push(nextTick);
    }

    const maxNumTicks = Math.ceil(this.ctrl.height / 25);
    const numTicks = ticks.length;
    if (numTicks > maxNumTicks) {
      const factor = Math.ceil(numTicks / maxNumTicks) * logBase;
      ticks = [];

      for (nextTick = min; nextTick <= max * factor; nextTick *= factor) {
        ticks.push(nextTick);
      }
    }

    return ticks;
  }

  configureAxisMode(axis, format) {
    axis.tickFormatter = (val, axis) => {
      if (!kbn.valueFormats[format]) {
        throw new Error(`Unit '${format}' is not supported`);
      }
      return kbn.valueFormats[format](val, axis.tickDecimals, axis.scaledDecimals);
    };
  }

  time_format(ticks, min, max) {
    if (min && max && ticks) {
      const range = +max - +min;
      const secPerTick = range / ticks / 1000;
      // Need have 10 milisecond margin on the day range
      // As sometimes last 24 hour dashboard evaluates to more than 86400000
      const oneDay = 86400010;
      const oneYear = 31536000000;

      if (secPerTick <= 45) {
        return '%H:%M:%S';
      }
      if (secPerTick <= 7200 || range <= oneDay) {
        return '%H:%M';
      }
      if (secPerTick <= 80000) {
        return '%m/%d %H:%M';
      }
      if (secPerTick <= 2419200 || range <= oneYear) {
        return '%m/%d';
      }
      return '%Y-%m';
    }

    return '%H:%M';
  }
}

/** @ngInject */
function graphDirective(timeSrv, popoverSrv, contextSrv) {
  return {
    restrict: 'A',
    template: '',
    link: (scope, elem) => {
      return new GraphElement(scope, elem, timeSrv);
    },
  };
}

coreModule.directive('grafanaGraph', graphDirective);
export { GraphElement, graphDirective };
