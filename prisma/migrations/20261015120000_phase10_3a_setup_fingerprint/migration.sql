-- Phase 10.3-A — Setup Identity & Deduplication (ADDITIVE ONLY)
-- Reviewed before application: exactly two ADD COLUMN statements and one
-- CREATE UNIQUE INDEX. No drop, no rewrite, no backfill. Legacy rows keep
-- NULL (multiple NULLs are allowed by the SQLite unique index, so existing
-- and future no-identity rows never conflict). The unique constraint is the
-- database-level race-condition guard: ONE PaperSignalOutcome row per
-- logical setup fingerprint, ever (open/counted/resolved all block
-- re-creation). SignalEvaluation.setupFingerprint is deliberately NOT
-- unique — repeated evaluation rows remain the append-only audit trail.

-- AlterTable
ALTER TABLE "PaperSignalOutcome" ADD COLUMN "setupFingerprint" TEXT;

-- AlterTable
ALTER TABLE "SignalEvaluation" ADD COLUMN "setupFingerprint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PaperSignalOutcome_setupFingerprint_key" ON "PaperSignalOutcome"("setupFingerprint");
