/**
 * settings-mcp.js —— 设置页的外部 MCP 服务器管理
 *
 * 从 settings.js 拆出（原 "外部MCP管理" 区块）：
 * 外部 MCP 列表与统计渲染、轮询、新增/编辑弹窗、JSON 格式化与示例加载。
 *
 * 与 settings.js 同处全局作用域；加载顺序置于 settings.js 之后。
 */
// ==================== 外部MCP管理 ====================

let currentEditingMCPName = null;

// 拉取外部MCP列表数据（供轮询使用，返回 { servers, stats }）
async function fetchExternalMCPs() {
    const response = await apiFetch('/api/external-mcp');
    if (!response.ok) {
        if (typeof readApiError === 'function') {
            throw new Error(await readApiError(response, '获取外部MCP列表失败'));
        }
        throw new Error('获取外部MCP列表失败');
    }
    return response.json();
}

// MCP 管理页定时刷新外部 MCP 状态（感知后台断连/自动重连）
let externalMcpPollTimer = null;
const EXTERNAL_MCP_POLL_INTERVAL_MS = 8000;
let externalMcpRenderSignature = '';

function renderExternalMCPData(data, forceRender = false) {
    const servers = data.servers || {};
    const stats = data.stats || {};
    const signature = JSON.stringify({ servers, stats });

    if (!forceRender && signature === externalMcpRenderSignature) {
        updateExternalMcpCardSelection();
        return false;
    }

    externalMcpRenderSignature = signature;
    renderExternalMCPList(servers);
    renderExternalMCPStats(stats);
    return true;
}

function startExternalMcpPoll() {
    stopExternalMcpPoll();
    externalMcpPollTimer = setInterval(function () {
        const mcpPage = document.getElementById('page-mcp-management');
        if (!mcpPage || !mcpPage.classList.contains('active')) {
            stopExternalMcpPoll();
            return;
        }
        if (document.hidden) {
            return;
        }
        loadExternalMCPs().catch(function () { /* ignore */ });
    }, EXTERNAL_MCP_POLL_INTERVAL_MS);
}

function stopExternalMcpPoll() {
    if (externalMcpPollTimer) {
        clearInterval(externalMcpPollTimer);
        externalMcpPollTimer = null;
    }
}

// 加载外部MCP列表并渲染
async function loadExternalMCPs(options = {}) {
    try {
        // 等待 i18n 就绪，避免快速刷新时翻译函数未初始化导致显示占位符
        if (window.i18nReady) await window.i18nReady;
        const data = await fetchExternalMCPs();
        renderExternalMCPData(data, options.forceRender === true);
    } catch (error) {
        console.error('加载外部MCP列表失败:', error);
        const list = document.getElementById('external-mcp-list');
        if (list) {
            const errT = typeof window.t === 'function' ? window.t : (k) => k;
        list.innerHTML = `<div class="error">${escapeHtml(errT('mcp.loadExternalMCPFailed'))}: ${escapeHtml(error.message)}</div>`;
        }
    }
}

async function reloadMcpToolsAfterExternalChange(refreshExternal = false) {
    if (typeof loadToolsList === 'function') {
        const page = (toolsPagination && toolsPagination.page) ? toolsPagination.page : 1;
        await loadToolsList(page, toolsSearchKeyword, { refreshExternal });
    }
}

// 轮询列表直到指定 MCP 的工具数量已更新（每秒拉一次，拿到即停，无固定延迟）
// name 为 null 时仅按 maxAttempts 次数轮询，不判断 tool_count
async function pollExternalMCPToolCount(name, maxAttempts = 10) {
    const pollIntervalMs = 1000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
        try {
            const data = await fetchExternalMCPs();
            renderExternalMCPData(data);
            if (name != null) {
                const server = data.servers && data.servers[name];
                if (server && server.tool_count > 0) break;
            }
        } catch (e) {
            console.warn('轮询工具数量失败:', e);
        }
    }
    await reloadMcpToolsAfterExternalChange(true);
    if (typeof window !== 'undefined' && typeof window.refreshMentionTools === 'function') {
        window.refreshMentionTools();
    }
}

// 渲染外部MCP列表
function renderExternalMCPList(servers) {
    const list = document.getElementById('external-mcp-list');
    if (!list) return;
    const layout = document.querySelector('.mcp-management-layout');
    
    if (Object.keys(servers).length === 0) {
        if (layout) layout.classList.add('external-empty');
        const emptyT = typeof window.t === 'function' ? window.t : (k) => k;
        list.innerHTML = '<div class="empty">📋 ' + emptyT('mcp.noExternalMCP') + '<br><span style="font-size: 0.875rem; margin-top: 8px; display: block;">' + emptyT('mcp.clickToAddExternal') + '</span></div>';
        return;
    }
    if (layout) layout.classList.remove('external-empty');
    
    let html = '<div class="external-mcp-items">';
    for (const [name, server] of Object.entries(servers)) {
        const status = server.status || 'disconnected';
        const statusClass = status === 'connected' ? 'status-connected' : 
                           status === 'connecting' ? 'status-connecting' :
                           status === 'error' ? 'status-error' :
                           status === 'disabled' ? 'status-disabled' : 'status-disconnected';
        const statusT = typeof window.t === 'function' ? window.t : (k) => k;
        const statusText = status === 'connected' ? statusT('mcp.connected') : 
                          status === 'connecting' ? statusT('mcp.connecting') :
                          status === 'error' ? statusT('mcp.connectionFailed') :
                          status === 'disabled' ? statusT('mcp.disabled') : statusT('mcp.disconnected');
        const transport = server.config.type || server.config.transport || (server.config.command ? 'stdio' : 'http');
        const transportIcon = transport === 'stdio' ? '⚙️' : '🌐';
        
        const hasTools = server.tool_count !== undefined && server.tool_count > 0;
        const cardClickTitle = hasTools
            ? escapeHtml(statusT('mcp.clickToViewTools', { name }))
            : '';
        const cardClass = hasTools ? 'external-mcp-item clickable' : 'external-mcp-item';
        const selectedClass = toolsExternalMcpFilter === name ? ' selected' : '';

        html += `
            <div class="${cardClass}${selectedClass}" data-mcp-name="${settingsEscapeAttr(name)}"${hasTools ? ` onclick="scrollToExternalMCPTools(${settingsEscapeJsStringAttr(name)}, event)" title="${settingsEscapeAttr(cardClickTitle)}"` : ''}>
                <div class="external-mcp-item-header">
                    <div class="external-mcp-item-info">
                        <h4>${transportIcon} ${escapeHtml(name)}${server.tool_count !== undefined && server.tool_count > 0 ? `<span class="tool-count-badge" title="${escapeAttr(statusT('mcp.toolCount'))}">🔧 ${server.tool_count}</span>` : ''}</h4>
                        <span class="external-mcp-status ${statusClass}">${statusText}</span>
                    </div>
                    <div class="external-mcp-item-actions">
                        ${status === 'connected' || status === 'disconnected' || status === 'error' || status === 'disabled' ?
                            `<button class="btn-small" id="btn-toggle-${settingsEscapeAttr(name)}" onclick="toggleExternalMCP(${settingsEscapeJsStringAttr(name)}, ${settingsEscapeJsStringAttr(status)})" title="${settingsEscapeAttr(status === 'connected' ? statusT('mcp.stopConnection') : statusT('mcp.startConnection'))}">
                                ${status === 'connected' ? '⏸ ' + statusT('mcp.stop') : '▶ ' + statusT('mcp.start')}
                            </button>` :
                            status === 'connecting' ?
                            `<button class="btn-small" id="btn-toggle-${settingsEscapeAttr(name)}" disabled style="opacity: 0.6; cursor: not-allowed;">
                                ⏳ ${statusT('mcp.connecting')}
                            </button>` : ''}
                        <button class="btn-small" onclick="editExternalMCP(${settingsEscapeJsStringAttr(name)})" title="${settingsEscapeAttr(statusT('mcp.editConfig'))}" ${status === 'connecting' ? 'disabled' : ''}>✏️ ${statusT('common.edit')}</button>
                        <button class="btn-small btn-danger" onclick="deleteExternalMCP(${settingsEscapeJsStringAttr(name)})" title="${settingsEscapeAttr(statusT('mcp.deleteConfig'))}" ${status === 'connecting' ? 'disabled' : ''}>🗑 ${statusT('common.delete')}</button>
                    </div>
                </div>
                ${(status === 'error' || status === 'disconnected') && server.error ? `
                <div class="external-mcp-error" style="margin: 12px 0; padding: 12px; background: ${status === 'error' ? '#fee' : '#fff8e6'}; border-left: 3px solid ${status === 'error' ? '#f44' : '#e6a700'}; border-radius: 4px; color: ${status === 'error' ? '#c33' : '#8a6d00'}; font-size: 0.875rem;">
                    <strong>${status === 'error' ? '❌' : '⚠️'} ${statusT('mcp.connectionErrorLabel')}</strong>${escapeHtml(server.error)}
                </div>` : ''}
                <div class="external-mcp-item-details">
                    <div>
                        <strong>${statusT('mcp.transportMode')}</strong>
                        <span>${transportIcon} ${escapeHtml(transport.toUpperCase())}</span>
                    </div>
                    ${server.tool_count !== undefined && server.tool_count > 0 ? `
                    <div>
                        <strong>${statusT('mcp.toolCount')}</strong>
                        <span style="font-weight: 600; color: var(--accent-color);">${statusT('mcp.toolsCountValue', { count: server.tool_count })}</span>
                    </div>` : server.tool_count === 0 && status === 'connected' ? `
                    <div>
                        <strong>${statusT('mcp.toolCount')}</strong>
                        <span style="color: var(--text-muted);">${statusT('mcp.noTools')}</span>
                    </div>` : ''}
                    ${server.config.description ? `
                    <div>
                        <strong>${statusT('mcp.description')}</strong>
                        <span>${escapeHtml(server.config.description)}</span>
                    </div>` : ''}
                    ${server.config.timeout ? `
                    <div>
                        <strong>${statusT('mcp.timeout')}</strong>
                        <span>${server.config.timeout} ${statusT('mcp.secondsUnit')}</span>
                    </div>` : ''}
                    ${transport === 'stdio' && server.config.command ? `
                    <div>
                        <strong>${statusT('mcp.command')}</strong>
                        <span style="font-family: monospace; font-size: 0.8125rem;">${escapeHtml(server.config.command)}</span>
                    </div>` : ''}
                    ${transport === 'http' && server.config.url ? `
                    <div>
                        <strong>${statusT('mcp.urlLabel')}</strong>
                        <span style="font-family: monospace; font-size: 0.8125rem; word-break: break-all;">${escapeHtml(server.config.url)}</span>
                    </div>` : ''}
                </div>
            </div>
        `;
    }
    html += '</div>';
    list.innerHTML = html;
    updateExternalMcpCardSelection();
}

// 渲染外部MCP统计信息
function renderExternalMCPStats(stats) {
    const statsEl = document.getElementById('external-mcp-stats');
    if (!statsEl) return;
    
    const total = stats.total || 0;
    const enabled = stats.enabled || 0;
    const disabled = stats.disabled || 0;
    const connected = stats.connected || 0;
    
    const statsT = typeof window.t === 'function' ? window.t : (k) => k;
    statsEl.innerHTML = `
        <span title="${statsT('mcp.totalCount')}">📊 ${statsT('mcp.totalCount')}: <strong>${total}</strong></span>
        <span title="${statsT('mcp.enabledCount')}">✅ ${statsT('mcp.enabledCount')}: <strong>${enabled}</strong></span>
        <span title="${statsT('mcp.disabledCount')}">⏸ ${statsT('mcp.disabledCount')}: <strong>${disabled}</strong></span>
        <span title="${statsT('mcp.connectedCount')}">🔗 ${statsT('mcp.connectedCount')}: <strong>${connected}</strong></span>
    `;
}

// 显示添加外部MCP模态框
function showAddExternalMCPModal() {
    if (typeof requirePermission === 'function' && !requirePermission('mcp:write')) return;
    currentEditingMCPName = null;
    document.getElementById('external-mcp-modal-title').textContent = (typeof window.t === 'function' ? window.t('mcp.addExternalMCP') : '添加外部MCP');
    document.getElementById('external-mcp-json').value = '';
    document.getElementById('external-mcp-json-error').style.display = 'none';
    document.getElementById('external-mcp-json-error').textContent = '';
    document.getElementById('external-mcp-json').classList.remove('error');
    openAppModal('external-mcp-modal');
}

// 关闭外部MCP模态框
function closeExternalMCPModal() {
    closeAppModal('external-mcp-modal');
    currentEditingMCPName = null;
}

// 编辑外部MCP
async function editExternalMCP(name) {
    try {
        currentEditingMCPName = name;
        document.getElementById('external-mcp-modal-title').textContent = (typeof window.t === 'function' ? window.t('mcp.editExternalMCP') : '编辑外部MCP');
        document.getElementById('external-mcp-json').value = '';
        document.getElementById('external-mcp-json-error').style.display = 'none';
        document.getElementById('external-mcp-json-error').textContent = '';
        document.getElementById('external-mcp-json').classList.remove('error');
        openAppModal('external-mcp-modal', { focus: false });
        const response = await apiFetch(`/api/external-mcp/${encodeURIComponent(name)}`);
        if (!response.ok) {
            throw new Error(typeof window.t === 'function' ? window.t('mcp.getConfigFailed') : '获取外部MCP配置失败');
        }
        const server = await response.json();
        const config = { ...server.config };
        delete config.tool_count;
        delete config.external_mcp_enable;
        const configObj = {};
        configObj[name] = config;
        const jsonStr = JSON.stringify(configObj, null, 2);
        deferModalContent(() => {
            document.getElementById('external-mcp-json').value = jsonStr;
            document.getElementById('external-mcp-json')?.focus();
        });
    } catch (error) {
        closeExternalMCPModal();
        console.error('编辑外部MCP失败:', error);
        alert((typeof window.t === 'function' ? window.t('mcp.operationFailed') : '编辑失败') + ': ' + error.message);
    }
}

// 格式化JSON
function formatExternalMCPJSON() {
    const jsonTextarea = document.getElementById('external-mcp-json');
    const errorDiv = document.getElementById('external-mcp-json-error');
    
    try {
        const jsonStr = jsonTextarea.value.trim();
        if (!jsonStr) {
            errorDiv.textContent = (typeof window.t === 'function' ? window.t('mcp.jsonEmpty') : 'JSON不能为空');
            errorDiv.style.display = 'block';
            jsonTextarea.classList.add('error');
            return;
        }
        
        const parsed = JSON.parse(jsonStr);
        const formatted = JSON.stringify(parsed, null, 2);
        jsonTextarea.value = formatted;
        errorDiv.style.display = 'none';
        jsonTextarea.classList.remove('error');
    } catch (error) {
        errorDiv.textContent = (typeof window.t === 'function' ? window.t('mcp.jsonError') : 'JSON格式错误') + ': ' + error.message;
        errorDiv.style.display = 'block';
        jsonTextarea.classList.add('error');
    }
}

// 加载示例
function loadExternalMCPExample() {
    const example = {
        "my-stdio-server": {
            command: "python3",
            args: [
                "${HOME}/mcp-servers/main.py",
                "--port",
                "${MCP_PORT:-3000}"
            ],
            env: {
                "API_KEY": "${API_KEY}",
                "LOG_LEVEL": "${LOG_LEVEL:-INFO}"
            },
            timeout: 300
        },
        "my-http-server": {
            type: "http",
            url: "https://mcp.example.com/mcp",
            headers: {
                "Authorization": "Bearer ${MCP_TOKEN}"
            }
        },
        "my-sse-server": {
            type: "sse",
            url: "http://127.0.0.1:8081/mcp/sse"
        }
    };
    
    document.getElementById('external-mcp-json').value = JSON.stringify(example, null, 2);
    document.getElementById('external-mcp-json-error').style.display = 'none';
    document.getElementById('external-mcp-json').classList.remove('error');
}

// 保存外部MCP
async function saveExternalMCP() {
    if (typeof requirePermission === 'function' && !requirePermission('mcp:write')) return;
    const jsonTextarea = document.getElementById('external-mcp-json');
    const jsonStr = jsonTextarea.value.trim();
    const errorDiv = document.getElementById('external-mcp-json-error');
    
    if (!jsonStr) {
        errorDiv.textContent = (typeof window.t === 'function' ? window.t('mcp.jsonEmpty') : 'JSON不能为空');
        errorDiv.style.display = 'block';
        jsonTextarea.classList.add('error');
        jsonTextarea.focus();
        return;
    }
    
    let configObj;
    try {
        configObj = JSON.parse(jsonStr);
    } catch (error) {
        errorDiv.textContent = (typeof window.t === 'function' ? window.t('mcp.jsonError') : 'JSON格式错误') + ': ' + error.message;
        errorDiv.style.display = 'block';
        jsonTextarea.classList.add('error');
        jsonTextarea.focus();
        return;
    }
    
    const t = (typeof window.t === 'function' ? window.t : function (k, opts) { return k; });
    // 验证必须是对象格式
    if (typeof configObj !== 'object' || Array.isArray(configObj) || configObj === null) {
        errorDiv.textContent = t('mcp.configMustBeObject');
        errorDiv.style.display = 'block';
        jsonTextarea.classList.add('error');
        return;
    }
    
    // 获取所有配置名称
    const names = Object.keys(configObj);
    if (names.length === 0) {
        errorDiv.textContent = t('mcp.configNeedOne');
        errorDiv.style.display = 'block';
        jsonTextarea.classList.add('error');
        return;
    }
    
    // 验证每个配置
    for (const name of names) {
        if (!name || name.trim() === '') {
            errorDiv.textContent = t('mcp.configNameEmpty');
            errorDiv.style.display = 'block';
            jsonTextarea.classList.add('error');
            return;
        }
        
        const config = configObj[name];
        if (typeof config !== 'object' || Array.isArray(config) || config === null) {
            errorDiv.textContent = t('mcp.configMustBeObj', { name: name });
            errorDiv.style.display = 'block';
            jsonTextarea.classList.add('error');
            return;
        }
        
        // 移除 external_mcp_enable 字段（由按钮控制，但保留 enabled/disabled 用于向后兼容）
        delete config.external_mcp_enable;
        
        // 验证配置内容（同时支持官方 type 字段和旧版 transport 字段）
        const transport = config.type || config.transport || (config.command ? 'stdio' : config.url ? 'http' : '');
        if (!transport) {
            errorDiv.textContent = t('mcp.configNeedCommand', { name: name });
            errorDiv.style.display = 'block';
            jsonTextarea.classList.add('error');
            return;
        }
        
        if (transport === 'stdio' && !config.command) {
            errorDiv.textContent = t('mcp.configStdioNeedCommand', { name: name });
            errorDiv.style.display = 'block';
            jsonTextarea.classList.add('error');
            return;
        }
        
        if (transport === 'http' && !config.url) {
            errorDiv.textContent = t('mcp.configHttpNeedUrl', { name: name });
            errorDiv.style.display = 'block';
            jsonTextarea.classList.add('error');
            return;
        }
        
        if (transport === 'sse' && !config.url) {
            errorDiv.textContent = t('mcp.configSseNeedUrl', { name: name });
            errorDiv.style.display = 'block';
            jsonTextarea.classList.add('error');
            return;
        }
    }
    
    // 清除错误提示
    errorDiv.style.display = 'none';
    jsonTextarea.classList.remove('error');
    
    try {
        // 如果是编辑模式，只更新当前编辑的配置
        if (currentEditingMCPName) {
            if (!configObj[currentEditingMCPName]) {
                errorDiv.textContent = (typeof window.t === 'function' ? window.t('mcp.configEditMustContainName', { name: currentEditingMCPName }) : '配置错误: 编辑模式下，JSON必须包含配置名称 "' + currentEditingMCPName + '"');
                errorDiv.style.display = 'block';
                jsonTextarea.classList.add('error');
                return;
            }
            
            const response = await apiFetch(`/api/external-mcp/${encodeURIComponent(currentEditingMCPName)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ config: configObj[currentEditingMCPName] }),
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || '保存失败');
            }
        } else {
            // 添加模式：保存所有配置
            for (const name of names) {
                const config = configObj[name];
                const response = await apiFetch(`/api/external-mcp/${encodeURIComponent(name)}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ config }),
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(`保存 "${name}" 失败: ${error.error || '未知错误'}`);
                }
            }
        }
        
        closeExternalMCPModal();
        await loadExternalMCPs();
        if (typeof window !== 'undefined' && typeof window.refreshMentionTools === 'function') {
            window.refreshMentionTools();
        }
        // 轮询几次以拉取后端异步更新的工具数量（无固定延迟，拿到即停）
        pollExternalMCPToolCount(null, 5);
        alert(typeof window.t === 'function' ? window.t('mcp.saveSuccess') : '保存成功');
    } catch (error) {
        console.error('保存外部MCP失败:', error);
        errorDiv.textContent = (typeof window.t === 'function' ? window.t('mcp.operationFailed') : '保存失败') + ': ' + error.message;
        errorDiv.style.display = 'block';
        jsonTextarea.classList.add('error');
    }
}

// 删除外部MCP
async function deleteExternalMCP(name) {
    if (!confirm((typeof window.t === 'function' ? window.t('mcp.deleteExternalConfirm', { name: name }) : `确定要删除外部MCP "${name}" 吗？`))) {
        return;
    }
    
    try {
        const response = await apiFetch(`/api/external-mcp/${encodeURIComponent(name)}`, {
            method: 'DELETE',
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '删除失败');
        }
        
        await loadExternalMCPs();
        // 刷新对话界面的工具列表，移除已删除的MCP工具
        if (typeof window !== 'undefined' && typeof window.refreshMentionTools === 'function') {
            window.refreshMentionTools();
        }
        alert(typeof window.t === 'function' ? window.t('mcp.deleteSuccess') : '删除成功');
    } catch (error) {
        console.error('删除外部MCP失败:', error);
        alert((typeof window.t === 'function' ? window.t('mcp.operationFailed') : '删除失败') + ': ' + error.message);
    }
}

// 切换外部MCP启停
async function toggleExternalMCP(name, currentStatus) {
    const action = currentStatus === 'connected' ? 'stop' : 'start';
    const buttonId = `btn-toggle-${name}`;
    const button = document.getElementById(buttonId);
    
    // 如果是启动操作，显示加载状态
    if (action === 'start' && button) {
        button.disabled = true;
        button.style.opacity = '0.6';
        button.style.cursor = 'not-allowed';
        button.innerHTML = '⏳ 连接中...';
    }
    
    try {
        const response = await apiFetch(`/api/external-mcp/${encodeURIComponent(name)}/${action}`, {
            method: 'POST',
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '操作失败');
        }
        
        const result = await response.json();
        
        // 如果是启动操作，先立即检查一次状态
        if (action === 'start') {
            // 立即检查一次状态（可能已经连接）
            try {
                const statusResponse = await apiFetch(`/api/external-mcp/${encodeURIComponent(name)}`);
                if (statusResponse.ok) {
                    const statusData = await statusResponse.json();
                    const status = statusData.status || 'disconnected';
                    
                    if (status === 'connected') {
                        await loadExternalMCPs();
                        if (typeof window !== 'undefined' && typeof window.refreshMentionTools === 'function') {
                            window.refreshMentionTools();
                        }
                        // 轮询直到该 MCP 工具数量已更新（每秒拉一次，无固定延迟）
                        pollExternalMCPToolCount(name, 10);
                        await reloadMcpToolsAfterExternalChange(true);
                        return;
                    }
                }
            } catch (error) {
                console.error('检查状态失败:', error);
            }
            
            // 如果还未连接，开始轮询
            await pollExternalMCPStatus(name, 30); // 最多轮询30次（约30秒）
        } else {
            // 停止操作，直接刷新
            await loadExternalMCPs();
            await reloadMcpToolsAfterExternalChange(false);
            // 刷新对话界面的工具列表
            if (typeof window !== 'undefined' && typeof window.refreshMentionTools === 'function') {
                window.refreshMentionTools();
            }
        }
    } catch (error) {
        console.error('切换外部MCP状态失败:', error);
        alert((typeof window.t === 'function' ? window.t('mcp.operationFailed') : '操作失败') + ': ' + error.message);
        
        // 恢复按钮状态
        if (button) {
            button.disabled = false;
            button.style.opacity = '1';
            button.style.cursor = 'pointer';
            button.innerHTML = '▶ 启动';
        }
        
        // 刷新状态
        await loadExternalMCPs();
        // 刷新对话界面的工具列表
        if (typeof window !== 'undefined' && typeof window.refreshMentionTools === 'function') {
            window.refreshMentionTools();
        }
    }
}

// 轮询外部MCP状态
async function pollExternalMCPStatus(name, maxAttempts = 30) {
    let attempts = 0;
    const pollInterval = 1000; // 1秒轮询一次
    
    while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        
        try {
            const response = await apiFetch(`/api/external-mcp/${encodeURIComponent(name)}`);
            if (response.ok) {
                const data = await response.json();
                const status = data.status || 'disconnected';
                
                // 更新按钮状态
                const buttonId = `btn-toggle-${name}`;
                const button = document.getElementById(buttonId);
                
                if (status === 'connected') {
                    await loadExternalMCPs();
                    if (typeof window !== 'undefined' && typeof window.refreshMentionTools === 'function') {
                        window.refreshMentionTools();
                    }
                    // 轮询直到该 MCP 工具数量已更新（每秒拉一次，无固定延迟）
                    pollExternalMCPToolCount(name, 10);
                    await reloadMcpToolsAfterExternalChange(true);
                    return;
                } else if (status === 'error' || status === 'disconnected') {
                    // 连接失败，刷新列表并显示错误
                    await loadExternalMCPs();
                    // 刷新对话界面的工具列表
                    if (typeof window !== 'undefined' && typeof window.refreshMentionTools === 'function') {
                        window.refreshMentionTools();
                    }
                    if (status === 'error') {
                        alert(typeof window.t === 'function' ? window.t('mcp.connectionFailedCheck') : '连接失败，请检查配置和网络连接');
                    }
                    return;
                } else if (status === 'connecting') {
                    // 仍在连接中，继续轮询
                    attempts++;
                    continue;
                }
            }
        } catch (error) {
            console.error('轮询状态失败:', error);
        }
        
        attempts++;
    }
    
    // 超时，刷新列表
    await loadExternalMCPs();
    // 刷新对话界面的工具列表
    if (typeof window !== 'undefined' && typeof window.refreshMentionTools === 'function') {
        window.refreshMentionTools();
    }
    alert(typeof window.t === 'function' ? window.t('mcp.connectionTimeout') : '连接超时，请检查配置和网络连接');
}

// 在打开设置时加载外部MCP列表
const originalOpenSettings = openSettings;
openSettings = async function() {
    await originalOpenSettings();
    await loadExternalMCPs();
};

// 语言切换后重新渲染 MCP 管理页中由 JS 写入的区块（innerHTML 不会随 data-i18n 自动更新）
document.addEventListener('languagechange', function () {
    try {
        const settingsPage = document.getElementById('page-settings');
        if (settingsPage) {
            initSettingsCustomSelects(settingsPage);
            refreshSettingsCustomSelects();
        }
        const mcpPage = document.getElementById('page-mcp-management');
        if (mcpPage && mcpPage.classList.contains('active')) {
            if (typeof loadExternalMCPs === 'function') {
                loadExternalMCPs({ forceRender: true }).catch(function () { /* ignore */ });
            }
            if (typeof updateToolsStats === 'function') {
                updateToolsStats().catch(function () { /* ignore */ });
            }
        }
    } catch (e) {
        console.warn('languagechange MCP refresh failed', e);
    }
});

