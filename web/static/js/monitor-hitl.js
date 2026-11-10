/**
 * monitor-hitl.js —— HITL 人工审批交互
 *
 * 从 monitor.js 拆出的独立功能域（原 4254-5539 行）：
 * 审批请求描述与倒计时、审批面板与停靠栏渲染、内联审批恢复、
 * 决策提交、时间线展开与"回到最新"跟随、任务重放状态。
 *
 * 与 monitor.js 同处全局作用域；本文件内的 window 导出均引用本文件函数，
 * 加载顺序置于 monitor.js 之后。
 */
function hitlApprovalTranslate(key, fallback, vars) {
    if (typeof window.t !== 'function') return fallback;
    const value = window.t(key, vars || {});
    return value && value !== key ? value : fallback;
}

function hitlApprovalTemplate(key, fallback, vars) {
    let template = hitlApprovalTranslate(key, fallback);
    Object.keys(vars || {}).forEach(function (name) {
        template = template.replaceAll('{{' + name + '}}', String(vars[name]));
    });
    return template;
}

function hitlApprovalPayload(data) {
    return data && data.payload && typeof data.payload === 'object' ? data.payload : {};
}

function hitlApprovalArguments(data) {
    const payload = hitlApprovalPayload(data);
    if (payload.argumentsObj && typeof payload.argumentsObj === 'object') return payload.argumentsObj;
    if (payload.arguments && typeof payload.arguments === 'object') return payload.arguments;
    if (typeof payload.arguments === 'string') {
        try {
            const parsed = JSON.parse(payload.arguments);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (e) { /* keep the raw request below */ }
    }
    return {};
}

function findHitlArgumentValue(args, keys) {
    if (!args || typeof args !== 'object') return '';
    for (let i = 0; i < keys.length; i++) {
        const value = args[keys[i]];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const nestedKeys = ['input', 'params', 'options', 'request'];
    for (let i = 0; i < nestedKeys.length; i++) {
        const nested = args[nestedKeys[i]];
        if (nested && typeof nested === 'object') {
            const found = findHitlArgumentValue(nested, keys);
            if (found) return found;
        }
    }
    return '';
}

function describeHitlApprovalRequest(data) {
    const payload = hitlApprovalPayload(data);
    const args = hitlApprovalArguments(data);
    const rawToolName = String(data.toolName || payload.toolName || 'tool').trim() || 'tool';
    const toolName = rawToolName.toLowerCase();
    const url = findHitlArgumentValue(args, ['url', 'uri', 'href', 'targetUrl', 'target_url']);
    const command = findHitlArgumentValue(args, ['command', 'cmd', 'script', 'shell_command']);
    const path = findHitlArgumentValue(args, ['path', 'filePath', 'file_path', 'filename']);
    const isBrowser = !!url || /browser|chrome|navigate|open_url|web/.test(toolName);
    const isCommand = !!command || /(^|::|_)exec$|shell|terminal|command|run_command/.test(toolName);
    const isFile = !!path || /write_file|edit_file|apply_patch|delete_file|move_file/.test(toolName);
    let displayTool = rawToolName;
    let question = hitlApprovalTemplate('hitl.requestGeneric', '允许 CyberStrikeAI 调用 {{tool}}？', { tool: rawToolName });
    let primary = '';
    let kind = 'generic';
    if (isBrowser) {
        kind = 'browser';
        question = url
            ? (url.length > 160
                ? hitlApprovalTranslate('hitl.requestVisitLongUrl', '允许 CyberStrikeAI 访问此地址？')
                : hitlApprovalTemplate('hitl.requestVisitUrl', '允许 CyberStrikeAI 访问 {{url}}？', { url: url }))
            : hitlApprovalTranslate('hitl.requestBrowser', '允许 CyberStrikeAI 使用浏览器？');
        primary = url;
    } else if (isCommand) {
        kind = 'command';
        question = hitlApprovalTranslate('hitl.requestCommand', '允许 CyberStrikeAI 执行这条命令？');
        primary = command;
    } else if (isFile) {
        kind = 'file';
        question = path
            ? (path.length > 160
                ? hitlApprovalTranslate('hitl.requestModifyLongPath', '允许 CyberStrikeAI 修改此文件？')
                : hitlApprovalTemplate('hitl.requestFile', '允许 CyberStrikeAI 修改 {{path}}？', { path: path }))
            : hitlApprovalTranslate('hitl.requestFiles', '允许 CyberStrikeAI 修改文件？');
        primary = path;
    }
    return {
        rawToolName: rawToolName,
        displayTool: displayTool,
        question: question,
        primary: primary,
        kind: kind,
        args: args,
        argsJSON: JSON.stringify(args, null, 2)
    };
}

function isAgentReviewedHitl(data) {
    if (!data) return false;
    const reviewer = String(data.reviewer || data.decidedBy || data.decided_by || '').trim().toLowerCase();
    const status = String(data.status || '').trim().toLowerCase();
    return reviewer === 'audit_agent' || reviewer === 'agent' || reviewer === 'ai' || status === 'audit_running';
}

function getHitlApprovalTiming(data) {
    const payload = hitlApprovalPayload(data);
    const approval = payload.hitlApproval && typeof payload.hitlApproval === 'object' ? payload.hitlApproval : {};
    const timeoutSeconds = Number(data.timeoutSeconds != null ? data.timeoutSeconds : approval.timeoutSeconds);
    const createdRaw = data.createdAt || approval.createdAt || '';
    const expiresRaw = data.expiresAt || approval.expiresAt || '';
    const createdAt = Date.parse(createdRaw);
    let expiresAt = Date.parse(expiresRaw);
    const safeTimeout = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? Math.floor(timeoutSeconds) : 0;
    if (!Number.isFinite(expiresAt) && safeTimeout > 0 && Number.isFinite(createdAt)) {
        expiresAt = createdAt + safeTimeout * 1000;
    }
    return {
        timeoutSeconds: safeTimeout,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0
    };
}

function formatHitlRemaining(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function buildHitlCountdownHtml(data) {
    const timing = getHitlApprovalTiming(data);
    if (!timing.timeoutSeconds || !timing.expiresAt) {
        return '<div class="hitl-approval-countdown hitl-approval-countdown--unlimited">' +
            '<span>' + escapeHtml(hitlApprovalTranslate('hitl.timeoutUnlimited', '不限时等待')) + '</span></div>';
    }
    const remaining = Math.max(0, timing.expiresAt - Date.now());
    const percent = Math.max(0, Math.min(100, remaining / (timing.timeoutSeconds * 1000) * 100));
    return '<div class="hitl-approval-countdown" data-hitl-expires-at="' + timing.expiresAt + '" data-hitl-timeout="' + timing.timeoutSeconds + '">' +
        '<div class="hitl-approval-countdown-copy"><span>' + escapeHtml(hitlApprovalTranslate('hitl.timeoutAutoReject', '到期自动拒绝')) + '</span>' +
        '<strong class="hitl-approval-countdown-value">' + formatHitlRemaining(remaining) + '</strong></div>' +
        '<div class="hitl-approval-progress" aria-hidden="true"><span class="hitl-approval-progress-value" style="width:' + percent.toFixed(2) + '%"></span></div>' +
        '</div>';
}

function stopHitlApprovalCountdown(panel) {
    if (panel && panel.__hitlCountdownTimer) {
        window.clearInterval(panel.__hitlCountdownTimer);
        panel.__hitlCountdownTimer = 0;
    }
}

function bindHitlApprovalCountdown(panel, data) {
    if (!panel) return;
    stopHitlApprovalCountdown(panel);
    panel.__hitlApprovalCountdownData = data;
    if (panel.classList.contains('hitl-approval-task-closed')) return;
    const timing = getHitlApprovalTiming(data);
    const countdown = panel.querySelector('.hitl-approval-countdown[data-hitl-expires-at]');
    if (!countdown || !timing.expiresAt || !timing.timeoutSeconds) return;
    const value = countdown.querySelector('.hitl-approval-countdown-value');
    const progress = countdown.querySelector('.hitl-approval-progress-value');
    const update = function () {
        const remaining = Math.max(0, timing.expiresAt - Date.now());
        const percent = Math.max(0, Math.min(100, remaining / (timing.timeoutSeconds * 1000) * 100));
        if (value) value.textContent = formatHitlRemaining(remaining);
        if (progress) progress.style.width = percent.toFixed(2) + '%';
        if (remaining <= 0) {
            stopHitlApprovalCountdown(panel);
            panel.classList.add('hitl-approval-expired');
            panel.querySelectorAll('.hitl-inline-approve, .hitl-inline-reject').forEach(function (button) {
                button.disabled = true;
            });
            const status = panel.querySelector('.hitl-inline-status');
            if (status) status.textContent = hitlApprovalTranslate('hitl.expiredAutoRejected', '审批已超时，正在自动拒绝…');
        }
    };
    update();
    panel.__hitlCountdownTimer = window.setInterval(update, 250);
}

function renderToolCallApprovalSummary(item, data) {
    if (!item || !data || !data.interruptId) return;
    let panel = item.querySelector(':scope > .hitl-inline-approval.hitl-tool-approval-summary');
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'hitl-inline-approval hitl-tool-approval-summary';
        const header = item.querySelector(':scope > .timeline-item-header');
        if (header && header.nextSibling) {
            item.insertBefore(panel, header.nextSibling);
        } else {
            item.appendChild(panel);
        }
    }
    const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
    const mode = String(data.mode || 'approval').trim().toLowerCase();
    const allowEdit = mode === 'review_edit';
    const argsObj = payload.argumentsObj && typeof payload.argumentsObj === 'object'
        ? payload.argumentsObj
        : {};
    panel.innerHTML = buildInlineHitlApprovalHtml(data, {
        toolName: '',
        mode: mode,
        allowEdit: allowEdit,
        argsJSON: JSON.stringify(argsObj, null, 2)
    });
    panel.dataset.hitlInterruptId = String(data.interruptId);
    panel.dataset.conversationId = String(data.conversationId || window.currentConversationId || '').trim();
    panel.classList.toggle('hitl-inline-done', !!data.resolved || String(data.status || '') === 'decided');
    if (!data.resolved && !isAgentReviewedHitl(data)) {
        bindInlineHitlApproval(panel, data, { allowEdit: allowEdit });
        bindHitlApprovalCountdown(panel, data);
        setHitlApprovalTaskAvailability(panel, panel.dataset.conversationId);
    }
}

function renderInlineHitlApproval(itemId, data) {
    const item = document.getElementById(itemId);
    if (!item || !data || !data.interruptId) return;
    if (item.classList.contains('timeline-item-tool_call')) {
        const state = toolCallDetailStateByItemId.get(item.id) || {};
        state.hitlData = data;
        state.pending = true;
        setToolCallDetailState(item, state);
        if (data.interruptId) {
            hitlInterruptToolItemMap.set(String(data.interruptId), item.id);
        }
        const existingContent = item.querySelector('.timeline-item-content.tool-call-detail-content');
        if (existingContent) {
            existingContent.remove();
            item.classList.remove('tool-call-detail-expanded');
        }
        renderToolCallApprovalSummary(item, data);
        updateToolDetailToggleLabel(item);
        return;
    }
    let contentEl = item.querySelector('.timeline-item-content');
    if (!contentEl) {
        // warning 等类型默认没有内容区域；HITL 内联审批需要可交互容器
        contentEl = document.createElement('div');
        contentEl.className = 'timeline-item-content';
        item.appendChild(contentEl);
    }
    const existingPanel = contentEl.querySelector('.hitl-inline-approval');
    if (existingPanel) {
        existingPanel.remove();
    }

    const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
    const toolName = data.toolName || payload.toolName || '-';
    let mode = String(data.mode || '').trim().toLowerCase();
    if (mode === 'feedback' || mode === 'followup') {
        mode = 'approval';
    }
    const allowEdit = mode === 'review_edit';
    const argsObj = payload.argumentsObj && typeof payload.argumentsObj === 'object' ? payload.argumentsObj : {};
    const argsJSON = JSON.stringify(argsObj, null, 2);
    const modeLabel = mode === 'review_edit' ? '审查编辑' : '审批模式';

    const panel = document.createElement('div');
    panel.className = 'hitl-inline-approval';
    panel.dataset.hitlInterruptId = String(data.interruptId);
    panel.dataset.conversationId = String(data.conversationId || window.currentConversationId || '').trim();
    panel.innerHTML = buildInlineHitlApprovalHtml(data, {
        toolName: toolName,
        mode: mode,
        modeLabel: modeLabel,
        allowEdit: allowEdit,
        argsJSON: argsJSON
    });
    contentEl.appendChild(panel);
    if (!isAgentReviewedHitl(data)) {
        bindInlineHitlApproval(panel, data, { allowEdit: allowEdit });
        bindHitlApprovalCountdown(panel, data);
        setHitlApprovalTaskAvailability(panel, panel.dataset.conversationId);
    }
}

function resolveInlineHitlDecision(timeline, data, decision, message) {
    if (!timeline || !data || !data.interruptId) return false;
    const interruptId = String(data.interruptId);
    let item = null;
    const mappedId = hitlInterruptToolItemMap.get(interruptId);
    if (mappedId) item = document.getElementById(mappedId);
    if (!item) item = findToolCallItemForHitl(timeline, data);
    if (!item) {
        item = timeline.querySelector('[data-hitl-interrupt-id="' + hitlEscapeAttrSelector(interruptId) + '"]');
    }
    if (!item) return false;

    if (item.classList.contains('timeline-item-tool_call')) {
        const state = toolCallDetailStateByItemId.get(item.id) || {};
        state.hitlData = Object.assign({}, state.hitlData || data, {
            resolved: true,
            decision: decision,
            decisionMessage: message || '',
            reviewer: data.reviewer || data.decidedBy || (state.hitlData && (state.hitlData.reviewer || state.hitlData.decidedBy)) || 'human',
            decidedBy: data.decidedBy || (state.hitlData && state.hitlData.decidedBy) || '',
            status: 'decided',
            comment: data.comment || (state.hitlData && state.hitlData.comment) || '',
            editedArgs: data.editedArgs || data.editedArguments || (state.hitlData && (state.hitlData.editedArgs || state.hitlData.editedArguments)) || null
        });
        if (decision === 'approve' && state.hitlData.editedArgs && typeof state.hitlData.editedArgs === 'object') {
            state.originalArgs = state.originalArgs || state.args || {};
            state.args = state.hitlData.editedArgs;
            state.argsEditedByHitl = true;
        }
        state.pending = decision === 'approve';
        setToolCallDetailState(item, state);
        const content = item.querySelector('.timeline-item-content.tool-call-detail-content');
        if (content) {
            content.remove();
            item.classList.remove('tool-call-detail-expanded');
        }
        renderToolCallApprovalSummary(item, state.hitlData);
        updateToolDetailToggleLabel(item);
        return true;
    }

    const panel = item.querySelector('.hitl-inline-approval');
    if (panel) {
        stopHitlApprovalCountdown(panel);
        panel.classList.add('hitl-inline-done');
        panel.innerHTML = buildInlineHitlApprovalHtml(Object.assign({}, data, {
            resolved: true,
            decision: decision,
            decisionMessage: message || '',
            status: 'decided'
        }), { toolName: data.toolName || '' });
        return true;
    }
    return false;
}

function findToolCallItemForHitl(timeline, data) {
    if (!timeline || !data) return null;
    const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
    const toolCallId = String(data.toolCallId || payload.toolCallId || '').trim();
    if (toolCallId) {
        const byId = timeline.querySelector('[data-tool-call-id="' + hitlEscapeAttrSelector(toolCallId) + '"]');
        if (byId && byId.classList.contains('timeline-item-tool_call')) return byId;
    }
    const toolName = String(data.toolName || payload.toolName || '').trim().toLowerCase();
    if (!toolName) return null;
    const shortWant = toolName.indexOf('::') >= 0 ? toolName.split('::').pop() : toolName;
    const calls = timeline.querySelectorAll('.timeline-item-tool_call');
    for (let i = calls.length - 1; i >= 0; i--) {
        const tn = String(calls[i].dataset.toolName || '').trim().toLowerCase();
        const shortTn = tn.indexOf('::') >= 0 ? tn.split('::').pop() : tn;
        if (tn === toolName || tn.endsWith('::' + shortWant) || shortTn === shortWant) {
            return calls[i];
        }
    }
    return null;
}

function buildInlineHitlApprovalHtml(data, opts) {
    const hasToolNameOverride = opts && Object.prototype.hasOwnProperty.call(opts, 'toolName');
    const toolName = hasToolNameOverride ? String(opts.toolName || '') : (data.toolName || '-');
    const mode = opts && opts.mode ? opts.mode : String(data.mode || 'approval').trim().toLowerCase();
    const allowEdit = opts && opts.allowEdit === true;
    const request = describeHitlApprovalRequest(Object.assign({}, data, toolName ? { toolName: toolName } : {}));
    const argsJSON = opts && opts.argsJSON ? opts.argsJSON : request.argsJSON;
    const reviewer = String(data.reviewer || data.decidedBy || '').trim().toLowerCase();
    const audit = reviewer === 'audit_agent' || String(data.status || '') === 'audit_running';
    const status = String(data.status || '').trim().toLowerCase();
    const timedOut = status === 'timeout' || String(data.decidedBy || '').trim().toLowerCase() === 'system' && /timeout|超时/i.test(String(data.comment || data.decisionMessage || ''));
    const cancelled = status === 'cancelled';
    const resolved = !!data.resolved || status === 'decided' || status === 'timeout' || cancelled || data.decision === 'approve' || data.decision === 'reject';
    const editedArgs = data.editedArgs || data.editedArguments;
    const hasEditedArgs = editedArgs && typeof editedArgs === 'object' && Object.keys(editedArgs).length > 0;
    const tr = hitlApprovalTranslate;
    const shield = '<svg class="hitl-codex-shield" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.2l6 2.5v4.5c0 3.8-2.35 6.55-6 8.6-3.65-2.05-6-4.8-6-8.6V4.7l6-2.5z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M7.5 10l1.55 1.55L12.8 7.8" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const toolHeading = toolName || request.displayTool
        ? '<div class="hitl-codex-tool-row">' + shield + '<span>' + escapeHtml(request.displayTool || toolName) + '</span></div>'
        : '';
    if (resolved) {
        if (cancelled) {
            const statusText = tr('hitl.interruptedApprovalCancelled', '任务已中断，审批已取消');
            const comment = data.comment && data.comment !== 'process restarted' && data.comment !== 'task cancelled'
                ? '<p class="hitl-codex-explainer">' + escapeHtml(data.comment) + '</p>'
                : '';
            return toolHeading + `
                <div class="hitl-codex-state hitl-codex-state--interrupted">
                    <span class="hitl-codex-state-icon" aria-hidden="true">×</span>
                    <strong>${escapeHtml(statusText)}</strong>
                </div>
                ${comment}
            `;
        }
        const ok = !timedOut && data.decision !== 'reject';
        let statusText;
        if (timedOut) {
            statusText = tr('hitl.expiredRejected', '审批超时，已自动拒绝');
        } else if (audit) {
            statusText = ok
                ? (hasEditedArgs ? tr('hitl.auditEditedApproved', '审计 Agent 已修改参数并批准') : tr('hitl.auditApproved', '审计 Agent 已批准'))
                : tr('hitl.auditRejected', '审计 Agent 已拒绝');
        } else {
            statusText = ok
                ? (hasEditedArgs ? tr('hitl.humanEditedApproved', '已修改参数并允许') : tr('hitl.humanApproved', '已允许一次'))
                : tr('hitl.humanRejected', '人工审批已拒绝');
        }
        const comment = data.comment
            ? '<p class="hitl-codex-explainer">' + escapeHtml(data.comment) + '</p>'
            : '';
        const diff = hasEditedArgs
            ? '<details class="hitl-codex-diff"><summary>' + escapeHtml(tr('hitl.viewEditedArgs', '查看修改后的参数')) + '</summary><pre>' + escapeHtml(JSON.stringify(editedArgs, null, 2)) + '</pre></details>'
            : '';
        return toolHeading + `
            <div class="hitl-codex-state hitl-codex-state--${ok ? 'approved' : 'rejected'}">
                <span class="hitl-codex-state-icon" aria-hidden="true">${ok ? '✓' : '×'}</span>
                <strong>${escapeHtml(statusText)}</strong>
            </div>
            ${comment}
            ${diff}
        `;
    }
    if (audit) {
        const auditStatus = mode === 'review_edit'
            ? tr('hitl.auditReviewEditing', '自动审查并校正中')
            : tr('hitl.auditReviewing', '自动审核中');
        const explanation = tr('hitl.auditReviewExplanation', '经过谨慎提示的审查智能体正在审查此请求，通过后才会执行。');
        return toolHeading + `
            <div class="hitl-codex-state hitl-codex-state--running">
                <span class="hitl-codex-spinner" aria-hidden="true"></span>
                <strong>${escapeHtml(auditStatus)}</strong>
            </div>
            <p class="hitl-codex-explainer">${escapeHtml(explanation)}</p>
        `;
    }
    const pendingStatus = allowEdit
        ? tr('hitl.waitingHumanReview', '等待人工审查')
        : tr('hitl.waitingHumanApproval', '等待人工审批');
    const rejectLabel = tr('hitl.reject', '拒绝');
    const approveLabel = allowEdit
        ? tr('hitl.saveEditedAndAllow', '保存修改并允许')
        : tr('hitl.allowOnce', '允许一次');
    const hasArgs = request.args && Object.keys(request.args).length > 0;
    const primary = request.primary
        ? '<div class="hitl-approval-primary hitl-approval-primary--' + request.kind + '"><code>' + escapeHtml(request.primary) + '</code></div>'
        : '';
    const requestDetails = hasArgs
        ? '<details class="hitl-approval-details"' + (allowEdit ? ' open' : '') + '><summary>' + escapeHtml(allowEdit
            ? tr('hitl.editRequestDetails', '查看或修改请求参数')
            : tr('hitl.viewRequestDetails', '查看请求详情')) + '</summary>' +
            (allowEdit
                ? '<textarea class="hitl-edit-args hitl-inline-edit" spellcheck="false">' + escapeHtml(argsJSON === '{}' ? '' : argsJSON) + '</textarea>'
                : '<pre>' + escapeHtml(argsJSON) + '</pre>') + '</details>'
        : '';
    return `
        ${toolHeading}
        <div class="hitl-approval-heading">
            <span class="hitl-approval-eyebrow">${escapeHtml(pendingStatus)}</span>
            <h3>${escapeHtml(request.question)}</h3>
        </div>
        ${primary}
        ${buildHitlCountdownHtml(data)}
        <div class="hitl-inline-body">
            ${requestDetails}
            <details class="hitl-approval-details hitl-approval-comment-details">
                <summary>${escapeHtml(tr('hitl.addApprovalComment', '添加审批备注（可选）'))}</summary>
                <input class="hitl-config-input hitl-inline-comment" type="text" placeholder="${escapeAttr(tr('hitl.commentPlaceholder', '例如：仅允许只读操作'))}">
            </details>
        </div>
        <div class="hitl-pending-actions hitl-inline-actions">
            <div class="hitl-input-help hitl-inline-status" aria-live="polite"></div>
            <button type="button" class="btn-secondary hitl-inline-reject">${escapeHtml(rejectLabel)} <kbd>Esc</kbd></button>
            <button type="button" class="btn-primary hitl-inline-approve">${escapeHtml(approveLabel)} <kbd>↵</kbd></button>
        </div>
    `;
}

function autoResizeHitlTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.max(textarea.scrollHeight, textarea.offsetHeight || 0) + 'px';
}

function bindInlineHitlApproval(panel, data, opts) {
    const approveBtn = panel.querySelector('.hitl-inline-approve');
    const rejectBtn = panel.querySelector('.hitl-inline-reject');
    const commentInput = panel.querySelector('.hitl-inline-comment');
    const editInput = panel.querySelector('.hitl-inline-edit');
    const statusEl = panel.querySelector('.hitl-inline-status');
    const allowEdit = opts && opts.allowEdit === true;
    if (!approveBtn || !rejectBtn || !statusEl) return;

    if (editInput) {
        autoResizeHitlTextarea(editInput);
        editInput.addEventListener('input', function () {
            autoResizeHitlTextarea(editInput);
        });
    }

    const setBusy = function (busy) {
        approveBtn.disabled = busy;
        rejectBtn.disabled = busy;
    };

    const submit = async function (decision) {
        setBusy(true);
        let editedArgs = null;
        if (decision === 'approve' && allowEdit && editInput) {
            const raw = String(editInput.value || '').trim();
            if (raw) {
                try {
                    editedArgs = JSON.parse(raw);
                } catch (e) {
                    statusEl.textContent = 'JSON 参数格式错误';
                    setBusy(false);
                    return;
                }
            }
            const originalArgs = hitlApprovalArguments(data);
            if (editedArgs && JSON.stringify(editedArgs) === JSON.stringify(originalArgs)) {
                editedArgs = null;
            }
        }
        const comment = commentInput ? String(commentInput.value || '').trim() : '';
        try {
            if (typeof window.submitHitlDecisionWithPayload === 'function') {
                const convFollow = data.conversationId || (typeof window.currentConversationId === 'string' ? window.currentConversationId : '');
                const ok = await window.submitHitlDecisionWithPayload(data.interruptId, decision, comment, (decision === 'approve' && allowEdit) ? editedArgs : null, convFollow);
                if (!ok) {
                    statusEl.textContent = '提交失败，请重试';
                    setBusy(false);
                    return;
                }
            } else {
                statusEl.textContent = '审批函数未加载';
                setBusy(false);
                return;
            }
            const msg = decision === 'approve' ? '已通过，等待执行继续...' : '已拒绝，反馈已交给模型继续迭代...';
            const toolItem = panel.closest('.timeline-item-tool_call');
            if (toolItem && toolItem.id) {
                const state = toolCallDetailStateByItemId.get(toolItem.id) || {};
                state.hitlData = Object.assign({}, state.hitlData || data, {
                    resolved: true,
                    decision: decision,
                    decisionMessage: msg,
                    reviewer: 'human',
                    status: 'decided',
                    comment: comment,
                    editedArgs: editedArgs
                });
                if (decision === 'approve' && editedArgs && typeof editedArgs === 'object') {
                    state.originalArgs = state.originalArgs || state.args || {};
                    state.args = editedArgs;
                    state.argsEditedByHitl = true;
                }
                state.pending = decision === 'approve';
                setToolCallDetailState(toolItem, state);
                renderToolCallApprovalSummary(toolItem, state.hitlData);
            } else {
                markInlineHitlDecision(panel, decision, msg);
            }
            panel.classList.add('hitl-inline-done');
            stopHitlApprovalCountdown(panel);
            clearChatHitlApprovalDock(data.interruptId);
            if (typeof window.setProjectConversationApprovalStatus === 'function') {
                window.setProjectConversationApprovalStatus(data.conversationId || window.currentConversationId || '', false);
            }
        } catch (e) {
            statusEl.textContent = '提交失败：' + (e && e.message ? e.message : 'unknown error');
            setBusy(false);
        }
    };

    const bindExplicitHitlAction = function (button, decision) {
        let pointerArmed = false;
        button.addEventListener('pointerdown', function (event) {
            pointerArmed = event.isPrimary !== false && (event.button == null || event.button === 0);
        });
        button.addEventListener('pointercancel', function () {
            pointerArmed = false;
        });
        button.onclick = function (event) {
            const pointerClick = !!event && Number(event.detail || 0) > 0;
            const explicitlyPressed = pointerArmed;
            pointerArmed = false;
            // 鼠标/触摸点击必须从审批按钮自身开始；键盘 Enter/Escape 的 detail 为 0，仍可正常使用。
            // 这可以拦截滚动定位按钮隐藏后被浏览器重新定向到底部审批按钮的合成 click。
            if (pointerClick && !explicitlyPressed) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            submit(decision);
        };
    };

    bindExplicitHitlAction(approveBtn, 'approve');
    bindExplicitHitlAction(rejectBtn, 'reject');
    if (panel.classList.contains('chat-hitl-approval-dock')) {
        panel.onkeydown = function (event) {
            const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
            const editing = tag === 'input' || tag === 'textarea' || tag === 'summary';
            if (event.key === 'Escape' && !editing) {
                event.preventDefault();
                rejectBtn.click();
            } else if (event.key === 'Enter' && !editing) {
                event.preventDefault();
                approveBtn.click();
            }
        };
    }
}

function clearChatHitlApprovalDock(interruptId) {
    const dock = document.getElementById('chat-hitl-approval-dock');
    if (!dock) return;
    if (interruptId && dock.dataset.hitlInterruptId && dock.dataset.hitlInterruptId !== String(interruptId)) return;
    stopHitlApprovalCountdown(dock);
    dock.hidden = true;
    dock.innerHTML = '';
    dock.removeAttribute('data-hitl-interrupt-id');
    dock.removeAttribute('data-conversation-id');
    dock.removeAttribute('tabindex');
    dock.onkeydown = null;
    const container = dock.closest('.chat-input-container');
    if (container) container.classList.remove('has-hitl-approval');
}

function wrapChatHitlApprovalScrollRegion(dock) {
    if (!dock) return;
    const actions = Array.prototype.find.call(dock.children, function (child) {
        return child.classList && child.classList.contains('hitl-inline-actions');
    });
    if (!actions) return;
    const scrollRegion = document.createElement('div');
    scrollRegion.className = 'chat-hitl-approval-scroll-region';
    while (dock.firstChild && dock.firstChild !== actions) {
        scrollRegion.appendChild(dock.firstChild);
    }
    dock.insertBefore(scrollRegion, actions);
}

function renderChatHitlApprovalDock(data) {
    const dock = document.getElementById('chat-hitl-approval-dock');
    if (!dock || !data || !data.interruptId) return false;
    const conversationId = String(data.conversationId || '').trim();
    const currentId = String(window.currentConversationId || '').trim();
    // 新任务尚未绑定会话 ID 时不能让其他运行中对话的迟到审批覆盖输入框。
    // 有明确会话 ID 的审批面板只允许显示在同一个当前对话中。
    if (conversationId && conversationId !== currentId) return false;
    if (isAgentReviewedHitl(data)) return false;
    let mode = String(data.mode || 'approval').trim().toLowerCase();
    if (mode === 'feedback' || mode === 'followup') mode = 'approval';
    const allowEdit = mode === 'review_edit';
    dock.dataset.hitlInterruptId = String(data.interruptId);
    dock.dataset.conversationId = conversationId || currentId;
    dock.setAttribute('tabindex', '-1');
    dock.innerHTML = buildInlineHitlApprovalHtml(data, {
        mode: mode,
        allowEdit: allowEdit,
        argsJSON: JSON.stringify(hitlApprovalArguments(data), null, 2)
    });
    wrapChatHitlApprovalScrollRegion(dock);
    dock.hidden = false;
    const container = dock.closest('.chat-input-container');
    if (container) container.classList.add('has-hitl-approval');
    bindInlineHitlApproval(dock, data, { allowEdit: allowEdit });
    bindHitlApprovalCountdown(dock, data);
    setHitlApprovalTaskAvailability(dock, dock.dataset.conversationId);
    return true;
}

const hitlSidebarApprovalState = new Map();
let hitlSidebarApprovalSyncTimer = 0;

function renderDirectHitlSidebarApproval(conversationId, data) {
    const id = String(conversationId || '').trim();
    if (!id) return false;
    const button = document.querySelector('.project-conversation-item[data-conversation-id="' + hitlEscapeAttrSelector(id) + '"]');
    if (!button) return false;
    const label = button.querySelector('.project-conversation-label');
    if (!label) return false;
    let group = label.querySelector('.project-task-status-group');
    if (!group) {
        group = document.createElement('span');
        group.className = 'project-task-status-group';
        label.appendChild(group);
    }
    let status = group.querySelector('.project-task-status--approval');
    if (!status) {
        status = document.createElement('span');
        status.className = 'project-task-status project-task-status--approval';
        status.innerHTML = '<span class="project-approval-label"></span><span class="project-approval-time"></span>' +
            '<span class="project-approval-progress"><span class="project-approval-progress-value"></span></span>';
        group.insertBefore(status, group.firstChild);
    }
    const text = hitlApprovalTranslate('hitl.waitingApprovalShort', '等待批准');
    const labelEl = status.querySelector('.project-approval-label');
    if (labelEl) labelEl.textContent = text;
    status.setAttribute('aria-label', text);
    status.title = text;
    const timing = getHitlApprovalTiming(data || {});
    const timeEl = status.querySelector('.project-approval-time');
    const progressEl = status.querySelector('.project-approval-progress');
    const valueEl = status.querySelector('.project-approval-progress-value');
    if (!timing.timeoutSeconds || !timing.expiresAt) {
        if (timeEl) timeEl.textContent = '';
        if (progressEl) progressEl.hidden = true;
        return true;
    }
    if (progressEl) progressEl.hidden = false;
    const remaining = Math.max(0, timing.expiresAt - Date.now());
    const percent = Math.max(0, Math.min(100, remaining / (timing.timeoutSeconds * 1000) * 100));
    if (timeEl) timeEl.textContent = formatHitlRemaining(remaining).replace(/^0/, '');
    if (valueEl) valueEl.style.width = percent.toFixed(2) + '%';
    status.setAttribute('role', 'progressbar');
    status.setAttribute('aria-valuemin', '0');
    status.setAttribute('aria-valuemax', '100');
    status.setAttribute('aria-valuenow', String(Math.round(percent)));
    status.classList.toggle('is-expired', remaining <= 0);
    return true;
}

function removeDirectHitlSidebarApproval(conversationId) {
    const id = String(conversationId || '').trim();
    if (!id) return;
    const button = document.querySelector('.project-conversation-item[data-conversation-id="' + hitlEscapeAttrSelector(id) + '"]');
    const status = button && button.querySelector('.project-task-status--approval');
    const group = status && status.closest('.project-task-status-group');
    if (status) status.remove();
    if (group && !group.children.length) group.remove();
}

function syncDirectHitlSidebarApprovals() {
    hitlSidebarApprovalState.forEach(function (data, conversationId) {
        renderDirectHitlSidebarApproval(conversationId, data);
    });
    if (!hitlSidebarApprovalState.size && hitlSidebarApprovalSyncTimer) {
        window.clearInterval(hitlSidebarApprovalSyncTimer);
        hitlSidebarApprovalSyncTimer = 0;
    }
}

function updateHitlApprovalSidebar(data, pending) {
    const conversationId = String((data && data.conversationId) || window.currentConversationId || '').trim();
    if (!conversationId) return;
    if (pending && isAgentReviewedHitl(data)) return;
    if (pending) {
        hitlSidebarApprovalState.set(conversationId, data || { conversationId: conversationId });
        renderDirectHitlSidebarApproval(conversationId, data || {});
        if (!hitlSidebarApprovalSyncTimer) {
            hitlSidebarApprovalSyncTimer = window.setInterval(syncDirectHitlSidebarApprovals, 500);
        }
    } else {
        hitlSidebarApprovalState.delete(conversationId);
        removeDirectHitlSidebarApproval(conversationId);
        syncDirectHitlSidebarApprovals();
    }
    if (typeof window.setProjectConversationApprovalStatus === 'function') {
        window.setProjectConversationApprovalStatus(conversationId, pending, pending ? data : null);
    }
}

function syncHitlApprovalSidebarState(items) {
    const nextByConversation = new Map();
    (Array.isArray(items) ? items : []).forEach(function (item) {
        if (isAgentReviewedHitl(item)) return;
        const conversationId = String(item && item.conversationId || '').trim();
        if (conversationId && !nextByConversation.has(conversationId)) {
            nextByConversation.set(conversationId, item);
        }
    });
    hitlSidebarApprovalState.forEach(function (_item, conversationId) {
        if (!nextByConversation.has(conversationId)) {
            hitlSidebarApprovalState.delete(conversationId);
            removeDirectHitlSidebarApproval(conversationId);
        }
    });
    nextByConversation.forEach(function (item, conversationId) {
        hitlSidebarApprovalState.set(conversationId, item);
    });
    syncDirectHitlSidebarApprovals();
    if (hitlSidebarApprovalState.size && !hitlSidebarApprovalSyncTimer) {
        hitlSidebarApprovalSyncTimer = window.setInterval(syncDirectHitlSidebarApprovals, 500);
    }
}

function reconcilePendingHitlState(rawItems) {
    const activeItems = (Array.isArray(rawItems) ? rawItems : [])
        .map(function (item) { return hitlPendingItemToData(item); })
        .filter(function (item) {
            return item && !isAgentReviewedHitl(item) && conversationExecutionTracker.isRunning(item.conversationId);
        });
    hitlPendingInterruptTracker.update(activeItems);
    syncHitlApprovalTaskAvailability();
    syncHitlApprovalSidebarState(activeItems);
    if (typeof window.syncProjectConversationApprovalStatuses === 'function') {
        window.syncProjectConversationApprovalStatuses(activeItems);
    }

    const currentId = String(window.currentConversationId || '').trim();
    const currentPending = activeItems.find(function (item) {
        return item.conversationId === currentId;
    });
    const dock = document.getElementById('chat-hitl-approval-dock');
    const dockInterruptId = dock && String(dock.dataset.hitlInterruptId || '').trim();
    if (!currentPending) {
        if (dockInterruptId) clearChatHitlApprovalDock();
        return;
    }

    if (!dockInterruptId || dockInterruptId !== currentPending.interruptId || dock.hidden) {
        renderChatHitlApprovalDock(currentPending);
    }
    const inlineSelector = '.hitl-inline-approval[data-hitl-interrupt-id="' +
        hitlEscapeAttrSelector(currentPending.interruptId) + '"]';
    if (!document.querySelector(inlineSelector)) {
        restoreHitlInlineForConversation(currentId);
    }
}

window.renderChatHitlApprovalDock = renderChatHitlApprovalDock;
window.clearChatHitlApprovalDock = clearChatHitlApprovalDock;

function markInlineHitlDecision(panel, decision, message) {
    if (!panel) return;
    const ok = decision === 'approve';
    panel.classList.add('hitl-inline-done');
    panel.innerHTML = `
        <div class="hitl-codex-state hitl-codex-state--${ok ? 'approved' : 'rejected'}">
            <span class="hitl-codex-state-icon" aria-hidden="true">${ok ? '✓' : '×'}</span>
            <strong>${escapeHtml(ok ? '已允许一次' : '人工审批已拒绝')}</strong>
        </div>
        ${message ? '<p class="hitl-codex-explainer">' + escapeHtml(message) + '</p>' : ''}
    `;
}

function renderInlineWorkflowHitlApproval(itemId, data) {
    const item = document.getElementById(itemId);
    if (!item || !data) return;
    const runId = data.workflowRunId || data.workflow_run_id;
    if (!runId) return;
    let contentEl = item.querySelector('.timeline-item-content');
    if (!contentEl) {
        contentEl = document.createElement('div');
        contentEl.className = 'timeline-item-content';
        item.appendChild(contentEl);
    }
    const existingPanel = contentEl.querySelector('.workflow-hitl-inline-approval');
    if (existingPanel) existingPanel.remove();

    const label = data.label || data.nodeId || runId;
    const prompt = data.prompt || '';
    const panel = document.createElement('div');
    panel.className = 'workflow-hitl-inline-approval hitl-inline-approval';
    panel.dataset.conversationId = String(data.conversationId || window.currentConversationId || '').trim();
    panel.innerHTML = `
        <div class="hitl-inline-header">
            <div class="hitl-inline-title">
                <span class="hitl-inline-icon" aria-hidden="true">!</span>
                <span>工作流审批</span>
            </div>
            <div class="hitl-inline-badges">
                <span class="hitl-tool-badge">${escapeHtml(label)}</span>
                <span class="hitl-mode-tag hitl-mode-tag--approval">审批模式</span>
            </div>
        </div>
        <div class="hitl-inline-body">
            ${prompt ? `<div class="hitl-inline-note">${escapeHtml(prompt)}</div>` : '<div class="hitl-inline-note">工作流暂停，等待你确认是否继续。</div>'}
            <label class="hitl-inline-field">
                <span class="hitl-context-label">备注（可选）</span>
                <input class="hitl-config-input workflow-hitl-inline-comment" type="text" placeholder="审批意见">
            </label>
        </div>
        <div class="hitl-pending-actions hitl-inline-actions">
            <div class="hitl-input-help workflow-hitl-inline-status" aria-live="polite"></div>
            <button class="btn-secondary workflow-hitl-inline-reject">拒绝</button>
            <button class="btn-primary workflow-hitl-inline-approve">通过</button>
        </div>
    `;
    contentEl.appendChild(panel);

    const approveBtn = panel.querySelector('.workflow-hitl-inline-approve');
    const rejectBtn = panel.querySelector('.workflow-hitl-inline-reject');
    const commentInput = panel.querySelector('.workflow-hitl-inline-comment');
    const statusEl = panel.querySelector('.workflow-hitl-inline-status');

    const setBusy = function (busy) {
        approveBtn.disabled = busy;
        rejectBtn.disabled = busy;
    };

    const submit = async function (approved) {
        setBusy(true);
        const comment = String(commentInput.value || '').trim();
        try {
            const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
            const response = await fetchFn(`/api/workflows/runs/${encodeURIComponent(runId)}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ approved: approved, comment: comment })
            });
            const body = response && typeof response.json === 'function' ? await response.json() : null;
            if (!response || !response.ok) {
                statusEl.textContent = (body && body.error) ? body.error : '提交失败，请重试';
                setBusy(false);
                return;
            }
            if (body && body.streamResuming) {
                statusEl.textContent = approved ? '已通过，工作流继续执行中…' : '已拒绝';
                panel.classList.add('hitl-inline-done');
                return;
            }
            statusEl.textContent = approved ? '已通过，工作流继续执行' : '已拒绝';
            panel.classList.add('hitl-inline-done');
        } catch (e) {
            statusEl.textContent = '提交失败：' + (e && e.message ? e.message : 'unknown error');
            setBusy(false);
        }
    };

    approveBtn.onclick = function () { submit(true); };
    rejectBtn.onclick = function () { submit(false); };
    setHitlApprovalTaskAvailability(panel, panel.dataset.conversationId);
}

function parseWorkflowHitlPendingJSON(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        const o = JSON.parse(String(raw));
        return o && typeof o === 'object' ? o : {};
    } catch (e) {
        return {};
    }
}

function workflowHitlDataFromRun(run) {
    if (!run) return null;
    const runId = run.id || run.workflowRunId || run.workflow_run_id;
    if (!runId) return null;
    const pending = parseWorkflowHitlPendingJSON(run.pending_hitl_json || run.pendingHitlJson || run.pendingHitlJSON);
    const pendingHitl = pending.pendingHitl && typeof pending.pendingHitl === 'object' ? pending.pendingHitl : pending;
    return {
        workflowRunId: String(runId),
        nodeId: pendingHitl.nodeId || run.pending_hitl_node_id || run.pendingHitlNodeId || '',
        label: pendingHitl.label || pendingHitl.nodeId || run.pending_hitl_node_id || run.pendingHitlNodeId || runId,
        prompt: pendingHitl.prompt || '',
        conversationId: run.conversation_id || run.conversationId || ''
    };
}

function findWorkflowHitlTimelineItem(detailsContainer, runId) {
    if (!detailsContainer || !runId) return null;
    const rid = String(runId).trim();
    const byRun = detailsContainer.querySelector('[data-workflow-run-id="' + hitlEscapeAttrSelector(rid) + '"]');
    if (byRun) return byRun;
    const items = detailsContainer.querySelectorAll('.timeline-item-workflow_hitl_waiting');
    for (let i = items.length - 1; i >= 0; i--) {
        const el = items[i];
        if (!el.querySelector('.workflow-hitl-inline-approval.hitl-inline-done')) {
            return el;
        }
    }
    return items.length ? items[items.length - 1] : null;
}

/**
 * 刷新或切换会话后：根据 workflow_runs(awaiting_hitl) 恢复工作流内联审批入口。
 */
async function restoreWorkflowHitlInlineForConversation(conversationId) {
    if (!conversationId || typeof apiFetch !== 'function') return;
    if (typeof window.currentConversationId === 'string' && window.currentConversationId !== conversationId) {
        return;
    }
    try {
        const resp = await apiFetch('/api/workflows/runs/pending?conversationId=' + encodeURIComponent(conversationId));
        if (!resp.ok) return;
        const data = await resp.json().catch(function () { return {}; });
        const runs = Array.isArray(data.runs) ? data.runs : [];
        if (!runs.length) return;

        let msgEl = document.querySelector('#chat-messages [data-backend-message-id]');
        const nodes = document.querySelectorAll('#chat-messages .message.assistant');
        for (let i = nodes.length - 1; i >= 0; i--) {
            if (nodes[i] && nodes[i].dataset && nodes[i].dataset.backendMessageId) {
                msgEl = nodes[i];
                break;
            }
        }
        if (!msgEl || !msgEl.id) return;
        const clientMsgId = msgEl.id;
        const backendMsgId = msgEl.dataset.backendMessageId;
        const detailsContainer = document.getElementById('process-details-' + clientMsgId);
        if (!detailsContainer) return;

        if (detailsContainer.dataset.lazyNotLoaded === '1' && detailsContainer.dataset.loaded !== '1') {
            try {
                detailsContainer.dataset.loading = '1';
                if (typeof loadProcessDetailsPaginated === 'function') {
                    await loadProcessDetailsPaginated(clientMsgId, backendMsgId);
                } else if (typeof apiFetch === 'function' && backendMsgId) {
                    const res = await apiFetch('/api/messages/' + encodeURIComponent(backendMsgId) + '/process-details?full=1');
                    const j = await res.json().catch(function () { return {}; });
                    if (res.ok && typeof renderProcessDetails === 'function') {
                        renderProcessDetails(clientMsgId, (j && Array.isArray(j.processDetails)) ? j.processDetails : []);
                    }
                }
            } catch (e) {
                console.error('加载过程详情失败（工作流 HITL 恢复）:', e);
            } finally {
                detailsContainer.dataset.loading = '0';
            }
        }

        expandProcessDetailsTimeline(clientMsgId);

        for (let i = 0; i < runs.length; i++) {
            const hitlData = workflowHitlDataFromRun(runs[i]);
            if (!hitlData) continue;
            let hitlItemEl = findWorkflowHitlTimelineItem(detailsContainer, hitlData.workflowRunId);
            if (!hitlItemEl) {
                const timeline = detailsContainer.querySelector('.progress-timeline');
                if (timeline && typeof addTimelineItem === 'function') {
                    const itemId = addTimelineItem(timeline, 'workflow_hitl_waiting', {
                        title: '🧑‍⚖️ 工作流等待审批',
                        message: hitlData.label || '',
                        data: hitlData
                    });
                    hitlItemEl = document.getElementById(itemId);
                }
            }
            if (hitlItemEl && hitlItemEl.id) {
                renderInlineWorkflowHitlApproval(hitlItemEl.id, hitlData);
            }
        }
    } catch (e) {
        console.error('restoreWorkflowHitlInlineForConversation failed', e);
    }
}

window.restoreWorkflowHitlInlineForConversation = restoreWorkflowHitlInlineForConversation;
window.submitWorkflowHitlDecision = async function submitWorkflowHitlDecision(runId, approved, comment) {
    const fetchFn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const response = await fetchFn('/api/workflows/runs/' + encodeURIComponent(String(runId)) + '/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: !!approved, comment: comment || '' })
    });
    const body = response && typeof response.json === 'function' ? await response.json() : null;
    if (!response || !response.ok) {
        throw new Error((body && body.error) ? body.error : '提交失败');
    }
    return body;
};

function hitlEscapeAttrSelector(val) {
    const s = String(val);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(s);
    }
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function expandProcessDetailsTimeline(assistantMessageId) {
    if (!assistantMessageId) return;
    const detailsContainer = document.getElementById('process-details-' + assistantMessageId);
    if (!detailsContainer) return;
    const timeline = detailsContainer.querySelector('.progress-timeline');
    if (!timeline) return;
    timeline.classList.add('expanded');
    detailsContainer.dataset.userExpanded = '1';
    if (typeof syncProcessDetailButtonLabels === 'function') {
        syncProcessDetailButtonLabels(assistantMessageId, true);
    } else {
        const collapseT = typeof window.t === 'function' ? window.t('tasks.collapseDetail') : '收起详情';
        document.querySelectorAll('#' + hitlEscapeAttrSelector(assistantMessageId) + ' .process-detail-btn').forEach(function (btn) {
            btn.innerHTML = '<span>' + collapseT + '</span>';
        });
    }
    if (typeof window.syncAssistantTurnSummary === 'function') {
        window.syncAssistantTurnSummary(document.getElementById(assistantMessageId));
    }
    setTimeout(function () {
        if (window.CyberStrikeChatScroll && typeof window.CyberStrikeChatScroll.scrollIntoViewIfFollowing === 'function') {
            window.CyberStrikeChatScroll.scrollIntoViewIfFollowing(detailsContainer, { behavior: 'smooth', block: 'nearest' });
        } else if (typeof window.captureScrollPinState === 'function' ? window.captureScrollPinState() : true) {
            detailsContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, 100);
}

function findLastAssistantMessageElInChat() {
    const nodes = document.querySelectorAll('#chat-messages .message.assistant');
    for (let i = nodes.length - 1; i >= 0; i--) {
        const el = nodes[i];
        if (el && el.dataset && el.dataset.backendMessageId) return el;
    }
    return null;
}

function hitlPendingItemToData(item, fallbackConversationId) {
    if (!item) return null;
    let payloadObj = item.payload && typeof item.payload === 'object' ? item.payload : {};
    if (typeof item.payload === 'string') {
        try {
            payloadObj = JSON.parse(item.payload || '{}');
        } catch (e) {
            payloadObj = {};
        }
    }
    const timing = payloadObj.hitlApproval && typeof payloadObj.hitlApproval === 'object'
        ? payloadObj.hitlApproval
        : {};
    return {
        interruptId: String(item.interruptId || item.id || '').trim(),
        mode: item.mode,
        toolName: item.toolName,
        toolCallId: item.toolCallId,
        payload: payloadObj,
        conversationId: String(item.conversationId || fallbackConversationId || '').trim(),
        createdAt: timing.createdAt || item.createdAt,
        timeoutSeconds: timing.timeoutSeconds,
        expiresAt: timing.expiresAt,
        reviewer: item.reviewer || item.decidedBy || 'human',
        status: item.status || 'pending'
    };
}

const hitlInlineRestoreInFlight = new Set();

/**
 * 刷新或切换会话后：根据待审批记录恢复时间线里的内联审批入口，并展开详情区。
 */
async function restoreHitlInlineForConversation(conversationId) {
    if (!conversationId || typeof apiFetch !== 'function') return;
    if (hitlInlineRestoreInFlight.has(conversationId)) return;
    if (typeof window.currentConversationId === 'string' && window.currentConversationId !== conversationId) {
        return;
    }
    hitlInlineRestoreInFlight.add(conversationId);
    try {
        const resp = await apiFetch('/api/hitl/pending?conversationId=' + encodeURIComponent(conversationId) + '&status=pending&pageSize=50');
        if (!resp.ok) return;
        const data = await resp.json().catch(function () { return {}; });
        const rawItems = (Array.isArray(data.items) ? data.items : []).filter(function (item) {
            return !isAgentReviewedHitl(item);
        });
        // 任务列表是当前进程的权威运行态。服务重启或任务取消后，即使审批查询
        // 短暂读到旧 pending 记录，也不能重新挂载审批入口和倒计时。
        const items = conversationExecutionTracker.ready && !conversationExecutionTracker.isRunning(conversationId)
            ? []
            : rawItems;
        if (typeof window.currentConversationId === 'string' && window.currentConversationId !== conversationId) return;
        clearChatHitlApprovalDock();
        const normalizedItems = items.map(function (item) {
            return hitlPendingItemToData(item, conversationId);
        }).filter(Boolean);
        hitlPendingInterruptTracker.replaceConversation(conversationId, normalizedItems);
        syncHitlApprovalTaskAvailability();
        if (items.length > 0) {
            const newestPending = normalizedItems[0];
            renderChatHitlApprovalDock(newestPending);
            updateHitlApprovalSidebar(newestPending, true);
        } else {
            updateHitlApprovalSidebar({ conversationId: conversationId }, false);
        }
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            let backendMsgId = item.messageId != null ? String(item.messageId).trim() : '';
            let msgEl = null;
            if (backendMsgId) {
                msgEl = document.querySelector('#chat-messages [data-backend-message-id="' + hitlEscapeAttrSelector(backendMsgId) + '"]');
            }
            if (!msgEl) {
                msgEl = findLastAssistantMessageElInChat();
                if (msgEl && msgEl.dataset && msgEl.dataset.backendMessageId) {
                    backendMsgId = String(msgEl.dataset.backendMessageId).trim();
                }
            }
            if (!msgEl || !msgEl.id || !backendMsgId) continue;
            const clientMsgId = msgEl.id;
            const detailsContainer = document.getElementById('process-details-' + clientMsgId);
            if (!detailsContainer) continue;
            if (detailsContainer.dataset.lazyNotLoaded === '1' && detailsContainer.dataset.loaded !== '1') {
                try {
                    detailsContainer.dataset.loading = '1';
                    if (typeof loadProcessDetailsPaginated === 'function') {
                        await loadProcessDetailsPaginated(clientMsgId, backendMsgId);
                    } else {
                        const res = await apiFetch('/api/messages/' + encodeURIComponent(backendMsgId) + '/process-details?full=1');
                        const j = await res.json().catch(function () { return {}; });
                        if (!res.ok) throw new Error((j && j.error) ? j.error : String(res.status));
                        const details = (j && Array.isArray(j.processDetails)) ? j.processDetails : [];
                        if (typeof renderProcessDetails === 'function') {
                            renderProcessDetails(clientMsgId, details);
                        }
                    }
                } catch (e) {
                    console.error('加载过程详情失败（HITL 恢复）:', e);
                } finally {
                    detailsContainer.dataset.loading = '0';
                }
            }
            expandProcessDetailsTimeline(clientMsgId);
            const hitlData = hitlPendingItemToData(item);
            let hitlItemEl = null;
            if (item.toolCallId) {
                hitlItemEl = detailsContainer.querySelector('[data-tool-call-id="' + hitlEscapeAttrSelector(String(item.toolCallId)) + '"]');
            }
            if (!hitlItemEl && item.toolName) {
                const want = String(item.toolName).trim().toLowerCase();
                const shortWant = want.indexOf('::') >= 0 ? want.split('::').pop() : want;
                const calls = detailsContainer.querySelectorAll('.timeline-item-tool_call');
                for (let j = calls.length - 1; j >= 0; j--) {
                    const tn = String(calls[j].dataset.toolName || '').trim().toLowerCase();
                    const shortTn = tn.indexOf('::') >= 0 ? tn.split('::').pop() : tn;
                    const match = want && (tn === want || tn.endsWith('::' + shortWant) || shortTn === shortWant);
                    if (match) {
                        hitlItemEl = calls[j];
                        break;
                    }
                }
            }
            if (!hitlItemEl) {
                hitlItemEl = detailsContainer.querySelector('[data-hitl-interrupt-id="' + hitlEscapeAttrSelector(String(item.id)) + '"]');
            }
            if (!hitlItemEl) continue;
            renderInlineHitlApproval(hitlItemEl.id, hitlData);
        }
        if (typeof restoreWorkflowHitlInlineForConversation === 'function') {
            await restoreWorkflowHitlInlineForConversation(conversationId);
        }
    } catch (e) {
        console.error('restoreHitlInlineForConversation failed', e);
    } finally {
        hitlInlineRestoreInFlight.delete(conversationId);
    }
}

window.expandProcessDetailsTimeline = expandProcessDetailsTimeline;
window.restoreHitlInlineForConversation = restoreHitlInlineForConversation;

/**
 * 无 SSE 时（例如刷新页面后）：从 DB 拉取最后一条助手消息的过程详情并重绘时间线，便于审批通过后仍能看到执行进展。
 */
async function refreshLastAssistantProcessDetails(conversationId) {
    if (!conversationId || typeof apiFetch !== 'function') return;
    if (typeof window.currentConversationId === 'string' && window.currentConversationId !== conversationId) return;
    const msgEl = findLastAssistantMessageElInChat();
    if (!msgEl || !msgEl.dataset.backendMessageId || !msgEl.id) return;
    const backendId = String(msgEl.dataset.backendMessageId).trim();
    const clientId = msgEl.id;
    const detailsContainer = document.getElementById('process-details-' + clientId);
    let wasExpanded = false;
    if (detailsContainer) {
        const tl = detailsContainer.querySelector('.progress-timeline');
        wasExpanded = !!(tl && tl.classList.contains('expanded'));
    }
    try {
        // 恢复流程必须遍历全部分页。直接请求无参数接口只会返回最早 50 条，
        // 长任务刷新后会表现为“旧轮次 → 当前实时轮次”的中间历史缺失。
        if (typeof loadProcessDetailsPaginated === 'function') {
            await loadProcessDetailsPaginated(clientId, backendId);
        } else {
            const res = await apiFetch(
                '/api/messages/' + encodeURIComponent(backendId) + '/process-details?full=1'
            );
            const j = await res.json().catch(function () { return {}; });
            if (!res.ok) return;
            const details = Array.isArray(j.processDetails) ? j.processDetails : [];
            if (typeof renderProcessDetails === 'function') {
                renderProcessDetails(clientId, details);
            }
        }
        if (wasExpanded) {
            expandProcessDetailsTimeline(clientId);
        }
    } catch (e) {
        console.warn('refreshLastAssistantProcessDetails', e);
    }
}

window.refreshLastAssistantProcessDetails = refreshLastAssistantProcessDetails;

const taskEventReplayAttachState = {
    conversationId: null,
    inFlightPromise: null,
    abortController: null
};

