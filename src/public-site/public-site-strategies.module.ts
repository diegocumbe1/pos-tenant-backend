import { Module } from '@nestjs/common';
import { BarberSiteStrategy } from './strategies/barber-site.strategy';
import { RetailSiteStrategy } from './strategies/retail-site.strategy';
import { VerticalSiteStrategyResolver } from './strategies/vertical-site-strategy.resolver';

/**
 * Registers the per-vertical public-site strategies and the resolver that the
 * shared PublicSiteService uses to stay vertical-agnostic.
 */
@Module({
  providers: [BarberSiteStrategy, RetailSiteStrategy, VerticalSiteStrategyResolver],
  exports: [VerticalSiteStrategyResolver],
})
export class PublicSiteStrategiesModule {}
