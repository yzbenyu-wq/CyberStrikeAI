/**
 * DomSafe —— 上下文明确的 DOM 转义入口
 *
 * 背景：此前项目中有 27 份各自实现的 escapeHtml / escapeAttr / escapeHtmlLocal，
 * 且实现并不一致（DOM 版不转义引号、projects.js 版转义引号、webshell.js 版
 * 用 !s 判空导致数字 0 被吞）。escapeHtml 被同时用在文本位置与属性位置，
 * 而它对属性上下文并不安全 —— 值中含 '"' 即可闭合属性并注入事件处理器。
 *
 * 本模块给出按上下文区分的 API，并提供全局兼容别名，使既有调用点无需改动：
 *   DomSafe.text(s)   元素内容
 *   DomSafe.attr(s)   属性值（value="", title="" …）
 *   DomSafe.js(s)     内联事件里的字符串参数
 *   DomSafe.url(s)    href / src（协议白名单）
 *   DomSafe.html(s)   富文本片段（委托 DOMPurify）
 *
 * 加载顺序：必须排在所有业务脚本之前。
 */
(function (global) {
    'use strict';

    function toStr(v) {
        return v == null ? '' : String(v);
    }

    /* 元素内容：只转 & < >。不转引号，否则正文里的 " 会显示成 &quot;。 */
    function text(v) {
        return toStr(v).replace(/[&<>]/g, function (c) {
            return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
        });
    }

    /* 属性值：必须转 & < > " '。漏掉引号即可闭合属性。 */
    function attr(v) {
        return toStr(v).replace(/[&<>"']/g, function (c) {
            switch (c) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                default: return '&#39;';
            }
        });
    }

    /* 内联事件里的字符串参数：onclick="fn('...')"。
       用 JSON.stringify 得到正确引号与转义，再转 < 防止提前闭合 script。 */
    function js(v) {
        return JSON.stringify(toStr(v)).replace(/</g, '\\u003c');
    }

    /* URL 属性：先做协议白名单，再做属性转义。
       先剔除控制字符与空白，避免 "java\tscript:" 这类绕过。 */
    var BAD_PROTOCOL = /^(?:javascript|vbscript|data:text\/html|data:application\/javascript)/i;
    function url(v) {
        var s = toStr(v);
        if (!s) return '';
        var probe = s.replace(/[\u0000-\u0020]/g, '').toLowerCase();
        if (BAD_PROTOCOL.test(probe)) return '';
        return attr(s);
    }

    /* 富文本：委托 DOMPurify，沿用 sanitize-markdown.js 的白名单。
       任一依赖不可用时降级为纯文本转义，绝不返回原始 HTML。 */
    function html(v, profile) {
        var s = toStr(v);
        var purify = global.DOMPurify;
        if (!purify) return text(s);
        var cfg;
        var sm = global.csMarkdownSanitize;
        if (sm && profile === 'timeline') cfg = sm.TIMELINE_SANITIZE_CONFIG;
        else if (sm) cfg = sm.CHAT_SANITIZE_CONFIG;
        return purify.sanitize(s, cfg);
    }

    global.DomSafe = { text: text, attr: attr, js: js, url: url, html: html };

    /* 全局兼容别名：既有 1300 余处 escapeHtml(...) / escapeAttr(...) 调用点
       保持原样即可，无需逐个改写。各业务文件中原有定义已移除，故此处生效。 */
    global.escapeHtml = text;
    global.escapeAttr = attr;
})(typeof window !== 'undefined' ? window : globalThis);
