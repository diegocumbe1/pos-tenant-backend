import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  controllers: [FinanceController],
  providers: [FinanceService],
  // El asistente consulta los gastos por aquí en vez de leer la tabla por su
  // cuenta: el cálculo de un gasto (recurrentes, rangos, categorías) vive en un
  // solo sitio y los dos canales heredan cualquier arreglo.
  exports: [FinanceService],
})
export class FinanceModule {}
