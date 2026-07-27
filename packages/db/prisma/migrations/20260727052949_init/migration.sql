-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "catalog_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "game" TEXT,
    "set_name" TEXT,
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_external_refs" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_external_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "printing" TEXT NOT NULL DEFAULT 'NORMAL',
    "language" TEXT NOT NULL DEFAULT 'EN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "sku_id" TEXT NOT NULL,
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserve_quantity" INTEGER NOT NULL DEFAULT 0,
    "cost_basis" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "resulting_on_hand" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "channel_instance_id" TEXT,
    "allocation_id" TEXT,
    "note" TEXT,
    "actor_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_instances" (
    "id" TEXT NOT NULL,
    "connector_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "credential_ref" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_polled_at" TIMESTAMP(3),
    "last_reconciled_at" TIMESTAMP(3),
    "health_status" TEXT NOT NULL DEFAULT 'unknown',
    "health_checked_at" TIMESTAMP(3),
    "health_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_allocations" (
    "id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "channel_instance_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'pooled',
    "quantity_allocated" INTEGER,
    "max_quantity" INTEGER,
    "listed_quantity" INTEGER NOT NULL DEFAULT 0,
    "price" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "external_listing_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "last_pushed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "channel_instance_id" TEXT NOT NULL,
    "topic" TEXT,
    "external_event_id" TEXT NOT NULL,
    "headers" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
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
    "channel_instance_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "operation" TEXT,
    "payload" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "duration_ms" INTEGER,

    CONSTRAINT "sync_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "channel_instance_id" TEXT,
    "inventory_item_id" TEXT,
    "sku_id" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "context" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "password_hash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "provider" TEXT NOT NULL DEFAULT 'local',
    "external_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "user_id" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "catalog_items_name_idx" ON "catalog_items"("name");

-- CreateIndex
CREATE INDEX "catalog_items_game_set_name_idx" ON "catalog_items"("game", "set_name");

-- CreateIndex
CREATE INDEX "catalog_external_refs_catalog_item_id_idx" ON "catalog_external_refs"("catalog_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_external_refs_source_external_id_key" ON "catalog_external_refs"("source", "external_id");

-- CreateIndex
CREATE INDEX "skus_catalog_item_id_idx" ON "skus"("catalog_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "skus_catalog_item_id_condition_printing_language_key" ON "skus"("catalog_item_id", "condition", "printing", "language");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_sku_id_key" ON "inventory_items"("sku_id");

-- CreateIndex
CREATE INDEX "stock_movements_inventory_item_id_created_at_idx" ON "stock_movements"("inventory_item_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_reason_created_at_idx" ON "stock_movements"("reason", "created_at");

-- CreateIndex
CREATE INDEX "channel_instances_connector_key_idx" ON "channel_instances"("connector_key");

-- CreateIndex
CREATE INDEX "channel_instances_enabled_idx" ON "channel_instances"("enabled");

-- CreateIndex
CREATE INDEX "channel_allocations_channel_instance_id_external_listing_id_idx" ON "channel_allocations"("channel_instance_id", "external_listing_id");

-- CreateIndex
CREATE INDEX "channel_allocations_status_idx" ON "channel_allocations"("status");

-- CreateIndex
CREATE INDEX "channel_allocations_inventory_item_id_idx" ON "channel_allocations"("inventory_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_allocations_inventory_item_id_channel_instance_id_key" ON "channel_allocations"("inventory_item_id", "channel_instance_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_channel_instance_id_external_event_id_key" ON "webhook_events"("channel_instance_id", "external_event_id");

-- CreateIndex
CREATE INDEX "sync_events_ts_idx" ON "sync_events"("ts");

-- CreateIndex
CREATE INDEX "sync_events_channel_instance_id_ts_idx" ON "sync_events"("channel_instance_id", "ts");

-- CreateIndex
CREATE INDEX "sync_events_entity_type_entity_id_idx" ON "sync_events"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "sync_events_outcome_ts_idx" ON "sync_events"("outcome", "ts");

-- CreateIndex
CREATE INDEX "alerts_status_created_at_idx" ON "alerts"("status", "created_at");

-- CreateIndex
CREATE INDEX "alerts_kind_status_idx" ON "alerts"("kind", "status");

-- CreateIndex
CREATE INDEX "alerts_inventory_item_id_idx" ON "alerts"("inventory_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "users_provider_external_id_key" ON "users"("provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_ref_key" ON "credentials"("ref");

-- AddForeignKey
ALTER TABLE "catalog_external_refs" ADD CONSTRAINT "catalog_external_refs_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_allocations" ADD CONSTRAINT "channel_allocations_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_allocations" ADD CONSTRAINT "channel_allocations_channel_instance_id_fkey" FOREIGN KEY ("channel_instance_id") REFERENCES "channel_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_channel_instance_id_fkey" FOREIGN KEY ("channel_instance_id") REFERENCES "channel_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_channel_instance_id_fkey" FOREIGN KEY ("channel_instance_id") REFERENCES "channel_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_channel_instance_id_fkey" FOREIGN KEY ("channel_instance_id") REFERENCES "channel_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

