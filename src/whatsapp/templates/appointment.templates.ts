export interface AppointmentTemplateInput {
  customerName: string;
  customerPhone: string;
  serviceName: string;
  specialistName: string;
  startTime: string;
  businessName: string;
}

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

export const renderCustomerConfirmation = (a: AppointmentTemplateInput): string =>
  [
    `Hola ${a.customerName}, te recordamos tu cita en ${a.businessName}:`,
    '',
    `📅 Fecha: ${formatDate(a.startTime)}`,
    `⏰ Hora: ${formatTime(a.startTime)}`,
    `✂️ Servicio: ${a.serviceName}`,
    `👤 Especialista: ${a.specialistName}`,
    '',
    'Nos vemos pronto. 🙌',
  ].join('\n');

export const renderBusinessNotification = (a: AppointmentTemplateInput): string =>
  [
    `Nueva cita agendada en ${a.businessName}:`,
    '',
    `👤 Cliente: ${a.customerName} (${a.customerPhone})`,
    `✂️ Servicio: ${a.serviceName}`,
    `📅 ${formatDate(a.startTime)} a las ${formatTime(a.startTime)}`,
    `👤 Especialista: ${a.specialistName}`,
  ].join('\n');
