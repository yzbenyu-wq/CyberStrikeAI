package app

import (
	"compress/gzip"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// staticRoot 需与 app.go 中 router.Static("/static", "./web/static") 保持一致。
const staticRoot = "./web/static"

// minGzipSize 低于此体积的文件不压缩：gzip 头本身约 20 字节，
// 小文件压缩后可能反而增大，且省不下往返开销。
const minGzipSize = 1024

// gzipSkipExt 已是压缩格式，再压收益极低甚至体积变大。
var gzipSkipExt = map[string]struct{}{
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {}, ".avif": {},
	".ico": {}, ".woff": {}, ".woff2": {}, ".ttf": {}, ".eot": {},
	".zip": {}, ".gz": {}, ".br": {}, ".mp4": {}, ".webm": {},
}

// gzipTargetExt 文本类资源，压缩收益显著（实测 js 体积可降约 74%）。
var gzipTargetExt = map[string]struct{}{
	".js": {}, ".css": {}, ".json": {}, ".svg": {}, ".html": {}, ".htm": {},
	".txt": {}, ".map": {}, ".webmanifest": {}, ".xml": {},
}

// staticAssetsMiddleware 为 /static 下的资源提供缓存协商与 gzip 压缩。
//
// 严格限定 /static 前缀的原因：应用内存在多处 SSE 流式端点
// （text/event-stream，见 handler/terminal.go、handler/multi_agent.go、
// handler/eino_single_agent.go），对其做缓冲压缩会破坏流式输出。
func staticAssetsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !strings.HasPrefix(c.Request.URL.Path, "/static/") {
			c.Next()
			return
		}

		rel := strings.TrimPrefix(c.Request.URL.Path, "/static/")
		info, statErr := os.Stat(filepath.Join(staticRoot, filepath.FromSlash(rel)))
		fileOK := statErr == nil && !info.IsDir()
		if fileOK {
			// 弱校验器：内容变化时 mtime 或 size 必然变化。
			// http.ServeContent 会读取该 ETag 处理 If-None-Match，未变更时返回 304。
			c.Header("ETag", fmt.Sprintf(`W/"%x-%x"`, info.ModTime().UnixNano(), info.Size()))
			if c.Query("v") != "" {
				// URL 自带版本号，内容变更时 URL 随之改变，可安全长缓存。
				c.Header("Cache-Control", "public, max-age=604800")
			} else {
				// 未带版本号：每次向服务端校验，未变更时 304，避免拿到旧代码。
				c.Header("Cache-Control", "no-cache")
			}
		}

		ext := strings.ToLower(filepath.Ext(c.Request.URL.Path))
		if _, skip := gzipSkipExt[ext]; skip {
			c.Next()
			return
		}
		if _, ok := gzipTargetExt[ext]; !ok {
			c.Next()
			return
		}
		// 过小的文件压缩后可能反而变大（gzip 头约 20 字节），不值得。
		if fileOK && info.Size() < minGzipSize {
			c.Next()
			return
		}
		if !strings.Contains(c.GetHeader("Accept-Encoding"), "gzip") {
			c.Next()
			return
		}

		c.Header("Vary", "Accept-Encoding")
		c.Header("Content-Encoding", "gzip")

		gw := &gzipResponseWriter{ResponseWriter: c.Writer}
		c.Writer = gw
		c.Next()
		// 仅在确实写入过正文时才产生 gzip 流，避免 304 等空响应写入多余字节。
		if gw.gz != nil {
			_ = gw.gz.Close()
		}
	}
}

// gzipResponseWriter 惰性创建 gzip.Writer：
// 压缩后长度改变，ServeContent 预设的 Content-Length 必须移除，否则响应会被截断。
type gzipResponseWriter struct {
	gin.ResponseWriter
	gz *gzip.Writer
}

func (w *gzipResponseWriter) WriteHeader(code int) {
	w.Header().Del("Content-Length")
	if code == http.StatusNotModified {
		// 304 不携带正文，不应声明已压缩。
		w.Header().Del("Content-Encoding")
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *gzipResponseWriter) WriteHeaderNow() {
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeaderNow()
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeaderNow()
	if w.gz == nil {
		w.gz = gzip.NewWriter(w.ResponseWriter)
	}
	return w.gz.Write(b)
}

func (w *gzipResponseWriter) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}
