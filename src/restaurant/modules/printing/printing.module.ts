import { Module } from '@nestjs/common';
import { PrintersController } from './printers.controller';
import { PrintersService } from './printers.service';
import { PrintJobsController } from './print-jobs.controller';
import { PrintJobsService } from './print-jobs.service';
import { PrintingDocumentService } from './printing-document.service';

@Module({
  controllers: [PrintersController, PrintJobsController],
  providers: [PrintersService, PrintJobsService, PrintingDocumentService],
  exports: [PrintJobsService, PrintingDocumentService],
})
export class PrintingModule {}
