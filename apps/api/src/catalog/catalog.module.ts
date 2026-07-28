import { Module } from '@nestjs/common';
import { CatalogSourceRegistry } from './catalog-source-registry.service';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';

@Module({
  controllers: [CatalogController],
  providers: [CatalogSourceRegistry, CatalogService],
  exports: [CatalogSourceRegistry, CatalogService],
})
export class CatalogModule {}
