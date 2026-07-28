import { Module } from '@nestjs/common';
import { CatalogSourceRegistry } from './catalog-source-registry.service';

@Module({
  providers: [CatalogSourceRegistry],
  exports: [CatalogSourceRegistry],
})
export class CatalogModule {}
