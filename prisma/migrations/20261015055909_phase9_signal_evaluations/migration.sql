-- CreateTable
CREATE TABLE "SignalEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "engineVersion" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasonCodes" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
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

-- CreateIndex
CREATE INDEX "SignalEvaluation_symbol_outcome_createdAt_idx" ON "SignalEvaluation"("symbol", "outcome", "createdAt");

-- CreateIndex
CREATE INDEX "SignalEvaluation_symbol_createdAt_idx" ON "SignalEvaluation"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "SignalEvaluation_createdAt_idx" ON "SignalEvaluation"("createdAt");
