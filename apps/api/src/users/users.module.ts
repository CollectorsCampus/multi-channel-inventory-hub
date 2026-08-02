import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Its own module rather than part of `AuthModule`.
 *
 * Authentication answers "who is this request", which every route needs;
 * administering accounts is one screen an admin visits occasionally. Keeping
 * them apart means the guard on every request does not drag user management
 * in behind it, and `AuthModule` stays the thing you read to understand how a
 * request is identified.
 *
 * It imports `AuthModule` for `PasswordService`, so hashing parameters are
 * shared with login rather than restated here.
 */
@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
