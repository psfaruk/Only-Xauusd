-- AlterTable
ALTER TABLE "AnalysisRun" ADD COLUMN "calculationConfig" TEXT;
ALTER TABLE "AnalysisRun" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "AnalysisRun" ADD COLUMN "generatedAtUtc" DATETIME;
ALTER TABLE "AnalysisRun" ADD COLUMN "inputFingerprint" TEXT;
ALTER TABLE "AnalysisRun" ADD COLUMN "reasonCodes" TEXT;
ALTER TABLE "AnalysisRun" ADD COLUMN "warnings" TEXT;

-- CreateIndex
CREATE INDEX "AnalysisRun_symbol_status_startedAt_idx" ON "AnalysisRun"("symbol", "status", "startedAt");

-- CreateIndex
CREATE INDEX "AnalysisRun_startedAt_idx" ON "AnalysisRun"("startedAt");
