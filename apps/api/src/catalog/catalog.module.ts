import { Module } from '@nestjs/common';
import { CatalogSourceRegistry } from './catalog-source-registry.service';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';
import { CatalogMergeService } from './catalog-merge.service';

@Module({
  controllers: [CatalogController],
  providers: [CatalogSourceRegistry, CatalogService, CatalogMergeService],
  exports: [CatalogSourceRegistry, CatalogService, CatalogMergeService],
})
export class CatalogModule {}
