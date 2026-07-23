CREATE TABLE "TelegramPollingState" (
    "botKey" TEXT NOT NULL,
    "offset" INTEGER,
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastUpdateId" INTEGER,
    "lastUpdateAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramPollingState_pkey" PRIMARY KEY ("botKey")
);
