import { Module } from '@nestjs/common';
import { CatalogSourceRegistry } from './catalog-source-registry.service';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';
import { CatalogMergeService } from './catalog-merge.service';
import { CatalogClearService } from './catalog-clear.service';

@Module({
  controllers: [CatalogController],
  providers: [CatalogSourceRegistry, CatalogService, CatalogMergeService, CatalogClearService],
  exports: [CatalogSourceRegistry, CatalogService, CatalogMergeService, CatalogClearService],
})
export class CatalogModule {}
