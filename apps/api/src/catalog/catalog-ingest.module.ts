import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CatalogIngestService } from './catalog-ingest.service';
import { CatalogIngestController } from './catalog-ingest.controller';
import { CatalogImportService } from './catalog-import.service';
import { CatalogImportController } from './catalog-import.controller';

/**
 * Its own module, rather than a provider inside `CatalogModule`.
 *
 * Ingest needs both the source registry and `IntakeService`, and
 * `InventoryModule` already imports `CatalogModule` — so putting it in
 * `CatalogModule` would make the two import each other. Nest resolves that only
 * with `forwardRef`, which works and then quietly turns every future
 * construction-time dependency between them into a runtime undefined.
 *
 * A third module importing both keeps the graph acyclic and needs no such trick.
 */
@Module({
  imports: [CatalogModule, InventoryModule],
  controllers: [CatalogIngestController, CatalogImportController],
  providers: [CatalogIngestService, CatalogImportService],
  exports: [CatalogIngestService, CatalogImportService],
})
export class CatalogIngestModule {}
