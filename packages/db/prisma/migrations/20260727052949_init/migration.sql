-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "catalog_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "game" TEXT,
    "setName" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_external_refs" (
    "id" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_external_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "printing" TEXT NOT NULL DEFAULT 'NORMAL',
    "language" TEXT NOT NULL DEFAULT 'EN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "quantityOnHand" INTEGER NOT NULL DEFAULT 0,
    "reserveQuantity" INTEGER NOT NULL DEFAULT 0,
    "costBasis" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "resultingOnHand" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "channelInstanceId" TEXT,
    "allocationId" TEXT,
    "note" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_instances" (
    "id" TEXT NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "credentialRef" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPolledAt" TIMESTAMP(3),
    "lastReconciledAt" TIMESTAMP(3),
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "healthCheckedAt" TIMESTAMP(3),
    "healthDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_allocations" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "channelInstanceId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'pooled',
    "quantityAllocated" INTEGER,
    "maxQuantity" INTEGER,
    "listedQuantity" INTEGER NOT NULL DEFAULT 0,
    "price" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "externalListingId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "lastPushedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "channelInstanceId" TEXT NOT NULL,
    "topic" TEXT,
    "externalEventId" TEXT NOT NULL,
    "headers" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_events" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "direction" TEXT NOT NULL,
    "channelInstanceId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "operation" TEXT,
    "payload" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "sync_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "channelInstanceId" TEXT,
    "inventoryItemId" TEXT,
    "skuId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "context" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "provider" TEXT NOT NULL DEFAULT 'local',
    "externalId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "userId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "catalog_items_name_idx" ON "catalog_items"("name");

-- CreateIndex
CREATE INDEX "catalog_items_game_setName_idx" ON "catalog_items"("game", "setName");

-- CreateIndex
CREATE INDEX "catalog_external_refs_catalogItemId_idx" ON "catalog_external_refs"("catalogItemId");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_external_refs_source_externalId_key" ON "catalog_external_refs"("source", "externalId");

-- CreateIndex
CREATE INDEX "skus_catalogItemId_idx" ON "skus"("catalogItemId");

-- CreateIndex
CREATE UNIQUE INDEX "skus_catalogItemId_condition_printing_language_key" ON "skus"("catalogItemId", "condition", "printing", "language");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_skuId_key" ON "inventory_items"("skuId");

-- CreateIndex
CREATE INDEX "stock_movements_inventoryItemId_createdAt_idx" ON "stock_movements"("inventoryItemId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_reason_createdAt_idx" ON "stock_movements"("reason", "createdAt");

-- CreateIndex
CREATE INDEX "channel_instances_connectorKey_idx" ON "channel_instances"("connectorKey");

-- CreateIndex
CREATE INDEX "channel_instances_enabled_idx" ON "channel_instances"("enabled");

-- CreateIndex
CREATE INDEX "channel_allocations_channelInstanceId_externalListingId_idx" ON "channel_allocations"("channelInstanceId", "externalListingId");

-- CreateIndex
CREATE INDEX "channel_allocations_status_idx" ON "channel_allocations"("status");

-- CreateIndex
CREATE INDEX "channel_allocations_inventoryItemId_idx" ON "channel_allocations"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_allocations_inventoryItemId_channelInstanceId_key" ON "channel_allocations"("inventoryItemId", "channelInstanceId");

-- CreateIndex
CREATE INDEX "webhook_events_status_receivedAt_idx" ON "webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_channelInstanceId_externalEventId_key" ON "webhook_events"("channelInstanceId", "externalEventId");

-- CreateIndex
CREATE INDEX "sync_events_ts_idx" ON "sync_events"("ts");

-- CreateIndex
CREATE INDEX "sync_events_channelInstanceId_ts_idx" ON "sync_events"("channelInstanceId", "ts");

-- CreateIndex
CREATE INDEX "sync_events_entityType_entityId_idx" ON "sync_events"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "sync_events_outcome_ts_idx" ON "sync_events"("outcome", "ts");

-- CreateIndex
CREATE INDEX "alerts_status_createdAt_idx" ON "alerts"("status", "createdAt");

-- CreateIndex
CREATE INDEX "alerts_kind_status_idx" ON "alerts"("kind", "status");

-- CreateIndex
CREATE INDEX "alerts_inventoryItemId_idx" ON "alerts"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "users_provider_externalId_key" ON "users"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_ref_key" ON "credentials"("ref");

-- AddForeignKey
ALTER TABLE "catalog_external_refs" ADD CONSTRAINT "catalog_external_refs_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_allocations" ADD CONSTRAINT "channel_allocations_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_allocations" ADD CONSTRAINT "channel_allocations_channelInstanceId_fkey" FOREIGN KEY ("channelInstanceId") REFERENCES "channel_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_channelInstanceId_fkey" FOREIGN KEY ("channelInstanceId") REFERENCES "channel_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_channelInstanceId_fkey" FOREIGN KEY ("channelInstanceId") REFERENCES "channel_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_channelInstanceId_fkey" FOREIGN KEY ("channelInstanceId") REFERENCES "channel_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


