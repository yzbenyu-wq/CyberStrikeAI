package app

import (
	"jameslee-ai/internal/config"
	"jameslee-ai/internal/mcp"
	"jameslee-ai/internal/vision"

	"go.uber.org/zap"
)

func registerVisionTools(mcpServer *mcp.Server, cfg *config.Config, logger *zap.Logger) {
	vision.RegisterAnalyzeImageTool(mcpServer, cfg, logger)
}
