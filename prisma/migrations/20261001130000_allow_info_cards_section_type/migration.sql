-- Permite las secciones personalizadas del editor ("Agregar sección") en el
-- sitio público. El DTO ya aceptaba 'info_cards', pero la restricción de la
-- tabla se quedó con la lista vieja: guardar secciones con una sección propia
-- reventaba con 500 (23514, public_site_sections_type_check).
ALTER TABLE "public_site_sections"
    DROP CONSTRAINT "public_site_sections_type_check";

ALTER TABLE "public_site_sections"
    ADD CONSTRAINT "public_site_sections_type_check"
    CHECK ("type" IN (
        'hero',
        'trust_bar',
        'services',
        'catalog',
        'gallery',
        'instagram',
        'info_cards',
        'booking_cta',
        'booking_modal',
        'contact'
    ));
