-- XAUUSD AI Trading Agent — consolidated baseline migration (2026-10-16)
-- CreateTable
CREATE TABLE "SystemEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MarketCandle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "candleTimeUtc" DATETIME NOT NULL,
    "open" TEXT NOT NULL,
    "high" TEXT NOT NULL,
    "low" TEXT NOT NULL,
    "close" TEXT NOT NULL,
    "tickVolume" INTEGER,
    "spread" TEXT,
    "source" TEXT NOT NULL,
    "isForming" BOOLEAN NOT NULL DEFAULT false,
    "validationStatus" TEXT NOT NULL DEFAULT 'VALID',
    "receivedAtUtc" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MarketLatestTick" (
    "symbol" TEXT NOT NULL PRIMARY KEY,
    "bid" TEXT NOT NULL,
    "ask" TEXT NOT NULL,
    "spread" TEXT,
    "spreadPoints" TEXT,
    "tickTimeUtc" DATETIME NOT NULL,
    "receivedAtUtc" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "validationStatus" TEXT NOT NULL DEFAULT 'VALID',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SymbolSpec" (
    "symbol" TEXT NOT NULL PRIMARY KEY,
    "digits" INTEGER,
    "point" TEXT,
    "tickSize" TEXT,
    "tickValue" TEXT,
    "volumeMin" TEXT,
    "volumeMax" TEXT,
    "volumeStep" TEXT,
    "source" TEXT NOT NULL,
    "verifiedFields" TEXT NOT NULL,
    "meta" TEXT,
    "lastVerifiedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DataQualityIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checkType" TEXT NOT NULL,
    "symbol" TEXT,
    "timeframe" TEXT,
    "targetTimeUtc" DATETIME,
    "targetRecordId" TEXT,
    "severity" TEXT NOT NULL,
    "errorCode" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "checkedAtUtc" DATETIME NOT NULL,
    "resolutionStatus" TEXT NOT NULL DEFAULT 'open',
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mode" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframes" TEXT NOT NULL,
    "rangeStartUtc" DATETIME,
    "rangeEndUtc" DATETIME,
    "startedAtUtc" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAtUtc" DATETIME,
    "requested" INTEGER NOT NULL DEFAULT 0,
    "received" INTEGER NOT NULL DEFAULT 0,
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "timeframes" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reasonCodes" TEXT,
    "warnings" TEXT,
    "inputFingerprint" TEXT,
    "calculationConfig" TEXT,
    "generatedAtUtc" DATETIME,
    "durationMs" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "setupId" TEXT NOT NULL,
    "analysisId" TEXT,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entry" REAL,
    "entryLow" REAL,
    "entryHigh" REAL,
    "stopLoss" REAL,
    "takeProfit" REAL,
    "riskReward" REAL,
    "expiry" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active',
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AiReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT,
    "analysisId" TEXT,
    "agent" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

-- CreateTable
CREATE TABLE "SignalEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "engineVersion" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasonCodes" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "setupFingerprint" TEXT,
    "datasetFingerprint" TEXT,
    "inputSnapshot" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "levels" TEXT,
    "decisionCandleTimeUtc" DATETIME,
    "setupKnownAtUtc" DATETIME,
    "expiryUtc" DATETIME,
    "quote" TEXT NOT NULL,
    "executionLocked" BOOLEAN NOT NULL,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ValidationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "harnessVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "datasetFingerprint" TEXT NOT NULL,
    "datasetFromUtc" DATETIME NOT NULL,
    "datasetToUtc" DATETIME NOT NULL,
    "candleCounts" TEXT NOT NULL,
    "observedSpread" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "limitations" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PaperCandidateOutcome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateEvaluationId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "candidateVersion" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "signalCreatedAtUtc" DATETIME NOT NULL,
    "decisionCandleTimeUtc" DATETIME NOT NULL,
    "setupKnownAtUtc" DATETIME NOT NULL,
    "expiryUtc" DATETIME NOT NULL,
    "datasetFingerprint" TEXT,
    "inputFingerprint" TEXT NOT NULL,
    "setupFingerprint" TEXT NOT NULL,
    "sourceCandleRange" TEXT NOT NULL,
    "entryReference" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "target" REAL NOT NULL,
    "invalidationLevel" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "resolvedAtUtc" DATETIME,
    "resolutionBarTimeUtc" DATETIME,
    "exitPrice" REAL,
    "observations" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedBarTimeUtc" DATETIME,
    "modeledCostsPrice" REAL NOT NULL,
    "grossPnlPrice" REAL,
    "netPnlPrice" REAL,
    "rMultiple" REAL,
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperCandidateOutcome_candidateEvaluationId_key" UNIQUE ("candidateEvaluationId"),
    CONSTRAINT "PaperCandidateOutcome_setupFingerprint_key" UNIQUE ("setupFingerprint")
);

-- CreateTable
CREATE TABLE "PaperSignalOutcome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalEvaluationId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "signalCreatedAtUtc" DATETIME NOT NULL,
    "decisionCandleTimeUtc" DATETIME NOT NULL,
    "setupKnownAtUtc" DATETIME NOT NULL,
    "expiryUtc" DATETIME NOT NULL,
    "datasetFingerprint" TEXT,
    "inputFingerprint" TEXT NOT NULL,
    "setupFingerprint" TEXT,
    "sourceCandleRange" TEXT NOT NULL,
    "entryReference" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "target" REAL NOT NULL,
    "invalidationLevel" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "resolvedAtUtc" DATETIME,
    "resolutionBarTimeUtc" DATETIME,
    "exitPrice" REAL,
    "observations" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedBarTimeUtc" DATETIME,
    "modeledCostsPrice" REAL NOT NULL,
    "grossPnlPrice" REAL,
    "netPnlPrice" REAL,
    "rMultiple" REAL,
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RiskCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT NOT NULL,
    "checks" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TradeApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    "expiresAt" DATETIME
);

-- CreateTable
CREATE TABLE "ExecutionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SystemEvent_createdAt_idx" ON "SystemEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SystemEvent_category_level_idx" ON "SystemEvent"("category", "level");

-- CreateIndex
CREATE INDEX "MarketCandle_symbol_timeframe_candleTimeUtc_idx" ON "MarketCandle"("symbol", "timeframe", "candleTimeUtc");

-- CreateIndex
CREATE UNIQUE INDEX "MarketCandle_symbol_timeframe_candleTimeUtc_key" ON "MarketCandle"("symbol", "timeframe", "candleTimeUtc");

-- CreateIndex
CREATE INDEX "DataQualityIssue_symbol_timeframe_checkedAtUtc_idx" ON "DataQualityIssue"("symbol", "timeframe", "checkedAtUtc");

-- CreateIndex
CREATE INDEX "DataQualityIssue_resolutionStatus_severity_idx" ON "DataQualityIssue"("resolutionStatus", "severity");

-- CreateIndex
CREATE INDEX "SyncRun_startedAtUtc_idx" ON "SyncRun"("startedAtUtc");

-- CreateIndex
CREATE INDEX "SyncRun_symbol_status_idx" ON "SyncRun"("symbol", "status");

-- CreateIndex
CREATE INDEX "AnalysisRun_symbol_status_startedAt_idx" ON "AnalysisRun"("symbol", "status", "startedAt");

-- CreateIndex
CREATE INDEX "AnalysisRun_startedAt_idx" ON "AnalysisRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_setupId_key" ON "Signal"("setupId");

-- CreateIndex
CREATE INDEX "Signal_symbol_status_createdAt_idx" ON "Signal"("symbol", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BacktestRun_symbol_timeframe_createdAt_idx" ON "BacktestRun"("symbol", "timeframe", "createdAt");

-- CreateIndex
CREATE INDEX "SignalEvaluation_symbol_outcome_createdAt_idx" ON "SignalEvaluation"("symbol", "outcome", "createdAt");

-- CreateIndex
CREATE INDEX "SignalEvaluation_symbol_createdAt_idx" ON "SignalEvaluation"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "SignalEvaluation_createdAt_idx" ON "SignalEvaluation"("createdAt");

-- CreateIndex
CREATE INDEX "ValidationRun_symbol_createdAt_idx" ON "ValidationRun"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "PaperCandidateOutcome_symbol_status_idx" ON "PaperCandidateOutcome"("symbol", "status");

-- CreateIndex
CREATE INDEX "PaperCandidateOutcome_symbol_outcome_idx" ON "PaperCandidateOutcome"("symbol", "outcome");

-- CreateIndex
CREATE INDEX "PaperCandidateOutcome_status_idx" ON "PaperCandidateOutcome"("status");

-- CreateIndex
CREATE INDEX "PaperCandidateOutcome_candidateVersion_idx" ON "PaperCandidateOutcome"("candidateVersion");

-- CreateIndex
CREATE UNIQUE INDEX "PaperSignalOutcome_signalEvaluationId_key" ON "PaperSignalOutcome"("signalEvaluationId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperSignalOutcome_setupFingerprint_key" ON "PaperSignalOutcome"("setupFingerprint");

-- CreateIndex
CREATE INDEX "PaperSignalOutcome_symbol_status_idx" ON "PaperSignalOutcome"("symbol", "status");

-- CreateIndex
CREATE INDEX "PaperSignalOutcome_symbol_outcome_idx" ON "PaperSignalOutcome"("symbol", "outcome");

-- CreateIndex
CREATE INDEX "PaperSignalOutcome_status_idx" ON "PaperSignalOutcome"("status");

-- CreateIndex
CREATE INDEX "RiskCheck_signalId_idx" ON "RiskCheck"("signalId");

-- CreateIndex
CREATE INDEX "ExecutionLog_signalId_idx" ON "ExecutionLog"("signalId");


-- CreateTable (Task 33/35 — BrokerSettings: UI-imported credentials, AES-256-GCM at rest)
CREATE TABLE "BrokerSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "server" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT NOT NULL DEFAULT 'ui',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
