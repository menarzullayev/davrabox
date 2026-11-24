import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { loadRateLimitConfig, type RateLimitConfig } from './config.js';
import { RateLimitGuard, UserRateLimitInterceptor } from './guard.js';
import { RateLimitService } from './service.js';

/**
 * Global rate limiting for the whole API. Import once (AppModule). Exports RateLimitService so any module can create
 * its own named limiters from the same (Redis-backed, or in-memory) store.
 */
@Global()
@Module({})
export class RateLimitModule {
  static forRoot(cfg?: RateLimitConfig): DynamicModule {
    return {
      module: RateLimitModule,
      providers: [
        { provide: RateLimitService, useFactory: () => RateLimitService.create(cfg ?? loadRateLimitConfig()) },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_INTERCEPTOR, useClass: UserRateLimitInterceptor },
      ],
      exports: [RateLimitService],
    };
  }
}
