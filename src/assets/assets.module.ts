import { Global, Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { ImageUploadService } from './image-upload.service';

@Global()
@Module({
  imports: [SupabaseModule],
  controllers: [AssetsController],
  providers: [AssetsService, ImageUploadService],
  exports: [ImageUploadService],
})
export class AssetsModule {}
