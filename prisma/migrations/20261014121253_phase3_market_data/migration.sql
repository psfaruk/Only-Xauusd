/*
  Warnings:

  - You are about to drop the `MarketTick` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `quality` on the `MarketCandle` table. All the data in the column will be lost.
  - You are about to drop the column `timestamp` on the `MarketCandle` table. All the data in the column will be lost.
  - You are about to drop the column `volume` on the `MarketCandle` table. All the data in the column will be lost.
  - Added the required column `candleTimeUtc` to the `MarketCandle` table without a default value. This is not possible if the table is not empty.
  - Added the required column `receivedAtUtc` to the `MarketCandle` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `MarketCandle` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "MarketTick_symbol_timestamp_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "MarketTick";
PRAGMA foreign_keys=on;

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

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MarketCandle" (
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
INSERT INTO "new_MarketCandle" ("close", "createdAt", "high", "id", "low", "open", "source", "symbol", "timeframe") SELECT "close", "createdAt", "high", "id", "low", "open", "source", "symbol", "timeframe" FROM "MarketCandle";
DROP TABLE "MarketCandle";
ALTER TABLE "new_MarketCandle" RENAME TO "MarketCandle";
CREATE INDEX "MarketCandle_symbol_timeframe_candleTimeUtc_idx" ON "MarketCandle"("symbol", "timeframe", "candleTimeUtc");
CREATE UNIQUE INDEX "MarketCandle_symbol_timeframe_candleTimeUtc_key" ON "MarketCandle"("symbol", "timeframe", "candleTimeUtc");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DataQualityIssue_symbol_timeframe_checkedAtUtc_idx" ON "DataQualityIssue"("symbol", "timeframe", "checkedAtUtc");

-- CreateIndex
CREATE INDEX "DataQualityIssue_resolutionStatus_severity_idx" ON "DataQualityIssue"("resolutionStatus", "severity");

-- CreateIndex
CREATE INDEX "SyncRun_startedAtUtc_idx" ON "SyncRun"("startedAtUtc");

-- CreateIndex
CREATE INDEX "SyncRun_symbol_status_idx" ON "SyncRun"("symbol", "status");
