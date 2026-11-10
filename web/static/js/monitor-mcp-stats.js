/**
 * monitor-mcp-stats.js —— MCP 工具统计面板
 *
 * 从 monitor.js 拆出的独立功能域（原 7779-8982 行）：
 * 统计卡片指标、环形成功率、工具排行表、分发图与堆叠条、
 * 时间线 SVG 与区间切换、工具筛选联动。
 *
 * 与 monitor.js 同处全局作用域，共享 monitorState / escapeHtml 等；
 * 加载顺序置于 monitor.js 之后（本文件顶层有 window 导出，依赖已加载的核心函数）。
 */
const MCP_STATS_TOP_N = 6;
const MCP_TIMELINE_RANGES = ['24h', '7d', '30d'];

function getMcpMonitorTimelineRange() {
    if (monitorState.timelineRange && MCP_TIMELINE_RANGES.includes(monitorState.timelineRange)) {
        return monitorState.timelineRange;
    }
    const saved = localStorage.getItem('mcpMonitorTimelineRange');
    const range = MCP_TIMELINE_RANGES.includes(saved) ? saved : '7d';
    monitorState.timelineRange = range;
    return range;
}

function buildMonitorTotals(summary) {
    const s = summary && typeof summary === 'object' ? summary : {};
    const total = s.totalCalls || 0;
    const success = s.successCalls || 0;
    const failed = s.failedCalls || 0;
    const blocked = s.blockedCalls || 0;
    return {
        total,
        success,
        failed,
        blocked,
        neutral: Math.max(0, total - success - failed - blocked),
        lastCallTime: s.lastCallTime ? new Date(s.lastCallTime) : null,
    };
}

function formatMcpTimelineLabel(isoOrDate, rangeKey, locale) {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (Number.isNaN(d.getTime())) return '';
    if (rangeKey === '24h') {
        return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    }
    if (rangeKey === '30d') {
        return d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
    }
    return d.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function buildMcpTimelineSvg(points, rangeKey) {
    if (!Array.isArray(points) || points.length === 0) return '';
    const W = 400;
    const H = 140;
    const padL = 32;
    const padR = 8;
    const padT = 12;
    const padB = 24;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = Math.max(1, ...points.map((p) => p.total || 0));
    const hasFailed = points.some((p) => (p.failed || 0) > 0);
    const hasBlocked = points.some((p) => (p.blocked || 0) > 0);
    const locale = (typeof window.uiLocale === 'function' ? window.uiLocale() : 'en-US');
    const barGap = points.length > 48 ? 1 : 2;
    const barW = Math.max(1.6, Math.min(8, (plotW / Math.max(1, points.length)) - barGap));

    const coords = points.map((p, i) => {
        const x = padL + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
        const y = padT + plotH - ((p.total || 0) / maxVal) * plotH;
        return { x, y, p, i };
    });

    const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ');
    const baseY = padT + plotH;
    const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(2)} ${baseY} L ${coords[0].x.toFixed(2)} ${baseY} Z`;

    let failPath = '';
    if (hasFailed) {
        failPath = coords.map((c, i) => {
            const fy = padT + plotH - ((c.p.failed || 0) / maxVal) * plotH;
            return `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${fy.toFixed(2)}`;
        }).join(' ');
    }

    const blockedPath = hasBlocked ? coords.map((c, i) => {
        const y = padT + plotH - ((c.p.blocked || 0) / maxVal) * plotH;
        return `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ') : '';

    let peakIdx = 0;
    points.forEach((p, i) => {
        if ((p.total || 0) >= (points[peakIdx].total || 0)) peakIdx = i;
    });

    const yTicks = [0, Math.ceil(maxVal / 2), maxVal];
    const yLines = yTicks.map((v) => {
        const y = padT + plotH - (v / maxVal) * plotH;
        const isBase = v === 0;
        return `<line class="mcp-stats-timeline-grid${isBase ? ' mcp-stats-timeline-grid--base' : ''}" x1="${padL}" y1="${y.toFixed(2)}" x2="${W - padR}" y2="${y.toFixed(2)}" />` +
            `<text class="mcp-stats-timeline-y" x="${padL - 4}" y="${(y + 3.5).toFixed(2)}">${v}</text>`;
    }).join('');

    const tickIdx = points.length <= 2
        ? points.map((_, i) => i)
        : [0, Math.floor((points.length - 1) / 2), points.length - 1];
    const xLabels = tickIdx.map((idx, ti) => {
        const c = coords[idx];
        const label = formatMcpTimelineLabel(c.p.t, rangeKey, locale);
        let anchor = 'middle';
        if (tickIdx.length > 1) {
            if (ti === 0) anchor = 'start';
            else if (ti === tickIdx.length - 1) anchor = 'end';
        }
        return `<text class="mcp-stats-timeline-axis" x="${c.x.toFixed(2)}" y="${H - 5}" text-anchor="${anchor}">${escapeHtml(label)}</text>`;
    }).join('');

    const dots = coords.map((c) => {
        const tipTime = formatMcpTimelineLabel(c.p.t, rangeKey, locale);
        const isPeak = c.i === peakIdx && (c.p.total || 0) > 0;
        const dotClass = 'mcp-stats-timeline-dot' + (isPeak ? ' mcp-stats-timeline-dot--peak' : '');
        return `<circle class="${dotClass}" cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${isPeak ? 2 : 1.5}"
            data-time="${escapeAttrLocal(tipTime)}"
            data-total="${c.p.total || 0}"
            data-failed="${c.p.failed || 0}"
            data-blocked="${c.p.blocked || 0}" />`;
    }).join('');

    const bars = coords.map((c) => {
        const total = c.p.total || 0;
        const failed = c.p.failed || 0;
        const blocked = c.p.blocked || 0;
        const h = total > 0 ? Math.max(3, (total / maxVal) * plotH) : 1;
        const y = baseY - h;
        const failedH = total > 0 ? h * (failed / total) : 0;
        const blockedH = total > 0 ? h * (blocked / total) : 0;
        const tipTime = formatMcpTimelineLabel(c.p.t, rangeKey, locale);
        return `<g class="mcp-stats-timeline-bar-group">
            <rect class="mcp-stats-timeline-bar${total > 0 ? ' is-active' : ''}" x="${(c.x - barW / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="1.6"
                data-time="${escapeAttrLocal(tipTime)}" data-total="${total}" data-failed="${failed}" data-blocked="${blocked}" />
            ${failedH > 0 ? `<rect class="mcp-stats-timeline-bar-fail" x="${(c.x - barW / 2).toFixed(2)}" y="${(baseY - failedH).toFixed(2)}" width="${barW.toFixed(2)}" height="${failedH.toFixed(2)}" rx="1.6"
                data-time="${escapeAttrLocal(tipTime)}" data-total="${total}" data-failed="${failed}" data-blocked="${blocked}" />` : ''}
            ${blockedH > 0 ? `<rect class="mcp-stats-timeline-bar-blocked" x="${(c.x - barW / 2).toFixed(2)}" y="${(baseY - failedH - blockedH).toFixed(2)}" width="${barW.toFixed(2)}" height="${blockedH.toFixed(2)}" rx="1.6"
                data-time="${escapeAttrLocal(tipTime)}" data-total="${total}" data-failed="${failed}" data-blocked="${blocked}" />` : ''}
        </g>`;
    }).join('');

    const peakC = coords[peakIdx];
    const peakMarker = (peakC.p.total || 0) > 0
        ? `<circle class="mcp-stats-timeline-peak-glow" cx="${peakC.x.toFixed(2)}" cy="${peakC.y.toFixed(2)}" r="5" />`
        : '';

    return `<svg class="mcp-stats-timeline__chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
            <linearGradient id="mcpTimelineAreaFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.28"/>
                <stop offset="85%" stop-color="#3b82f6" stop-opacity="0.04"/>
                <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
            </linearGradient>
            <linearGradient id="mcpTimelineLineStroke" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stop-color="#60a5fa"/>
                <stop offset="50%" stop-color="#3b82f6"/>
                <stop offset="100%" stop-color="#2563eb"/>
            </linearGradient>
        </defs>
        ${yLines}
        <path class="mcp-stats-timeline-area" d="${areaPath}" fill="url(#mcpTimelineAreaFill)" />
        ${bars}
        ${peakMarker}
        <path class="mcp-stats-timeline-line" d="${linePath}" stroke="url(#mcpTimelineLineStroke)" />
        ${hasFailed ? `<path class="mcp-stats-timeline-line mcp-stats-timeline-line--fail" d="${failPath}" />` : ''}
        ${hasBlocked ? `<path class="mcp-stats-timeline-line mcp-stats-timeline-line--blocked" d="${blockedPath}" />` : ''}
        ${dots}
        ${xLabels}
    </svg>`;
}

let mcpTimelineEventsBound = false;
let mcpTimelineTooltipEl = null;

function bindMcpStatsTimelineEvents() {
    const root = document.getElementById('monitor-stats');
    if (!root) return;

    root.querySelectorAll('.mcp-stats-timeline__range').forEach((btn) => {
        btn.onclick = function () {
            const range = btn.getAttribute('data-range');
            if (range) setMcpMonitorTimelineRange(range);
        };
    });

    if (mcpTimelineEventsBound) return;
    if (!mcpTimelineTooltipEl) {
        mcpTimelineTooltipEl = document.createElement('div');
        mcpTimelineTooltipEl.className = 'mcp-stats-timeline-tooltip';
        mcpTimelineTooltipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(mcpTimelineTooltipEl);
    }

    root.addEventListener('mousemove', function (e) {
        const dot = e.target.closest('.mcp-stats-timeline-dot, .mcp-stats-timeline-bar, .mcp-stats-timeline-bar-fail, .mcp-stats-timeline-bar-blocked');
        if (!dot || !mcpTimelineTooltipEl) {
            root.querySelectorAll('.mcp-stats-timeline-dot.is-active').forEach((d) => d.classList.remove('is-active'));
            root.querySelectorAll('.mcp-stats-timeline-bar.is-hover, .mcp-stats-timeline-bar-fail.is-hover, .mcp-stats-timeline-bar-blocked.is-hover').forEach((d) => d.classList.remove('is-hover'));
            mcpTimelineTooltipEl.style.display = 'none';
            return;
        }
        root.querySelectorAll('.mcp-stats-timeline-dot.is-active').forEach((d) => d.classList.remove('is-active'));
        root.querySelectorAll('.mcp-stats-timeline-bar.is-hover, .mcp-stats-timeline-bar-fail.is-hover, .mcp-stats-timeline-bar-blocked.is-hover').forEach((d) => d.classList.remove('is-hover'));
        dot.classList.add('is-active');
        dot.classList.add('is-hover');
        const time = dot.getAttribute('data-time') || '';
        const total = dot.getAttribute('data-total') || '0';
        const failed = dot.getAttribute('data-failed') || '0';
        const blocked = dot.getAttribute('data-blocked') || '0';
        const tip = mcpMonitorT('timelineTooltip', { time, total, failed, blocked })
            || monitorFallback(`${time}：${total} 次（失败 ${failed}，安全拦截 ${blocked}）`, `${time}: ${total} calls (${failed} failed, ${blocked} blocked)`);
        mcpTimelineTooltipEl.textContent = tip;
        mcpTimelineTooltipEl.style.display = 'block';
        mcpTimelineTooltipEl.style.left = `${e.clientX}px`;
        mcpTimelineTooltipEl.style.top = `${e.clientY}px`;
    });

    root.addEventListener('mouseleave', function (e) {
        if (!e.target.closest || !e.target.closest('.mcp-stats-combined__timeline, .mcp-stats-timeline')) return;
        if (e.relatedTarget && root.contains(e.relatedTarget)) return;
        root.querySelectorAll('.mcp-stats-timeline-dot.is-active').forEach((d) => d.classList.remove('is-active'));
        root.querySelectorAll('.mcp-stats-timeline-bar.is-hover, .mcp-stats-timeline-bar-fail.is-hover, .mcp-stats-timeline-bar-blocked.is-hover').forEach((d) => d.classList.remove('is-hover'));
        if (mcpTimelineTooltipEl) mcpTimelineTooltipEl.style.display = 'none';
    });

    mcpTimelineEventsBound = true;
}

function getMcpTimelineRangeLabel(rangeKey) {
    const key = rangeKey === '24h' ? 'timelineRange24h' : rangeKey === '30d' ? 'timelineRange30d' : 'timelineRange7d';
    return mcpMonitorT(key) || rangeKey;
}

function syncMcpMonitorTimelineRangeUI(activeRange) {
    const range = activeRange || getMcpMonitorTimelineRange();
    document.querySelectorAll('#monitor-stats .mcp-stats-timeline__range').forEach((btn) => {
        const r = btn.getAttribute('data-range');
        const on = r === range;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const scopeBadge = document.querySelector('#monitor-stats .mcp-stats-scope-badge--timeline');
    if (scopeBadge) scopeBadge.textContent = getMcpTimelineRangeLabel(range);
}

function renderMcpStatsScopeBadges(showTools, showTimeline) {
    const parts = [];
    if (showTools) {
        const cumulative = mcpMonitorT('scopeCumulative') || '累计';
        parts.push(`<span class="mcp-stats-scope-badge mcp-stats-scope-badge--cumulative">${escapeHtml(cumulative)}</span>`);
    }
    if (showTimeline) {
        const range = getMcpMonitorTimelineRange();
        parts.push(`<span class="mcp-stats-scope-badge mcp-stats-scope-badge--timeline">${escapeHtml(getMcpTimelineRangeLabel(range))}</span>`);
    }
    if (!parts.length) return '';
    return `<div class="mcp-stats-combined__scopes" role="note">${parts.join('')}</div>`;
}

function buildTimelineSparseHint(points, timeline) {
    if (!Array.isArray(points) || points.length < 4 || !timeline || !timeline.summary) return '';
    const summaryTotal = timeline.summary.totalCalls || 0;
    const peak = timeline.summary.peak || 0;
    if (summaryTotal === 0 || peak === 0) return '';

    const nonZero = points.filter((p) => (p.total || 0) > 0).length;
    const nonZeroRatio = nonZero / points.length;
    let peakIdx = 0;
    points.forEach((p, i) => {
        if ((p.total || 0) >= (points[peakIdx].total || 0)) peakIdx = i;
    });
    const peakNearEnd = peakIdx >= Math.floor(points.length * 0.8);
    if (nonZeroRatio > 0.3 && !peakNearEnd) return '';

    const rangeKey = timeline.range || getMcpMonitorTimelineRange();
    const locale = (typeof window.uiLocale === 'function' ? window.uiLocale() : 'en-US');
    const peakTime = timeline.summary.peakAt
        ? formatMcpTimelineLabel(timeline.summary.peakAt, rangeKey, locale)
        : formatMcpTimelineLabel(points[peakIdx].t, rangeKey, locale);
    return mcpMonitorT('timelineSparseHint', { peak, peakTime })
        || `该时段多数时间为 0，峰值 ${peak} 次出现在 ${peakTime}`;
}

function renderMcpTimelineActiveMoments(points, rangeKey) {
    if (!Array.isArray(points) || points.length === 0) return '';
    const locale = (typeof window.uiLocale === 'function' ? window.uiLocale() : 'en-US');
    const active = points
        .map((p, i) => ({ ...p, i }))
        .filter((p) => (p.total || 0) > 0)
        .sort((a, b) => (b.total || 0) - (a.total || 0) || b.i - a.i)
    const shown = active.slice(0, 4);
    const hiddenCount = Math.max(0, active.length - shown.length);
    if (!active.length) return '';
    const label = mcpMonitorT('timelineActiveMoments') || monitorFallback('活跃时段', 'Active moments');
    const moreLabel = mcpMonitorT('timelineMoreMoments', { n: hiddenCount }) || `+${hiddenCount}`;
    const chips = shown.map((p) => {
        const time = formatMcpTimelineLabel(p.t, rangeKey, locale);
        const failed = p.failed || 0;
        const failedLabel = mcpMonitorT('failedCount', { n: failed }) || `失败 ${failed}`;
        const blocked = p.blocked || 0;
        const blockedLabel = mcpMonitorT('blockedCount', { n: blocked }) || monitorFallback(`安全拦截 ${blocked}`, `Blocked ${blocked}`);
        return `<span class="mcp-stats-timeline-moment" title="${escapeAttr(time)}">
            <span class="mcp-stats-timeline-moment__time">${escapeHtml(time)}</span>
            <span class="mcp-stats-timeline-moment__count">${p.total || 0}</span>
            ${failed > 0 ? `<span class="mcp-stats-timeline-moment__fail">${escapeHtml(failedLabel)}</span>` : ''}
            ${blocked > 0 ? `<span class="mcp-stats-timeline-moment__blocked">${escapeHtml(blockedLabel)}</span>` : ''}
        </span>`;
    }).join('');
    const moreChip = hiddenCount > 0
        ? `<span class="mcp-stats-timeline-moment mcp-stats-timeline-moment--more" title="${escapeAttr(mcpMonitorT('timelineMoreMomentsTitle', { n: hiddenCount }) || `还有 ${hiddenCount} 个活跃时段`)}">${escapeHtml(moreLabel)}</span>`
        : '';
    return `<div class="mcp-stats-timeline-moments">
        <span class="mcp-stats-timeline-moments__label">${escapeHtml(label)}</span>
        <div class="mcp-stats-timeline-moments__list">${chips}${moreChip}</div>
    </div>`;
}

async function setMcpMonitorTimelineRange(range) {
    if (!MCP_TIMELINE_RANGES.includes(range)) return;
    localStorage.setItem('mcpMonitorTimelineRange', range);
    monitorState.timelineRange = range;
    monitorState.timelineError = null;
    monitorState.timelineLoading = true;
    syncMcpMonitorTimelineRangeUI(range);
    updateMonitorTimelineSection();
    try {
        const { timeline, timelineError } = await fetchMonitorTimeline(range);
        applyMonitorTimelinePayload(timeline, timelineError, range);
    } catch (err) {
        applyMonitorTimelinePayload(null, err.message || 'error', range);
    }
}
window.setMcpMonitorTimelineRange = setMcpMonitorTimelineRange;

function renderMcpStatsTimelineRangeButtons() {
    const activeRange = getMcpMonitorTimelineRange();
    return MCP_TIMELINE_RANGES.map((r) => {
        const labelKey = r === '24h' ? 'timelineRange24h' : r === '30d' ? 'timelineRange30d' : 'timelineRange7d';
        const label = mcpMonitorT(labelKey) || r;
        return `<button type="button" class="mcp-stats-timeline__range${activeRange === r ? ' is-active' : ''}"
            data-range="${r}" aria-pressed="${activeRange === r ? 'true' : 'false'}">${escapeHtml(label)}</button>`;
    }).join('');
}

const MCP_TIMELINE_EMPTY_ICON = '<svg class="mcp-stats-timeline-empty-state__icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

function renderMcpStatsTimelineEmptyState(compact) {
    const noData = mcpMonitorT('timelineNoData') || monitorFallback('该时段暂无调用', 'No calls in this period');
    const emptyHint = mcpMonitorT('timelineEmptyHint')
        || monitorFallback('切换时间范围查看其他时段，或在对话/任务中调用 MCP 工具', 'Switch the time range or invoke MCP tools in chat or tasks');
    const compactClass = compact ? ' mcp-stats-timeline-empty-state--compact' : '';
    return `<div class="mcp-stats-timeline-empty-state${compactClass}">
        ${MCP_TIMELINE_EMPTY_ICON}
        <p class="mcp-stats-timeline-empty-state__title">${escapeHtml(noData)}</p>
        <p class="mcp-stats-timeline-empty-state__hint">${escapeHtml(emptyHint)}</p>
    </div>`;
}

function renderMcpStatsTimelineBody(timeline, timelineError, compactEmpty, loading) {
    if (loading) {
        const loadingText = mcpMonitorT('timelineLoading') || monitorFallback('趋势加载中…', 'Loading trend…');
        return `<div class="monitor-empty monitor-empty--inline">${escapeHtml(loadingText)}</div>`;
    }

    const hint = mcpMonitorT('timelineHint') || monitorFallback('全部工具合计', 'All tools combined');

    if (timelineError) {
        const errText = mcpMonitorT('timelineLoadError') || monitorFallback('无法加载调用趋势', 'Failed to load call trend');
        return `<p class="mcp-stats-timeline-error">${escapeHtml(errText)}：${escapeHtml(timelineError)}</p>`;
    }

    const points = timeline && Array.isArray(timeline.points) ? timeline.points : [];
    const summaryTotal = timeline && timeline.summary ? (timeline.summary.totalCalls || 0) : 0;
    const peak = timeline && timeline.summary ? (timeline.summary.peak || 0) : 0;
    const summaryText = mcpMonitorT('timelineSummary', { total: summaryTotal, peak })
        || `区间内 ${summaryTotal} 次 · 峰值 ${peak}`;

    if (points.length === 0 || summaryTotal === 0) {
        return renderMcpStatsTimelineEmptyState(!!compactEmpty);
    }

    const rangeKey = timeline.range || getMcpMonitorTimelineRange();
    const chartSvg = buildMcpTimelineSvg(points, rangeKey);
    const totalLegend = mcpMonitorT('timelineTotalLegend') || '总调用';
    const failLegend = mcpMonitorT('timelineFailedLegend') || '失败';
    const blockedLegend = mcpMonitorT('timelineBlockedLegend') || monitorFallback('安全拦截', 'Blocked');
    const hasFailed = points.some((p) => (p.failed || 0) > 0);
    const hasBlocked = points.some((p) => (p.blocked || 0) > 0);
    const sparseHint = buildTimelineSparseHint(points, timeline);
    const momentsHtml = renderMcpTimelineActiveMoments(points, rangeKey);
    const sparseHtml = sparseHint
        ? `<p class="mcp-stats-timeline__sparse-hint">${escapeHtml(sparseHint)}</p>`
        : '';

    return `
        <p class="mcp-stats-timeline__inline-meta">${escapeHtml(hint)} · ${escapeHtml(summaryText)}</p>
        ${momentsHtml}
        <div class="mcp-stats-timeline__chart-wrap">${chartSvg}</div>
        ${sparseHtml}
        <div class="mcp-stats-timeline__legend">
            <span class="mcp-stats-timeline__legend-item">${escapeHtml(totalLegend)}</span>
            ${hasFailed ? `<span class="mcp-stats-timeline__legend-item mcp-stats-timeline__legend-item--fail">${escapeHtml(failLegend)}</span>` : ''}
            ${hasBlocked ? `<span class="mcp-stats-timeline__legend-item mcp-stats-timeline__legend-item--blocked">${escapeHtml(blockedLegend)}</span>` : ''}
        </div>`;
}

function renderMcpStatsCombinedSection(topTools, totals, activeToolFilter, timeline, timelineError, showTimeline) {
    const statsTitle = mcpMonitorT('toolStatsTitle') || monitorFallback('工具统计', 'Tool statistics');
    const timelineTitle = mcpMonitorT('timelineTitle') || monitorFallback('调用趋势', 'Call trend');
    const statsHint = mcpMonitorT('toolStatsHint') || monitorFallback('点击色条或列表行筛选下方执行记录', 'Click a bar segment or row to filter records below');
    const hasTools = topTools.length > 0;

    if (!hasTools && !showTimeline) return '';

    const filterChipLabel = activeToolFilter ? formatMonitorToolName(activeToolFilter) : '';
    const filterChip = activeToolFilter
        ? `<span class="mcp-stats-filter-chip" title="${escapeAttr(mcpMonitorT('filterByToolTitle', { tool: filterChipLabel }) || filterChipLabel)}">
            <span class="mcp-stats-filter-chip__label">${escapeHtml(mcpMonitorT('filterActive', { tool: filterChipLabel }) || `已筛选：${filterChipLabel}`)}</span>
            <button type="button" class="mcp-stats-filter-chip__clear mcp-stats-clear-filter" aria-label="${escapeAttr(mcpMonitorT('clearToolFilter') || '清除工具筛选')}">×</button>
        </span>`
        : '';

    const rangeButtons = showTimeline
        ? `<div class="mcp-stats-timeline__ranges" role="group" aria-label="${escapeAttr(timelineTitle)}">${renderMcpStatsTimelineRangeButtons()}</div>`
        : '';

    const panelTitle = showTimeline && hasTools
        ? `${statsTitle} · ${timelineTitle}`
        : (hasTools ? statsTitle : timelineTitle);

    const scopeBadges = renderMcpStatsScopeBadges(hasTools, showTimeline);
    const metaHint = hasTools ? statsHint : '';

    const timelineCol = showTimeline
        ? `<div class="mcp-stats-combined__timeline">
            <p class="mcp-stats-combined__col-label">${escapeHtml(timelineTitle)}</p>
            <div class="mcp-stats-combined__timeline-inner">${renderMcpStatsTimelineBody(timeline, timelineError, hasTools, monitorState.timelineLoading)}</div>
        </div>`
        : '';

    let bodyMod = 'mcp-stats-combined__body';
    if (hasTools && showTimeline) bodyMod += ' mcp-stats-combined__body--full';
    else if (hasTools) bodyMod += ' mcp-stats-combined__body--tools';
    else bodyMod += ' mcp-stats-combined__body--timeline';

    const mainBlock = hasTools
        ? `<div class="mcp-stats-combined__main">${renderMcpStatsToolsPanel(topTools, totals, activeToolFilter)}</div>`
        : '';

    return `
        <section class="mcp-stats-combined" aria-label="${escapeAttr(panelTitle)}">
            <header class="mcp-stats-combined__head">
                <div class="mcp-stats-combined__head-text">
                    <h4 class="mcp-stats-combined__title">${escapeHtml(panelTitle)}</h4>
                    <div class="mcp-stats-combined__meta-row">
                        ${scopeBadges}
                        ${metaHint ? `<p class="mcp-stats-combined__meta">${escapeHtml(metaHint)}</p>` : ''}
                    </div>
                </div>
                <div class="mcp-stats-combined__actions">
                    ${filterChip}
                    ${rangeButtons}
                </div>
            </header>
            <div class="${bodyMod}">
                ${mainBlock}
                ${timelineCol}
            </div>
        </section>`;
}

function mcpMonitorT(key, params) {
    if (typeof window.t !== 'function') return '';
    const fullKey = 'mcpMonitor.' + key;
    const text = window.t(fullKey, {
        ...(params || {}),
        interpolation: { escapeValue: false },
    });
    if (!text || text === fullKey) return '';
    return text;
}

function monitorFallback(zhText, enText) {
    return (typeof window.__locale === 'string' && window.__locale.startsWith('zh')) ? zhText : enText;
}

function refreshMonitorPanelFromState() {
    if (!document.getElementById('monitor-stats')) return;
    if (!monitorState.lastFetchedAt) return;
    const statusFilter = document.getElementById('monitor-status-filter');
    const currentStatusFilter = statusFilter ? statusFilter.value : 'all';
    renderMonitorStats(monitorState.summary, monitorState.topTools, monitorState.lastFetchedAt);
    renderMonitorExecutions(monitorState.executions || [], currentStatusFilter);
    renderMonitorPagination();
}

const MCP_STATS_TOOL_CHEVRON = '<svg class="mcp-stats-tool-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

function getMcpStatsRateTone(rateNum) {
    if (rateNum >= 95) return 'is-success';
    if (rateNum >= 80) return 'is-warning';
    return 'is-danger';
}

function getMcpStatsRingStrokeClass(rateNum) {
    if (rateNum >= 95) return '';
    if (rateNum >= 80) return 'is-warning';
    return 'is-danger';
}

function renderMcpStatsSuccessRing(percent) {
    const p = Math.min(100, Math.max(0, parseFloat(percent) || 0));
    const r = 15.9155;
    const circumference = 2 * Math.PI * r;
    const offset = circumference - (p / 100) * circumference;
    const strokeClass = getMcpStatsRingStrokeClass(p);
    return `<div class="mcp-stats-ring-wrap" aria-hidden="true">
        <svg class="mcp-stats-ring-svg" viewBox="0 0 36 36">
            <circle class="mcp-stats-ring-track" cx="18" cy="18" r="${r}" fill="none" stroke-width="3"/>
            <circle class="mcp-stats-ring-fill ${strokeClass}" cx="18" cy="18" r="${r}" fill="none" stroke-width="3"
                stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
        </svg>
    </div>`;
}

function renderMcpStatsToolVolumeBar(total, success, failed, maxTotal) {
    const volumePct = maxTotal > 0 && total > 0 ? (total / maxTotal) * 100 : 0;
    const successPct = total > 0 ? (success / total) * 100 : 0;
    const failPct = total > 0 ? (failed / total) * 100 : 0;
    const legend = mcpMonitorT('barVolumeLegend') || '条长表示相对调用量';
    const volumeTitle = `${total} / ${maxTotal}`;
    return `<div class="mcp-stats-tool-bar-track" title="${escapeAttr(legend)} · ${escapeHtml(volumeTitle)}">
        <div class="mcp-stats-tool-bar-fill" style="width:${volumePct.toFixed(2)}%">
            <div class="mcp-stats-tool-bar-inner">
                <span class="mcp-stats-tool-bar-seg mcp-stats-tool-bar-seg--success" style="width:${successPct.toFixed(2)}%"></span>
                <span class="mcp-stats-tool-bar-seg mcp-stats-tool-bar-seg--fail" style="width:${failPct.toFixed(2)}%"></span>
            </div>
        </div>
    </div>`;
}

function getMcpToolRateClass(rateNum) {
    if (rateNum >= 95) return 'is-success';
    if (rateNum >= 80) return 'is-warning';
    return 'is-danger';
}

const MCP_STATS_DIST_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#14b8a6', '#ec4899'];
const MCP_STATS_CHART_MIN_PCT = 5;

function buildMcpStatsChartSegments(topTools, totals, options = {}) {
    const groupSmall = options.groupSmall !== false;
    const minPct = options.minPct ?? MCP_STATS_CHART_MIN_PCT;
    const othersLabel = mcpMonitorT('distOthers') || '其他工具';
    const topNTotal = topTools.reduce((s, t) => s + (t.totalCalls || 0), 0);
    const otherCalls = Math.max(0, totals.total - topNTotal);

    const segments = [];
    let bundledCalls = otherCalls;

    topTools.forEach((tool, i) => {
        const calls = tool.totalCalls || 0;
        if (calls <= 0 || totals.total <= 0) return;
        const pct = (calls / totals.total) * 100;
        if (groupSmall && pct < minPct) {
            bundledCalls += calls;
            return;
        }
        segments.push({
            color: MCP_STATS_DIST_COLORS[i % MCP_STATS_DIST_COLORS.length],
            name: tool.toolName || '',
            calls,
            pct: pct.toFixed(1),
            pctNum: pct,
            isOthers: false,
            colorIndex: i,
        });
    });

    if (bundledCalls > 0 && totals.total > 0) {
        const pct = (bundledCalls / totals.total) * 100;
        segments.push({
            color: '#cbd5e1',
            name: othersLabel,
            calls: bundledCalls,
            pct: pct.toFixed(1),
            pctNum: pct,
            isOthers: true,
            colorIndex: topTools.length,
        });
    }

    let acc = 0;
    return segments.map((s) => {
        const start = acc;
        acc += s.pctNum;
        return { ...s, start, end: acc };
    });
}

function renderMcpStatsShareCell(sharePct, color) {
    const width = Math.min(100, Math.max(0, parseFloat(sharePct) || 0));
    return `<td class="mcp-stats-col-share">
        <div class="mcp-stats-share-cell">
            <span class="mcp-stats-share-pct">${escapeHtml(sharePct)}%</span>
            <span class="mcp-stats-share-track" aria-hidden="true">
                <span class="mcp-stats-share-fill" style="width:${width.toFixed(1)}%;background:${color}"></span>
            </span>
        </div>
    </td>`;
}

function mcpStatsDescribeDonutSegment(startPct, endPct, outerR, innerR) {
    if (endPct <= startPct) return '';
    const span = endPct - startPct;
    const cx = 50;
    const cy = 50;
    const point = (pct, r) => {
        const rad = ((pct / 100) * 360 - 90) * Math.PI / 180;
        return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };
    if (span >= 99.995) {
        const [x1, y1] = point(0, outerR);
        const [x2, y2] = point(50, outerR);
        const [x3, y3] = point(50, innerR);
        const [x4, y4] = point(0, innerR);
        const [x5, y5] = point(50, outerR);
        const [x6, y6] = point(100, outerR);
        const [x7, y7] = point(100, innerR);
        const [x8, y8] = point(50, innerR);
        return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${outerR} ${outerR} 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)} A ${outerR} ${outerR} 0 0 1 ${x6.toFixed(3)} ${y6.toFixed(3)} L ${x7.toFixed(3)} ${y7.toFixed(3)} A ${innerR} ${innerR} 0 0 0 ${x8.toFixed(3)} ${y8.toFixed(3)} A ${innerR} ${innerR} 0 0 0 ${x4.toFixed(3)} ${y4.toFixed(3)} Z`;
    }
    const large = span > 50 ? 1 : 0;
    const [x1, y1] = point(startPct, outerR);
    const [x2, y2] = point(endPct, outerR);
    const [x3, y3] = point(endPct, innerR);
    const [x4, y4] = point(startPct, innerR);
    return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${outerR} ${outerR} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} L ${x3.toFixed(3)} ${y3.toFixed(3)} A ${innerR} ${innerR} 0 ${large} 0 ${x4.toFixed(3)} ${y4.toFixed(3)} Z`;
}

function resetMcpStatsDistCenter(panel) {
    if (!panel) return;
    const label = panel.querySelector('.mcp-stats-dist-donut-label');
    const value = panel.querySelector('.mcp-stats-dist-donut-value');
    const unit = panel.querySelector('.mcp-stats-dist-donut-unit');
    if (!label || !value) return;
    label.textContent = panel.getAttribute('data-center-label') || '';
    label.classList.add('is-default');
    const centerVal = panel.getAttribute('data-center-value') || '';
    const numEl = panel.querySelector('.mcp-stats-dist-donut-value-num');
    if (numEl) numEl.textContent = centerVal;
    else value.textContent = centerVal;
    if (unit) {
        unit.textContent = panel.getAttribute('data-center-suffix') || '%';
        unit.hidden = false;
    }
}

function previewMcpStatsDistCenter(panel, toolName, pct) {
    if (!panel) return;
    const label = panel.querySelector('.mcp-stats-dist-donut-label');
    const value = panel.querySelector('.mcp-stats-dist-donut-value');
    const unit = panel.querySelector('.mcp-stats-dist-donut-unit');
    if (!label || !value) return;
    const shortName = toolName.length > 14 ? `${toolName.slice(0, 13)}…` : toolName;
    label.textContent = shortName;
    label.classList.remove('is-default');
    const numEl = panel.querySelector('.mcp-stats-dist-donut-value-num');
    if (numEl) numEl.textContent = pct;
    else value.textContent = pct;
    if (unit) unit.hidden = false;
}

function setMcpStatsDistHover(toolName) {
    const panel = document.querySelector('.mcp-stats-dist-panel');
    const root = document.getElementById('monitor-stats');
    const esc = toolName && typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(toolName)
        : (toolName || '').replace(/"/g, '\\"');

    if (panel) {
        panel.querySelectorAll('.mcp-stats-dist-segment, .mcp-stats-dist-legend-item').forEach((el) => {
            const t = el.getAttribute('data-tool-name') || '';
            const match = toolName && t === toolName;
            el.classList.toggle('is-highlighted', !!match);
            el.classList.toggle('is-dimmed', !!toolName && !match && t);
        });
        if (toolName) {
            const el = panel.querySelector(`[data-tool-name="${esc}"]`);
            if (el) {
                previewMcpStatsDistCenter(panel, toolName, el.getAttribute('data-pct') || '');
            }
        } else {
            resetMcpStatsDistCenter(panel);
        }
    }

    if (root) {
        root.querySelectorAll(
            'tr.mcp-stats-tool-row[data-tool-name], .mcp-stats-tool-item[data-tool-name], .mcp-stats-proportion-seg[data-tool-name]'
        ).forEach((el) => {
            const t = el.getAttribute('data-tool-name') || '';
            const match = toolName && t === toolName;
            el.classList.toggle('is-highlighted', !!match);
            el.classList.toggle('is-dimmed', !!toolName && !match && t);
        });
    }
}

function handleMonitorStatsToolFilter(toolName) {
    if (!toolName) return;
    const toolFilter = document.getElementById('monitor-tool-filter');
    if (toolFilter && toolFilter.value === toolName) {
        clearMonitorToolFilter();
        return;
    }
    filterMonitorByTool(toolName);
}

function renderMcpStatsInsightPanel(topTools, totals, activeToolFilter = '', options = {}) {
    const embedded = !!options.embedded;
    const distTitle = mcpMonitorT('distTitle') || '调用分布';
    const distClickHint = mcpMonitorT('distClickHint') || '点击扇区筛选执行记录';
    const distOthersTitle = mcpMonitorT('distOthersNoFilter') || '其他工具无法单独筛选';
    const top6ShareLabel = mcpMonitorT('distTop6Share', { n: MCP_STATS_TOP_N }) || `Top ${MCP_STATS_TOP_N} 占全部调用`;

    const top6Total = topTools.reduce((s, t) => s + (t.totalCalls || 0), 0);
    const top6SharePct = totals.total > 0 ? ((top6Total / totals.total) * 100).toFixed(1) : '0.0';

    const segments = buildMcpStatsChartSegments(topTools, totals, { groupSmall: embedded });

    const segmentPathsHtml = segments.map((s) => {
        const pathD = mcpStatsDescribeDonutSegment(s.start, s.end, 48, 30);
        if (!pathD) return '';
        const isActive = !s.isOthers && activeToolFilter && activeToolFilter === s.name;
        const segAria = s.isOthers
            ? escapeHtml(s.name)
            : escapeHtml(mcpMonitorT('distSegmentAria', { name: s.name, pct: s.pct, calls: s.calls })
                || `${s.name}，占 ${s.pct}%，${s.calls} 次`);
        return `<path class="mcp-stats-dist-segment${isActive ? ' is-active' : ''}${s.isOthers ? ' is-others' : ''}"
            d="${pathD}"
            fill="${s.color}"
            data-tool-name="${s.isOthers ? '' : escapeHtml(s.name)}"
            data-pct="${s.pct}"
            data-calls="${s.calls}"
            data-is-others="${s.isOthers ? '1' : '0'}"
            tabindex="${s.isOthers ? '-1' : '0'}"
            role="${s.isOthers ? 'presentation' : 'button'}"
            aria-label="${segAria}" />`;
    }).join('');

    const legendHtml = embedded ? '' : segments.map((s) => {
        const isActive = !s.isOthers && activeToolFilter && activeToolFilter === s.name;
        const inner = `
            <span class="mcp-stats-dist-swatch" style="--swatch-color:${s.color}"></span>
            <span class="mcp-stats-dist-legend-name" title="${escapeAttr(s.name)}">${escapeHtml(s.name)}</span>
            <span class="mcp-stats-dist-legend-pct">${s.pct}%</span>`;
        if (s.isOthers) {
            return `<li class="mcp-stats-dist-legend-item is-others" title="${escapeAttr(distOthersTitle)}" data-is-others="1">${inner}</li>`;
        }
        const rowAria = mcpMonitorT('toolRowAriaLabel', { name: s.name, total: s.calls, rate: s.pct })
            || `${s.name}，${s.calls} 次调用，占 ${s.pct}%`;
        return `<li class="mcp-stats-dist-legend-item-wrap">
            <button type="button" class="mcp-stats-dist-legend-item${isActive ? ' is-active' : ''}"
                data-tool-name="${escapeAttrLocal(s.name)}"
                data-pct="${s.pct}"
                data-calls="${s.calls}"
                data-is-others="0"
                aria-label="${escapeAttrLocal(rowAria)}"
                aria-pressed="${isActive ? 'true' : 'false'}">${inner}</button>
        </li>`;
    }).join('');

    const centerLabel = embedded ? (mcpMonitorT('distTitle') || '占比') : `Top ${MCP_STATS_TOP_N}`;
    const distHint = totals.total > 0
        ? (mcpMonitorT('distTotalCalls', { n: totals.total }) || `共 ${totals.total} 次调用`)
        : '';

    const bodyClass = embedded ? 'mcp-stats-dist-body mcp-stats-dist-body--chart-only' : 'mcp-stats-dist-body mcp-stats-dist-body--side';
    const legendBlock = legendHtml
        ? `<ul class="mcp-stats-dist-legend mcp-stats-dist-legend--side">${legendHtml}</ul>`
        : '';

    const headerHtml = embedded
        ? `<div class="mcp-stats-dist-embedded-title">${escapeHtml(distTitle)}</div>`
        : `
            <div class="mcp-stats-tools-header">
                <div class="mcp-stats-tools-heading">
                    <h4 class="mcp-stats-tools-title">${escapeHtml(distTitle)}</h4>
                    <span class="mcp-stats-tools-legend">${escapeHtml(distClickHint)}</span>
                </div>
                <span class="mcp-stats-tools-hint">${escapeHtml(distHint)}</span>
            </div>`;

    return `
        <div class="mcp-stats-dist-panel${embedded ? ' mcp-stats-dist-panel--embedded' : ''}" aria-label="${escapeAttrLocal(distTitle)}"
            data-center-label="${escapeAttrLocal(centerLabel)}"
            data-center-value="${top6SharePct}"
            data-center-suffix="%">
            ${headerHtml}
            <div class="${bodyClass}">
                <div class="mcp-stats-dist-chart-stage">
                    <div class="mcp-stats-dist-chart-wrap">
                        <svg class="mcp-stats-dist-svg" viewBox="0 0 100 100" role="img" aria-label="${escapeAttr(top6ShareLabel)} ${top6SharePct}%">
                            <g class="mcp-stats-dist-segments">${segmentPathsHtml}</g>
                        </svg>
                        <div class="mcp-stats-dist-donut-hole" aria-hidden="true">
                            <span class="mcp-stats-dist-donut-label is-default">${centerLabel}</span>
                            <span class="mcp-stats-dist-donut-value"><span class="mcp-stats-dist-donut-value-num">${top6SharePct}</span><span class="mcp-stats-dist-donut-unit">%</span></span>
                        </div>
                    </div>
                </div>
                ${legendBlock}
            </div>
        </div>
    `;
}


function renderMcpStatsStackedBar(success, failed) {
    const total = success + failed;
    if (total <= 0) {
        return '<div class="mcp-stats-stacked-bar" role="presentation"><div class="mcp-stats-stacked-bar-seg mcp-stats-stacked-bar-seg--success" style="flex:1"></div></div>';
    }
    const successFlex = Math.max(0, (success / total) * 100);
    const failFlex = Math.max(0, (failed / total) * 100);
    return `<div class="mcp-stats-stacked-bar" role="presentation">
        <div class="mcp-stats-stacked-bar-seg mcp-stats-stacked-bar-seg--success" style="flex:${successFlex}"></div>
        <div class="mcp-stats-stacked-bar-seg mcp-stats-stacked-bar-seg--fail" style="flex:${failFlex}"></div>
    </div>`;
}

function updateMonitorStatsSubtitle(lastFetchedAt, toolCount, retentionDays) {
    const subtitle = document.getElementById('monitor-stats-subtitle');
    if (!subtitle) return;
    const locale = (typeof window.uiLocale === 'function' ? window.uiLocale() : 'en-US');
    const timeText = lastFetchedAt
        ? (lastFetchedAt.toLocaleString ? lastFetchedAt.toLocaleString(locale) : String(lastFetchedAt))
        : '—';
    let text = mcpMonitorT('statsSubtitle', { time: timeText, count: toolCount })
        || monitorFallback(`最后刷新 ${timeText} · 共 ${toolCount} 个工具`, `Refreshed ${timeText} · ${toolCount} tools`);
    if (typeof retentionDays === 'number' && retentionDays > 0) {
        const hint = mcpMonitorT('retentionHint', { days: retentionDays })
            || monitorFallback(`执行记录保留 ${retentionDays} 天，超期自动清理`, `Execution records are kept for ${retentionDays} days, then purged automatically.`);
        text += ' · ' + hint;
    }
    subtitle.textContent = text;
    subtitle.hidden = false;
}

function filterMonitorByTool(toolName) {
    const toolFilter = document.getElementById('monitor-tool-filter');
    if (!toolFilter || !toolName) return;
    toolFilter.value = formatMonitorToolName(toolName);
    toolFilter.classList.add('is-filter-active');
    applyMonitorFilters();
    const execSection = document.querySelector('.monitor-executions');
    if (execSection && typeof execSection.scrollIntoView === 'function') {
        execSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function clearMonitorToolFilter() {
    const toolFilter = document.getElementById('monitor-tool-filter');
    if (!toolFilter) return;
    toolFilter.value = '';
    toolFilter.classList.remove('is-filter-active');
    applyMonitorFilters();
}

let monitorStatsPanelEventsBound = false;

function bindMonitorStatsPanelEvents() {
    if (monitorStatsPanelEventsBound) return;
    const root = document.getElementById('monitor-stats');
    if (!root) return;
    root.addEventListener('click', function (e) {
        const clearBtn = e.target.closest('.mcp-stats-clear-filter');
        if (clearBtn) {
            e.preventDefault();
            clearMonitorToolFilter();
            return;
        }
        const filterEl = e.target.closest(
            '.mcp-stats-dist-segment[data-tool-name], .mcp-stats-dist-legend-item[data-tool-name], ' +
            '.mcp-stats-proportion-seg[data-tool-name], .mcp-stats-tool-item[data-tool-name], tr.mcp-stats-tool-row[data-tool-name]'
        );
        if (filterEl && filterEl.getAttribute('data-is-others') !== '1') {
            const tool = filterEl.getAttribute('data-tool-name');
            if (tool) {
                e.preventDefault();
                handleMonitorStatsToolFilter(tool);
            }
            return;
        }
    });
    root.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const filterEl = e.target.closest(
            '.mcp-stats-dist-segment[data-tool-name], .mcp-stats-proportion-seg[data-tool-name], ' +
            '.mcp-stats-tool-item[data-tool-name], tr.mcp-stats-tool-row[data-tool-name]'
        );
        if (!filterEl || filterEl.getAttribute('data-is-others') === '1') return;
        const tool = filterEl.getAttribute('data-tool-name');
        if (tool) {
            e.preventDefault();
            handleMonitorStatsToolFilter(tool);
        }
    });
    root.addEventListener('mouseover', function (e) {
        const el = e.target.closest(
            '.mcp-stats-dist-segment[data-tool-name], .mcp-stats-dist-legend-item[data-tool-name], ' +
            '.mcp-stats-proportion-seg[data-tool-name], .mcp-stats-tool-item[data-tool-name], tr.mcp-stats-tool-row[data-tool-name]'
        );
        if (!el || el.getAttribute('data-is-others') === '1') return;
        const tool = el.getAttribute('data-tool-name');
        if (tool) setMcpStatsDistHover(tool);
    });
    root.addEventListener('mouseout', function (e) {
        const el = e.target.closest(
            '.mcp-stats-dist-segment[data-tool-name], .mcp-stats-dist-legend-item[data-tool-name], ' +
            '.mcp-stats-proportion-seg[data-tool-name], .mcp-stats-tool-item[data-tool-name], tr.mcp-stats-tool-row[data-tool-name]'
        );
        if (!el) return;
        const related = e.relatedTarget;
        const next = related && related.closest
            ? related.closest(
                '.mcp-stats-dist-segment[data-tool-name], .mcp-stats-dist-legend-item[data-tool-name], ' +
                '.mcp-stats-proportion-seg[data-tool-name], .mcp-stats-tool-item[data-tool-name], tr.mcp-stats-tool-row[data-tool-name]'
            )
            : null;
        if (next) return;
        setMcpStatsDistHover('');
    });
    monitorStatsPanelEventsBound = true;
}

function renderMcpStatsMetricsBar(totals, successRate, rateTone, rateSubText, lastCallText, hasCalls = true) {
    const totalCallsLabel = mcpMonitorT('totalCalls') || monitorFallback('总调用次数', 'Total calls');
    const successRateLabel = mcpMonitorT('successRate') || monitorFallback('成功率', 'Success rate');
    const lastCallLabel = mcpMonitorT('lastCall') || monitorFallback('最近一次调用', 'Last call');
    const successPill = mcpMonitorT('successCount', { n: totals.success }) || monitorFallback(`成功 ${totals.success}`, `Success ${totals.success}`);
    const failedPill = mcpMonitorT('failedCount', { n: totals.failed }) || monitorFallback(`失败 ${totals.failed}`, `Failed ${totals.failed}`);
    const blockedPill = mcpMonitorT('blockedCount', { n: totals.blocked }) || monitorFallback(`安全拦截 ${totals.blocked}`, `Blocked ${totals.blocked}`);
    const neutralPill = mcpMonitorT('neutralCount', { n: totals.neutral }) || monitorFallback(`终止 ${totals.neutral}`, `Stopped ${totals.neutral}`);
    const rateHint = mcpMonitorT('rateExcludesBlocked') || monitorFallback('成功率仅统计成功和失败的调用，不包含安全拦截和终止', 'Success rate includes only successful and failed calls; blocked and stopped calls are excluded');
    const rateValue = hasCalls ? `${successRate}%` : successRate;
    const blockedChip = totals.blocked > 0
        ? `<span class="mcp-stats-kpi__chip is-blocked">${escapeHtml(blockedPill)}</span>`
        : '';
    const neutralChip = totals.neutral > 0
        ? `<span class="mcp-stats-kpi__chip is-neutral">${escapeHtml(neutralPill)}</span>`
        : '';

    return `
        <div class="mcp-stats-kpi" role="group" aria-label="${escapeAttr(totalCallsLabel)}">
            <article class="mcp-stats-kpi__item mcp-stats-kpi__item--calls">
                <span class="mcp-stats-kpi__accent" aria-hidden="true"></span>
                <div class="mcp-stats-kpi__content">
                    <span class="mcp-stats-kpi__label">${escapeHtml(totalCallsLabel)}</span>
                    <span class="mcp-stats-kpi__value">${totals.total}</span>
                    <div class="mcp-stats-kpi__meta">
                        <span class="mcp-stats-kpi__chip is-ok">${escapeHtml(successPill)}</span>
                        <span class="mcp-stats-kpi__chip is-fail">${escapeHtml(failedPill)}</span>
                        ${blockedChip}
                        ${neutralChip}
                    </div>
                </div>
            </article>
            <article class="mcp-stats-kpi__item mcp-stats-kpi__item--rate">
                <span class="mcp-stats-kpi__accent" aria-hidden="true"></span>
                <div class="mcp-stats-kpi__content">
                    <span class="mcp-stats-kpi__label" title="${escapeAttrLocal(rateHint)}">${escapeHtml(successRateLabel)}</span>
                    <span class="mcp-stats-kpi__value mcp-stats-kpi__value--rate ${rateTone}">${rateValue}</span>
                    <span class="mcp-stats-kpi__status ${rateTone}">${escapeHtml(rateSubText)}</span>
                </div>
            </article>
            <article class="mcp-stats-kpi__item mcp-stats-kpi__item--time">
                <span class="mcp-stats-kpi__accent" aria-hidden="true"></span>
                <div class="mcp-stats-kpi__content">
                    <span class="mcp-stats-kpi__label">${escapeHtml(lastCallLabel)}</span>
                    <time class="mcp-stats-kpi__value mcp-stats-kpi__value--time">${escapeHtml(lastCallText)}</time>
                </div>
            </article>
        </div>`;
}

function renderMcpStatsToolTable(topTools, totals, activeToolFilter = '') {
    const colTool = mcpMonitorT('columnTool') || '工具';
    const colCalls = mcpMonitorT('columnCalls') || '调用';
    const colShare = mcpMonitorT('columnShare') || '占比';
    const colRate = mcpMonitorT('columnSuccessRate') || '成功率';
    const unknownToolLabel = mcpMonitorT('unknownTool') || '未知工具';

    let rowsHtml = '';
    topTools.forEach((tool, index) => {
        const rawName = tool.toolName || unknownToolLabel;
        const name = formatMonitorToolName(rawName);
        const total = tool.totalCalls || 0;
        const success = tool.successCalls || 0;
        const failed = tool.failedCalls || 0;
        const blocked = tool.blockedCalls || 0;
        const effectiveTotal = success + failed;
        const toolRateNum = effectiveTotal > 0 ? (success / effectiveTotal) * 100 : 0;
        const toolRate = toolRateNum.toFixed(1);
        const rateText = effectiveTotal > 0 ? `${toolRate}%` : '-';
        const sharePct = totals.total > 0 ? ((total / totals.total) * 100).toFixed(1) : '0.0';
        const dotColor = MCP_STATS_DIST_COLORS[index % MCP_STATS_DIST_COLORS.length];
        const isActive = activeToolFilter && monitorToolNamesEqual(activeToolFilter, rawName);
        const rateClass = effectiveTotal > 0 ? getMcpToolRateClass(toolRateNum) : 'is-muted';
        const rankClass = index === 0 ? ' rank-1' : index === 1 ? ' rank-2' : index === 2 ? ' rank-3' : '';
        const blockedLabel = mcpMonitorT('blockedCount', { n: blocked }) || monitorFallback(`安全拦截 ${blocked}`, `Blocked ${blocked}`);
        const rowAria = (effectiveTotal > 0
            ? (mcpMonitorT('toolRowAriaLabel', { name, total, rate: toolRate }) || `${name}，${total} 次调用，成功率 ${toolRate}%`)
            : (mcpMonitorT('toolRowNoCompletedAriaLabel', { name, total }) || monitorFallback(`${name}，${total} 次调用，暂无完成结果，点击查看执行记录`, `${name}, ${total} calls, no completed outcomes, click to view records`)))
            + (blocked > 0 ? ` · ${blockedLabel}` : '');
        rowsHtml += `
            <tr class="mcp-stats-tool-row${isActive ? ' is-active' : ''}"
                data-tool-name="${escapeAttrLocal(rawName)}"
                tabindex="0"
                role="button"
                aria-label="${escapeAttrLocal(rowAria)}"
                aria-pressed="${isActive ? 'true' : 'false'}">
                <td class="col-rank"><span class="mcp-stats-rank${rankClass}">${index + 1}</span></td>
                <td class="col-tool" title="${escapeAttrLocal(name)}">
                    <span class="mcp-stats-tool-dot" style="background:${dotColor}" aria-hidden="true"></span>
                    <span class="mcp-stats-tool-label">${escapeHtml(name)}</span>
                </td>
                <td class="col-num">${total}</td>
                <td class="col-share">${sharePct}%</td>
                <td class="col-rate">
                    <span class="mcp-stats-rate ${rateClass}">${rateText}</span>
                    ${failed > 0 ? `<span class="mcp-stats-fail-note">${escapeHtml(mcpMonitorT('failedCount', { n: failed }) || `失败 ${failed}`)}</span>` : ''}
                    ${blocked > 0 ? `<span class="mcp-stats-blocked-note">${escapeHtml(blockedLabel)}</span>` : ''}
                </td>
            </tr>`;
    });

    return `
        <table class="mcp-stats-tool-table">
            <thead>
                <tr>
                    <th class="col-rank" scope="col">#</th>
                    <th class="col-tool" scope="col">${escapeHtml(colTool)}</th>
                    <th class="col-num" scope="col">${escapeHtml(colCalls)}</th>
                    <th class="col-share" scope="col">${escapeHtml(colShare)}</th>
                    <th class="col-rate" scope="col">${escapeHtml(colRate)}</th>
                </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
        </table>`;
}

/** MCP 合并面板左侧：堆叠占比条 + 工具排行列表（无饼图/表格套娃） */
function renderMcpStatsToolsPanel(topTools, totals, activeToolFilter = '') {
    const segments = buildMcpStatsChartSegments(topTools, totals, { groupSmall: false });
    const topNTotal = topTools.reduce((s, t) => s + (t.totalCalls || 0), 0);
    const topNSharePct = totals.total > 0 ? ((topNTotal / totals.total) * 100).toFixed(1) : '0.0';
    const caption = mcpMonitorT('rankingSummary', { n: MCP_STATS_TOP_N, pct: topNSharePct, total: totals.total })
        || `Top ${MCP_STATS_TOP_N} 占 ${topNSharePct}% · 共 ${totals.total} 次`;
    const unknownToolLabel = mcpMonitorT('unknownTool') || '未知工具';
    const distAria = mcpMonitorT('distTitle') || '调用分布';

    const stackedHtml = segments.map((s) => {
        const isActive = !s.isOthers && activeToolFilter && monitorToolNamesEqual(activeToolFilter, s.name);
        const displayName = s.isOthers ? s.name : formatMonitorToolName(s.name);
        const title = `${displayName} · ${s.pct}% · ${s.calls}`;
        if (s.isOthers) {
            return `<span class="mcp-stats-proportion-seg is-others" data-is-others="1" role="presentation"
                style="flex:${s.pctNum} 1 0;background:${s.color}" title="${escapeAttr(title)}"></span>`;
        }
        const segAria = mcpMonitorT('distSegmentAria', { name: displayName, pct: s.pct, calls: s.calls })
            || `${displayName}，占 ${s.pct}%，${s.calls} 次`;
        return `<span class="mcp-stats-proportion-seg${isActive ? ' is-active' : ''}"
            data-tool-name="${escapeAttrLocal(s.name)}" data-pct="${s.pct}" data-calls="${s.calls}" data-is-others="0"
            role="button" tabindex="0" aria-label="${escapeAttrLocal(segAria)}"
            style="flex:${s.pctNum} 1 0;background:${s.color}" title="${escapeAttr(title)}"></span>`;
    }).join('');

    const maxCalls = Math.max(1, ...topTools.map((t) => t.totalCalls || 0));
    const listHtml = topTools.map((tool, index) => {
        const rawName = tool.toolName || unknownToolLabel;
        const name = formatMonitorToolName(rawName);
        const total = tool.totalCalls || 0;
        const success = tool.successCalls || 0;
        const failed = tool.failedCalls || 0;
        const blocked = tool.blockedCalls || 0;
        const effectiveTotal = success + failed;
        const toolRateNum = effectiveTotal > 0 ? (success / effectiveTotal) * 100 : 0;
        const toolRate = toolRateNum.toFixed(1);
        const rateText = effectiveTotal > 0 ? `${toolRate}%` : '-';
        const sharePct = totals.total > 0 ? ((total / totals.total) * 100).toFixed(1) : '0.0';
        const color = MCP_STATS_DIST_COLORS[index % MCP_STATS_DIST_COLORS.length];
        const barPct = maxCalls > 0 ? ((total / maxCalls) * 100).toFixed(1) : '0';
        const isActive = activeToolFilter && monitorToolNamesEqual(activeToolFilter, rawName);
        const rateClass = effectiveTotal > 0 ? getMcpToolRateClass(toolRateNum) : 'is-muted';
        const rankClass = index === 0 ? ' rank-1' : index === 1 ? ' rank-2' : index === 2 ? ' rank-3' : '';
        const blockedLabel = mcpMonitorT('blockedCount', { n: blocked }) || monitorFallback(`安全拦截 ${blocked}`, `Blocked ${blocked}`);
        const rowAria = (effectiveTotal > 0
            ? (mcpMonitorT('toolRowAriaLabel', { name, total, rate: toolRate }) || `${name}，${total} 次，成功率 ${toolRate}%`)
            : (mcpMonitorT('toolRowNoCompletedAriaLabel', { name, total }) || monitorFallback(`${name}，${total} 次调用，暂无完成结果，点击查看执行记录`, `${name}, ${total} calls, no completed outcomes, click to view records`)))
            + (blocked > 0 ? ` · ${blockedLabel}` : '');
        const failNote = failed > 0
            ? `<span class="mcp-stats-tool-item__fail">${escapeHtml(mcpMonitorT('failedCount', { n: failed }) || `失败 ${failed}`)}</span>`
            : '';
        const successLabel = mcpMonitorT('successCount', { n: success }) || `成功 ${success}`;
        const failedLabel = mcpMonitorT('failedCount', { n: failed }) || `失败 ${failed}`;
        return `<li class="mcp-stats-tool-item${isActive ? ' is-active' : ''}"
            data-tool-name="${escapeAttrLocal(rawName)}" tabindex="0" role="button"
            aria-label="${escapeAttrLocal(rowAria)}" aria-pressed="${isActive ? 'true' : 'false'}">
            <div class="mcp-stats-tool-item__top">
                <span class="mcp-stats-tool-item__rank mcp-stats-rank${rankClass}">${index + 1}</span>
                <span class="mcp-stats-tool-item__dot" style="background:${color}" aria-hidden="true"></span>
                <span class="mcp-stats-tool-item__name" title="${escapeAttrLocal(name)}">${escapeHtml(name)}</span>
                <span class="mcp-stats-tool-item__share">${sharePct}%</span>
            </div>
            <div class="mcp-stats-tool-item__middle">
                <strong class="mcp-stats-tool-item__calls">${total}</strong>
                <span class="mcp-stats-tool-item__calls-label">${escapeHtml(mcpMonitorT('columnCalls') || '调用')}</span>
                <span class="mcp-stats-tool-item__track" aria-hidden="true">
                    <span class="mcp-stats-tool-item__fill" style="width:${barPct}%;background:${color}"></span>
                </span>
            </div>
            <div class="mcp-stats-tool-item__bottom">
                <span class="mcp-stats-tool-item__pill is-success">${escapeHtml(successLabel)}</span>
                <span class="mcp-stats-tool-item__pill${failed > 0 ? ' is-danger' : ''}">${escapeHtml(failedLabel)}</span>
                ${blocked > 0 ? `<span class="mcp-stats-tool-item__pill is-blocked">${escapeHtml(blockedLabel)}</span>` : ''}
                <span class="mcp-stats-tool-item__rate ${rateClass}">${rateText}${failNote}</span>
            </div>
        </li>`;
    }).join('');

    return `
        <div class="mcp-stats-tools-panel" role="region" aria-label="${escapeAttr(mcpMonitorT('toolStatsTitle') || '工具统计')}">
            <div class="mcp-stats-tools-panel__hero">
                <div class="mcp-stats-proportion-bar" role="img" aria-label="${escapeAttr(distAria)}">${stackedHtml}</div>
                <p class="mcp-stats-tools-panel__caption">
                    <span class="mcp-stats-scope-badge mcp-stats-scope-badge--cumulative mcp-stats-scope-badge--inline">${escapeHtml(mcpMonitorT('scopeCumulative') || '累计')}</span>
                    ${escapeHtml(caption)}
                </p>
            </div>
            <ol class="mcp-stats-tools-panel__list">${listHtml}</ol>
        </div>`;
}

function renderMcpStatsChartAside(topTools, totals, activeToolFilter = '') {
    const distTitle = mcpMonitorT('distTitle') || '调用分布';
    const distClickHint = mcpMonitorT('distClickHint') || '点击扇区筛选';
    const top6ShareLabel = mcpMonitorT('distTop6Share', { n: MCP_STATS_TOP_N }) || `Top ${MCP_STATS_TOP_N} 占全部调用`;
    const topNTotal = topTools.reduce((s, t) => s + (t.totalCalls || 0), 0);
    const top6SharePct = totals.total > 0 ? ((topNTotal / totals.total) * 100).toFixed(1) : '0.0';
    const centerLabel = `Top ${MCP_STATS_TOP_N}`;

    const segments = buildMcpStatsChartSegments(topTools, totals, { groupSmall: true });
    const segmentPathsHtml = segments.map((s) => {
        const pathD = mcpStatsDescribeDonutSegment(s.start, s.end, 48, 30);
        if (!pathD) return '';
        const isActive = !s.isOthers && activeToolFilter && activeToolFilter === s.name;
        const segAria = s.isOthers
            ? escapeHtml(s.name)
            : escapeHtml(mcpMonitorT('distSegmentAria', { name: s.name, pct: s.pct, calls: s.calls })
                || `${s.name}，占 ${s.pct}%，${s.calls} 次`);
        return `<path class="mcp-stats-dist-segment${isActive ? ' is-active' : ''}${s.isOthers ? ' is-others' : ''}"
            d="${pathD}" fill="${s.color}"
            data-tool-name="${s.isOthers ? '' : escapeHtml(s.name)}"
            data-pct="${s.pct}" data-calls="${s.calls}"
            data-is-others="${s.isOthers ? '1' : '0'}"
            tabindex="${s.isOthers ? '-1' : '0'}"
            role="${s.isOthers ? 'presentation' : 'button'}"
            aria-label="${segAria}" />`;
    }).join('');

    return `
        <div class="mcp-stats-dist-panel mcp-stats-dist-panel--compact"
            aria-label="${escapeAttrLocal(distTitle)}"
            data-center-label="${escapeAttrLocal(centerLabel)}"
            data-center-value="${top6SharePct}"
            data-center-suffix="%">
            <p class="mcp-stats-panel__aside-title">${escapeHtml(distTitle)}</p>
            <div class="mcp-stats-panel__chart">
                <svg class="mcp-stats-dist-svg" viewBox="0 0 100 100" role="img" aria-label="${escapeAttr(top6ShareLabel)} ${top6SharePct}%">
                    <g class="mcp-stats-dist-segments">${segmentPathsHtml}</g>
                </svg>
                <div class="mcp-stats-dist-donut-hole" aria-hidden="true">
                    <span class="mcp-stats-dist-donut-label is-default">${centerLabel}</span>
                    <span class="mcp-stats-dist-donut-value">
                        <span class="mcp-stats-dist-donut-value-num">${top6SharePct}</span>
                        <span class="mcp-stats-dist-donut-unit">%</span>
                    </span>
                </div>
            </div>
            <p class="mcp-stats-panel__aside-hint">${escapeHtml(distClickHint)}</p>
        </div>`;
}

function renderMcpStatsDetailSection(topTools, totals, activeToolFilter = '', timeline = null, timelineError = null) {
    const showTimeline = timeline != null || !!timelineError;
    return renderMcpStatsCombinedSection(topTools, totals, activeToolFilter, timeline, timelineError, showTimeline);
}

/** @deprecated 保留供其他页面；MCP 监控主面板请用 renderMcpStatsToolTable */
function renderMcpStatsToolRanking(topTools, totals, activeToolFilter = '', options = {}) {
    if (options.bare || options.embedded) {
        return renderMcpStatsToolTable(topTools, totals, activeToolFilter);
    }
    return renderMcpStatsDetailSection(topTools, totals, activeToolFilter);
}

/* 工具筛选联动：供内联事件与跨文件调用，函数在本文件内定义 */
window.filterMonitorByTool = filterMonitorByTool;
window.clearMonitorToolFilter = clearMonitorToolFilter;
