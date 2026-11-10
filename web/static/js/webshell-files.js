/**
 * webshell-files.js —— WebShell 文件管理
 *
 * 从 webshell.js 拆出的独立功能域（原 4228 行至文件末尾）：
 * 目录列举与解析（Linux ls / Windows dir）、列表渲染与过滤、目录树、
 * 上传下载、重命名删除、读取编辑写入、批量操作。
 *
 * 与 webshell.js 同处全局作用域，共享其 wsT / escapeHtml / 连接缓存等；
 * 加载顺序置于 webshell.js 之后。
 */
// ---------- 文件管理 ----------
function webshellFileListDir(conn, path) {
    const listEl = document.getElementById('webshell-file-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="webshell-loading">' + wsT('common.refresh') + '...</div>';

    if (typeof apiFetch === 'undefined') {
        listEl.innerHTML = '<div class="webshell-file-error">apiFetch 未定义</div>';
        return;
    }

    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: webshellFileRequestBody(conn, { action: 'list', path: path })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            applyWebshellDetectedOS(conn, data);
            if (!data.ok && data.error) {
                listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(data.error) + '</div><pre class="webshell-file-raw">' + escapeHtml(data.output || '') + '</pre>';
                return;
            }
            var normalizedPath = normalizeWebshellPath(path);
            var inferredPath = inferPathFromWindowsDirOutput(data.output || '');
            var displayPath = inferredPath || normalizedPath;
            listEl.dataset.currentPath = displayPath;
            listEl.dataset.rawOutput = data.output || '';
            var pathInput = document.getElementById('webshell-file-path');
            if (pathInput) pathInput.value = displayPath;
            renderFileList(listEl, displayPath, data.output || '', conn);
        })
        .catch(function (err) {
            listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : wsT('webshell.execError')) + '</div>';
        });
}

function normalizeLsMtime(month, day, timeOrYear) {
    if (!month || !day || !timeOrYear) return '';
    var token = String(timeOrYear).trim();
    if (/^\d{4}$/.test(token)) return token + ' ' + month + ' ' + day;
    var now = new Date();
    var year = now.getFullYear();
    if (/^\d{1,2}:\d{2}$/.test(token)) {
        var monthMap = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
        var m = monthMap[month];
        var d = parseInt(day, 10);
        if (m != null && !isNaN(d)) {
            var inferred = new Date(year, m, d);
            if (inferred.getTime() > now.getTime()) year = year - 1;
        }
        return year + ' ' + month + ' ' + day + ' ' + token;
    }
    return month + ' ' + day + ' ' + token;
}

function modeToType(mode) {
    if (!mode || !mode.length) return '';
    var c = mode.charAt(0);
    if (c === 'd') return 'dir';
    if (c === '-') return 'file';
    if (c === 'l') return 'link';
    if (c === 'c') return 'char';
    if (c === 'b') return 'block';
    if (c === 's') return 'socket';
    if (c === 'p') return 'pipe';
    return c;
}

function parseWindowsDirEntry(line) {
    var m = String(line || '').match(/^(\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\s+(\d{1,2}:\d{2})(?:\s*(AM|PM))?\s+(<[^>]+>|[\d,]+)\s+(.+?)\s*$/i);
    if (!m) return null;
    var kind = (m[4] || '').trim();
    var name = (m[5] || '').trim();
    if (!name || name === '.' || name === '..') return null;
    var isDir = /^<(dir|junction|symlinkd)>$/i.test(kind);
    var size = isDir ? '' : kind.replace(/,/g, '');
    var mtime = (m[1] + ' ' + m[2] + (m[3] ? (' ' + m[3].toUpperCase()) : '')).trim();
    return {
        name: name,
        isDir: isDir,
        size: size,
        mtime: mtime,
        mode: isDir ? 'd' : '-',
        owner: '',
        group: '',
        type: isDir ? 'dir' : 'file'
    };
}

function parseWebshellListItems(rawOutput) {
    var lines = (rawOutput || '').split(/\n/).filter(function (l) { return l.trim(); });
    var items = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var trimmedLine = String(line || '').trim();
        // `ls -la` 首行常见 "total 12"（中文环境为 "总计 12"），不是文件项。
        if (/^(total|总计)\s+\d+$/i.test(trimmedLine)) continue;
        // `dir` 头尾信息（中英文）与 shell 提示符，不是目录项。
        if (/^(驱动器|卷的序列号是|volume in drive|volume serial number is|directory of)/i.test(trimmedLine)) continue;
        if (/^[A-Za-z]:\\.*\s+的目录$/i.test(trimmedLine)) continue;
        if (/^\d+\s+(个文件|file\(s\))\s+[\d,]+\s+(字节|bytes?)$/i.test(trimmedLine)) continue;
        if (/^\d+\s+(个目录|dir\(s\))\s+[\d,]+\s+(可用字节|bytes free)$/i.test(trimmedLine)) continue;
        if (/^[^>\n]*>\s*dir(?:\s|$)/i.test(trimmedLine)) continue;
        var name = '';
        var isDir = false;
        var size = '';
        var mode = '';
        var mtime = '';
        var owner = '';
        var group = '';
        var type = '';
        var mLs = line.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\S+)\s+(.+)$/);
        if (mLs) {
            mode = mLs[1];
            owner = mLs[3];
            group = mLs[4];
            size = mLs[5];
            mtime = normalizeLsMtime(mLs[6], mLs[7], mLs[8]);
            name = (mLs[9] || '').trim();
            isDir = mode && mode.startsWith('d');
            type = modeToType(mode);
        } else {
            var winItem = parseWindowsDirEntry(line);
            if (winItem) {
                items.push({
                    name: winItem.name,
                    isDir: winItem.isDir,
                    line: line,
                    size: winItem.size,
                    mode: winItem.mode,
                    mtime: winItem.mtime,
                    owner: winItem.owner,
                    group: winItem.group,
                    type: winItem.type
                });
                continue;
            }
            // 仅兜底解析 Unix 权限格式，避免把 `dir` 统计行误识别为文件。
            if (/^[bcdlps-][rwxStTs-]{9}[+.@]?\s/.test(line)) {
                var parts = line.trim().split(/\s+/);
                if (parts.length >= 9) {
                    name = parts.slice(8).join(' ').trim();
                } else {
                    name = parts.length ? parts[parts.length - 1].trim() : line.trim();
                }
                if (name === '.' || name === '..') continue;
                isDir = line.startsWith('d');
                parts = line.split(/\s+/);
                if (parts.length >= 5) { mode = parts[0]; size = parts[4]; }
                if (parts.length >= 4) { owner = parts[2] || ''; group = parts[3] || ''; }
                if (parts.length >= 8 && /^[A-Za-z]{3}$/.test(parts[5])) mtime = normalizeLsMtime(parts[5], parts[6], parts[7]);
                type = modeToType(mode);
            } else {
                continue;
            }
        }
        if (name === '.' || name === '..') continue;
        items.push({ name: name, isDir: isDir, line: line, size: size, mode: mode, mtime: mtime, owner: owner, group: group, type: type });
    }
    return items;
}

function fetchWebshellDirectoryItems(conn, path) {
    if (!conn || typeof apiFetch === 'undefined') return Promise.resolve([]);
    return apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: webshellFileRequestBody(conn, { action: 'list', path: path })
    }).then(function (r) { return r.json(); }).then(function (data) {
        applyWebshellDetectedOS(conn, data);
        if (!data || data.error || !data.ok) return [];
        return parseWebshellListItems(data.output || '');
    }).catch(function () {
        return [];
    });
}

function renderFileList(listEl, currentPath, rawOutput, conn, nameFilter) {
    currentPath = normalizeWebshellPath(currentPath);
    var items = parseWebshellListItems(rawOutput);
    var selectedPath = getWebshellSelectedFile(conn || webshellCurrentConn);
    if (nameFilter && nameFilter.trim()) {
        var f = nameFilter.trim().toLowerCase();
        items = items.filter(function (item) { return item.name.toLowerCase().indexOf(f) !== -1; });
    }
    // 面包屑
    var breadcrumbEl = document.getElementById('webshell-file-breadcrumb');
    if (breadcrumbEl) {
        var absolute = currentPath.startsWith('/');
        var parts = (currentPath === '.' || currentPath === '/' || currentPath === '') ? [] : currentPath.replace(/^\//, '').split('/');
        breadcrumbEl.innerHTML = '<a href="#" class="webshell-breadcrumb-item" data-path="' + (absolute ? '/' : '.') + '">' + (wsT('webshell.breadcrumbHome') || '根') + '</a>' +
            parts.map(function (p, idx) {
                var path = (absolute ? '/' : '') + parts.slice(0, idx + 1).join('/');
                return ' / <a href="#" class="webshell-breadcrumb-item" data-path="' + escapeHtml(path) + '">' + escapeHtml(p) + '</a>';
            }).join('');
    }
    renderDirectoryTree(currentPath, items, conn);
    var html = '';
    if (items.length === 0) {
        // 目录为空/过滤后为空时，给出明确空状态，避免 tbody 留白导致“整块抽象大白屏”
        if (rawOutput.trim() && !nameFilter) {
            html = '<pre class="webshell-file-raw">' + escapeHtml(rawOutput) + '</pre>';
        } else {
            html = '<table class="webshell-file-table"><thead><tr><th class="webshell-col-check"><input type="checkbox" id="webshell-file-select-all" title="' + (wsT('webshell.selectAll') || '全选') + '" /></th><th>' + wsT('webshell.filePath') + '</th><th class="webshell-col-size">大小</th><th class="webshell-col-mtime">' + (wsT('webshell.colModifiedAt') || '修改时间') + '</th><th class="webshell-col-owner">' + (wsT('webshell.colOwner') || '所有者') + '</th><th class="webshell-col-perms">' + (wsT('webshell.colPerms') || '权限') + '</th><th class="webshell-col-actions"></th></tr></thead><tbody>' +
                '<tr><td colspan="7" class="webshell-file-empty-state">' + (wsT('common.noData') || '暂无文件') + '</td></tr>' +
                '</tbody></table>';
        }
    } else {
        html = '<table class="webshell-file-table"><thead><tr><th class="webshell-col-check"><input type="checkbox" id="webshell-file-select-all" title="' + (wsT('webshell.selectAll') || '全选') + '" /></th><th>' + wsT('webshell.filePath') + '</th><th class="webshell-col-size">大小</th><th class="webshell-col-mtime">' + (wsT('webshell.colModifiedAt') || '修改时间') + '</th><th class="webshell-col-owner">' + (wsT('webshell.colOwner') || '所有者') + '</th><th class="webshell-col-perms">' + (wsT('webshell.colPerms') || '权限') + '</th><th class="webshell-col-actions"></th></tr></thead><tbody>';
        if (currentPath !== '.' && currentPath !== '') {
            html += '<tr><td></td><td><a href="#" class="webshell-file-link" data-path="' + escapeHtml(getWebshellParentPath(currentPath)) + '" data-isdir="1">..</a></td><td></td><td></td><td></td><td></td><td></td></tr>';
        }
        items.forEach(function (item) {
            var pathNext = currentPath === '.' ? item.name : currentPath + '/' + item.name;
            var pathNextNorm = normalizeWebshellPath(pathNext);
            var nameClass = item.isDir ? 'is-dir' : 'is-file';
            html += '<tr class="' + (!item.isDir && selectedPath === pathNextNorm ? 'webshell-file-row-selected' : '') + '"><td class="webshell-col-check">';
            if (!item.isDir) html += '<input type="checkbox" class="webshell-file-cb" data-path="' + escapeHtml(pathNext) + '" />';
            html += '</td><td class="webshell-col-name"><a href="#" class="webshell-file-link ' + nameClass + '" title="' + escapeHtml(item.name) + '" data-path="' + escapeHtml(pathNext) + '" data-isdir="' + (item.isDir ? '1' : '0') + '">' + escapeHtml(item.name) + (item.isDir ? '/' : '') + '</a></td>';
            html += '<td class="webshell-col-size">' + escapeHtml(item.size) + '</td>';
            html += '<td class="webshell-col-mtime">' + escapeHtml(item.mtime || '') + '</td>';
            html += '<td class="webshell-col-owner">' + escapeHtml(item.owner || '') + '</td>';
            html += '<td class="webshell-col-perms">' + escapeHtml(item.mode || '') + '</td>';
            html += '<td class="webshell-col-actions">';
            if (item.isDir) {
                html += '<button type="button" class="btn-ghost btn-sm webshell-file-rename" data-path="' + escapeHtml(pathNext) + '" data-name="' + escapeHtml(item.name) + '">' + (wsT('webshell.rename') || '重命名') + '</button>';
            } else {
                var actionsLabel = wsT('common.actions') || '操作';
                html += '<details class="webshell-row-actions"><summary class="btn-ghost btn-sm webshell-row-actions-btn" title="' + actionsLabel + '">' + actionsLabel + '</summary>' +
                    '<div class="webshell-row-actions-menu">' +
                    '<button type="button" class="btn-ghost btn-sm webshell-file-read" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.readFile') + '</button>' +
                    '<button type="button" class="btn-ghost btn-sm webshell-file-download" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.downloadFile') + '</button>' +
                    '<button type="button" class="btn-ghost btn-sm webshell-file-edit" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.editFile') + '</button>' +
                    '<button type="button" class="btn-ghost btn-sm webshell-file-rename" data-path="' + escapeHtml(pathNext) + '" data-name="' + escapeHtml(item.name) + '">' + (wsT('webshell.rename') || '重命名') + '</button>' +
                    '<button type="button" class="btn-ghost btn-sm webshell-file-del" data-path="' + escapeHtml(pathNext) + '">' + wsT('webshell.deleteFile') + '</button>' +
                    '</div></details>';
            }
            html += '</td></tr>';
        });
        html += '</tbody></table>';
    }
    listEl.innerHTML = html;

    listEl.querySelectorAll('.webshell-file-link').forEach(function (a) {
        a.addEventListener('click', function (e) {
            e.preventDefault();
            const path = a.getAttribute('data-path');
            const isDir = a.getAttribute('data-isdir') === '1';
            const pathInput = document.getElementById('webshell-file-path');
            if (isDir) {
                setWebshellSelectedFile(webshellCurrentConn, '');
                if (pathInput) pathInput.value = path;
                webshellFileListDir(webshellCurrentConn, path);
            } else {
                // 打开文件时保留当前“浏览目录”上下文，避免返回时落到单文件视图
                setWebshellSelectedFile(webshellCurrentConn, path);
                renderDirectoryTree(currentPath, items, conn || webshellCurrentConn);
                webshellFileRead(webshellCurrentConn, path, listEl, currentPath);
            }
        });
    });
    listEl.querySelectorAll('.webshell-file-read').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            var filePath = btn.getAttribute('data-path');
            setWebshellSelectedFile(webshellCurrentConn, filePath);
            renderDirectoryTree(currentPath, items, conn || webshellCurrentConn);
            webshellFileRead(webshellCurrentConn, filePath, listEl, currentPath);
        });
    });
    listEl.querySelectorAll('.webshell-file-download').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            webshellFileDownload(webshellCurrentConn, btn.getAttribute('data-path'));
        });
    });
    listEl.querySelectorAll('.webshell-file-edit').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            webshellFileEdit(webshellCurrentConn, btn.getAttribute('data-path'), listEl);
        });
    });
    listEl.querySelectorAll('.webshell-file-del').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (!confirm(wsT('webshell.deleteConfirm'))) return;
            webshellFileDelete(webshellCurrentConn, btn.getAttribute('data-path'), function () {
                webshellFileListDir(webshellCurrentConn, document.getElementById('webshell-file-path').value.trim() || '.');
            });
        });
    });
    listEl.querySelectorAll('.webshell-file-rename').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            webshellFileRename(webshellCurrentConn, btn.getAttribute('data-path'), btn.getAttribute('data-name'), listEl);
        });
    });
    var selectAll = document.getElementById('webshell-file-select-all');
    if (selectAll) {
        selectAll.addEventListener('change', function () {
            listEl.querySelectorAll('.webshell-file-cb').forEach(function (cb) { cb.checked = selectAll.checked; });
        });
    }
    if (breadcrumbEl) {
        breadcrumbEl.querySelectorAll('.webshell-breadcrumb-item').forEach(function (a) {
            a.addEventListener('click', function (e) {
                e.preventDefault();
                var p = a.getAttribute('data-path');
                var pathInput = document.getElementById('webshell-file-path');
                if (pathInput) pathInput.value = p;
                webshellFileListDir(webshellCurrentConn, p);
            });
        });
    }
}

function renderDirectoryTree(currentPath, items, conn) {
    var treeEl = document.getElementById('webshell-dir-tree');
    if (!treeEl) return;
    var state = getWebshellTreeState(conn || webshellCurrentConn);
    var curr = normalizeWebshellPath(currentPath);
    var dirs = (items || []).filter(function (item) { return item && item.isDir; });
    if (!state) {
        treeEl.innerHTML = '<div class="webshell-empty">暂无目录</div>';
        return;
    }
    var tree = state.tree;
    var expanded = state.expanded;
    var loaded = state.loaded;
    var selectedPath = getWebshellSelectedFile(conn || webshellCurrentConn);
    var rootPath = curr.startsWith('/') ? '/' : '.';
    if (!tree[rootPath]) tree[rootPath] = [];
    if (expanded[rootPath] !== false) expanded[rootPath] = true;

    // 把当前目录的子项（目录+文件）同步到树缓存
    var childNodes = (items || []).map(function (item) {
        var childPath = curr === '.' ? normalizeWebshellPath(item.name) : normalizeWebshellPath(curr + '/' + item.name);
        return {
            path: childPath,
            name: item.name,
            isDir: !!item.isDir
        };
    }).filter(function (n) { return !!n.path; });
    childNodes.sort(function (a, b) {
        // 目录优先，再按名称排序
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '');
    });
    tree[curr] = childNodes;
    loaded[curr] = true;
    childNodes.forEach(function (node) {
        if (node.isDir && !tree[node.path]) tree[node.path] = [];
    });

    // 仅对“真实路径”补祖先链；相对上探链（../..）不构建，避免出现假层级。
    var isRelativeUpChain = /^(?:\.\.\/)*\.\.$/.test(curr);
    var parts = (curr === '.' || curr === '/') ? [] : curr.replace(/^\//, '').split('/');
    var parentPath = rootPath;
    if (!isRelativeUpChain) {
        for (var i = 0; i < parts.length; i++) {
            var nextPath = parentPath === '.' ? parts[i] : normalizeWebshellPath(parentPath + '/' + parts[i]);
            if (!tree[parentPath]) tree[parentPath] = [];
            var parentChildren = tree[parentPath];
            var hasAncestorNode = parentChildren.some(function (n) { return n && n.path === nextPath; });
            if (!hasAncestorNode) {
                parentChildren.push({ path: nextPath, name: parts[i], isDir: true });
                parentChildren.sort(function (a, b) {
                    if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
                    return (a.name || '').localeCompare(b.name || '');
                });
            }
            if (!tree[nextPath]) tree[nextPath] = [];
            expanded[parentPath] = true;
            parentPath = nextPath;
        }
    }
    if (expanded[curr] == null) expanded[curr] = true;

    function renderNode(node, depth) {
        var path = node.path;
        var isDir = !!node.isDir;
        var children = isDir ? (tree[path] || []).slice() : [];
        var hasLoadedChildren = isDir ? (loaded[path] === true) : true;
        var canExpand = isDir && (path === rootPath || !hasLoadedChildren || children.length > 0);
        var hasChildren = children.length > 0;
        var isExpanded = isDir ? (expanded[path] === true) : false;
        var isActive = path === curr;
        var isSelectedFile = !isDir && path === selectedPath;
        var name = node.name;
        var icon = isDir ? (path === rootPath ? '🗂' : '📁') : '📄';
        var nodeHtml =
            '<div class="webshell-tree-node" data-depth="' + depth + '">' +
            '<div class="webshell-tree-row' + (isActive ? ' active' : '') + (isSelectedFile ? ' selected-file' : '') + '">' +
            '<button type="button" class="webshell-tree-toggle' + (canExpand ? '' : ' empty') + '" data-path="' + escapeHtml(path) + '">' + (canExpand ? (isExpanded ? '▾' : '▸') : '·') + '</button>' +
            '<button type="button" class="webshell-dir-item' + (isDir ? ' is-dir' : ' is-file') + '" title="' + escapeHtml(name) + '" data-path="' + escapeHtml(path) + '" data-isdir="' + (isDir ? '1' : '0') + '"><span class="webshell-tree-icon">' + icon + '</span><span class="webshell-tree-name">' + escapeHtml(name) + '</span></button>' +
            '</div>';
        if (isDir && hasChildren && isExpanded) {
            nodeHtml += '<div class="webshell-tree-children">';
            for (var j = 0; j < children.length; j++) {
                nodeHtml += renderNode(children[j], depth + 1);
            }
            nodeHtml += '</div>';
        }
        nodeHtml += '</div>';
        return nodeHtml;
    }

    treeEl.innerHTML = '<div class="webshell-tree-root">' + renderNode({ path: rootPath, name: '/', isDir: true }, 0) + '</div>';
    treeEl.querySelectorAll('.webshell-tree-toggle').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var p = normalizeWebshellPath(btn.getAttribute('data-path') || '.');
            if (expanded[p] === true) {
                expanded[p] = false;
                renderDirectoryTree(curr, items, conn || webshellCurrentConn);
                return;
            }
            if (loaded[p] === true) {
                expanded[p] = true;
                renderDirectoryTree(curr, items, conn || webshellCurrentConn);
                return;
            }
            fetchWebshellDirectoryItems(conn || webshellCurrentConn, p).then(function (subItems) {
                var nextChildren = (subItems || []).map(function (it) {
                    return {
                        path: p === '.' ? normalizeWebshellPath(it.name) : normalizeWebshellPath(p + '/' + it.name),
                        name: it.name,
                        isDir: !!it.isDir
                    };
                }).filter(function (n) { return !!n.path; }).sort(function (a, b) {
                    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                    return (a.name || '').localeCompare(b.name || '');
                });
                tree[p] = nextChildren;
                nextChildren.forEach(function (childNode) {
                    if (childNode.isDir) {
                        if (!tree[childNode.path]) tree[childNode.path] = [];
                        if (loaded[childNode.path] == null) loaded[childNode.path] = false;
                    }
                });
                loaded[p] = true;
                expanded[p] = true;
                renderDirectoryTree(curr, items, conn || webshellCurrentConn);
            });
        });
    });
    treeEl.querySelectorAll('.webshell-dir-item').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var p = normalizeWebshellPath(btn.getAttribute('data-path') || '.');
            var isDir = btn.getAttribute('data-isdir') === '1';
            var pathInput = document.getElementById('webshell-file-path');
            if (isDir) {
                setWebshellSelectedFile(webshellCurrentConn, '');
                if (pathInput) pathInput.value = p;
                webshellFileListDir(webshellCurrentConn, p);
                return;
            }
            var listEl = document.getElementById('webshell-file-list');
            var browsePath = p.replace(/\/[^/]+$/, '') || '.';
            setWebshellSelectedFile(webshellCurrentConn, p);
            renderDirectoryTree(curr, items, conn || webshellCurrentConn);
            if (listEl) webshellFileRead(webshellCurrentConn, p, listEl, browsePath);
        });
    });
}

function webshellFileListApplyFilter() {
    var listEl = document.getElementById('webshell-file-list');
    var path = listEl && listEl.dataset.currentPath ? listEl.dataset.currentPath : (document.getElementById('webshell-file-path') && document.getElementById('webshell-file-path').value.trim()) || '.';
    var raw = listEl && listEl.dataset.rawOutput ? listEl.dataset.rawOutput : '';
    var filterInput = document.getElementById('webshell-file-filter');
    var filter = filterInput ? filterInput.value : '';
    if (!listEl || !raw) return;
    renderFileList(listEl, path, raw, webshellCurrentConn, filter);
}

function webshellFileMkdir(conn, pathInput) {
    if (!conn || typeof apiFetch === 'undefined') return;
    var base = (pathInput && pathInput.value.trim()) || '.';
    var name = prompt(wsT('webshell.newDir') || '新建目录', 'newdir');
    if (name == null || !name.trim()) return;
    var path = base === '.' ? name.trim() : base + '/' + name.trim();
    apiFetch('/api/webshell/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: webshellFileRequestBody(conn, { action: 'mkdir', path: path }) })
        .then(function (r) { return r.json(); })
        .then(function () { webshellFileListDir(conn, base); })
        .catch(function () { webshellFileListDir(conn, base); });
}

function webshellFileNewFile(conn, pathInput) {
    if (!conn || typeof apiFetch === 'undefined') return;
    var base = (pathInput && pathInput.value.trim()) || '.';
    var name = prompt(wsT('webshell.newFile') || '新建文件', 'newfile.txt');
    if (name == null || !name.trim()) return;
    var path = base === '.' ? name.trim() : base + '/' + name.trim();
    var content = prompt('初始内容（可选）', '');
    if (content === null) return;
    var listEl = document.getElementById('webshell-file-list');
    webshellFileWrite(conn, path, content || '', function () { webshellFileListDir(conn, base); }, listEl);
}

function webshellFileUpload(conn, pathInput) {
    if (!conn || typeof apiFetch === 'undefined') return;
    var base = (pathInput && pathInput.value.trim()) || '.';
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = false;
    input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            var buf = reader.result;
            var bin = new Uint8Array(buf);
            var CHUNK = 32000;
            var base64Chunks = [];
            for (var i = 0; i < bin.length; i += CHUNK) {
                var slice = bin.subarray(i, Math.min(i + CHUNK, bin.length));
                var b64 = btoa(String.fromCharCode.apply(null, slice));
                base64Chunks.push(b64);
            }
            var path = base === '.' ? file.name : base + '/' + file.name;
            var listEl = document.getElementById('webshell-file-list');
            if (listEl) listEl.innerHTML = '<div class="webshell-loading">' + (wsT('webshell.upload') || '上传') + '...</div>';
            var idx = 0;
            function sendNext() {
                if (idx >= base64Chunks.length) {
                    webshellFileListDir(conn, base);
                    return;
                }
                apiFetch('/api/webshell/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: webshellFileRequestBody(conn, { action: 'upload_chunk', path: path, content: base64Chunks[idx], chunk_index: idx }) })
                    .then(function (r) { return r.json(); })
                    .then(function () { idx++; sendNext(); })
                    .catch(function () { idx++; sendNext(); });
            }
            sendNext();
        };
        reader.readAsArrayBuffer(file);
    };
    input.click();
}

function webshellFileRename(conn, oldPath, oldName, listEl) {
    if (!conn || typeof apiFetch === 'undefined') return;
    var newName = prompt((wsT('webshell.rename') || '重命名') + ': ' + oldName, oldName);
    if (newName == null || newName.trim() === '') return;
    var parts = oldPath.split('/');
    var dir = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
    var newPath = dir + newName.trim();
    apiFetch('/api/webshell/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: webshellFileRequestBody(conn, { action: 'rename', path: oldPath, target_path: newPath }) })
        .then(function (r) { return r.json(); })
        .then(function () { webshellFileListDir(conn, document.getElementById('webshell-file-path').value.trim() || '.'); })
        .catch(function () { webshellFileListDir(conn, document.getElementById('webshell-file-path').value.trim() || '.'); });
}

function webshellBatchDelete(conn, pathInput) {
    if (!conn) return;
    var listEl = document.getElementById('webshell-file-list');
    var checked = listEl ? listEl.querySelectorAll('.webshell-file-cb:checked') : [];
    var paths = [];
    checked.forEach(function (cb) { paths.push(cb.getAttribute('data-path')); });
    if (paths.length === 0) { alert(wsT('webshell.batchDelete') + '：请先勾选文件'); return; }
    if (!confirm(wsT('webshell.batchDelete') + '：确定删除 ' + paths.length + ' 个文件？')) return;
    var base = (pathInput && pathInput.value.trim()) || '.';
    var i = 0;
    function delNext() {
        if (i >= paths.length) { webshellFileListDir(conn, base); return; }
        webshellFileDelete(conn, paths[i], function () { i++; delNext(); });
    }
    delNext();
}

function webshellBatchDownload(conn, pathInput) {
    if (!conn) return;
    var listEl = document.getElementById('webshell-file-list');
    var checked = listEl ? listEl.querySelectorAll('.webshell-file-cb:checked') : [];
    var paths = [];
    checked.forEach(function (cb) { paths.push(cb.getAttribute('data-path')); });
    if (paths.length === 0) { alert(wsT('webshell.batchDownload') + '：请先勾选文件'); return; }
    paths.forEach(function (path) { webshellFileDownload(conn, path); });
}

// 下载文件到本地（读取内容后触发浏览器下载）
function webshellFileDownload(conn, path) {
    if (typeof apiFetch === 'undefined') return;
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: webshellFileRequestBody(conn, { action: 'read', path: path })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            var content = (data && data.output) != null ? data.output : (data.error || '');
            var name = path.replace(/^.*[/\\]/, '') || 'download.txt';
            var blob = new Blob([content], { type: 'application/octet-stream' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            a.click();
            URL.revokeObjectURL(a.href);
        })
        .catch(function (err) { alert(wsT('webshell.execError') + ': ' + (err && err.message ? err.message : '')); });
}

function webshellFileRead(conn, path, listEl, browsePath) {
    if (typeof apiFetch === 'undefined') return;
    listEl.innerHTML = '<div class="webshell-loading">' + wsT('webshell.readFile') + '...</div>';
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: webshellFileRequestBody(conn, { action: 'read', path: path })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            const out = (data && data.output) ? data.output : (data.error || '');
            var backPath = (browsePath && String(browsePath).trim()) ? String(browsePath).trim() : ((document.getElementById('webshell-file-path') && document.getElementById('webshell-file-path').value.trim()) || '.');
            if (backPath === path) {
                // 兜底：若路径被污染成文件路径，回退到父目录
                backPath = path.replace(/\/[^/]+$/, '') || '.';
            }
            listEl.innerHTML = '<div class="webshell-file-content"><div class="webshell-file-content-path">' + escapeHtml(path) + '</div><pre>' + escapeHtml(out) + '</pre><button type="button" class="btn-ghost" id="webshell-file-back-btn" data-back-path="' + escapeHtml(backPath) + '">' + wsT('webshell.back') + '</button></div>';
            var backBtn = document.getElementById('webshell-file-back-btn');
            if (backBtn) {
                backBtn.addEventListener('click', function () {
                    var p = backBtn.getAttribute('data-back-path') || '.';
                    webshellFileListDir(webshellCurrentConn, p);
                });
            }
        })
        .catch(function (err) {
            listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : '') + '</div>';
        });
}

function webshellFileEdit(conn, path, listEl) {
    if (typeof apiFetch === 'undefined') return;
    listEl.innerHTML = '<div class="webshell-loading">' + wsT('webshell.editFile') + '...</div>';
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: webshellFileRequestBody(conn, { action: 'read', path: path })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            const content = (data && data.output) ? data.output : (data.error || '');
            const pathInput = document.getElementById('webshell-file-path');
            const currentPath = pathInput ? pathInput.value.trim() || '.' : '.';
            listEl.innerHTML =
                '<div class="webshell-file-edit-wrap">' +
                '<div class="webshell-file-edit-path">' + escapeHtml(path) + '</div>' +
                '<textarea id="webshell-edit-textarea" class="webshell-file-edit-textarea" rows="18">' + escapeHtml(content) + '</textarea>' +
                '<div class="webshell-file-edit-actions">' +
                '<button type="button" class="btn-primary btn-sm" id="webshell-edit-save">' + wsT('webshell.saveFile') + '</button> ' +
                '<button type="button" class="btn-ghost btn-sm" id="webshell-edit-cancel">' + wsT('webshell.cancelEdit') + '</button>' +
                '</div></div>';
            document.getElementById('webshell-edit-save').addEventListener('click', function () {
                const textarea = document.getElementById('webshell-edit-textarea');
                const newContent = textarea ? textarea.value : '';
                webshellFileWrite(webshellCurrentConn, path, newContent, function () {
                    webshellFileListDir(webshellCurrentConn, currentPath);
                }, listEl);
            });
            document.getElementById('webshell-edit-cancel').addEventListener('click', function () {
                webshellFileListDir(webshellCurrentConn, currentPath);
            });
        })
        .catch(function (err) {
            listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : '') + '</div>';
        });
}

function webshellFileWrite(conn, path, content, onDone, listEl) {
    if (typeof apiFetch === 'undefined') return;
    if (listEl) listEl.innerHTML = '<div class="webshell-loading">' + wsT('webshell.saveFile') + '...</div>';
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: webshellFileRequestBody(conn, { action: 'write', path: path, content: content })
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            if (data && !data.ok && data.error && listEl) {
                listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(data.error) + '</div><pre class="webshell-file-raw">' + escapeHtml(data.output || '') + '</pre>';
                return;
            }
            if (onDone) onDone();
        })
        .catch(function (err) {
            if (listEl) listEl.innerHTML = '<div class="webshell-file-error">' + escapeHtml(err && err.message ? err.message : wsT('webshell.execError')) + '</div>';
        });
}

function webshellFileDelete(conn, path, onDone) {
    if (typeof apiFetch === 'undefined') return;
    apiFetch('/api/webshell/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: webshellFileRequestBody(conn, { action: 'delete', path: path })
    }).then(function (r) { return r.json(); })
        .then(function () { if (onDone) onDone(); })
        .catch(function () { if (onDone) onDone(); });
}

// 删除连接（请求服务端删除后刷新列表）
function deleteWebshell(id) {
    if (!confirm(wsT('webshell.deleteConfirm'))) return;
    if (currentWebshellId === id) destroyWebshellTerminal();
    if (currentWebshellId === id) currentWebshellId = null;
    // 清理本地缓存（服务端会级联删除 SQLite 里的状态）
    delete webshellPersistLoadedByConn[id];
    if (webshellPersistSaveTimersByConn[id]) {
        clearTimeout(webshellPersistSaveTimersByConn[id]);
        delete webshellPersistSaveTimersByConn[id];
    }
    delete webshellTerminalSessionsByConn[id];
    var dbStateKey = getWebshellDbStateStorageKey({ id: id });
    if (dbStateKey) delete webshellDbConfigByConn[dbStateKey];
    Object.keys(webshellTerminalLogsByConn).forEach(function (k) {
        if (k === id || k.indexOf(id + '::') === 0) delete webshellTerminalLogsByConn[k];
    });
    Object.keys(webshellHistoryByConn).forEach(function (k) {
        if (k === id || k.indexOf(id + '::') === 0) delete webshellHistoryByConn[k];
    });
    if (typeof apiFetch === 'undefined') return;
    apiFetch('/api/webshell/connections/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {
            return refreshWebshellConnectionsFromServer();
        })
        .then(function () {
            const workspace = document.getElementById('webshell-workspace');
            if (workspace) {
                workspace.innerHTML = '<div class="webshell-workspace-placeholder">' + wsT('webshell.selectOrAdd') + '</div>';
            }
        })
        .catch(function (e) {
            console.warn('删除 WebShell 连接失败', e);
            refreshWebshellConnectionsFromServer();
        });
}

// 打开添加连接弹窗
function showAddWebshellModal() {
    if (typeof requirePermission === 'function' && !requirePermission('webshell:write')) return;
    var editIdEl = document.getElementById('webshell-edit-id');
    if (editIdEl) editIdEl.value = '';
    document.getElementById('webshell-url').value = '';
    document.getElementById('webshell-password').value = '';
    document.getElementById('webshell-type').value = 'php';
    document.getElementById('webshell-method').value = 'post';
    document.getElementById('webshell-cmd-param').value = '';
    var osSelEl = document.getElementById('webshell-os');
    if (osSelEl) osSelEl.value = 'auto';
    var encSelEl = document.getElementById('webshell-encoding');
    if (encSelEl) encSelEl.value = 'auto';
    populateWebshellProjectSelect('');
    document.getElementById('webshell-remark').value = '';
    var titleEl = document.getElementById('webshell-modal-title');
    if (titleEl) titleEl.textContent = wsT('webshell.addConnection');
    var modal = document.getElementById('webshell-modal');
    if (modal) {
        openAppModal(modal);
        refreshWebshellFormSelects(modal);
    }
}

// 打开编辑连接弹窗（预填当前连接信息）
function showEditWebshellModal(connId) {
    var conn = webshellConnections.find(function (c) { return c.id === connId; });
    if (!conn) return;
    var titleEl = document.getElementById('webshell-modal-title');
    if (titleEl) titleEl.textContent = wsT('webshell.editConnectionTitle');
    openAppModal('webshell-modal', { focus: false });
    deferModalContent(function () {
        var editIdEl = document.getElementById('webshell-edit-id');
        if (editIdEl) editIdEl.value = conn.id;
        document.getElementById('webshell-url').value = conn.url || '';
        document.getElementById('webshell-password').value = conn.password || '';
        document.getElementById('webshell-type').value = conn.type || 'php';
        document.getElementById('webshell-method').value = (conn.method || 'post').toLowerCase();
        document.getElementById('webshell-cmd-param').value = conn.cmdParam || '';
        var osEditEl = document.getElementById('webshell-os');
        if (osEditEl) osEditEl.value = normalizeWebshellOS(conn.os);
        var encEditEl = document.getElementById('webshell-encoding');
        if (encEditEl) encEditEl.value = normalizeWebshellEncoding(conn.encoding);
        populateWebshellProjectSelect(webshellConnectionProjectId(conn));
        document.getElementById('webshell-remark').value = conn.remark || '';
        refreshWebshellFormSelects(document.getElementById('webshell-modal'));
        document.getElementById('webshell-url')?.focus();
    });
}

// 关闭弹窗
function closeWebshellModal() {
    var editIdEl = document.getElementById('webshell-edit-id');
    if (editIdEl) editIdEl.value = '';
    closeAppModal('webshell-modal');
}

// 语言切换时刷新 WebShell 页面内所有由 JS 生成的文案（不重建终端）
function refreshWebshellUIOnLanguageChange() {
    var page = typeof window.currentPage === 'function' ? window.currentPage() : (window.currentPage || '');
    if (page !== 'webshell') return;

    renderWebshellList();
    var workspace = document.getElementById('webshell-workspace');
    if (workspace) {
        if (!currentWebshellId || !webshellCurrentConn) {
            workspace.innerHTML = '<div class="webshell-workspace-placeholder" data-i18n="webshell.selectOrAdd">' + wsT('webshell.selectOrAdd') + '</div>';
        } else {
            // 只更新标签文案，不重建终端
            var tabTerminal = workspace.querySelector('.webshell-tab[data-tab="terminal"]');
            var tabFile = workspace.querySelector('.webshell-tab[data-tab="file"]');
            var tabAi = workspace.querySelector('.webshell-tab[data-tab="ai"]');
            var tabDb = workspace.querySelector('.webshell-tab[data-tab="db"]');
            var tabMemo = workspace.querySelector('.webshell-tab[data-tab="memo"]');
            if (tabTerminal) tabTerminal.textContent = wsT('webshell.tabTerminal');
            if (tabFile) tabFile.textContent = wsT('webshell.tabFileManager');
            if (tabAi) tabAi.textContent = wsT('webshell.tabAiAssistant') || 'AI 助手';
            if (tabDb) tabDb.textContent = wsT('webshell.tabDbManager') || '数据库管理';
            if (tabMemo) tabMemo.textContent = wsT('webshell.tabMemo') || '备忘录';

            var quickLabel = workspace.querySelector('.webshell-quick-label');
            if (quickLabel) quickLabel.textContent = (wsT('webshell.quickCommands') || '快捷命令') + ':';
            var terminalClearBtn = document.getElementById('webshell-terminal-clear');
            if (terminalClearBtn) {
                terminalClearBtn.title = wsT('webshell.clearScreen') || '清屏';
                terminalClearBtn.textContent = wsT('webshell.clearScreen') || '清屏';
            }
            var terminalCopyBtn = document.getElementById('webshell-terminal-copy-log');
            if (terminalCopyBtn) {
                terminalCopyBtn.title = wsT('webshell.copyTerminalLog') || '复制日志';
                terminalCopyBtn.textContent = wsT('webshell.copyTerminalLog') || '复制日志';
            }
            setWebshellTerminalStatus(webshellTerminalRunning);
            if (webshellCurrentConn) renderWebshellTerminalSessions(webshellCurrentConn);
            var pathLabel = workspace.querySelector('.webshell-file-toolbar label span');
            var fileSidebarTitle = workspace.querySelector('.webshell-file-sidebar-title');
            var fileMoreActionsBtn = workspace.querySelector('.webshell-toolbar-actions-btn');
            var listDirBtn = document.getElementById('webshell-list-dir');
            var parentDirBtn = document.getElementById('webshell-parent-dir');
            if (pathLabel) pathLabel.textContent = wsT('webshell.filePath');
            if (fileSidebarTitle) fileSidebarTitle.textContent = wsT('webshell.dirTree') || '目录列表';
            if (fileMoreActionsBtn) fileMoreActionsBtn.textContent = wsT('webshell.moreActions') || '更多操作';
            if (listDirBtn) listDirBtn.textContent = wsT('webshell.listDir');
            if (parentDirBtn) parentDirBtn.textContent = wsT('webshell.parentDir');
            // 文件管理工具栏按钮（红框区域）：切换语言时立即更新
            var refreshBtn = document.getElementById('webshell-file-refresh');
            var mkdirBtn = document.getElementById('webshell-mkdir-btn');
            var newFileBtn = document.getElementById('webshell-newfile-btn');
            var uploadBtn = document.getElementById('webshell-upload-btn');
            var batchDeleteBtn = document.getElementById('webshell-batch-delete-btn');
            var batchDownloadBtn = document.getElementById('webshell-batch-download-btn');
            var filterInput = document.getElementById('webshell-file-filter');
            if (refreshBtn) { refreshBtn.title = wsT('webshell.refresh') || '刷新'; refreshBtn.textContent = wsT('webshell.refresh') || '刷新'; }
            if (mkdirBtn) mkdirBtn.textContent = wsT('webshell.newDir') || '新建目录';
            if (newFileBtn) newFileBtn.textContent = wsT('webshell.newFile') || '新建文件';
            if (uploadBtn) uploadBtn.textContent = wsT('webshell.upload') || '上传';
            if (batchDeleteBtn) batchDeleteBtn.textContent = wsT('webshell.batchDelete') || '批量删除';
            if (batchDownloadBtn) batchDownloadBtn.textContent = wsT('webshell.batchDownload') || '批量下载';
            if (filterInput) filterInput.placeholder = wsT('webshell.filterPlaceholder') || '过滤文件名';

            // AI 助手区域文案：Tab 内按钮、占位符、系统就绪提示
            var aiNewConvBtn = document.getElementById('webshell-ai-new-conv');
            if (aiNewConvBtn) aiNewConvBtn.textContent = wsT('webshell.aiNewConversation') || '新对话';
            var aiInput = document.getElementById('webshell-ai-input');
            if (aiInput) aiInput.placeholder = wsT('webshell.aiPlaceholder') || '例如：列出当前目录下的文件';
            var aiSendBtn = document.getElementById('webshell-ai-send');
            if (aiSendBtn) aiSendBtn.textContent = wsT('webshell.aiSend') || '发送';
            var aiMemoTitle = document.querySelector('.webshell-memo-head span');
            if (aiMemoTitle) aiMemoTitle.textContent = wsT('webshell.aiMemo') || '备忘录';
            var aiMemoClearBtn = document.getElementById('webshell-ai-memo-clear');
            if (aiMemoClearBtn) aiMemoClearBtn.textContent = wsT('webshell.aiMemoClear') || '清空';
            var aiMemoInput = document.getElementById('webshell-ai-memo-input');
            if (aiMemoInput) aiMemoInput.placeholder = wsT('webshell.aiMemoPlaceholder') || '记录关键命令、测试思路、复现步骤...';
            var aiMemoStatus = document.getElementById('webshell-ai-memo-status');
            if (aiMemoStatus && !aiMemoStatus.classList.contains('error')) {
                var savingText = wsT('webshell.aiMemoSaving') || '保存中...';
                var savedText = wsT('webshell.aiMemoSaved') || '已保存到本地';
                aiMemoStatus.textContent = aiMemoStatus.textContent === savingText ? savingText : savedText;
            }
            var dbTypeLabel = document.querySelector('#webshell-db-type') ? document.querySelector('#webshell-db-type').closest('label') : null;
            if (dbTypeLabel && dbTypeLabel.querySelector('span')) dbTypeLabel.querySelector('span').textContent = wsT('webshell.dbType') || '数据库类型';
            var dbProfileNameLabel = document.querySelector('#webshell-db-profile-name') ? document.querySelector('#webshell-db-profile-name').closest('label') : null;
            if (dbProfileNameLabel && dbProfileNameLabel.querySelector('span')) dbProfileNameLabel.querySelector('span').textContent = wsT('webshell.dbProfileName') || '连接名称';
            var dbHostLabel = document.querySelector('#webshell-db-host') ? document.querySelector('#webshell-db-host').closest('label') : null;
            if (dbHostLabel && dbHostLabel.querySelector('span')) dbHostLabel.querySelector('span').textContent = wsT('webshell.dbHost') || '主机';
            var dbPortLabel = document.querySelector('#webshell-db-port') ? document.querySelector('#webshell-db-port').closest('label') : null;
            if (dbPortLabel && dbPortLabel.querySelector('span')) dbPortLabel.querySelector('span').textContent = wsT('webshell.dbPort') || '端口';
            var dbUserLabel = document.querySelector('#webshell-db-user') ? document.querySelector('#webshell-db-user').closest('label') : null;
            if (dbUserLabel && dbUserLabel.querySelector('span')) dbUserLabel.querySelector('span').textContent = wsT('webshell.dbUsername') || '用户名';
            var dbPassLabel = document.querySelector('#webshell-db-pass') ? document.querySelector('#webshell-db-pass').closest('label') : null;
            if (dbPassLabel && dbPassLabel.querySelector('span')) dbPassLabel.querySelector('span').textContent = wsT('webshell.dbPassword') || '密码';
            var dbNameLabel = document.querySelector('#webshell-db-name') ? document.querySelector('#webshell-db-name').closest('label') : null;
            if (dbNameLabel && dbNameLabel.querySelector('span')) dbNameLabel.querySelector('span').textContent = wsT('webshell.dbName') || '数据库名';
            var dbSqliteLabel = document.querySelector('#webshell-db-sqlite-path') ? document.querySelector('#webshell-db-sqlite-path').closest('label') : null;
            if (dbSqliteLabel && dbSqliteLabel.querySelector('span')) dbSqliteLabel.querySelector('span').textContent = wsT('webshell.dbSqlitePath') || 'SQLite 文件路径';
            var dbSchemaTitle = document.querySelector('.webshell-db-sidebar-head span');
            if (dbSchemaTitle) dbSchemaTitle.textContent = wsT('webshell.dbSchema') || '数据库结构';
            var dbLoadSchemaBtn = document.getElementById('webshell-db-load-schema-btn');
            if (dbLoadSchemaBtn) dbLoadSchemaBtn.textContent = wsT('webshell.dbLoadSchema') || '加载结构';
            var dbTemplateBtn = document.getElementById('webshell-db-template-btn');
            if (dbTemplateBtn) dbTemplateBtn.textContent = wsT('webshell.dbTemplateSql') || '示例 SQL';
            var dbClearBtn = document.getElementById('webshell-db-clear-btn');
            if (dbClearBtn) dbClearBtn.textContent = wsT('webshell.dbClearSql') || '清空 SQL';
            var dbRunBtn = document.getElementById('webshell-db-run-btn');
            if (dbRunBtn) dbRunBtn.textContent = wsT('webshell.dbRunSql') || '执行 SQL';
            var dbTestBtn = document.getElementById('webshell-db-test-btn');
            if (dbTestBtn) dbTestBtn.textContent = wsT('webshell.dbTest') || '测试连接';
            var dbSql = document.getElementById('webshell-db-sql');
            if (dbSql) dbSql.placeholder = wsT('webshell.dbSqlPlaceholder') || '输入 SQL，例如：SELECT version();';
            var dbTitle = document.querySelector('.webshell-db-output-title');
            if (dbTitle) dbTitle.textContent = wsT('webshell.dbOutput') || '执行输出';
            var dbHint = document.querySelector('.webshell-db-hint');
            if (dbHint) dbHint.textContent = wsT('webshell.dbCliHint') || '如果提示命令不存在，请先在目标主机安装对应客户端（mysql/psql/sqlite3/sqlcmd）';
            var dbTreeHint = document.querySelector('.webshell-db-sidebar-hint');
            if (dbTreeHint) dbTreeHint.textContent = wsT('webshell.dbSelectTableHint') || '点击表名可生成查询 SQL';
            var dbAddProfileBtn = document.getElementById('webshell-db-add-profile-btn');
            if (dbAddProfileBtn) dbAddProfileBtn.textContent = '+ ' + (wsT('webshell.dbAddProfile') || '新增连接');
            var dbProfileModalTitle = document.getElementById('webshell-db-profile-modal-title');
            if (dbProfileModalTitle) dbProfileModalTitle.textContent = wsT('webshell.editConnectionTitle') || '编辑连接';
            var dbProfileCancelBtn = document.getElementById('webshell-db-profile-cancel-btn');
            if (dbProfileCancelBtn) dbProfileCancelBtn.textContent = '取消';
            var dbProfileSaveBtn = document.getElementById('webshell-db-profile-save-btn');
            if (dbProfileSaveBtn) dbProfileSaveBtn.textContent = '保存';
            document.querySelectorAll('.webshell-db-profile-menu[data-action="edit"]').forEach(function (el) {
                el.title = wsT('webshell.editConnection') || '编辑';
            });
            document.querySelectorAll('.webshell-db-profile-menu[data-action="delete"]').forEach(function (el) {
                el.title = wsT('webshell.dbDeleteProfile') || '删除连接';
            });
            var dbTree = document.getElementById('webshell-db-schema-tree');
            if (dbTree && !dbTree.querySelector('.webshell-db-group')) {
                dbTree.innerHTML = '<div class="webshell-empty">' + escapeHtml(wsT('webshell.dbNoSchema') || '暂无数据库结构，请先加载') + '</div>';
            }

            // 如果当前 AI 对话区只有系统就绪提示（没有用户消息），用当前语言重置这条提示
            var aiMessages = document.getElementById('webshell-ai-messages');
            if (aiMessages) {
                var hasUserMsg = !!aiMessages.querySelector('.webshell-ai-msg.user');
                var msgNodes = aiMessages.querySelectorAll('.webshell-ai-msg');
                if (!hasUserMsg && msgNodes.length <= 1) {
                    var readyMsg = wsT('webshell.aiSystemReadyMessage') || '系统已就绪。请输入您的测试需求，系统将自动执行相应的安全测试。';
                    aiMessages.innerHTML = '';
                    var readyDiv = document.createElement('div');
                    readyDiv.className = 'webshell-ai-msg assistant';
                    readyDiv.textContent = readyMsg;
                    aiMessages.appendChild(readyDiv);
                }
            }

            var pathInput = document.getElementById('webshell-file-path');
            var fileListEl = document.getElementById('webshell-file-list');
            if (fileListEl && webshellCurrentConn && pathInput) {
                webshellFileListDir(webshellCurrentConn, pathInput.value.trim() || '.');
            }

            // 连接搜索占位符（动态属性：这里手动更新）
            var connSearchEl = document.getElementById('webshell-conn-search');
            if (connSearchEl) {
                var ph = wsT('webshell.searchPlaceholder') || '搜索连接...';
                connSearchEl.setAttribute('placeholder', ph);
                connSearchEl.placeholder = ph;
            }
        }
    }

    var modal = document.getElementById('webshell-modal');
    if (modal && isAppModalOpen('webshell-modal')) {
        var titleEl = document.getElementById('webshell-modal-title');
        var editIdEl = document.getElementById('webshell-edit-id');
        if (titleEl) {
            titleEl.textContent = (editIdEl && editIdEl.value) ? wsT('webshell.editConnectionTitle') : wsT('webshell.addConnection');
        }
        if (typeof window.applyTranslations === 'function') {
            window.applyTranslations(modal);
        }
    }
}

document.addEventListener('languagechange', function () {
    refreshWebshellUIOnLanguageChange();
});

// 任意入口删除对话后同步：若当前在 WebShell AI 助手且已选连接，则刷新对话列表（与 Chat 侧边栏删除保持一致）
document.addEventListener('conversation-deleted', function (e) {
    var id = e.detail && e.detail.conversationId;
    if (!id || !currentWebshellId || !webshellCurrentConn) return;
    var listEl = document.getElementById('webshell-ai-conv-list');
    if (listEl) fetchAndRenderWebshellAiConvList(webshellCurrentConn, listEl);
    if (webshellAiConvMap[webshellCurrentConn.id] === id) {
        delete webshellAiConvMap[webshellCurrentConn.id];
        var msgs = document.getElementById('webshell-ai-messages');
        if (msgs) msgs.innerHTML = '';
    }
});

// 测试连通性（不保存，仅用当前表单参数请求 Shell 执行一次性探活命令）
function testWebshellConnection() {
    var url = (document.getElementById('webshell-url') || {}).value;
    if (url && typeof url.trim === 'function') url = url.trim();
    if (!url) {
        alert(wsT('webshell.url') ? (wsT('webshell.url') + ' 必填') : '请填写 Shell 地址');
        return;
    }
    var password = (document.getElementById('webshell-password') || {}).value;
    if (password && typeof password.trim === 'function') password = password.trim(); else password = '';
    var type = (document.getElementById('webshell-type') || {}).value || 'php';
    var method = ((document.getElementById('webshell-method') || {}).value || 'post').toLowerCase();
    var cmdParam = (document.getElementById('webshell-cmd-param') || {}).value;
    if (cmdParam && typeof cmdParam.trim === 'function') cmdParam = cmdParam.trim(); else cmdParam = '';
    var osTag = normalizeWebshellOS((document.getElementById('webshell-os') || {}).value);
    var encoding = normalizeWebshellEncoding((document.getElementById('webshell-encoding') || {}).value);
    var btn = document.getElementById('webshell-test-btn');
    var probeToken = buildWebshellProbeToken();
    if (btn) { btn.disabled = true; btn.textContent = (typeof wsT === 'function' ? wsT('common.refresh') : '刷新') + '...'; }
    if (typeof apiFetch === 'undefined') {
        if (btn) { btn.disabled = false; btn.textContent = wsT('webshell.testConnectivity'); }
        alert(wsT('webshell.testFailed') || '连通性测试失败');
        return;
    }
    // 连通性使用 Windows/Linux 都识别的最小内建命令作为探测（echo token 在 cmd 和 sh 下行为等价）
    apiFetch('/api/webshell/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: url,
            password: password || '',
            type: type,
            method: method === 'get' ? 'get' : 'post',
            cmd_param: cmdParam || '',
            encoding: encoding,
            os: osTag,
            command: buildWebshellProbeCommand(probeToken)
        })
    })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (btn) { btn.disabled = false; btn.textContent = wsT('webshell.testConnectivity'); }
            if (!data) {
                alert(wsT('webshell.testFailed') || '连通性测试失败');
                return;
            }
            // 仅 HTTP 200 不算通过，需校验响应中是否包含本次一次性探活 token
            var output = (data.output != null) ? String(data.output) : '';
            var reallyOk = data.ok && isWebshellProbeOutputMatched(output, probeToken);
            if (reallyOk) {
                alert(wsT('webshell.testSuccess') || '连通性正常，Shell 可访问');
            } else {
                var msg;
                if (data.ok && !isWebshellProbeOutputMatched(output, probeToken))
                    msg = wsT('webshell.testNoExpectedOutput') || 'Shell 返回了响应但未得到预期输出，请检查连接密码与命令参数名';
                else
                    msg = (data.error) ? data.error : (wsT('webshell.testFailed') || '连通性测试失败');
                if (data.http_code) msg += ' (HTTP ' + data.http_code + ')';
                alert(msg);
            }
        })
        .catch(function (e) {
            if (btn) { btn.disabled = false; btn.textContent = wsT('webshell.testConnectivity'); }
            alert((wsT('webshell.testFailed') || '连通性测试失败') + ': ' + (e && e.message ? e.message : String(e)));
        });
}

// 保存连接（新建或更新，请求服务端写入 SQLite 后刷新列表）
function saveWebshellConnection() {
    if (typeof requirePermission === 'function' && !requirePermission('webshell:write')) return;
    var url = (document.getElementById('webshell-url') || {}).value;
    if (url && typeof url.trim === 'function') url = url.trim();
    if (!url) {
        alert('请填写 Shell 地址');
        return;
    }
    var password = (document.getElementById('webshell-password') || {}).value;
    if (password && typeof password.trim === 'function') password = password.trim(); else password = '';
    var type = (document.getElementById('webshell-type') || {}).value || 'php';
    var method = ((document.getElementById('webshell-method') || {}).value || 'post').toLowerCase();
    var cmdParam = (document.getElementById('webshell-cmd-param') || {}).value;
    if (cmdParam && typeof cmdParam.trim === 'function') cmdParam = cmdParam.trim(); else cmdParam = '';
    var osTag = normalizeWebshellOS((document.getElementById('webshell-os') || {}).value);
    var encoding = normalizeWebshellEncoding((document.getElementById('webshell-encoding') || {}).value);
    var remark = (document.getElementById('webshell-remark') || {}).value;
    if (remark && typeof remark.trim === 'function') remark = remark.trim(); else remark = '';

    var editIdEl = document.getElementById('webshell-edit-id');
    var editId = editIdEl ? editIdEl.value.trim() : '';
    var projectId = (document.getElementById('webshell-project-id') || {}).value || '';
    if (projectId && typeof projectId.trim === 'function') projectId = projectId.trim(); else projectId = '';
    var body = { url: url, password: password, type: type, method: method === 'get' ? 'get' : 'post', cmd_param: cmdParam, encoding: encoding, os: osTag, remark: remark || url, project_id: projectId };
    if (typeof apiFetch === 'undefined') return;

    var reqUrl = editId ? ('/api/webshell/connections/' + encodeURIComponent(editId)) : '/api/webshell/connections';
    var reqMethod = editId ? 'PUT' : 'POST';
    apiFetch(reqUrl, {
        method: reqMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
        .then(function (r) { return r.json(); })
        .then(function () {
            closeWebshellModal();
            return refreshWebshellConnectionsFromServer();
        })
        .then(function (list) {
            // 若编辑的是当前选中的连接，同步更新 webshellCurrentConn，使终端/文件管理立即使用新配置
            if (editId && currentWebshellId === editId && Array.isArray(list)) {
                var updated = list.find(function (c) { return c.id === editId; });
                if (updated) webshellCurrentConn = updated;
            }
        })
        .catch(function (e) {
            console.warn('保存 WebShell 连接失败', e);
            alert(e && e.message ? e.message : '保存失败');
        });
}

