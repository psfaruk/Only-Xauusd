-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "strategyVersion" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "datasetFingerprint" TEXT NOT NULL,
    "datasetFromUtc" DATETIME NOT NULL,
    "datasetToUtc" DATETIME NOT NULL,
    "candleCount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "exclusions" TEXT NOT NULL,
    "rules" TEXT NOT NULL,
    "devMetrics" TEXT NOT NULL,
    "oosMetrics" TEXT NOT NULL,
    "trades" TEXT NOT NULL,
    "limitations" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BacktestRun_symbol_timeframe_createdAt_idx" ON "BacktestRun"("symbol", "timeframe", "createdAt");
