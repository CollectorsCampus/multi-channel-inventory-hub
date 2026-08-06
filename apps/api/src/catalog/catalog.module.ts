import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { CatalogSourceRegistry } from './catalog-source-registry.service';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';
import { CatalogMergeService } from './catalog-merge.service';
import { CatalogClearService } from './catalog-clear.service';
import { CatalogCredentialsService } from './catalog-credentials.service';

@Module({
  imports: [ConnectorsModule],
  controllers: [CatalogController],
  providers: [
    CatalogSourceRegistry,
    CatalogService,
    CatalogMergeService,
    CatalogClearService,
    CatalogCredentialsService,
  ],
  exports: [
    CatalogSourceRegistry,
    CatalogService,
    CatalogMergeService,
    CatalogClearService,
    CatalogCredentialsService,
  ],
})
export class CatalogModule {}
